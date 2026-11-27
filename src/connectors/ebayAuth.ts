import { fetchWithBackoff, HttpResponseError } from './base.ts';
import type { FetchLike } from './base.ts';

export interface EbayTokenProvider {
  isConfigured(): boolean;
  getAccessToken(): Promise<string>;
  invalidate(): void;
}

export interface EbayOAuthOptions {
  staticToken?: string;
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
  scopes?: string[];
  sandbox?: boolean;
  tokenUrl?: string;
  refreshBufferMs?: number;
  fetchFn?: FetchLike;
  nowFn?: () => number;
}

export class EbayOAuthTokenManager implements EbayTokenProvider {
  private readonly staticToken?: string;
  private readonly clientId?: string;
  private readonly clientSecret?: string;
  private readonly refreshToken?: string;
  private readonly scope?: string;
  private readonly tokenUrl: string;
  private readonly refreshBufferMs: number;
  private readonly fetchFn?: FetchLike;
  private readonly now: () => number;
  private accessToken?: string;
  private expiresAtMs = 0;
  private inFlightRefresh?: Promise<string>;

  constructor(options: EbayOAuthOptions = {}) {
    const disabled = options.staticToken === '' && !options.clientId && !options.clientSecret;
    this.staticToken = (options.staticToken ?? process.env.EBAY_ACCESS_TOKEN)?.trim();
    this.clientId = disabled ? undefined : (options.clientId ?? process.env.EBAY_CLIENT_ID)?.trim();
    this.clientSecret = disabled ? undefined : (options.clientSecret ?? process.env.EBAY_CLIENT_SECRET)?.trim();
    this.refreshToken = (options.refreshToken ?? process.env.EBAY_REFRESH_TOKEN)?.trim();
    this.scope = options.scopes?.join(' ').trim();
    const host = options.sandbox ? 'sandbox.ebay.com' : 'ebay.com';
    this.tokenUrl = options.tokenUrl ?? `https://api.${host}/identity/v1/oauth2/token`;
    this.refreshBufferMs = options.refreshBufferMs ?? 120_000;
    this.fetchFn = options.fetchFn;
    this.now = options.nowFn ?? Date.now;
  }

  isConfigured(): boolean {
    return Boolean(this.clientId && this.clientSecret || this.staticToken);
  }

  async getAccessToken(): Promise<string> {
    if (!this.clientId || !this.clientSecret) {
      if (!this.staticToken) throw new Error('eBay OAuth credentials are missing');
      return this.staticToken;
    }
    if (this.accessToken && this.now() + this.refreshBufferMs < this.expiresAtMs) return this.accessToken;
    this.inFlightRefresh ??= this.refresh(this.clientId, this.clientSecret).finally(() => {
      this.inFlightRefresh = undefined;
    });
    return this.inFlightRefresh;
  }

  invalidate(): void {
    this.accessToken = undefined;
    this.expiresAtMs = 0;
  }

  private async refresh(clientId: string, clientSecret: string): Promise<string> {
    const body = new URLSearchParams({ grant_type: this.refreshToken ? 'refresh_token' : 'client_credentials' });
    if (this.refreshToken) {
      body.set('refresh_token', this.refreshToken);
      if (this.scope) body.set('scope', this.scope);
    } else {
      body.set('scope', this.scope || 'https://api.ebay.com/oauth/api_scope');
    }
    const response = await fetchWithBackoff(this.tokenUrl, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body, redirect: 'error', signal: AbortSignal.timeout(15_000),
    }, { fetchFn: this.fetchFn });
    const data = await response.json() as { access_token?: unknown; expires_in?: unknown } | null;
    if (typeof data?.access_token !== 'string' || !data.access_token.trim() ||
        typeof data.expires_in !== 'number' || !Number.isSafeInteger(data.expires_in * 1000) || data.expires_in <= 0) {
      throw new Error('eBay OAuth returned an invalid token or expiry');
    }
    this.accessToken = data.access_token.trim();
    this.expiresAtMs = this.now() + data.expires_in * 1000;
    return this.accessToken;
  }
}

export async function withEbayToken(
  provider: EbayTokenProvider, request: (token: string) => Promise<Response>,
): Promise<Response> {
  const token = await provider.getAccessToken();
  try {
    return await request(token);
  } catch (error) {
    if (!(error instanceof HttpResponseError) || error.status !== 401) throw error;
  }
  provider.invalidate();
  return request(await provider.getAccessToken());
}
