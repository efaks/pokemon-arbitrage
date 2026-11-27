import type { ArbitrageConfig } from '../config.ts';
import { fetchWithBackoff, TokenBucketRateLimiter } from '../connectors/base.ts';
import type { FetchLike } from '../connectors/base.ts';
import { EbayOAuthTokenManager, withEbayToken } from '../connectors/ebayAuth.ts';
import type { EbayTokenProvider } from '../connectors/ebayAuth.ts';
import type { ArbitrageDatabase } from '../db/database.ts';
import { toCents } from '../domain/money.ts';
import type { CanonicalSku, CardCondition, CardVariant, SoldComp } from '../domain/types.ts';
import type { BuyBook } from '../engine/buyBook.ts';
import type { FmvEngine } from '../valuation/fmvEngine.ts';

export interface ProviderSyncSummary {
  provider: string;
  enabled: boolean;
  skusUpserted: number;
  compsInserted: number;
  errors: string[];
}

export interface MarketSyncSummary {
  startedAt: string;
  finishedAt: string;
  totalSkusUpserted: number;
  totalCompsInserted: number;
  providers: ProviderSyncSummary[];
  errorCount: number;
}

interface SyncOptions {
  nowIso?: string;
  limit?: number;
}

export interface MarketSyncProvider {
  readonly name: string;
  isEnabled(): boolean;
  sync(db: ArbitrageDatabase, options?: SyncOptions): Promise<ProviderSyncSummary>;
}

interface HttpOptions {
  baseUrl?: string;
  fetchFn?: FetchLike;
  rateLimiter?: TokenBucketRateLimiter;
}

function summary(provider: string, enabled: boolean): ProviderSyncSummary {
  return { provider, enabled, skusUpserted: 0, compsInserted: 0, errors: [] };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Market data sync failed';
}

function runLimit(limit = 50): number {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError('Sync limit must be a positive integer');
  return limit;
}

function marketRequest(options: HttpOptions) {
  const rateLimiter = options.rateLimiter ?? new TokenBucketRateLimiter({ capacity: 2, refillPerSecond: 2 });
  return (url: URL, headers?: HeadersInit) => fetchWithBackoff(url.href, {
    headers, redirect: 'error', signal: AbortSignal.timeout(15_000),
  }, { fetchFn: options.fetchFn, rateLimiter });
}

function soldComp(
  sku: CanonicalSku, id: string, source: SoldComp['source'], cents: number, soldAt: string,
  condition: CardCondition = sku.assetClass === 'sealed' ? 'SEALED' : 'NM',
): SoldComp {
  return {
    id, skuId: sku.id, source, soldPriceCents: cents, shippingCents: 0, totalPriceCents: cents,
    condition, grader: sku.grader, grade: sku.grade, soldAt,
  };
}

function positiveCents(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function normalize(text: string): string {
  return text.normalize('NFKD').toLowerCase().replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\b0+(?=\d)/g, '');
}

interface PokemonTcgCard {
  id?: string;
  name?: string;
  number?: string;
  rarity?: string;
  set?: { id?: string; name?: string; printedTotal?: number };
  images?: { small?: string; large?: string };
  tcgplayer?: { prices?: Partial<Record<'holofoil' | 'reverseHolofoil' | 'normal', { market?: number }>> };
}

interface PokemonTcgOptions extends HttpOptions {
  apiKey?: string;
  enabled?: boolean;
  query?: string;
  pageSize?: number;
}

function cardVariant(rarity: string, prices: NonNullable<PokemonTcgCard['tcgplayer']>['prices']): CardVariant {
  if (/promo/i.test(rarity)) return 'promo';
  if (/special illustration rare/i.test(rarity)) return 'sir';
  if (prices?.holofoil || /holo|hyper rare|double rare/i.test(rarity)) return 'holo';
  return prices?.normal || !prices?.reverseHolofoil ? 'standard' : 'reverse_holo';
}

export class PokemonTcgApiCatalogSyncer implements MarketSyncProvider {
  readonly name = 'Pokémon TCG API';
  private readonly apiKey?: string;
  private readonly enabled: boolean;
  private readonly endpoint: URL;
  private readonly query: string;
  private readonly pageSize: number;
  private readonly request: ReturnType<typeof marketRequest>;

  constructor(options: PokemonTcgOptions = {}) {
    this.apiKey = (options.apiKey ?? process.env.POKEMON_TCG_API_KEY)?.trim();
    this.enabled = options.enabled === true || Boolean(this.apiKey);
    this.endpoint = new URL(`${(options.baseUrl ?? 'https://api.pokemontcg.io').replace(/\/+$/, '')}/v2/cards`);
    this.query = options.query ?? 'rarity:"Special Illustration Rare" OR rarity:"Hyper Rare"';
    this.pageSize = Math.min(runLimit(options.pageSize ?? 250), 250);
    this.request = marketRequest(options);
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  async sync(db: ArbitrageDatabase, options: SyncOptions = {}): Promise<ProviderSyncSummary> {
    const result = summary(this.name, this.isEnabled());
    if (!result.enabled) return result;
    const now = options.nowIso ?? new Date().toISOString();
    const day = now.slice(0, 10);
    const limit = runLimit(options.limit);
    const pageSize = Math.min(limit, this.pageSize);
    const rawSkus = db.listSkus({ assetClass: 'raw', language: 'EN' });
    try {
      for (let page = 1; (page - 1) * pageSize < limit; page++) {
        const url = new URL(this.endpoint);
        url.search = new URLSearchParams({ q: this.query, orderBy: '-set.releaseDate', pageSize: String(pageSize), page: String(page) }).toString();
        const response = await this.request(url, this.apiKey ? { 'X-Api-Key': this.apiKey } : undefined);
        const { data, totalCount } = await response.json() as { data: PokemonTcgCard[]; totalCount?: number };
        if (!Array.isArray(data)) throw new Error('Pokémon TCG API returned an invalid card list');
        const comps: SoldComp[] = [];
        for (const card of data.slice(0, limit - (page - 1) * pageSize)) {
          const set = card?.set;
          if (!card?.id || !card.name || !card.number || !set?.id || !set.name || !positiveCents(set.printedTotal)) continue;
          const setCode = set.id;
          const setName = set.name;
          const prices = card.tcgplayer?.prices;
          const cardNumber = `${card.number}/${set.printedTotal}`;
          const variant = cardVariant(card.rarity ?? '', prices);
          const id = 'ptcg-api-' + card.id;
          const existing = db.getSku(id) ?? rawSkus.find(sku => sku.variant === variant && sku.cardNumber &&
            normalize(sku.cardNumber) === normalize(cardNumber) &&
            (normalize(sku.setName) === normalize(setName) || sku.setCode.toLowerCase() === setCode.toLowerCase()));
          const sku: CanonicalSku = {
            ...existing, id: existing?.id ?? id, name: existing?.name ?? card.name,
            assetClass: 'raw', language: 'EN', variant, cardNumber,
            setCode: existing?.setCode ?? setCode, setName: existing?.setName ?? setName,
            aliases: [...new Set([...(existing?.aliases ?? []), `${card.name} ${cardNumber}`, `${setName} ${card.name}`])],
            referenceImageUrl: card.images?.large ?? card.images?.small ?? existing?.referenceImageUrl,
            createdAt: existing?.createdAt ?? now, updatedAt: now,
          };
          db.upsertSku(sku);
          result.skusUpserted++;
          const market = prices?.holofoil?.market ?? prices?.reverseHolofoil?.market ?? prices?.normal?.market;
          const cents = typeof market === 'number' ? toCents(market) : 0;
          if (positiveCents(cents)) comps.push(soldComp(sku, `ptcg-api-${card.id}-${day}`, 'tcgplayer', cents, now));
        }
        if (comps.length) result.compsInserted += db.insertSoldComps(comps);
        if (data.length < pageSize || totalCount !== undefined && totalCount <= page * pageSize) break;
      }
    } catch (error) {
      result.errors.push(errorMessage(error));
    }
    return result;
  }
}

export type PriceChartingPriceField = 'loose-price' | 'cib-price' | 'new-price' | 'graded-price' |
  'box-only-price' | 'manual-only-price' | 'bgs-10-price' | 'condition-17-price' | 'condition-18-price';

interface PriceChartingProduct extends Partial<Record<PriceChartingPriceField, number>> {
  id?: string;
  'product-name'?: string;
  'console-name'?: string;
}

export function priceChartingFieldForSku(sku: CanonicalSku): PriceChartingPriceField | undefined {
  if (sku.assetClass === 'sealed') return 'new-price';
  if (sku.assetClass === 'raw') return 'loose-price';
  const grade = Number(sku.grade);
  if (grade === 10) {
    if (sku.grader === 'PSA') return 'manual-only-price';
    if (sku.grader === 'BGS') return 'bgs-10-price';
    if (sku.grader === 'CGC') return 'condition-17-price';
    return undefined;
  }
  if (grade === 9.5) return 'box-only-price';
  if (grade === 9) return 'graded-price';
  if (grade === 8 || grade === 8.5) return 'new-price';
  if (grade === 7 || grade === 7.5) return 'cib-price';
}

function skuQuery(sku: CanonicalSku): string {
  return sku.cardNumber && !sku.name.includes(sku.cardNumber) ? `${sku.name} ${sku.cardNumber}` : sku.name;
}

function productScore(product: PriceChartingProduct, sku: CanonicalSku): number {
  const name = normalize(product?.['product-name'] ?? '');
  const category = normalize(product?.['console-name'] ?? '');
  if (!name || !/\bpokemon\b/.test(`${category} ${name}`)) return 0;
  const aliases = [sku.name, ...sku.aliases].map(normalize);
  const exact = aliases.includes(name);
  const number = sku.cardNumber && normalize(sku.cardNumber.split('/')[0]);
  const label = normalize(sku.cardNumber ? sku.name.split(sku.cardNumber)[0] : sku.name);
  if (!exact && number && (!name.includes(label) || !name.split(' ').includes(number))) return 0;
  if (!exact && !number && !aliases.some(alias => ` ${name} `.includes(` ${alias} `))) return 0;
  return 1 + Number(exact) + 2 * Number(category.includes(normalize(sku.setName)));
}

export class PriceChartingSyncer implements MarketSyncProvider {
  readonly name = 'PriceCharting';
  private readonly apiToken?: string;
  private readonly baseUrl: string;
  private readonly request: ReturnType<typeof marketRequest>;

  constructor(options: HttpOptions & { apiToken?: string } = {}) {
    this.apiToken = (options.apiToken ?? process.env.PRICECHARTING_API_TOKEN)?.trim();
    this.baseUrl = (options.baseUrl ?? 'https://www.pricecharting.com').replace(/\/+$/, '');
    this.request = marketRequest(options);
  }

  isEnabled(): boolean {
    return Boolean(this.apiToken);
  }

  async sync(db: ArbitrageDatabase, options: SyncOptions = {}): Promise<ProviderSyncSummary> {
    const token = this.apiToken;
    const result = summary(this.name, Boolean(token));
    if (!token) return result;
    const now = options.nowIso ?? new Date().toISOString();
    const day = now.slice(0, 10);
    for (const sku of db.listSkus().slice(0, runLimit(options.limit))) {
      const field = priceChartingFieldForSku(sku);
      if (!field) continue;
      try {
        const search = new URL(`${this.baseUrl}/api/products`);
        const query = sku.cardNumber
          ? `${sku.name.split(sku.cardNumber)[0].trim()} #${sku.cardNumber.split('/')[0]} ${sku.setName}`
          : sku.name;
        search.search = new URLSearchParams({ t: token, q: query }).toString();
        const response = await this.request(search);
        const { status, products } = await response.json() as { status?: string; products?: PriceChartingProduct[] };
        if (status !== undefined && status !== 'success') throw new Error('PriceCharting product search failed');
        let best: PriceChartingProduct | undefined;
        let bestScore = 0;
        for (const product of products ?? []) {
          const score = productScore(product, sku);
          if (score > bestScore) {
            best = product;
            bestScore = score;
          }
        }
        if (!best) continue;
        let cents = best[field];
        if (cents === undefined && best.id) {
          const detail = new URL(`${this.baseUrl}/api/product`);
          detail.search = new URLSearchParams({ t: token, id: best.id }).toString();
          const priceResponse = await this.request(detail);
          const product = await priceResponse.json() as PriceChartingProduct & { status?: string };
          if (product.status !== undefined && product.status !== 'success') throw new Error('PriceCharting product lookup failed');
          cents = product[field];
        }
        if (positiveCents(cents)) {
          result.compsInserted += db.insertSoldComps([soldComp(sku, `pricecharting-${sku.id}-${day}`, 'pricecharting', cents, now)]);
        }
      } catch (error) {
        result.errors.push(`${sku.id}: ${errorMessage(error)}`);
      }
    }
    return result;
  }
}

interface EbaySoldOptions extends HttpOptions {
  accessToken?: string;
  tokenProvider?: EbayTokenProvider;
  enabled?: boolean;
  limitPerQuery?: number;
  categoryIds?: string;
}

interface EbayItemSale {
  itemId?: string;
  title?: string;
  lastSoldPrice?: { value?: string; currency?: string };
  lastSoldDate?: string;
  condition?: string;
}

function saleCondition(sku: CanonicalSku, sale: EbayItemSale): CardCondition {
  if (sku.assetClass === 'sealed') return 'SEALED';
  const text = normalize(sale.condition ?? '');
  if (/\b(?:damaged|dmg|poor)\b/.test(text)) return 'DMG';
  if (/\b(?:heavy|heavily|hp)\b/.test(text)) return 'HP';
  if (/\b(?:moderate|moderately|mp|very good)\b/.test(text)) return 'MP';
  if (/\b(?:light|lightly|lp|excellent)\b/.test(text)) return 'LP';
  return 'NM';
}

function matchesSale(sku: CanonicalSku, title: string): boolean {
  const text = ` ${normalize(title)} `;
  if (sku.assetClass === 'sealed') {
    return [sku.name, ...sku.aliases].some(name => text.includes(` ${normalize(name)} `));
  }
  const label = normalize(sku.cardNumber ? sku.name.split(sku.cardNumber)[0] : sku.name);
  if (!text.includes(` ${label} `)) return false;
  if (sku.cardNumber) {
    const [number] = sku.cardNumber.split('/');
    if (!text.includes(` ${normalize(number)} `)) return false;
    const fullNumber = title.match(/\b[a-z]*\d+\s*\/\s*[a-z]*\d+\b/i)?.[0];
    if (fullNumber && normalize(fullNumber) !== normalize(sku.cardNumber)) return false;
  }
  if (sku.assetClass === 'raw') return !/\b(?:graded|slabbed|psa|bgs|cgc|sgc)\b/.test(text);
  const grade = title.match(/\b(psa|bgs|cgc|sgc)\s*[-:]?\s*(?:(?:gem|mint|pristine)\s+)*(10|[1-9])(?:\.(\d+))?(?![\w.]|\s*\/)/i);
  return grade?.[1].toUpperCase() === sku.grader && grade !== null &&
    Number(grade[3] ? `${grade[2]}.${grade[3]}` : grade[2]) === Number(sku.grade);
}

export class EbaySoldCompsSyncer implements MarketSyncProvider {
  readonly name = 'eBay Marketplace Insights';
  private readonly enabled: boolean;
  private readonly tokenProvider: EbayTokenProvider;
  private readonly baseUrl: string;
  private readonly request: ReturnType<typeof marketRequest>;
  private readonly limitPerQuery: number;
  private readonly categoryIds?: string;

  constructor(options: EbaySoldOptions = {}) {
    this.enabled = options.enabled ?? process.env.EBAY_INSIGHTS_ENABLED === 'true';
    this.baseUrl = (options.baseUrl ?? 'https://api.ebay.com').replace(/\/+$/, '');
    this.categoryIds = options.categoryIds ?? process.env.EBAY_INSIGHTS_CATEGORY_IDS;
    this.limitPerQuery = Math.min(runLimit(options.limitPerQuery ?? 25), 200);
    this.request = marketRequest(options);
    this.tokenProvider = options.tokenProvider ?? new EbayOAuthTokenManager({
      staticToken: options.accessToken ?? process.env.EBAY_ACCESS_TOKEN,
      clientId: options.accessToken === '' ? '' : process.env.EBAY_CLIENT_ID,
      clientSecret: options.accessToken === '' ? '' : process.env.EBAY_CLIENT_SECRET,
      refreshToken: '',
      scopes: ['https://api.ebay.com/oauth/api_scope/buy.marketplace.insights'],
      sandbox: new URL(this.baseUrl).hostname.endsWith('.sandbox.ebay.com'),
      fetchFn: options.fetchFn,
    });
  }

  isEnabled(): boolean {
    return this.enabled && this.tokenProvider.isConfigured();
  }

  async sync(db: ArbitrageDatabase, options: SyncOptions = {}): Promise<ProviderSyncSummary> {
    const result = summary(this.name, this.isEnabled());
    if (!result.enabled) return result;
    for (const sku of db.listSkus().slice(0, runLimit(options.limit))) {
      try {
        const url = new URL(`${this.baseUrl}/buy/marketplace_insights/v1_beta/item_sales/search`);
        url.search = new URLSearchParams({
          q: skuQuery(sku), limit: String(this.limitPerQuery),
          category_ids: this.categoryIds ?? (sku.assetClass === 'sealed' ? '183456,183457,261044,261045' : '183454'),
        }).toString();
        const response = await withEbayToken(this.tokenProvider, token => this.request(url, {
          Authorization: `Bearer ${token}`, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
        }));
        const { itemSales } = await response.json() as { itemSales?: EbayItemSale[] };
        const comps: SoldComp[] = [];
        for (const sale of itemSales ?? []) {
          const price = sale?.lastSoldPrice;
          const cents = price?.currency === 'USD' && typeof price.value === 'string' && /^\d+(?:\.\d+)?$/.test(price.value)
            ? toCents(Number(price.value)) : 0;
          const timestamp = Date.parse(sale?.lastSoldDate ?? '');
          if (!sale?.itemId || !sale.title || !positiveCents(cents) || !Number.isFinite(timestamp) ||
              !matchesSale(sku, sale.title)) continue;
          comps.push(soldComp(sku, 'ebay-sale-' + sale.itemId, 'ebay', cents, new Date(timestamp).toISOString(), saleCondition(sku, sale)));
        }
        if (comps.length) result.compsInserted += db.insertSoldComps(comps);
      } catch (error) {
        result.errors.push(`${sku.id}: ${errorMessage(error)}`);
      }
    }
    return result;
  }
}

interface CoordinatorOptions extends SyncOptions {
  buyBook?: BuyBook;
  fmvEngine?: FmvEngine;
  config?: ArbitrageConfig;
}

export class MarketSyncCoordinator {
  private readonly db: ArbitrageDatabase;
  private readonly providers: readonly MarketSyncProvider[];
  private readonly now: () => Date;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(db: ArbitrageDatabase, providers: MarketSyncProvider[], options: { nowFn?: () => Date } = {}) {
    this.db = db;
    this.providers = Object.freeze([...providers]);
    this.now = options.nowFn ?? (() => new Date());
  }

  getProviders(): readonly MarketSyncProvider[] {
    return this.providers;
  }

  syncAll(options: CoordinatorOptions = {}): Promise<MarketSyncSummary> {
    const run = this.tail.then(() => this.sync(options));
    this.tail = run.catch(() => undefined);
    return run;
  }

  private async sync({ nowIso, limit, buyBook, fmvEngine, config }: CoordinatorOptions): Promise<MarketSyncSummary> {
    const startedAt = this.now().toISOString();
    const asOf = new Date(nowIso ?? startedAt).toISOString();
    const providers: ProviderSyncSummary[] = [];
    limit = runLimit(limit);
    for (const provider of this.providers) {
      const result = summary(provider.name, false);
      try {
        result.enabled = provider.isEnabled();
        providers.push(result.enabled ? await provider.sync(this.db, { nowIso: asOf, limit }) : result);
      } catch (error) {
        result.errors.push(errorMessage(error));
        providers.push(result);
      }
    }
    if (buyBook && fmvEngine && config) buyBook.refresh(this.db, fmvEngine, config, asOf);
    const result: MarketSyncSummary = {
      startedAt, finishedAt: this.now().toISOString(), providers,
      totalSkusUpserted: providers.reduce((sum, item) => sum + item.skusUpserted, 0),
      totalCompsInserted: providers.reduce((sum, item) => sum + item.compsInserted, 0),
      errorCount: providers.reduce((sum, item) => sum + item.errors.length, 0),
    };
    this.db.logAuditEvent('market.sync_completed', { ...result });
    return result;
  }
}
