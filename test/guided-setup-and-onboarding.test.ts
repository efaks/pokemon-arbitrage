import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createSystemRuntime, reloadSystemRuntime } from '../src/cli.ts';
import { seedCanonicalCatalog } from '../src/catalog/seed.ts';
import type { FetchLike } from '../src/connectors/base.ts';
import { ArbitrageDatabase } from '../src/db/database.ts';
import { AutopilotEngine } from '../src/engine/autopilot.ts';
import { evaluateReadiness } from '../src/engine/readiness.ts';
import { createArbitrageServer } from '../src/server/httpServer.ts';
import {
  ALLOWED_ENV_KEYS, buildSetupGuide, SETUP_PROFILES, SETUP_STEP_IDS, testProviderConnection, updateProjectEnv, updateSetupWorkflow,
} from '../src/setup/configManager.ts';
import type { SetupGuideReport } from '../src/setup/configManager.ts';
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
  const humanGuide = execFileSync(process.execPath, [cli, 'setup', '--db', ':memory:'], { cwd, env, encoding: 'utf8' });
  assert.match(humanGuide, /Profile: Live closed loop \(live_closed_loop, default\)/);
  assert.match(humanGuide, /\[NEXT\] 1\. catalog/);
  assert.match(humanGuide, /\[BLOCKED\] 8\. shadow_burn_in_and_go_live/);
  assert.equal(humanGuide.match(/^\[(?:DONE|SKIP|NEXT|WAIT|BLOCKED)\]/gm)?.length, 8);
  assert.match(humanGuide, /Current Step[^\n]*\n[^\n]+\n[^\n]+/);
  assert.match(humanGuide, /Verification checks[\s\S]+Completion criteria[\s\S]+guided_setup_wizard.+--json/);
  assert.equal(run('expand-catalog', '--db', 'test.sqlite', '--pack', 'expanded_sealed').skusUpserted, 25);
  assert.equal(run('setup', '--db', 'test.sqlite', '--json').readiness.catalogSkuCount, 25);
  assert.equal(run('reconcile-sales', '--db', ':memory:', '--mock').adapterName, 'Simulated fulfillment');
});

test('HITL onboarding progresses from an empty database through a zero-order shadow pass and supports upgrading', t => {
  const { envPath } = workspace(t);
  withoutEnv(t, ...ALLOWED_ENV_KEYS);
  const runtime = createSystemRuntime({ dbPath: ':memory:', quiet: true, mode: 'shadow', envPath });
  const { db } = runtime;
  t.after(() => db.close());
  const guide = () => buildSetupGuide(runtime);
  const initial = guide();
  assert.equal(initial.setupProgressPct, 0);
  assert.equal(initial.workflow.profileSelected, false);
  assert.equal(initial.workflowState.targetProfile, 'live_closed_loop');
  assert.equal(initial.currentStep?.id, 'catalog');
  assert.deepEqual(initial.steps.map(step => step.id), SETUP_STEP_IDS);
  assert.deepEqual(initial.workflow.profiles.map(profile => profile.id), SETUP_PROFILES);
  initial.steps.forEach((step, index) => {
    assert.equal(step.order, index + 1);
    for (const text of [step.title, step.phase, step.summary, step.whyItMatters, step.completionCriteria]) assert.ok(text);
    for (const entries of [step.operatorActions, step.questionsForUser, step.agentActions, step.verificationChecks]) {
      assert.ok(entries.length > 0, step.id);
    }
    assert.deepEqual(step.userInstructions, step.operatorActions);
    assert.deepEqual(step.mcpTools, [...new Set(step.agentActions.map(action => action.tool))]);
    assert.deepEqual(step.externalLinks, step.resources.map(({ url }) => url));
    for (const { label, url } of step.resources) assert.ok(label && new URL(url).protocol === 'https:');
  });
  assert.ok(initial.readiness.blockingIssues.some(issue => issue.includes('Order API')));

  updateSetupWorkflow(db, { targetProfile: 'hitl_alerts' });
  const hitl = guide();
  assert.equal(hitl.readiness.targetProfile, 'hitl_alerts');
  assert.deepEqual(hitl.steps.slice(5, 7).map(step => step.status), ['skipped', 'skipped']);
  assert.equal(hitl.setupProgressPct, 25);
  assert.ok(!hitl.readiness.blockingIssues.some(issue => issue.includes('Order API')));
  assert.ok(hitl.readiness.warnings.some(issue => issue.includes('HITL alert profile active')));
  assert.ok(!hitl.readiness.recommendedNextActions.some(action => action.includes('EBAY_ORDER_API_TOKEN')));
  updateSetupWorkflow(db, { skipStep: 'ebay_checkout', reason: 'Awaiting partner approval' });
  updateSetupWorkflow(db, { skipStep: 'ebay_selling_and_fulfillment', reason: 'Operator handles selling' });

  seedCanonicalCatalog(db);
  updateProjectEnv({ BESTBUY_API_KEY: 'fixture-supply-key' }, { envPath });
  reloadSystemRuntime(runtime);
  assert.equal(guide().nextSetupStep, 'risk_and_tax');
  updateSetupWorkflow(db, { acknowledgeStep: 'risk_and_tax', note: ' Defaults approved and operator handles intake. ' });
  assert.equal(guide().steps[3].acknowledgement?.note, 'Defaults approved and operator handles intake.');
  updateSetupWorkflow(db, { skipStep: 'alerting_and_verification', reason: 'Local alerts and manual review' });
  assert.equal(guide().nextSetupStep, 'shadow_burn_in_and_go_live');
  assert.equal(guide().currentStep?.status, 'pending');
  for (const cycle of [
    { operatingMode: 'shadow', fetchedCount: 0, errorCount: 0 },
    { operatingMode: 'shadow', fetchedCount: 2, errorCount: 1 },
    { operatingMode: 'hitl', fetchedCount: 2, errorCount: 0 },
    { operatingMode: 'shadow', fetchedCount: '2', errorCount: 0 },
  ]) db.logAuditEvent('cycle.completed', cycle);
  assert.equal(db.hasCompletedShadowPass(), false);
  db.logAuditEvent('cycle.completed', { operatingMode: 'shadow', errorCount: 0, fetchedCount: 2 });
  assert.equal(db.listOrders('shadow_recorded').length, 0);
  assert.equal(db.hasCompletedShadowPass(), true);
  assert.equal(guide().currentStep?.status, 'pending');
  db.setOperatingMode('hitl');
  const complete = guide();
  assert.equal(complete.setupProgressPct, 100);
  assert.equal(complete.readiness.setupProgressPct, 100);
  assert.equal(complete.nextSetupStep, null);
  assert.equal(complete.currentStep, null);
  assert.equal(complete.workflow.readyForTargetProfile, true);
  assert.equal(complete.workflow.completedStepCount, 8);
  db.setKillSwitch(true, 'Paused for review');
  assert.equal(guide().currentStep?.status, 'blocked');
  db.setKillSwitch(false);

  const upgraded = updateSetupWorkflow(db, { targetProfile: 'live_closed_loop' });
  assert.deepEqual(Object.keys(upgraded.skippedSteps), ['alerting_and_verification']);
  const closedLoop = guide();
  assert.deepEqual(closedLoop.steps.slice(5, 7).map(step => step.status), ['pending', 'pending']);
  assert.equal(closedLoop.nextSetupStep, 'ebay_checkout');
  assert.ok(closedLoop.setupProgressPct < 100);
});

test('simulated launch requires a shadow pass and a ready mode for each profile', t => {
  const { envPath } = workspace(t);
  const runtime = createSystemRuntime({ dbPath: ':memory:', useMock: true, quiet: true, mode: 'shadow', envPath });
  const { db } = runtime;
  t.after(() => db.close());
  for (const targetProfile of SETUP_PROFILES) {
    updateSetupWorkflow(db, { targetProfile, skipStep: 'alerting_and_verification', reason: 'Manual by choice' });
    const guide = buildSetupGuide(runtime);
    assert.equal(guide.steps[4].status, 'complete');
    assert.equal(guide.workflow.readyForTargetProfile, false);
    assert.equal(guide.currentStep?.status, 'pending');
  }
  db.setOperatingMode('live');
  assert.equal(buildSetupGuide(runtime).currentStep?.status, 'pending');
  db.logAuditEvent('cycle.completed', { operatingMode: 'shadow', errorCount: 0, fetchedCount: 1 });
  for (const targetProfile of SETUP_PROFILES) {
    updateSetupWorkflow(db, { targetProfile });
    const guide = buildSetupGuide(runtime);
    assert.equal(guide.workflow.readyForTargetProfile, true);
    assert.equal(guide.setupProgressPct, 100);
  }
});

test('SQLite migrates, persists, and clears setup checkpoints without storing credentials', t => {
  const { cwd } = workspace(t);
  withoutEnv(t, 'PSA_API_TOKEN');
  const secret = 'workflow-persistence-fixture-secret';
  process.env.PSA_API_TOKEN = secret;
  const path = join(cwd, 'workflow.sqlite');
  new ArbitrageDatabase(path).close();
  const raw = new DatabaseSync(path);
  t.after(() => raw.close());
  raw.exec('DROP TABLE setup_workflow');
  const db = new ArbitrageDatabase(path);
  let saved;
  try {
    assert.equal(db.getSetupWorkflowState().profileSelected, false);
    saved = updateSetupWorkflow(db, {
      targetProfile: 'hitl_alerts', acknowledgeStep: 'risk_and_tax', note: 'Confirmed ' + secret,
      skipStep: 'alerting_and_verification', reason: 'Local only ' + secret,
    });
    assert.ok(!JSON.stringify(raw.prepare('SELECT * FROM setup_workflow').get()).includes(secret));
    assert.ok(!JSON.stringify(raw.prepare('SELECT payload FROM audit_events').all()).includes(secret));
  } finally {
    db.close();
  }
  const reopened = new ArbitrageDatabase(path);
  t.after(() => reopened.close());
  assert.deepEqual(reopened.getSetupWorkflowState(), saved);
  assert.throws(() => updateSetupWorkflow(reopened, {
    targetProfile: 'live_auto_buy', skipStep: 'ebay_checkout', reason: 'Still pending',
  }), /hitl_alerts/);
  assert.deepEqual(reopened.getSetupWorkflowState(), saved);
  const acknowledged = updateSetupWorkflow(reopened, { acknowledgeStep: 'alerting_and_verification', note: 'Mixed setup' });
  assert.equal(acknowledged.skippedSteps.alerting_and_verification, undefined);
  const cleared = updateSetupWorkflow(reopened, { clearStep: 'alerting_and_verification' });
  assert.equal(cleared.acknowledgedSteps.alerting_and_verification, undefined);
  const reset = updateSetupWorkflow(reopened, { reset: true });
  assert.equal(reset.targetProfile, 'live_closed_loop');
  assert.equal(reset.profileSelected, false);
  assert.deepEqual(reset.acknowledgedSteps, {});
  assert.deepEqual(reset.skippedSteps, {});
  assert.deepEqual(reopened.listAuditEvents(1)[0].payload, { reset: true, targetProfile: 'live_closed_loop' });
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
  const workflow = await call('setup-guide/workflow', {
    targetProfile: 'hitl_alerts', acknowledgeStep: 'risk_and_tax', note: 'Approved ' + key,
    skipStep: 'alerting_and_verification', reason: 'Manual checks ' + key,
  });
  assert.equal(workflow.status, 200);
  const workflowText = await workflow.text();
  assert.ok(!workflowText.includes(key));
  const checkpoint: SetupGuideReport = JSON.parse(workflowText);
  assert.equal(checkpoint.workflow.targetProfile, 'hitl_alerts');
  assert.equal(checkpoint.workflowState.acknowledgedSteps.risk_and_tax?.note, 'Approved [redacted]');
  assert.equal(checkpoint.workflowState.skippedSteps.alerting_and_verification?.reason, 'Manual checks [redacted]');
  assert.deepEqual((await (await call('setup-guide')).json()).workflowState, checkpoint.workflowState);
  for (const body of [
    {}, { targetProfile: 'bad' }, { targetProfile: 'hitl_alerts', extra: true }, { reset: 1 },
    { reset: true, targetProfile: 'hitl_alerts' }, { skipStep: 'catalog', reason: 'Required step' },
    { acknowledgeStep: 'market_data', note: 'Needs actual comps' }, { acknowledgeStep: 'risk_and_tax' },
    { skipStep: 'alerting_and_verification', reason: '   ' }, { reason: 'Without a skip' }, { clearStep: [] },
  ]) assert.equal((await call('setup-guide/workflow', body)).status, 400, JSON.stringify(body));
  assert.deepEqual(runtime.db.getSetupWorkflowState(), checkpoint.workflowState);
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
