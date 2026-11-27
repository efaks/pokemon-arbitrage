import { toCents } from '../domain/money.ts';
import type { CanonicalSku, RawListing, SellerProfile } from '../domain/types.ts';
import { fetchWithBackoff, TokenBucketRateLimiter } from './base.ts';
import type { FetchLike, SupplyConnector } from './base.ts';

interface RequestOptions {
  fetchFn?: FetchLike;
  rateLimiter?: TokenBucketRateLimiter;
}

function seller(name: string): SellerProfile {
  return {
    sellerId: name, username: name, feedbackScore: 0, positivePercent: 0,
    accountAgeDays: 0, returnsAccepted: false,
  };
}

function firstPartyRetailerSeller(sellerId: string, username: string): SellerProfile {
  return {
    sellerId, username, feedbackScore: 10_000, positivePercent: 99.9,
    accountAgeDays: 3650, returnsAccepted: true,
  };
}

function httpsUrl(value: unknown): URL | null {
  if (typeof value !== 'string' || !/^https:\/\//i.test(value.trim())) return null;
  const url = URL.parse(value.trim());
  return url?.protocol === 'https:' && !url.username && !url.password ? url : null;
}

function configuredFeedUrl(value: string | undefined, variable: string): string | undefined {
  if (!value?.trim()) return undefined;
  const url = httpsUrl(value);
  if (!url) throw new Error(`${variable} must be an HTTPS URL without embedded credentials`);
  return url.href;
}

function priceCents(value: number | string | null | undefined): number | undefined {
  if (value == null || typeof value === 'string' && !value.trim()) return undefined;
  const cents = toCents(Number(value));
  return Number.isSafeInteger(cents) && cents > 0 ? cents : undefined;
}

interface BestBuyProduct {
  sku?: number;
  upc?: string;
  name?: string;
  url?: string;
  salePrice?: number;
  regularPrice?: number;
  onlineAvailability?: boolean;
  image?: string;
  shortDescription?: string;
}

export class BestBuyApiConnector implements SupplyConnector {
  readonly name = 'Best Buy Products';
  readonly source = 'bestbuy';
  readonly supportsAutoCheckout = false;
  readonly pollIntervalMs = 60_000;
  private readonly apiKey?: string;
  private readonly request: RequestOptions;

  constructor(options: RequestOptions & { apiKey?: string } = {}) {
    this.apiKey = (options.apiKey ?? process.env.BESTBUY_API_KEY)?.trim();
    this.request = {
      fetchFn: options.fetchFn,
      rateLimiter: options.rateLimiter ?? new TokenBucketRateLimiter({ capacity: 1, refillPerSecond: 2 }),
    };
  }

  isEnabled(): boolean {
    return Boolean(this.apiKey);
  }

  async fetchListings(skus: CanonicalSku[]): Promise<RawListing[]> {
    if (!this.apiKey) return [];
    const upcs = [...new Set(skus.flatMap(sku =>
      sku.assetClass === 'sealed' && sku.upc && /^\d+$/.test(sku.upc) ? [sku.upc] : [],
    ))];
    const now = new Date().toISOString();
    const listings: RawListing[] = [];
    const batchSize = 100;
    for (let offset = 0; offset < upcs.length; offset += batchSize) {
      const batch = upcs.slice(offset, offset + batchSize);
      const url = new URL(`https://api.bestbuy.com/v1/products(upc in(${batch.join(',')}))`);
      url.search = new URLSearchParams({
        format: 'json', apiKey: this.apiKey, pageSize: String(batchSize),
        show: 'sku,upc,name,url,salePrice,regularPrice,onlineAvailability,image,shortDescription',
      }).toString();
      const response = await fetchWithBackoff(url.href, { redirect: 'error' }, this.request);
      const { products } = await response.json() as { products?: BestBuyProduct[] };
      for (const product of products ?? []) {
        const cents = priceCents(product.salePrice) ?? priceCents(product.regularPrice);
        if (product.onlineAvailability !== true || !product.sku || !product.name || !product.url || !cents ||
            !product.upc || !batch.includes(product.upc)) continue;
        listings.push({
          listingId: String(product.sku), source: this.source, title: product.name,
          description: product.shortDescription ?? '', url: product.url, upc: product.upc,
          priceCents: cents, shippingCents: 0, currency: 'USD', quantity: 1,
          conditionHint: 'SEALED', imageUrls: product.image ? [product.image] : [],
          seller: firstPartyRetailerSeller('Best Buy', 'Best Buy'),
          supportsAutoCheckout: false, listedAt: now, fetchedAt: now,
        });
      }
    }
    return listings;
  }
}

interface RetailerFeedOptions extends RequestOptions {
  feedUrl?: string;
  apiKey?: string;
}

interface RetailerFeedItem {
  title?: string;
  description?: string;
  url?: string;
  upc?: string;
  priceCents?: number;
  shippingCents?: number;
  imageUrl?: string;
}

interface CostcoItem extends RetailerFeedItem {
  itemNumber?: string | number;
  brand?: string;
  category?: string;
  price?: number | string;
  inStock?: boolean;
  onlineAvailable?: boolean;
  warehouseId?: string | number;
  limitPerMember?: number;
}

export class CostcoConnector implements SupplyConnector {
  readonly name = 'Costco Wholesale';
  readonly source = 'costco';
  readonly supportsAutoCheckout = false;
  readonly pollIntervalMs = 60_000;
  private readonly feedUrl?: string;
  private readonly apiKey?: string;
  private readonly warehouseId?: string;
  private readonly request: RequestOptions;

  constructor(options: RetailerFeedOptions & { warehouseId?: string } = {}) {
    this.feedUrl = configuredFeedUrl(options.feedUrl ?? process.env.COSTCO_FEED_URL, 'COSTCO_FEED_URL');
    this.apiKey = (options.apiKey ?? process.env.COSTCO_API_KEY)?.trim();
    this.warehouseId = (options.warehouseId ?? process.env.COSTCO_WAREHOUSE_ID)?.trim();
    this.request = {
      fetchFn: options.fetchFn,
      rateLimiter: options.rateLimiter ?? new TokenBucketRateLimiter({ capacity: 1, refillPerSecond: 2 }),
    };
  }

  isEnabled(): boolean {
    return Boolean(this.feedUrl);
  }

  async fetchListings(skus: CanonicalSku[]): Promise<RawListing[]> {
    if (!this.feedUrl) return [];
    const feedUrl = new URL(this.feedUrl);
    if (this.warehouseId) feedUrl.searchParams.set('warehouseId', this.warehouseId);
    const headers = new Headers({ Accept: 'application/json' });
    if (this.apiKey) headers.set('Authorization', `Bearer ${this.apiKey}`);
    const response = await fetchWithBackoff(feedUrl.href, { headers, redirect: 'error' }, this.request);
    const { items, products } = await response.json() as { items?: CostcoItem[]; products?: CostcoItem[] };
    const upcs = new Set(skus.map(sku => sku.upc).filter(Boolean));
    const now = new Date().toISOString();
    const listings: RawListing[] = [];
    for (const item of items ?? products ?? []) {
      if (!item || item.inStock === false || item.onlineAvailable === false) continue;
      const { itemNumber, title, upc } = item;
      const url = httpsUrl(item.url);
      const cents = item.priceCents ?? priceCents(item.price);
      const shippingCents = item.shippingCents ?? 0;
      if (!itemNumber || !title?.trim() || !url || cents === undefined || !Number.isSafeInteger(cents) || cents <= 0
        || !Number.isSafeInteger(shippingCents) || shippingCents < 0) continue;
      if (!upcs.has(upc) && !/\bpok[eé]mon\b/i.test([title, item.brand, item.category].join(' '))) continue;
      listings.push({
        listingId: String(itemNumber), source: this.source, title, description: item.description ?? '',
        url: url.href, upc, priceCents: cents, shippingCents, currency: 'USD', quantity: 1,
        conditionHint: 'SEALED', imageUrls: item.imageUrl ? [item.imageUrl] : [],
        seller: firstPartyRetailerSeller('costco-wholesale', this.name),
        supportsAutoCheckout: false, listedAt: now, fetchedAt: now,
        metadata: {
          itemNumber, warehouseId: item.warehouseId ?? this.warehouseId,
          limitPerMember: item.limitPerMember, membershipRequired: true,
        },
      });
    }
    return listings;
  }
}

interface PokemonCenterProduct extends RetailerFeedItem {
  productSku?: string;
  sku?: string;
  available?: boolean;
  availability?: string;
  exclusive?: boolean;
  purchaseLimit?: number;
}

export class PokemonCenterConnector implements SupplyConnector {
  readonly name = 'Pokémon Center';
  readonly source = 'pokemon_center';
  readonly supportsAutoCheckout = false;
  readonly pollIntervalMs = 45_000;
  private readonly feedUrl?: string;
  private readonly apiKey?: string;
  private readonly region: string;
  private readonly request: RequestOptions;

  constructor(options: RetailerFeedOptions & { region?: string } = {}) {
    this.feedUrl = configuredFeedUrl(options.feedUrl ?? process.env.POKEMON_CENTER_FEED_URL, 'POKEMON_CENTER_FEED_URL');
    this.apiKey = (options.apiKey ?? process.env.POKEMON_CENTER_API_KEY)?.trim();
    this.region = (options.region ?? process.env.POKEMON_CENTER_REGION)?.trim() || 'US';
    this.request = {
      fetchFn: options.fetchFn,
      rateLimiter: options.rateLimiter ?? new TokenBucketRateLimiter({ capacity: 1, refillPerSecond: 2 }),
    };
  }

  isEnabled(): boolean {
    return Boolean(this.feedUrl);
  }

  async fetchListings(_skus: CanonicalSku[]): Promise<RawListing[]> {
    if (!this.feedUrl) return [];
    const headers = new Headers({ Accept: 'application/json', 'X-Pokemon-Center-Region': this.region });
    if (this.apiKey) headers.set('Authorization', `Bearer ${this.apiKey}`);
    const response = await fetchWithBackoff(this.feedUrl, { headers, redirect: 'error' }, this.request);
    const { products, items } = await response.json() as { products?: PokemonCenterProduct[]; items?: PokemonCenterProduct[] };
    const now = new Date().toISOString();
    const listings: RawListing[] = [];
    for (const product of products ?? items ?? []) {
      if (!product) continue;
      const { available, availability, title, priceCents: cents, upc } = product;
      if (available === false || availability === 'out_of_stock' || availability === 'sold_out') continue;
      if (available !== true && availability !== 'in_stock' && availability !== 'preorder') continue;
      const productSku = product.productSku ?? product.sku;
      const url = httpsUrl(product.url);
      const shippingCents = product.shippingCents ?? 0;
      if (!productSku || !title?.trim() || !url || cents === undefined || !Number.isSafeInteger(cents) || cents <= 0
        || !Number.isSafeInteger(shippingCents) || shippingCents < 0) continue;
      listings.push({
        listingId: productSku, source: this.source, title, description: product.description ?? '',
        url: url.href, upc, priceCents: cents, shippingCents, currency: 'USD', quantity: 1,
        conditionHint: 'SEALED', imageUrls: product.imageUrl ? [product.imageUrl] : [],
        seller: firstPartyRetailerSeller('pokemon-center', this.name),
        supportsAutoCheckout: false, listedAt: now, fetchedAt: now,
        metadata: { productSku, exclusive: product.exclusive, availability, purchaseLimit: product.purchaseLimit, region: this.region },
      });
    }
    return listings;
  }
}

interface ShopifyProduct {
  title?: string;
  handle?: string;
  body_html?: string;
  product_type?: string;
  tags?: string[] | string;
  created_at?: string;
  images?: { src?: string }[];
  variants?: {
    id: number;
    title?: string;
    price?: string;
    available?: boolean;
    barcode?: string;
  }[];
}

function storefrontOrigin(domain: string): string {
  const url = new URL(domain.includes('://') ? domain : `https://${domain}`);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Shopify storefront must be configured as an HTTPS domain');
  }
  return url.origin;
}

/** Configure only authorized storefronts with USD product prices. */
export class ShopifyStorefrontConnector implements SupplyConnector {
  readonly name = 'Local Game Store Shopify';
  readonly source = 'lgs_shopify';
  readonly supportsAutoCheckout = false;
  readonly pollIntervalMs = 120_000;
  private readonly storefronts: string[];
  private readonly request: RequestOptions;

  constructor(options: RequestOptions & { storeDomain?: string } = {}) {
    const domains = (options.storeDomain ?? process.env.LGS_SHOPIFY_DOMAINS ?? '').split(/[\s,]+/).filter(Boolean);
    this.storefronts = [...new Set(domains.map(storefrontOrigin))];
    this.request = {
      fetchFn: options.fetchFn,
      rateLimiter: options.rateLimiter ?? new TokenBucketRateLimiter({ capacity: 2, refillPerSecond: 2 }),
    };
  }

  isEnabled(): boolean {
    return this.storefronts.length > 0;
  }

  async fetchListings(skus: CanonicalSku[]): Promise<RawListing[]> {
    const upcs = new Set(skus.flatMap(sku => sku.upc ? [sku.upc] : []));
    const now = new Date().toISOString();
    const listings: RawListing[] = [];
    for (const origin of this.storefronts) {
      const response = await fetchWithBackoff(`${origin}/products.json?limit=250`, { redirect: 'error' }, this.request);
      const { products } = await response.json() as { products?: ShopifyProduct[] };
      const hostname = new URL(origin).hostname;
      for (const product of products ?? []) {
        if (!product.title || !product.handle) continue;
        const productText = [product.title, product.product_type, product.tags].join(' ');
        const pokemonProduct = /\bpok[eé]mon\b/i.test(productText);
        for (const variant of product.variants ?? []) {
          const cents = priceCents(variant.price);
          const pokemonVariant = variant.barcode && upcs.has(variant.barcode) ||
            /\bpok[eé]mon\b/i.test(variant.title ?? '');
          if (variant.available !== true || !cents || !variant.id || !(pokemonProduct || pokemonVariant)) continue;
          const variantTitle = variant.title && variant.title !== 'Default Title' ? ` - ${variant.title}` : '';
          const createdAt = Date.parse(product.created_at ?? '');
          listings.push({
            listingId: `${hostname}:${variant.id}`, source: this.source,
            title: product.title + variantTitle, description: product.body_html ?? '',
            url: `${origin}/products/${encodeURIComponent(product.handle)}?variant=${variant.id}`,
            priceCents: cents, shippingCents: 0, currency: 'USD', quantity: 1,
            upc: variant.barcode || undefined,
            imageUrls: (product.images ?? []).flatMap(image => image.src ? [image.src] : []),
            seller: firstPartyRetailerSeller('shopify:' + hostname, hostname),
            supportsAutoCheckout: false, fetchedAt: now,
            listedAt: Number.isFinite(createdAt) ? new Date(createdAt).toISOString() : now,
          });
        }
      }
    }
    return listings;
  }
}

interface TcgplayerProduct {
  productId: number;
  name?: string;
  url?: string;
  imageUrl?: string;
}

interface TcgplayerPrice {
  productId: number;
  lowPrice?: number;
  subTypeName?: string;
}

export class TcgplayerFeedConnector implements SupplyConnector {
  readonly name = 'TCGplayer Catalog and Pricing';
  readonly source = 'tcgplayer';
  readonly supportsAutoCheckout = false;
  readonly pollIntervalMs = 300_000;
  private readonly token?: string;
  private readonly request: RequestOptions;

  constructor(options: RequestOptions & { accessToken?: string } = {}) {
    this.token = (options.accessToken ?? process.env.TCGPLAYER_API_TOKEN)?.trim();
    this.request = {
      fetchFn: options.fetchFn,
      rateLimiter: options.rateLimiter ?? new TokenBucketRateLimiter({ capacity: 2, refillPerSecond: 2 }),
    };
  }

  isEnabled(): boolean {
    return Boolean(this.token);
  }

  private async getResults<T>(path: string, init: RequestInit = {}): Promise<T[]> {
    const response = await fetchWithBackoff(`https://api.tcgplayer.com/v1.39.0/${path}`, {
      ...init, redirect: 'error',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
    }, this.request);
    const data = await response.json() as { success?: boolean; results?: T[] };
    if (data.success === false) throw new Error('TCGplayer catalog or pricing request failed');
    return data.results ?? [];
  }

  async fetchListings(skus: CanonicalSku[]): Promise<RawListing[]> {
    if (!this.token) return [];
    const queries = new Set(skus.filter(sku => sku.assetClass !== 'graded' && sku.language === 'EN')
      .map(sku => sku.aliases[0] ?? sku.name));
    const productIds = new Set<number>();
    for (const name of queries) {
      const results = await this.getResults<number>('catalog/categories/3/search', {
        method: 'POST',
        body: JSON.stringify({ limit: 10, filters: [{ name: 'ProductName', values: [name] }] }),
      });
      for (const id of results) {
        if (Number.isSafeInteger(id) && id > 0) productIds.add(id);
      }
    }

    const now = new Date().toISOString();
    const listings = new Map<string, RawListing>();
    const ids = [...productIds];
    const batchSize = 50;
    for (let offset = 0; offset < ids.length; offset += batchSize) {
      const batch = ids.slice(offset, offset + batchSize).join(',');
      const products = await this.getResults<TcgplayerProduct>(`catalog/products/${batch}`);
      const productsById = new Map(products.map(product => [product.productId, product]));
      const prices = await this.getResults<TcgplayerPrice>(`pricing/product/${batch}`);
      for (const price of prices) {
        const product = productsById.get(price.productId);
        const cents = priceCents(price.lowPrice);
        if (!product?.name || !product.url || !cents) continue;
        const variant = price.subTypeName || 'default';
        const listingId = `${price.productId}:${variant}`;
        const listing: RawListing = {
          listingId, source: this.source, title: [product.name, price.subTypeName].filter(Boolean).join(' - '),
          description: 'TCGplayer catalog low price. Seller, condition, and shipping require checkout review.',
          url: product.url, priceCents: cents, shippingCents: 0, currency: 'USD', quantity: 1,
          languageHint: 'EN', imageUrls: product.imageUrl ? [product.imageUrl] : [],
          seller: seller('TCGplayer marketplace'), supportsAutoCheckout: false, listedAt: now, fetchedAt: now,
          metadata: { productId: price.productId, subTypeName: price.subTypeName, priceType: 'catalogLow' },
        };
        listings.set(listingId, listing);
      }
    }
    return [...listings.values()];
  }
}
