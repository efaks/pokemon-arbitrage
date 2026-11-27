import { randomUUID } from 'node:crypto';
import { chmodSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { HttpResponseError } from '../connectors/base.ts';
import type { FetchLike } from '../connectors/base.ts';
import { EbayOAuthTokenManager, withEbayToken } from '../connectors/ebayAuth.ts';
import { evaluateReadiness } from '../engine/readiness.ts';
import type { ReadinessReport } from '../engine/readiness.ts';
import { applyEnvUpdate, encodedEnvMarker, envAssignment, envValueComment, readEnvFile } from '../env.ts';
import { discoverEbaySellerSetup, sellerSetupTokenProvider } from './ebayOnboarding.ts';
import { rememberSecret, SECRET_ENV_KEYS, secretMask, redactSecrets } from './secrets.ts';
import { setupSteps } from './setupSteps.ts';
import type { SetupStep } from './setupSteps.ts';

export { SECRET_ENV_KEYS };
export type { SetupStep };

export const ALLOWED_ENV_KEYS: ReadonlySet<string> = new Set([
  ...SECRET_ENV_KEYS, 'EBAY_CLIENT_ID', 'EBAY_RU_NAME',
  'EBAY_FULFILLMENT_POLICY_ID', 'EBAY_PAYMENT_POLICY_ID', 'EBAY_RETURN_POLICY_ID', 'EBAY_MERCHANT_LOCATION_KEY',
  'EBAY_SELL_SANDBOX', 'ARBITRAGE_AUTO_PUBLISH_LISTINGS', 'EBAY_INSIGHTS_ENABLED', 'EBAY_INSIGHTS_CATEGORY_IDS',
  'VISION_API_URL', 'VISION_MODEL', 'COSTCO_FEED_URL', 'COSTCO_WAREHOUSE_ID', 'POKEMON_CENTER_FEED_URL',
  'POKEMON_CENTER_REGION', 'LGS_SHOPIFY_DOMAINS', 'ARBITRAGE_MODE', 'ARBITRAGE_DB_PATH',
  'ARBITRAGE_DAILY_CAP_CENTS', 'ARBITRAGE_AUTO_BUY_MAX_ORDER_CENTS', 'ARBITRAGE_MAX_POSITION_PER_SKU',
  'ARBITRAGE_CASH_BALANCE_CENTS', 'ARBITRAGE_MIN_CASH_RESERVE_CENTS', 'ARBITRAGE_ALLOW_RAW_AUTO_BUY',
  'ARBITRAGE_MIN_PROFIT_CENTS', 'ARBITRAGE_MIN_NET_ROI', 'ARBITRAGE_MIN_LIQUIDITY_SCORE',
  'ARBITRAGE_MIN_MATCH_CONFIDENCE', 'ARBITRAGE_MAX_ANOMALY_DISCOUNT', 'ARBITRAGE_SALES_TAX_RATE',
  'ARBITRAGE_STALE_COMP_MAX_AGE_DAYS', 'ARBITRAGE_MIN_COMP_COUNT', 'ARBITRAGE_SELLER_MIN_FEEDBACK',
  'ARBITRAGE_SELLER_MIN_POSITIVE_PERCENT', 'ARBITRAGE_SELLER_MIN_ACCOUNT_AGE_DAYS',
  'ARBITRAGE_CIRCUIT_BREAKER_MAX_ERRORS_PER_WINDOW',
]);

export function maskEnvValue(key: string, value: string): string {
  return SECRET_ENV_KEYS.has(key) ? secretMask : redactSecrets(value);
}

export interface UpdateEnvResult {
  path: string;
  updatedKeys: string[];
  removedKeys: string[];
  maskedValues: Record<string, string>;
}

function envLine(key: string, value: string): string {
  if (/^[\w.,:/@%+?&=~/-]*$/.test(value)) return `${key}=${value}`;
  if (!value.includes("'")) return `${key}='${value}'`;
  if (!/[\\"$]/.test(value)) return `${key}="${value}"`;
  return `${key}=${JSON.stringify(value)} ${encodedEnvMarker}`;
}

export function updateProjectEnv(
  updates: Record<string, string | null>, options: { envPath?: string; applyToProcessEnv?: boolean } = {},
): UpdateEnvResult {
  const entries = Object.entries(updates);
  for (const [key, value] of entries) {
    if (SECRET_ENV_KEYS.has(key)) {
      rememberSecret(process.env[key]);
      if (typeof value === 'string') rememberSecret(value);
    }
  }
  for (const [key, value] of entries) {
    if (!ALLOWED_ENV_KEYS.has(key)) throw new Error(`Setting ${redactSecrets(key)} is disallowed`);
    if (value !== null && (typeof value !== 'string' || /[\r\n\0]/.test(value))) {
      throw new Error(`${key} must be a string without CR, LF, or NUL, or null to remove it`);
    }
  }
  const path = resolve(options.envPath ?? '.env');
  const contents = readEnvFile(path) ?? '';
  const separator = contents.includes('\r\n') ? '\r\n' : '\n';
  const lines = contents ? contents.replace(/\r?\n$/, '').split(/\r?\n/) : [];
  const pending = new Map(entries);
  const nextLines = lines.flatMap(line => {
    const assignment = envAssignment.exec(line);
    if (!assignment || !Object.hasOwn(updates, assignment[1])) return [line];
    const [, key, raw] = assignment;
    const comment = envValueComment(raw);
    const value = pending.get(key);
    pending.delete(key);
    if (value == null) return comment ? [comment] : [];
    return [envLine(key, value) + (comment ? ' ' + comment : '')];
  });
  for (const [key, value] of pending) if (value !== null) nextLines.push(envLine(key, value));
  const tempPath = join(dirname(path), `.env-${randomUUID()}.tmp`);
  try {
    writeFileSync(tempPath, nextLines.length ? nextLines.join(separator) + separator : '', { mode: 0o600, flag: 'wx' });
    chmodSync(tempPath, 0o600);
    renameSync(tempPath, path);
  } finally {
    rmSync(tempPath, { force: true });
  }
  if (options.applyToProcessEnv !== false) {
    for (const [key, value] of entries) applyEnvUpdate(key, value);
  }
  const updatedKeys = entries.filter(([, value]) => value !== null).map(([key]) => key);
  return {
    path: redactSecrets(path), updatedKeys, removedKeys: entries.filter(([, value]) => value === null).map(([key]) => key),
    maskedValues: Object.fromEntries(updatedKeys.map(key => [key, maskEnvValue(key, updates[key]!)])),
  };
}

export interface SetupGuideReport {
  envPath: string;
  readiness: ReadinessReport;
  steps: SetupStep[];
  setupProgressPct: number;
  nextSetupStep: string | null;
}

export function buildSetupGuide(
  runtime: Parameters<typeof evaluateReadiness>[0], options: { envPath?: string } = {},
): SetupGuideReport {
  const readiness = evaluateReadiness(runtime);
  return redactSecrets({
    envPath: resolve(options.envPath ?? runtime.envPath ?? '.env'), readiness,
    ...setupSteps(readiness, runtime.db.listOrders('shadow_recorded', 1).length > 0),
  });
}

export const providerConnectionTargets = [
  'ebay_oauth', 'ebay_browse', 'ebay_sell_policies', 'pokemon_tcg', 'pricecharting', 'bestbuy', 'costco',
  'pokemon_center', 'shopify', 'psa', 'vision', 'webhook',
] as const;
export type ProviderConnectionTarget = typeof providerConnectionTargets[number];

export interface ProviderConnectionResult {
  provider: ProviderConnectionTarget;
  configured: boolean;
  ok: boolean;
  status?: number;
  message: string;
}

const env = (key: string) => process.env[key]?.trim() || '';
function httpsEndpoint(value: string): URL {
  const url = URL.parse(value);
  if (!url || url.protocol !== 'https:' || url.username || url.password) throw new Error('Invalid HTTPS endpoint');
  return url;
}

export async function testProviderConnection(
  provider: ProviderConnectionTarget, { fetchFn = fetch }: { fetchFn?: FetchLike } = {},
): Promise<ProviderConnectionResult> {
  const result: ProviderConnectionResult = { provider, configured: true, ok: false, message: 'Connection failed' };
  const missing = () => ({ ...result, configured: false, message: 'Required provider settings are missing' });
  const success = () => ({ ...result, ok: true, message: 'Provider responded successfully' });
  const request = async (url: URL | string, headers?: HeadersInit, method = 'GET') => {
    const response = await fetchFn(url.toString(), { method, headers, redirect: 'error', signal: AbortSignal.timeout(15_000) });
    await response.body?.cancel();
    return response.status;
  };
  const bearer = (value: string) => value ? { Authorization: `Bearer ${value}` } : undefined;
  const sandbox = env('EBAY_SELL_SANDBOX') === 'true';
  const appToken = new EbayOAuthTokenManager({
    ...(provider === 'ebay_oauth' ? { staticToken: '' } : {}), refreshToken: '', sandbox, fetchFn,
  });
  try {
    switch (provider) {
      case 'ebay_oauth':
        if (!appToken.isConfigured()) return missing();
        await appToken.getAccessToken();
        return success();
      case 'ebay_browse': {
        if (!appToken.isConfigured()) return missing();
        const response = await withEbayToken(appToken, async token => {
          const status = await request(`https://api.${sandbox ? 'sandbox.' : ''}ebay.com/buy/browse/v1/item_summary/search?q=pokemon&limit=1`,
            { Authorization: `Bearer ${token}`, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US' });
          if (status >= 400) throw new HttpResponseError(status, 'eBay Browse rejected the request');
          return new Response(null, { status });
        });
        result.status = response.status;
        break;
      }
      case 'ebay_sell_policies': {
        const tokenProvider = sellerSetupTokenProvider(sandbox, fetchFn);
        if (!tokenProvider.isConfigured()) return missing();
        await discoverEbaySellerSetup({ tokenProvider, sandbox, fetchFn });
        return success();
      }
      case 'pokemon_tcg': {
        const key = env('POKEMON_TCG_API_KEY');
        result.status = await request('https://api.pokemontcg.io/v2/cards?pageSize=1', key ? { 'X-Api-Key': key } : undefined);
        break;
      }
      case 'pricecharting': {
        const token = env('PRICECHARTING_API_TOKEN');
        if (!token) return missing();
        const response = await fetchFn('https://www.pricecharting.com/api/products?' + new URLSearchParams({ t: token, q: 'pokemon charizard' }), {
          redirect: 'error', signal: AbortSignal.timeout(15_000),
        });
        result.status = response.status;
        if (response.ok && (await response.json() as { status?: string }).status === 'success') return { ...success(), status: response.status };
        await response.body?.cancel().catch(() => undefined);
        return { ...result, message: `PriceCharting did not confirm success (HTTP ${response.status})` };
      }
      case 'bestbuy': {
        const key = env('BESTBUY_API_KEY');
        if (!key) return missing();
        result.status = await request('https://api.bestbuy.com/v1/products?' + new URLSearchParams({ apiKey: key, format: 'json', pageSize: '1' }));
        break;
      }
      case 'costco':
      case 'pokemon_center': {
        const prefix = provider === 'costco' ? 'COSTCO' : 'POKEMON_CENTER';
        const endpoint = env(prefix + '_FEED_URL');
        if (!endpoint) return missing();
        const url = httpsEndpoint(endpoint);
        const headers = new Headers(bearer(env(prefix + '_API_KEY')));
        if (provider === 'costco') {
          const warehouse = env('COSTCO_WAREHOUSE_ID');
          if (warehouse) url.searchParams.set('warehouseId', warehouse);
        } else {
          headers.set('X-Pokemon-Center-Region', env('POKEMON_CENTER_REGION') || 'US');
        }
        result.status = await request(url, headers);
        break;
      }
      case 'shopify': {
        const domains = env('LGS_SHOPIFY_DOMAINS');
        if (!domains) return missing();
        for (const domain of domains.split(/[\s,]+/).filter(Boolean)) {
          const site = httpsEndpoint(domain.includes('://') ? domain : `https://${domain}`);
          result.status = await request(new URL('/products.json?limit=1', site));
          if (result.status < 200 || result.status >= 300) break;
        }
        break;
      }
      case 'psa': {
        const token = env('PSA_API_TOKEN');
        if (!token) return missing();
        result.status = await request('https://api.psacard.com/publicapi/cert/GetByCertNumber/1', bearer(token));
        break;
      }
      case 'vision': {
        const endpoint = env('VISION_API_URL');
        const key = env('VISION_API_KEY');
        if (!endpoint || !key) return missing();
        const url = httpsEndpoint(endpoint);
        url.pathname = (url.pathname.replace(/\/chat\/completions\/?$/, '').replace(/\/$/, '') || '/v1') + '/models';
        result.status = await request(url, bearer(key));
        break;
      }
      case 'webhook': {
        const endpoint = env('ARBITRAGE_WEBHOOK_URL');
        if (!endpoint) return missing();
        result.status = await request(httpsEndpoint(endpoint), undefined, 'HEAD');
        break;
      }
    }
    result.ok = result.status !== undefined && result.status >= 200 && result.status < 300;
    result.message = result.ok ? 'Provider responded successfully' : `Provider did not confirm the probe (HTTP ${result.status ?? 'unknown'})`;
  } catch (error) {
    const httpStatus = error instanceof HttpResponseError ? error.status : undefined;
    result.message = 'Connection failed. Check the provider configuration and access.';
    if (httpStatus !== undefined) result.status = httpStatus;
  }
  return result;
}
