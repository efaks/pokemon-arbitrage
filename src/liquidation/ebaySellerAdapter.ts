import { fetchWithBackoff, HttpResponseError } from '../connectors/base.ts';
import type { FetchLike } from '../connectors/base.ts';
import { EbayOAuthTokenManager, withEbayToken } from '../connectors/ebayAuth.ts';
import type { EbayTokenProvider } from '../connectors/ebayAuth.ts';
import type { CanonicalSku, CardCondition, ExitChannel, Grader, InventoryItem } from '../domain/types.ts';

export interface PublishListingInput {
  title?: string;
  description?: string;
  priceCents: number;
  condition?: CardCondition;
  imageUrls?: string[];
}

export interface PublishListingResult {
  success: boolean;
  externalOfferId?: string;
  externalListingId?: string;
  externalListingUrl?: string;
  failureReason?: string;
}

export interface UpdateListingPriceResult {
  success: boolean;
  failureReason?: string;
}

export interface WithdrawListingResult {
  success: boolean;
  failureReason?: string;
}

export interface SellListingAdapter {
  readonly name: string;
  readonly channel: ExitChannel;
  isConfigured(): boolean;
  publishListing(item: InventoryItem, sku: CanonicalSku, input: PublishListingInput): Promise<PublishListingResult>;
  updateListingPrice(item: InventoryItem, newPriceCents: number): Promise<UpdateListingPriceResult>;
  withdrawListing(item: InventoryItem): Promise<WithdrawListingResult>;
}

export class DisabledSellerAdapter implements SellListingAdapter {
  readonly name = 'Local inventory';
  readonly channel = 'ebay';
  isConfigured(): boolean { return false; }
  async publishListing(): Promise<PublishListingResult> {
    return { success: false, failureReason: 'Selling adapter is disabled' };
  }
  async updateListingPrice(): Promise<UpdateListingPriceResult> { return this.publishListing(); }
  async withdrawListing(): Promise<WithdrawListingResult> { return this.publishListing(); }
}

type SimulationOverride = { publishFailure?: string; repriceFailure?: string; withdrawFailure?: string };

export class SimulatedSellerAdapter implements SellListingAdapter {
  readonly name = 'Simulated seller';
  readonly channel = 'ebay';
  private readonly overrides: Readonly<Record<string, SimulationOverride>>;

  constructor(overrides: Readonly<Record<string, SimulationOverride>> = {}) {
    this.overrides = overrides;
  }

  isConfigured(): boolean { return true; }

  async publishListing(item: InventoryItem): Promise<PublishListingResult> {
    const failureReason = this.overrides[item.id]?.publishFailure;
    if (failureReason) return { success: false, failureReason };
    const externalListingId = `sim-listing-${item.id}`;
    return {
      success: true, externalOfferId: `sim-offer-${item.id}`, externalListingId,
      externalListingUrl: `https://ebay.example.test/itm/${encodeURIComponent(externalListingId)}`,
    };
  }

  async updateListingPrice(item: InventoryItem): Promise<UpdateListingPriceResult> {
    const failureReason = this.overrides[item.id]?.repriceFailure;
    return failureReason ? { success: false, failureReason } : { success: true };
  }

  async withdrawListing(item: InventoryItem): Promise<WithdrawListingResult> {
    const failureReason = this.overrides[item.id]?.withdrawFailure;
    return failureReason ? { success: false, failureReason } : { success: true };
  }
}

interface EbaySellerOptions {
  tokenProvider?: EbayTokenProvider;
  accessToken?: string;
  refreshToken?: string;
  clientId?: string;
  clientSecret?: string;
  fulfillmentPolicyId?: string;
  paymentPolicyId?: string;
  returnPolicyId?: string;
  merchantLocationKey?: string;
  sandbox?: boolean;
  baseUrl?: string;
  fetchFn?: FetchLike;
}

const marketplaceId = 'EBAY_US';
const graderIds: Record<Grader, string> = { PSA: '275010', BGS: '275013', CGC: '275015', SGC: '275016' };
const rawConditionIds = { NM: '400010', LP: '400015', MP: '400016', HP: '400017', DMG: '400017' };

// eBay category 183454 uses descriptors for both graded and ungraded singles.
function conditionFields(sku: CanonicalSku, item: InventoryItem, observed: CardCondition) {
  if (sku.assetClass === 'sealed') return { condition: 'NEW' };
  if (sku.assetClass === 'raw') {
    if (observed === 'SEALED') throw new Error('A raw single requires an ungraded card condition');
    return { condition: 'USED_VERY_GOOD', conditionDescriptors: [{ name: '40001', values: [rawConditionIds[observed]] }] };
  }
  const grader = item.grader ?? sku.grader;
  const grade = Number(item.grade ?? sku.grade);
  const gradeIndex = (10 - grade) * 2;
  if (!grader || !graderIds[grader] || !Number.isInteger(gradeIndex) || gradeIndex < 0 || gradeIndex > 18) {
    throw new Error('The graded card requires a supported grader and grade from 1 to 10');
  }
  return {
    condition: 'LIKE_NEW',
    conditionDescriptors: [{ name: '27501', values: [graderIds[grader]] }, { name: '27502', values: [`27502${gradeIndex}`] }],
  };
}

function inventorySkuKey(item: InventoryItem): string {
  return `pa-${item.id}`;
}

function price(cents: number) {
  if (!Number.isSafeInteger(cents) || cents <= 0) throw new RangeError('Listing price must be positive integer cents');
  return { value: (cents / 100).toFixed(2), currency: 'USD' };
}

function failure(error: unknown, operation: string) {
  return { success: false, failureReason: `eBay ${operation}: ${error instanceof Error ? error.message : 'Request failed'}` };
}

interface OfferDetails {
  offerId?: string;
  sku?: string;
  marketplaceId?: string;
  format?: string;
  status?: string;
  listing?: { listingId?: string; listingStatus?: string };
}

export class EbaySellInventoryAdapter implements SellListingAdapter {
  readonly name = 'eBay Sell Inventory API';
  readonly channel = 'ebay';
  private readonly tokenProvider: EbayTokenProvider;
  private readonly authKind: 'oauth' | 'static';
  private readonly listingPolicies: { fulfillmentPolicyId: string; paymentPolicyId: string; returnPolicyId: string };
  private readonly merchantLocationKey: string;
  private readonly sandbox: boolean;
  private readonly baseUrl: string;
  private readonly fetchFn?: FetchLike;

  constructor(options: EbaySellerOptions = {}) {
    const accessToken = (options.accessToken ?? process.env.EBAY_SELL_API_TOKEN ?? '').trim();
    const refreshToken = options.refreshToken?.trim() ??
      (process.env.EBAY_SELL_REFRESH_TOKEN?.trim() || process.env.EBAY_REFRESH_TOKEN?.trim() || '');
    const clientId = (options.clientId ?? process.env.EBAY_CLIENT_ID ?? '').trim();
    const clientSecret = (options.clientSecret ?? process.env.EBAY_CLIENT_SECRET ?? '').trim();
    const useOAuth = Boolean(refreshToken && clientId && clientSecret);
    this.authKind = options.tokenProvider || useOAuth ? 'oauth' : 'static';
    this.sandbox = options.sandbox ?? process.env.EBAY_SELL_SANDBOX === 'true';
    this.baseUrl = (options.baseUrl ?? `https://api.${this.sandbox ? 'sandbox.' : ''}ebay.com`).replace(/\/+$/, '');
    this.fetchFn = options.fetchFn;
    this.tokenProvider = options.tokenProvider ?? new EbayOAuthTokenManager({
      staticToken: accessToken, clientId: useOAuth ? clientId : '', clientSecret: useOAuth ? clientSecret : '',
      refreshToken, sandbox: this.sandbox, fetchFn: this.fetchFn,
      scopes: ['https://api.ebay.com/oauth/api_scope/sell.inventory'],
    });
    this.listingPolicies = {
      fulfillmentPolicyId: (options.fulfillmentPolicyId ?? process.env.EBAY_FULFILLMENT_POLICY_ID ?? '').trim(),
      paymentPolicyId: (options.paymentPolicyId ?? process.env.EBAY_PAYMENT_POLICY_ID ?? '').trim(),
      returnPolicyId: (options.returnPolicyId ?? process.env.EBAY_RETURN_POLICY_ID ?? '').trim(),
    };
    this.merchantLocationKey = (options.merchantLocationKey ?? process.env.EBAY_MERCHANT_LOCATION_KEY ?? '').trim();
  }

  isConfigured(): boolean {
    return this.tokenProvider.isConfigured() && Boolean(this.merchantLocationKey) && Object.values(this.listingPolicies).every(Boolean);
  }

  getAuthKind(): 'oauth' | 'static' { return this.authKind; }

  private request(method: string, path: string, body?: unknown, maxRetries?: number): Promise<Response> {
    if (!this.isConfigured()) throw new Error('Configure a Sell Inventory token, all three listing policies, and the merchant location');
    return withEbayToken(this.tokenProvider, token => fetchWithBackoff(`${this.baseUrl}/sell/inventory/v1${path}`, {
      method, headers: {
        Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Language': 'en-US',
      },
      body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(15_000),
    }, { fetchFn: this.fetchFn, maxRetries }));
  }

  private async findOffer(sku: string): Promise<OfferDetails | undefined> {
    const query = new URLSearchParams({ sku, marketplace_id: marketplaceId, format: 'FIXED_PRICE' });
    const response = await this.request('GET', `/offer?${query}`);
    const data = await response.json() as { offers?: OfferDetails[] };
    return data.offers?.find(offer => offer.offerId && offer.sku === sku &&
      offer.marketplaceId === marketplaceId && offer.format === 'FIXED_PRICE');
  }

  async publishListing(item: InventoryItem, sku: CanonicalSku, input: PublishListingInput): Promise<PublishListingResult> {
    let operation = 'inventory item upsert';
    let externalOfferId: string | undefined;
    try {
      const key = inventorySkuKey(item);
      const description = input.description?.trim() || item.skuName;
      const imageUrls = input.imageUrls?.length ? input.imageUrls : sku.referenceImageUrl ? [sku.referenceImageUrl] : [];
      const condition = input.condition ?? item.actualCondition ?? item.expectedCondition;
      const offer = {
        sku: key, listingDescription: description, marketplaceId, format: 'FIXED_PRICE', listingDuration: 'GTC',
        categoryId: sku.assetClass === 'sealed' ? '183456' : '183454', availableQuantity: 1,
        merchantLocationKey: this.merchantLocationKey, listingPolicies: this.listingPolicies,
        pricingSummary: { price: price(input.priceCents) },
      };
      // Replacing an inventory item also changes its published offer's product fields.
      await this.request('PUT', `/inventory_item/${encodeURIComponent(key)}`, {
        ...conditionFields(sku, item, condition),
        availability: { shipToLocationAvailability: { quantity: 1 } },
        product: {
          title: (input.title?.trim() || item.skuName).slice(0, 80), description, imageUrls,
          aspects: { Game: ['Pokémon TCG'], Set: [sku.setName] },
        },
      });

      operation = 'offer creation';
      let externalListingId = item.externalListingId;
      let reusedOffer = Boolean(item.externalOfferId);
      if (item.externalOfferId) {
        externalOfferId = item.externalOfferId;
      } else {
        try {
          const response = await this.request('POST', '/offer', offer, 0);
          const data = await response.json() as OfferDetails;
          if (typeof data.offerId !== 'string' || !data.offerId.trim()) throw new Error('Response did not include offerId');
          externalOfferId = data.offerId;
        } catch (createError) {
          // Recover a retained or already-created offer by its deterministic SKU.
          const existing = await this.findOffer(key).catch(() => undefined);
          if (!existing?.offerId) throw createError;
          externalOfferId = existing.offerId;
          reusedOffer = true;
          if (existing.status === 'PUBLISHED') {
            externalListingId = existing.listing?.listingId;
            if (!externalListingId || existing.listing?.listingStatus === 'ENDED') {
              throw new Error('Reconcile the existing eBay listing before retrying');
            }
          }
        }
      }
      const offerPath = `/offer/${encodeURIComponent(externalOfferId)}`;
      if (reusedOffer) {
        operation = 'offer update';
        await this.request('PUT', offerPath, offer);
      }
      if (!externalListingId) {
        operation = 'offer publish';
        const response = await this.request('POST', `${offerPath}/publish`, undefined, 0);
        const data = await response.json() as { listingId?: string };
        if (typeof data.listingId !== 'string' || !data.listingId.trim()) throw new Error('Response did not include listingId');
        externalListingId = data.listingId;
      }
      const host = this.sandbox ? 'www.sandbox.ebay.com' : 'www.ebay.com';
      return {
        success: true, externalOfferId, externalListingId,
        externalListingUrl: `https://${host}/itm/${encodeURIComponent(externalListingId)}`,
      };
    } catch (error) {
      return { ...failure(error, operation), externalOfferId };
    }
  }

  async updateListingPrice(item: InventoryItem, newPriceCents: number): Promise<UpdateListingPriceResult> {
    try {
      if (!item.externalOfferId) throw new Error('Inventory item has no external offer ID');
      const sku = inventorySkuKey(item);
      const offerId = item.externalOfferId;
      const response = await this.request('POST', '/bulk_update_price_quantity', {
        requests: [{ sku, offers: [{ offerId, availableQuantity: 1, price: price(newPriceCents) }] }],
      });
      const data = await response.json() as {
        responses?: { statusCode?: number; offerId?: string; sku?: string; errors?: unknown[] }[];
      };
      const result = data.responses?.find(entry =>
        (entry.offerId === undefined || entry.offerId === offerId) && (entry.sku === undefined || entry.sku === sku));
      if (!result?.statusCode || result.statusCode < 200 || result.statusCode >= 300 || result.errors?.length) {
        throw new Error(`Offer price was not updated (status ${result?.statusCode ?? 'missing'})`);
      }
      return { success: true };
    } catch (error) {
      return failure(error, 'price update');
    }
  }

  async withdrawListing(item: InventoryItem): Promise<WithdrawListingResult> {
    try {
      if (!item.externalOfferId) throw new Error('Inventory item has no external offer ID');
      await this.request('POST', `/offer/${encodeURIComponent(item.externalOfferId)}/withdraw`, undefined, 0);
      return { success: true };
    } catch (error) {
      // If eBay applied a withdrawal before the response was lost, a retry can confirm it.
      if (item.externalOfferId && this.isConfigured() && (!(error instanceof HttpResponseError) || error.status !== 401)) {
        const offer = await this.request('GET', `/offer/${encodeURIComponent(item.externalOfferId)}`)
          .then(response => response.json() as Promise<OfferDetails>).catch(() => undefined);
        if (offer?.offerId === item.externalOfferId && offer.status === 'UNPUBLISHED') return { success: true };
      }
      return failure(error, 'offer withdrawal');
    }
  }
}
