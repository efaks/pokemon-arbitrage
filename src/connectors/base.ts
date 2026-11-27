import type { CanonicalSku, RawListing, SourceName } from '../domain/types.ts';

export interface SupplyConnector {
  readonly name: string;
  readonly source: SourceName;
  readonly supportsAutoCheckout: boolean;
  readonly pollIntervalMs: number;
  isEnabled(): boolean;
  fetchListings(skus: CanonicalSku[]): Promise<RawListing[]>;
}

export type FetchLike = typeof fetch;

type Sleep = (ms: number) => Promise<void>;
const sleep: Sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const MAX_BACKOFF_MS = 30_000;

export class TokenBucketRateLimiter {
  private readonly capacity: number;
  private readonly refillPerSecond: number;
  private readonly now: () => number;
  private readonly sleep: Sleep;
  private available: number;
  private refilledAt: number;

  constructor(options: {
    capacity: number;
    refillPerSecond: number;
    nowFn?: () => number;
    sleepFn?: Sleep;
  }) {
    if (!Number.isFinite(options.capacity) || options.capacity <= 0 ||
        !Number.isFinite(options.refillPerSecond) || options.refillPerSecond <= 0) {
      throw new RangeError('Token bucket capacity and refill rate must be positive and finite');
    }
    this.capacity = options.capacity;
    this.refillPerSecond = options.refillPerSecond;
    this.now = options.nowFn ?? (() => performance.now());
    this.sleep = options.sleepFn ?? sleep;
    this.available = this.capacity;
    this.refilledAt = this.now();
  }

  async acquire(tokens = 1): Promise<void> {
    if (!Number.isFinite(tokens) || tokens <= 0 || tokens > this.capacity) {
      throw new RangeError('Requested tokens must be positive and within the bucket capacity');
    }

    for (;;) {
      const now = Math.max(this.refilledAt, this.now());
      const elapsedSeconds = (now - this.refilledAt) / 1000;
      this.available = Math.min(this.capacity, this.available + elapsedSeconds * this.refillPerSecond);
      this.refilledAt = now;
      if (this.available >= tokens) {
        this.available -= tokens;
        return;
      }
      await this.sleep(Math.ceil((tokens - this.available) / this.refillPerSecond * 1000));
    }
  }
}

function retryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  if (/^\d+$/.test(value)) {
    const ms = Number(value) * 1000;
    return Number.isSafeInteger(ms) ? ms : undefined;
  }
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

export class HttpResponseError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function fetchWithBackoff(
  url: string,
  init: RequestInit,
  options: {
    maxRetries?: number;
    baseDelayMs?: number;
    rateLimiter?: TokenBucketRateLimiter;
    fetchFn?: FetchLike;
    sleepFn?: Sleep;
  } = {},
): Promise<Response> {
  const { maxRetries = 3, baseDelayMs = 500, rateLimiter, fetchFn = fetch, sleepFn = sleep } = options;
  if (!Number.isSafeInteger(maxRetries) || maxRetries < 0 ||
      !Number.isFinite(baseDelayMs) || baseDelayMs < 0) {
    throw new RangeError('Retry count and backoff delay must be nonnegative');
  }

  for (let attempt = 0; ; attempt++) {
    await rateLimiter?.acquire();
    const response = await fetchFn(url, init);
    if (response.ok) return response;

    const retryable = response.status === 429 || response.status >= 500 && response.status < 600;
    const retryAfter = response.status === 429 ? retryAfterMs(response.headers.get('Retry-After')) : undefined;
    await response.body?.cancel().catch(() => undefined);
    if (!retryable || attempt >= maxRetries) {
      const origin = new URL(url).origin;
      throw new HttpResponseError(response.status,
        `${init.method ?? 'GET'} ${origin} returned HTTP ${response.status} after ${attempt + 1} attempt(s)`);
    }

    const backoff = Math.min(MAX_BACKOFF_MS, baseDelayMs * 2 ** Math.min(attempt, 52));
    await sleepFn(retryAfter ?? Math.ceil(backoff * (0.5 + Math.random() * 0.5)));
  }
}
