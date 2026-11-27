import { randomUUID } from 'node:crypto';
import { fetchWithBackoff, HttpResponseError } from '../connectors/base.ts';
import type { FetchLike } from '../connectors/base.ts';
import { EbayOAuthTokenManager, withEbayToken } from '../connectors/ebayAuth.ts';
import type { EbayTokenProvider } from '../connectors/ebayAuth.ts';

const scopeBase = 'https://api.ebay.com/oauth/api_scope';
const apiRoot = (sandbox?: boolean) => `https://api.${sandbox ? 'sandbox.' : ''}ebay.com`;

export interface EbayConsentUrlOptions {
  clientId: string;
  ruName: string;
  sandbox?: boolean;
  includeBuyOrder?: boolean;
  includeSell?: boolean;
  state?: string;
}

export function buildEbayConsentUrl({
  clientId, ruName, sandbox = false, includeBuyOrder, includeSell = true, state = randomUUID(),
}: EbayConsentUrlOptions) {
  if (!clientId.trim() || !ruName.trim()) throw new Error('EBAY_CLIENT_ID and EBAY_RU_NAME are required for eBay consent');
  const scopes = [scopeBase];
  if (includeSell) scopes.push(...['sell.inventory', 'sell.fulfillment.readonly', 'sell.account.readonly'].map(scope => `${scopeBase}/${scope}`));
  if (includeBuyOrder) scopes.push(`${scopeBase}/buy.order`);
  const url = new URL(`https://auth.${sandbox ? 'sandbox.' : ''}ebay.com/oauth2/authorize`);
  url.search = new URLSearchParams({
    client_id: clientId.trim(), redirect_uri: ruName.trim(), response_type: 'code', scope: scopes.join(' '), state,
  }).toString();
  return { url: url.href, scopes, sandbox, state };
}

export interface EbayAuthCodeExchangeResult {
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
  refreshTokenExpiresInSeconds: number;
}

function normalizeCode(input: string): string {
  const code = input.trim();
  if (/^https?:\/\//i.test(code)) return URL.parse(code)?.searchParams.get('code') ?? '';
  if (!code.includes('%')) return code;
  try { return decodeURIComponent(code); } catch { return code; }
}

function requestError(operation: string, error: unknown): Error {
  const status = error instanceof HttpResponseError ? ` (HTTP ${error.status})` : '';
  return new Error(`eBay ${operation} failed${status}`);
}

export async function exchangeEbayAuthorizationCode(options: {
  clientId: string; clientSecret: string; ruName: string; code: string; sandbox?: boolean; fetchFn?: FetchLike;
}): Promise<EbayAuthCodeExchangeResult> {
  const { sandbox, fetchFn } = options;
  const clientId = options.clientId.trim();
  const clientSecret = options.clientSecret.trim();
  const ruName = options.ruName.trim();
  const code = normalizeCode(options.code);
  if (!clientId || !clientSecret || !ruName || !code.trim()) {
    throw new Error('eBay code exchange requires client credentials, the RuName, and an authorization code');
  }
  try {
    const response = await fetchWithBackoff(`${apiRoot(sandbox)}/identity/v1/oauth2/token`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: ruName }),
    }, { fetchFn, maxRetries: 0 });
    const { access_token, refresh_token, expires_in, refresh_token_expires_in } = await response.json() as {
      access_token?: string; refresh_token?: string; expires_in?: number; refresh_token_expires_in?: number;
    };
    if (typeof access_token !== 'string' || !access_token.trim() ||
        typeof refresh_token !== 'string' || !refresh_token.trim() ||
        typeof expires_in !== 'number' || !Number.isSafeInteger(expires_in) || expires_in <= 0 ||
        typeof refresh_token_expires_in !== 'number' || !Number.isSafeInteger(refresh_token_expires_in) || refresh_token_expires_in <= 0) {
      throw new Error('Invalid eBay token response');
    }
    return { accessToken: access_token, refreshToken: refresh_token, expiresInSeconds: expires_in, refreshTokenExpiresInSeconds: refresh_token_expires_in };
  } catch (error) {
    throw requestError('authorization code exchange', error);
  }
}

interface SellerRequestOptions {
  tokenProvider: EbayTokenProvider;
  sandbox?: boolean;
  fetchFn?: FetchLike;
}

function sellerRequest(options: SellerRequestOptions, path: string, body?: object): Promise<Response> {
  return withEbayToken(options.tokenProvider, token => fetchWithBackoff(`${apiRoot(options.sandbox)}${path}`, {
    method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(15_000),
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json', 'Content-Language': 'en-US' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }, { fetchFn: options.fetchFn, ...(body ? { maxRetries: 0 } : {}) }));
}

type EbayPolicy = { name?: string; [key: string]: unknown };
type EbayLocation = EbayPolicy & { merchantLocationKey?: string; merchantLocationStatus?: string; status?: string };

export interface EbaySellerSetupDiscovery {
  fulfillmentPolicies: EbayPolicy[];
  paymentPolicies: EbayPolicy[];
  returnPolicies: EbayPolicy[];
  locations: EbayLocation[];
  fulfillmentPolicyId?: string;
  paymentPolicyId?: string;
  returnPolicyId?: string;
  merchantLocationKey?: string;
}

function validId(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export async function discoverEbaySellerSetup(
  options: SellerRequestOptions & { marketplaceId?: string },
): Promise<EbaySellerSetupDiscovery> {
  try {
    const query = new URLSearchParams({ marketplace_id: options.marketplaceId ?? 'EBAY_US' });
    const get = async (path: string) => (await sellerRequest(options, path)).json();
    const [fulfillment, payment, returns, firstPage] = await Promise.all([
      get(`/sell/account/v1/fulfillment_policy?${query}`), get(`/sell/account/v1/payment_policy?${query}`),
      get(`/sell/account/v1/return_policy?${query}`), get('/sell/inventory/v1/location'),
    ]);
    const fulfillmentPolicies: EbayPolicy[] = fulfillment.fulfillmentPolicies ?? [];
    const paymentPolicies: EbayPolicy[] = payment.paymentPolicies ?? [];
    const returnPolicies: EbayPolicy[] = returns.returnPolicies ?? [];
    const locations: EbayLocation[] = [...(firstPage.locations ?? [])];
    let page = firstPage;
    let offset = 0;
    const seenPages = new Set<string>();
    while (typeof page.next === 'string' && page.next && page.locations?.length > 0) {
      if (seenPages.has(page.next)) throw new Error('eBay returned a repeated inventory location page');
      seenPages.add(page.next);
      offset += page.locations.length;
      page = await get(`/sell/inventory/v1/location?offset=${offset}`);
      locations.push(...(page.locations ?? []));
    }
    const enabled = locations.find(location =>
      validId(location.merchantLocationKey) && (location.merchantLocationStatus ?? location.status) === 'ENABLED');
    return {
      fulfillmentPolicies, paymentPolicies, returnPolicies, locations,
      fulfillmentPolicyId: fulfillmentPolicies.map(policy => validId(policy.fulfillmentPolicyId)).find(Boolean),
      paymentPolicyId: paymentPolicies.map(policy => validId(policy.paymentPolicyId)).find(Boolean),
      returnPolicyId: returnPolicies.map(policy => validId(policy.returnPolicyId)).find(Boolean),
      merchantLocationKey: validId(enabled?.merchantLocationKey) ?? locations.map(location => validId(location.merchantLocationKey)).find(Boolean),
    };
  } catch (error) {
    throw requestError('seller policy and location discovery', error);
  }
}

export async function createDefaultMerchantLocation(options: SellerRequestOptions & {
  locationKey: string;
  name?: string;
  address: { addressLine1?: string; city: string; stateOrProvince: string; postalCode: string; country: string };
}): Promise<{ created: true; locationKey: string }> {
  const locationKey = options.locationKey.trim();
  if (!locationKey || locationKey.length > 50 || locationKey === '.' || locationKey === '..') {
    throw new Error('Merchant location key must contain 1 to 50 characters and cannot be a dot segment');
  }
  try {
    const response = await sellerRequest(options, `/sell/inventory/v1/location/${encodeURIComponent(locationKey)}`, {
      name: options.name?.trim() || 'Default warehouse',
      location: { address: options.address },
      locationTypes: ['WAREHOUSE'],
      merchantLocationStatus: 'ENABLED',
    });
    await response.body?.cancel();
    return { created: true, locationKey };
  } catch (error) {
    throw requestError('merchant location creation', error);
  }
}

export function sellerSetupTokenProvider(sandbox: boolean, fetchFn?: FetchLike): EbayTokenProvider {
  const clientId = process.env.EBAY_CLIENT_ID?.trim();
  const clientSecret = process.env.EBAY_CLIENT_SECRET?.trim();
  const refreshToken = process.env.EBAY_SELL_REFRESH_TOKEN?.trim() || process.env.EBAY_REFRESH_TOKEN?.trim();
  const useOAuth = Boolean(clientId && clientSecret && refreshToken);
  return new EbayOAuthTokenManager({
    clientId: useOAuth ? clientId : '', clientSecret: useOAuth ? clientSecret : '', refreshToken,
    staticToken: process.env.EBAY_SELL_API_TOKEN ?? '', sandbox, fetchFn,
  });
}
