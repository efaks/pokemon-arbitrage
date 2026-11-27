import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createSystemRuntime, reloadSystemRuntime } from '../src/cli.ts';
import type { FetchLike } from '../src/connectors/base.ts';
import { AutopilotEngine } from '../src/engine/autopilot.ts';
import { evaluateReadiness } from '../src/engine/readiness.ts';
import { createArbitrageServer } from '../src/server/httpServer.ts';
import { ALLOWED_ENV_KEYS, buildSetupGuide, testProviderConnection, updateProjectEnv } from '../src/setup/configManager.ts';
import { buildEbayConsentUrl, createDefaultMerchantLocation, discoverEbaySellerSetup,
  exchangeEbayAuthorizationCode } from '../src/setup/ebayOnboarding.ts';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

function workspace(t: TestContext) {
  const cwd = mkdtempSync(join(tmpdir(), 'arbitrage-guided-setup-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  return { cwd, envPath: join(cwd, '.env') };
}

function withoutEnv(t: TestContext, ...keys: string[]) {
  const previous = new Map(keys.map(key => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test('an approved order can fill at exactly the cash reserve floor', async t => {
  const runtime = createSystemRuntime({ dbPath: ':memory:', useMock: true, quiet: true, mode: 'hitl' });
  t.after(() => runtime.db.close());
  await runtime.pipeline.runCycle();
  const order = runtime.db.listOrders('pending_hitl').find(candidate => candidate.listingId === 'mock-ssp-bb-clean');
  assert.ok(order);
  runtime.config.cashBalanceCents = runtime.config.minCashReserveCents + order.landedCostCents;
  runtime.db.updateOrderStatus(order.id, 'approved');
  assert.equal(runtime.db.getPortfolioSnapshot(runtime.config).cashBalanceCents, runtime.config.minCashReserveCents);
  const outcome = await runtime.executor.executeApprovedOrder(order.id);
  assert.equal(outcome.status, 'filled', outcome.reason);
  assert.equal(runtime.db.getPortfolioSnapshot(runtime.config).cashBalanceCents, runtime.config.minCashReserveCents);
});

test('settings writes are allowlisted, private, lossless, and reload the same database', t => {
  const { envPath } = workspace(t);
  withoutEnv(t, 'ARBITRAGE_SKIP_DOTENV', 'ARBITRAGE_MODE', 'ARBITRAGE_CASH_BALANCE_CENTS', 'ARBITRAGE_DAILY_CAP_CENTS',
    'ARBITRAGE_DB_PATH', 'VISION_API_KEY', 'VISION_MODEL');
  const example = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
  for (const match of example.matchAll(/^([A-Z_]+)=/gm)) assert.ok(ALLOWED_ENV_KEYS.has(match[1]), match[1]);
  const initial = '# original comment\nARBITRAGE_CASH_BALANCE_CENTS=10000\nVISION_MODEL=old # preserve the model note\nVISION_MODEL=duplicate\nOTHER=keep # comment\n';
  writeFileSync(envPath, initial, { mode: 0o644 });
  assert.throws(() => updateProjectEnv({ PATH: '/bad' }, { envPath }), /PATH is disallowed/);
  assert.throws(() => updateProjectEnv({ NODE_OPTIONS: '--import=bad' }, { envPath }), /NODE_OPTIONS is disallowed/);
  for (const value of ['bad\rline', 'bad\nline', 'bad\0line']) {
    assert.throws(() => updateProjectEnv({ VISION_MODEL: value }, { envPath }), /CR, LF, or NUL/);
  }
  assert.equal(readFileSync(envPath, 'utf8'), initial);
  process.env.ARBITRAGE_DAILY_CAP_CENTS = '123456';
  const runtime = createSystemRuntime({ dbPath: ':memory:', envPath, useMock: true, quiet: true, mode: 'hitl' });
  const { db, pipeline } = runtime;
  t.after(() => db.close());
  const exact = ` a 'quoted' "model" \\ # dollars $100 `;
  const secret = 'local-secret-value-never-echoed';
  const update = updateProjectEnv({ VISION_API_KEY: secret, VISION_MODEL: exact,
    ARBITRAGE_CASH_BALANCE_CENTS: '82500', ARBITRAGE_MODE: null }, { envPath, applyToProcessEnv: false });
  assert.deepEqual(update.removedKeys, ['ARBITRAGE_MODE']);
  assert.equal(update.maskedValues.VISION_API_KEY, '[redacted]');
  assert.ok(!JSON.stringify(update).includes(secret));
  assert.equal(statSync(envPath).mode & 0o777, 0o600);
  const saved = readFileSync(envPath, 'utf8');
  assert.match(saved, /^# original comment/m);
  assert.match(saved, /^OTHER=keep # comment/m);
  assert.match(saved, /# preserve the model note/);
  assert.equal(saved.match(/^VISION_MODEL=/gm)?.length, 1);
  assert.equal(process.env.VISION_MODEL, 'old');
  assert.equal(reloadSystemRuntime(runtime), runtime);
  assert.equal(runtime.db, db);
  assert.notEqual(runtime.pipeline, pipeline);
  assert.ok(db.listSkus().length > 0);
  assert.equal(runtime.config.cashBalanceCents, 82500);
  assert.equal(runtime.config.dailySpendCapCents, 123456);
  assert.equal(process.env.VISION_MODEL, exact);
  assert.equal(process.env.VISION_API_KEY, secret);
  assert.equal(runtime.config.operatingMode, 'hitl');
  assert.equal(runtime.salesReconciler.isConfigured(), true);
  updateProjectEnv({ VISION_API_KEY: null, VISION_MODEL: null }, { envPath });
  reloadSystemRuntime(runtime);
  assert.equal(process.env.VISION_API_KEY, undefined);
  assert.equal(process.env.VISION_MODEL, undefined);
  delete process.env.OTHER;
});

test('eBay consent and token exchange handle sandbox scopes, raw and pasted codes', async () => {
  const consent = buildEbayConsentUrl({ clientId: 'app-id', ruName: 'registered name', sandbox: true,
    includeBuyOrder: true, state: 'operator-nonce' });
  const url = new URL(consent.url);
  assert.equal(url.origin, 'https://auth.sandbox.ebay.com');
  assert.equal(url.pathname, '/oauth2/authorize');
  assert.equal(url.searchParams.get('client_id'), 'app-id');
  assert.equal(url.searchParams.get('redirect_uri'), 'registered name');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('state'), consent.state);
  assert.deepEqual(url.searchParams.get('scope')?.split(' '), consent.scopes);
  assert.match(consent.scopes.join(' '), /sell\.fulfillment\.readonly.*sell\.account\.readonly.*buy\.order/);
  assert.equal(buildEbayConsentUrl({ clientId: 'id', ruName: 'ru', includeSell: false }).scopes.length, 1);

  for (const [code, expected] of [
    ['https://return.example.test/accepted?code=one%2Btwo%252Fx&state=nonce', 'one+two%2Fx'],
    ['one%2Btwo%2Fx', 'one+two/x'], ['100%raw', '100%raw'],
  ]) {
    const tokens = await exchangeEbayAuthorizationCode({ clientId: 'id', clientSecret: 'private', ruName: 'ru',
      code, sandbox: true, fetchFn: async (input, init) => {
        assert.equal(String(input), 'https://api.sandbox.ebay.com/identity/v1/oauth2/token');
        assert.equal(init?.method, 'POST');
        assert.equal(new Headers(init.headers).get('authorization'), 'Basic ' + Buffer.from('id:private').toString('base64'));
        assert.deepEqual(Object.fromEntries(new URLSearchParams(String(init.body))),
          { grant_type: 'authorization_code', code: expected, redirect_uri: 'ru' });
        return Response.json({ access_token: 'access', refresh_token: 'refresh', expires_in: 7200, refresh_token_expires_in: 86400 });
      } });
    assert.deepEqual(tokens, { accessToken: 'access', refreshToken: 'refresh', expiresInSeconds: 7200, refreshTokenExpiresInSeconds: 86400 });
  }
  await assert.rejects(() => exchangeEbayAuthorizationCode({ clientId: 'id', clientSecret: 'private', ruName: 'ru',
    code: 'https://return.example.test/?state=only', fetchFn: async () => assert.fail() }), /authorization code/);
});

test('eBay setup discovers all pages, prefers enabled stock locations, and creates an authorized warehouse', async () => {
  const tokenProvider = { isConfigured: () => true, getAccessToken: async () => 'seller-token', invalidate() {} };
  const fetchFn: FetchLike = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, 'https://api.sandbox.ebay.com');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer seller-token');
    if (init?.method === 'POST') {
      assert.equal(url.pathname, '/sell/inventory/v1/location/store%2F1');
      assert.deepEqual(JSON.parse(String(init.body)), {
        name: 'Default warehouse', merchantLocationStatus: 'ENABLED', locationTypes: ['WAREHOUSE'],
        location: { address: { city: 'State College', stateOrProvince: 'PA', postalCode: '16801', country: 'US' } },
      });
      return new Response(null, { status: 204 });
    }
    if (url.pathname.endsWith('/location')) {
      return !url.searchParams.has('offset')
        ? Response.json({ next: 'page-2', locations: [{ merchantLocationKey: 'closed', status: 'DISABLED' }] })
        : Response.json({ locations: [{ merchantLocationKey: 'open', merchantLocationStatus: 'ENABLED' }] });
    }
    assert.equal(url.searchParams.get('marketplace_id'), 'EBAY_US');
    if (url.pathname.endsWith('/fulfillment_policy')) return Response.json({ fulfillmentPolicies: [{}, { fulfillmentPolicyId: 'ship' }] });
    if (url.pathname.endsWith('/payment_policy')) return Response.json({ paymentPolicies: [{ paymentPolicyId: 'pay' }] });
    assert.ok(url.pathname.endsWith('/return_policy'));
    return Response.json({ returnPolicies: [{ returnPolicyId: 'returns' }] });
  };
  const options = { sandbox: true, tokenProvider, fetchFn };
  const report = await discoverEbaySellerSetup(options);
  assert.deepEqual([report.fulfillmentPolicyId, report.paymentPolicyId, report.returnPolicyId, report.merchantLocationKey],
    ['ship', 'pay', 'returns', 'open']);
  assert.equal(report.locations.length, 2);
  assert.deepEqual(await createDefaultMerchantLocation({ ...options, locationKey: 'store/1',
    address: { city: 'State College', stateOrProvince: 'PA', postalCode: '16801', country: 'US' } }),
  { created: true, locationKey: 'store/1' });
});

test('provider probes avoid write requests and do not return upstream errors or secrets', async t => {
  withoutEnv(t, 'POKEMON_TCG_API_KEY', 'PRICECHARTING_API_TOKEN', 'ARBITRAGE_WEBHOOK_URL', 'BESTBUY_API_KEY');
  process.env.POKEMON_TCG_API_KEY = 'fixture-pokemon-api-secret';
  process.env.ARBITRAGE_WEBHOOK_URL = 'https://hooks.example.test/private/webhook';
  process.env.PRICECHARTING_API_TOKEN = 'fixture-price-secret';
  const reply = await testProviderConnection('pokemon_tcg', { fetchFn: async (url, init) => {
    assert.match(String(url), /pageSize=1/);
    assert.equal(new Headers(init?.headers).get('x-api-key'), process.env.POKEMON_TCG_API_KEY);
    return Response.json({ data: [] });
  } });
  assert.deepEqual({ ok: reply.ok, status: reply.status }, { ok: true, status: 200 });
  const price = await testProviderConnection('pricecharting', { fetchFn: async () =>
    Response.json({ status: 'error', error: process.env.PRICECHARTING_API_TOKEN }) });
  assert.equal(price.ok, false);
  assert.ok(!JSON.stringify(price).includes(process.env.PRICECHARTING_API_TOKEN));
  const hook = await testProviderConnection('webhook', { fetchFn: async (url, init) => {
    assert.equal(init?.method, 'HEAD');
    throw new Error(String(url));
  } });
  assert.equal(hook.ok, false);
  assert.ok(!JSON.stringify(hook).includes(process.env.ARBITRAGE_WEBHOOK_URL));
  assert.equal((await testProviderConnection('bestbuy', { fetchFn: async () => assert.fail() })).configured, false);
});

test('setup and catalog commands work with a clean temporary database and simulated reconciliation', t => {
  const { cwd } = workspace(t);
  const env: NodeJS.ProcessEnv = { ...process.env, ARBITRAGE_SKIP_DOTENV: '1' };
  for (const key of ALLOWED_ENV_KEYS) delete env[key as keyof typeof env];
  const run = (...args: string[]) => JSON.parse(execFileSync(process.execPath, [cli, ...args], { cwd, env, encoding: 'utf8' }));
  const report = run('setup', '--db', ':memory:', '--json');
  assert.equal(report.nextSetupStep, 'catalog');
  assert.equal(report.steps.length, 8);
  assert.equal(run('expand-catalog', '--db', 'test.sqlite', '--pack', 'expanded_sealed').skusUpserted, 25);
  assert.equal(run('setup', '--db', 'test.sqlite', '--json').readiness.catalogSkuCount, 25);
  assert.equal(run('reconcile-sales', '--db', ':memory:', '--mock').adapterName, 'Simulated fulfillment');
});

test('setup and HTTP use reloaded settings, expanded catalog, and live cash reporting', async t => {
  const { envPath } = workspace(t);
  withoutEnv(t, 'ARBITRAGE_CASH_BALANCE_CENTS', 'ARBITRAGE_SKIP_DOTENV', 'BESTBUY_API_KEY');
  const runtime = createSystemRuntime({ dbPath: ':memory:', useMock: true, seedCatalog: false, quiet: true, envPath });
  t.after(() => runtime.db.close());
  assert.equal(buildSetupGuide(runtime).nextSetupStep, 'catalog');
  const autopilot = new AutopilotEngine(runtime);
  const server = createArbitrageServer({ ...runtime, runtime, autopilot });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.close(); });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const call = (path: string, body?: object) => fetch(`http://127.0.0.1:${address.port}/api/${path}`,
    body === undefined ? undefined : { method: 'POST', body: JSON.stringify(body) });
  const expanded = await call('catalog/expand', { pack: 'all_curated' });
  assert.equal(expanded.status, 200);
  assert.equal((await expanded.json()).totalCatalogSkus, 95);
  const key = 'private-bestbuy-fixture-key';
  updateProjectEnv({ ARBITRAGE_CASH_BALANCE_CENTS: '34567', BESTBUY_API_KEY: key }, { envPath });
  reloadSystemRuntime(runtime);
  runtime.db.setKillSwitch(true, 'Secret in an echoed string ' + key);
  const guide = await call('setup-guide');
  assert.equal(guide.status, 200);
  const guideText = await guide.text();
  assert.ok(!guideText.includes(key));
  const { readiness } = JSON.parse(guideText);
  assert.equal(readiness.dynamicCashBalanceCents, 34567);
  assert.ok(readiness.fulfillmentSyncEnabled);
  assert.equal(readiness.nextSetupStep, 'market_data');
  assert.equal(evaluateReadiness({ db: runtime.db, fmvEngine: runtime.fmvEngine, config: runtime.config }).fulfillmentSyncEnabled, false);
  const reconcile = await call('inventory/reconcile-sales', { limit: 1, sinceIso: '2026-01-01T00:00:00Z' });
  assert.equal(reconcile.status, 200);
  assert.equal((await reconcile.json()).enabled, true);
  assert.equal((await call('inventory/reconcile-sales', { limit: 201 })).status, 400);
  assert.ok((await autopilot.runAutopilotPass()).reconciliation?.enabled);
});

test('scheduled sync and sale reconciliation use the reloaded runtime', { timeout: 3000 }, async t => {
  const { envPath } = workspace(t);
  withoutEnv(t, 'ARBITRAGE_SKIP_DOTENV', 'ARBITRAGE_CASH_BALANCE_CENTS');
  const runtime = createSystemRuntime({ dbPath: ':memory:', useMock: true, quiet: true, envPath });
  const autopilot = new AutopilotEngine(runtime);
  const { marketSync: oldMarketSync, salesReconciler: oldReconciler } = runtime;
  const oldSync = t.mock.method(oldMarketSync, 'syncAll');
  const oldReconcile = t.mock.method(oldReconciler, 'reconcileSoldOrders');
  t.after(async () => {
    autopilot.stopDaemon();
    await autopilot.waitForIdle();
    runtime.db.close();
  });
  autopilot.startDaemon({ hotIntervalMs: 1000, standardIntervalMs: 1000, syncIntervalMs: 5, repriceIntervalMs: 5 });
  updateProjectEnv({ ARBITRAGE_CASH_BALANCE_CENTS: '75000' }, { envPath });
  reloadSystemRuntime(runtime);
  const synced = Promise.withResolvers<number | undefined>();
  const reconciled = Promise.withResolvers<boolean>();
  const syncAll = runtime.marketSync.syncAll.bind(runtime.marketSync);
  t.mock.method(runtime.marketSync, 'syncAll', async (options: Parameters<typeof syncAll>[0]) => {
    const summary = await syncAll(options);
    synced.resolve(options?.config?.cashBalanceCents);
    return summary;
  });
  const reconcile = runtime.salesReconciler.reconcileSoldOrders.bind(runtime.salesReconciler);
  t.mock.method(runtime.salesReconciler, 'reconcileSoldOrders', async () => {
    const summary = await reconcile();
    reconciled.resolve(summary.enabled);
    return summary;
  });
  assert.deepEqual(await Promise.all([synced.promise, reconciled.promise]), [75000, true]);
  assert.equal(oldSync.mock.callCount(), 0);
  assert.equal(oldReconcile.mock.callCount(), 0);
});
