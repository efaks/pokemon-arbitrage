import { toCents } from '../domain/money.ts';
import type { CanonicalSku, CardCondition, RawListing } from '../domain/types.ts';
import { fetchWithBackoff, TokenBucketRateLimiter } from './base.ts';
import type { FetchLike, SupplyConnector } from './base.ts';
import { EbayOAuthTokenManager, withEbayToken } from './ebayAuth.ts';
import type { EbayTokenProvider } from './ebayAuth.ts';

export interface EbayConnectorOptions {
  accessToken?: string;
  tokenProvider?: EbayTokenProvider;
  baseUrl?: string;
  marketplaceId?: string;
  limitPerQuery?: number;
  fetchFn?: FetchLike;
  rateLimiter?: TokenBucketRateLimiter;
}

interface EbayAmount {
  value?: string;
  currency?: string;
}

interface EbayItemSummary {
  itemId?: string;
  title?: string;
  itemWebUrl?: string;
  shortDescription?: string;
  price?: EbayAmount;
  shippingOptions?: { shippingCost?: EbayAmount }[];
  image?: { imageUrl?: string };
  additionalImages?: { imageUrl?: string }[];
  seller?: {
    username?: string;
    feedbackScore?: number;
    feedbackPercentage?: string;
  };
  condition?: string;
  gtin?: string;
  epid?: string;
  itemCreationDate?: string;
}

function amountCents(amount?: EbayAmount): number | undefined {
  if (!amount?.value?.trim() || amount.currency !== undefined && amount.currency !== 'USD') return undefined;
  const cents = toCents(Number(amount.value));
  return Number.isSafeInteger(cents) && cents >= 0 ? cents : undefined;
}

function conditionHint(condition?: string): CardCondition | undefined {
  switch (condition?.trim().toLowerCase()) {
    case 'near mint': return 'NM';
    case 'lightly played': return 'LP';
    case 'moderately played': return 'MP';
    case 'heavily played': return 'HP';
    case 'damaged': return 'DMG';
    default: return undefined;
  }
}

function mapItem(item: EbayItemSummary, fetchedAt: string): RawListing | undefined {
  const priceCents = amountCents(item.price);
  if (!item.itemId || !item.title || !item.itemWebUrl || priceCents === undefined || priceCents === 0) return undefined;
  const shippingCosts = (item.shippingOptions ?? []).flatMap(option => {
    const cents = amountCents(option.shippingCost);
    return cents === undefined ? [] : [cents];
  });
  const imageUrls = [item.image, ...(item.additionalImages ?? [])]
    .map(image => image?.imageUrl).filter((url): url is string => Boolean(url));
  const username = item.seller?.username ?? '';
  const feedback = Number(item.seller?.feedbackPercentage ?? 0);
  const createdAt = Date.parse(item.itemCreationDate ?? '');

  return {
    listingId: item.itemId, source: 'ebay', title: item.title, description: item.shortDescription ?? '',
    url: item.itemWebUrl, priceCents, shippingCents: shippingCosts.length ? Math.min(...shippingCosts) : 0,
    currency: 'USD', quantity: 1, upc: item.gtin, conditionHint: conditionHint(item.condition),
    imageUrls: [...new Set(imageUrls)],
    seller: {
      sellerId: username, username, feedbackScore: item.seller?.feedbackScore ?? 0,
      positivePercent: Number.isFinite(feedback) ? feedback : 0,
      accountAgeDays: 0, accountAgeUnknown: true, returnsAccepted: false,
    },
    supportsAutoCheckout: shippingCosts.length > 0,
    listedAt: Number.isFinite(createdAt) ? new Date(createdAt).toISOString() : fetchedAt,
    fetchedAt,
    metadata: { condition: item.condition, epid: item.epid, shippingCostKnown: shippingCosts.length > 0 },
  };
}

export class EbayBrowseConnector implements SupplyConnector {
  readonly name = 'eBay Browse';
  readonly source = 'ebay';
  readonly supportsAutoCheckout = true;
  readonly pollIntervalMs = 60_000;
  private readonly tokenProvider: EbayTokenProvider;
  private readonly baseUrl: string;
  private readonly marketplaceId: string;
  private readonly limitPerQuery: number;
  private readonly fetchFn?: FetchLike;
  private readonly rateLimiter: TokenBucketRateLimiter;

  constructor(options: EbayConnectorOptions = {}) {
    this.baseUrl = (options.baseUrl ?? 'https://api.ebay.com').replace(/\/+$/, '');
    this.marketplaceId = options.marketplaceId ?? 'EBAY_US';
    this.limitPerQuery = options.limitPerQuery ?? 25;
    this.fetchFn = options.fetchFn;
    this.rateLimiter = options.rateLimiter ?? new TokenBucketRateLimiter({ capacity: 2, refillPerSecond: 2 });
    this.tokenProvider = options.tokenProvider ?? new EbayOAuthTokenManager({
      staticToken: options.accessToken ?? process.env.EBAY_ACCESS_TOKEN,
      clientId: options.accessToken === '' ? '' : process.env.EBAY_CLIENT_ID,
      clientSecret: options.accessToken === '' ? '' : process.env.EBAY_CLIENT_SECRET,
      refreshToken: '',
      sandbox: new URL(this.baseUrl).hostname.endsWith('.sandbox.ebay.com'),
      fetchFn: this.fetchFn,
    });
  }

  isEnabled(): boolean {
    return this.tokenProvider.isConfigured();
  }

  async fetchListings(skus: CanonicalSku[]): Promise<RawListing[]> {
    if (!this.isEnabled()) return [];
    const queries = new Set(skus.map(sku =>
      sku.cardNumber && !sku.name.includes(sku.cardNumber) ? `${sku.name} ${sku.cardNumber}` : sku.name,
    ));
    const listings = new Map<string, RawListing>();
    const fetchedAt = new Date().toISOString();
    for (const query of queries) {
      const url = new URL(`${this.baseUrl}/buy/browse/v1/item_summary/search`);
      url.search = new URLSearchParams({
        q: query, filter: 'buyingOptions:{FIXED_PRICE}', sort: 'newlyListed', limit: String(this.limitPerQuery),
      }).toString();
      const response = await withEbayToken(this.tokenProvider, token => fetchWithBackoff(url.href, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          'X-EBAY-C-MARKETPLACE-ID': this.marketplaceId,
        },
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
      }, { fetchFn: this.fetchFn, rateLimiter: this.rateLimiter }));

      const { itemSummaries } = await response.json() as { itemSummaries?: EbayItemSummary[] };
      for (const item of itemSummaries ?? []) {
        const listing = mapItem(item, fetchedAt);
        if (listing && !listings.has(listing.listingId)) listings.set(listing.listingId, listing);
      }
    }
    return [...listings.values()];
  }
}
