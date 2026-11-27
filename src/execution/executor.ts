import { createHash, randomUUID } from 'node:crypto';
import type { FetchLike } from '../connectors/base.ts';
import type { ArbitrageConfig } from '../config.ts';
import type { ArbitrageDatabase } from '../db/database.ts';
import { percentOfCents, toCents } from '../domain/money.ts';
import type { ArbitrageDecision, CanonicalSku, InventoryItem, PurchaseOrder, RawListing } from '../domain/types.ts';

export interface LiveListingCheck {
  available: boolean;
  currentPriceCents: number;
  currentShippingCents: number;
  reason?: string;
}

export interface ExecutePurchaseResult {
  success: boolean;
  externalOrderId?: string;
  failureReason?: string;
}

export interface ExecutionAdapter {
  verifyLiveListing(listing: RawListing): Promise<LiveListingCheck>;
  executePurchase(order: PurchaseOrder, listing: RawListing): Promise<ExecutePurchaseResult>;
}

function listedQuote(listing: RawListing): LiveListingCheck {
  return { available: true, currentPriceCents: listing.priceCents, currentShippingCents: listing.shippingCents };
}

export class ShadowExecutor implements ExecutionAdapter {
  async verifyLiveListing(listing: RawListing): Promise<LiveListingCheck> {
    return listedQuote(listing);
  }

  async executePurchase(order: PurchaseOrder, _listing: RawListing): Promise<ExecutePurchaseResult> {
    return { success: true, externalOrderId: `shadow-${order.id}` };
  }
}

type SimulationOverride = Partial<LiveListingCheck> & { failureReason?: string };

export class SimulatedApiExecutor implements ExecutionAdapter {
  private readonly overrides: ReadonlyMap<string, SimulationOverride>;

  constructor(overrides: ReadonlyMap<string, SimulationOverride> | Record<string, SimulationOverride> = {}) {
    this.overrides = overrides instanceof Map ? overrides : new Map(Object.entries(overrides));
  }

  async verifyLiveListing(listing: RawListing): Promise<LiveListingCheck> {
    const { failureReason: _failureReason, ...quote } = this.overrides.get(listing.listingId) ?? {};
    return { ...listedQuote(listing), ...quote };
  }

  async executePurchase(order: PurchaseOrder, listing: RawListing): Promise<ExecutePurchaseResult> {
    const failureReason = this.overrides.get(listing.listingId)?.failureReason;
    if (failureReason) return { success: false, failureReason };
    return { success: true, externalOrderId: `sim-${order.idempotencyKey.slice(0, 24)}` };
  }
}

interface EbayOrderOptions {
  accessToken?: string;
  browseAccessToken?: string;
  baseUrl?: string;
  browseBaseUrl?: string;
  marketplaceId?: string;
  sandbox?: boolean;
  fetchFn?: FetchLike;
  guestCheckout?: {
    contactEmail: string;
    shippingAddress: {
      recipient: string;
      addressLine1: string;
      addressLine2?: string;
      city: string;
      stateOrProvince: string;
      postalCode: string;
      country: string;
      phoneNumber?: string;
    };
    /** Show the official Checkout with eBay widget and return the resulting purchase order ID. */
    completeWithWidget(session: { checkoutSessionId: string; securityToken: string }): Promise<string>;
  };
}

interface EbayAmount {
  value?: string;
  currency?: string;
}

interface EbayBrowseItem {
  price?: EbayAmount;
  shippingOptions?: { shippingCost?: EbayAmount }[];
  buyingOptions?: string[];
  itemEndDate?: string;
  estimatedAvailabilities?: { estimatedAvailabilityStatus?: string }[];
}

interface EbayCheckout {
  checkoutSessionId?: string;
  pricingSummary?: { total?: EbayAmount };
}

interface EbayPurchase {
  purchaseOrderId?: string;
  purchaseOrderPaymentStatus?: string;
  pricingSummary?: { total?: EbayAmount };
  lineItems?: { itemId?: string; quantity?: number }[];
}

function usdCents(amount?: EbayAmount): number | undefined {
  if (amount?.currency !== 'USD' || !amount.value?.trim()) return undefined;
  const cents = toCents(Number(amount.value));
  return Number.isSafeInteger(cents) && cents >= 0 ? cents : undefined;
}

export class EbayOrderApiExecutor implements ExecutionAdapter {
  private readonly accessToken?: string;
  private readonly browseAccessToken?: string;
  private readonly orderBase: string;
  private readonly purchaseOrderBase: string;
  private readonly browseBase: string;
  private readonly marketplaceId: string;
  private readonly fetchFn: FetchLike;
  private readonly guestCheckout?: EbayOrderOptions['guestCheckout'];

  constructor(options: EbayOrderOptions = {}) {
    const hostSuffix = options.sandbox ? 'sandbox.ebay.com' : 'ebay.com';
    this.accessToken = (options.accessToken ?? process.env.EBAY_ORDER_API_TOKEN)?.trim();
    this.browseAccessToken = (options.browseAccessToken ?? process.env.EBAY_ACCESS_TOKEN ?? this.accessToken)?.trim();
    this.orderBase = (options.baseUrl ?? `https://apix.${hostSuffix}`).replace(/\/+$/, '');
    this.purchaseOrderBase = (options.baseUrl ?? `https://api.${hostSuffix}`).replace(/\/+$/, '');
    this.browseBase = (options.browseBaseUrl ?? options.baseUrl ?? `https://api.${hostSuffix}`).replace(/\/+$/, '');
    this.marketplaceId = options.marketplaceId ?? 'EBAY_US';
    this.fetchFn = options.fetchFn ?? fetch;
    this.guestCheckout = options.guestCheckout;
  }

  private async request(url: string, token: string, step: string, method = 'GET', body?: object): Promise<Response> {
    const response = await this.fetchFn(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-EBAY-C-MARKETPLACE-ID': this.marketplaceId,
      },
      body: body && JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`eBay ${step} returned HTTP ${response.status}`);
    }
    return response;
  }

  async verifyLiveListing(listing: RawListing): Promise<LiveListingCheck> {
    const unavailable = (reason: string) => ({ ...listedQuote(listing), available: false, reason });
    if (!this.accessToken || !this.browseAccessToken) return unavailable('eBay Order API token is missing');
    if (listing.source !== 'ebay') return unavailable('eBay Order API requires an eBay listing');
    try {
      const response = await this.request(
        `${this.browseBase}/buy/browse/v1/item/${encodeURIComponent(listing.listingId)}`,
        this.browseAccessToken, 'Browse verification',
      );
      const item = await response.json() as EbayBrowseItem;
      const price = usdCents(item.price);
      const shipping = (item.shippingOptions ?? []).flatMap(option => {
        const cents = usdCents(option.shippingCost);
        return cents === undefined ? [] : [cents];
      });
      const availabilities = item.estimatedAvailabilities ?? [];
      if (Date.parse(item.itemEndDate ?? '') <= Date.now() ||
          !item.buyingOptions?.includes('FIXED_PRICE') ||
          !availabilities.some(option => option.estimatedAvailabilityStatus === 'IN_STOCK' ||
            option.estimatedAvailabilityStatus === 'LIMITED_STOCK')) {
        return unavailable('eBay listing is unavailable for fixed-price checkout');
      }
      if (price === undefined || price <= 0 || !shipping.length) {
        return unavailable('eBay did not quote a verifiable USD price and shipping cost');
      }
      return { available: true, currentPriceCents: price, currentShippingCents: Math.min(...shipping) };
    } catch (error) {
      return unavailable(errorMessage(error, 'eBay Browse verification failed'));
    }
  }

  async executePurchase(order: PurchaseOrder, listing: RawListing): Promise<ExecutePurchaseResult> {
    if (!this.accessToken) return { success: false, failureReason: 'eBay Order API token is missing' };
    if (listing.source !== 'ebay') return { success: false, failureReason: 'Complete checkout through the listing link' };

    const guest = this.guestCheckout;
    const version = guest ? 'v2' : 'v1';
    const base = `${this.orderBase}/buy/order/${version}`;
    const lookupBase = `${this.purchaseOrderBase}/buy/order/${version}`;
    const checkoutPath = guest ? 'guest_checkout_session' : 'checkout_session';
    const lineItemInputs = [{ itemId: listing.listingId, quantity: order.quantity }];
    let externalOrderId: string | undefined;
    try {
      const sessionResponse = await this.request(
        `${base}/${checkoutPath}/initiate`, this.accessToken, 'checkout initiation', 'POST',
        guest ? { lineItemInputs, contactEmail: guest.contactEmail, shippingAddress: guest.shippingAddress }
          : { lineItemInputs },
      );
      const session = await sessionResponse.json() as EbayCheckout;
      const total = usdCents(session.pricingSummary?.total);
      if (!session.checkoutSessionId || total === undefined || total <= 0 || total > order.landedCostCents) {
        return { success: false, failureReason: 'eBay checkout total is unavailable or exceeds the approved cost' };
      }

      let purchase: EbayPurchase;
      if (guest) {
        const securityToken = sessionResponse.headers.get('X-EBAY-SECURITY-SIGNATURE');
        if (!securityToken) return { success: false, failureReason: 'eBay guest checkout security token is missing' };
        externalOrderId = await guest.completeWithWidget({
          checkoutSessionId: session.checkoutSessionId, securityToken,
        });
        if (!externalOrderId) return { success: false, failureReason: 'eBay guest checkout was not completed' };
        const response = await this.request(
          `${lookupBase}/guest_purchase_order/${encodeURIComponent(externalOrderId)}`, this.accessToken, 'guest order lookup',
        );
        purchase = await response.json() as EbayPurchase;
        const purchasedTotal = usdCents(purchase.pricingSummary?.total);
        if (purchase.purchaseOrderId !== externalOrderId || purchase.lineItems?.length !== 1 ||
            !purchase.lineItems.some(item => item.itemId === listing.listingId && item.quantity === order.quantity) ||
            purchasedTotal === undefined || purchasedTotal <= 0 || purchasedTotal > order.landedCostCents) {
          return { success: false, externalOrderId, failureReason: 'eBay guest order details did not match the approved order' };
        }
      } else {
        // A placement request can succeed even if the response is lost. Never retry it automatically.
        const response = await this.request(
          `${base}/${checkoutPath}/${encodeURIComponent(session.checkoutSessionId)}/place_order`,
          this.accessToken, 'order placement', 'POST', {},
        );
        purchase = await response.json() as EbayPurchase;
        externalOrderId = purchase.purchaseOrderId;
        if (externalOrderId && purchase.purchaseOrderPaymentStatus === 'PENDING') {
          const lookup = await this.request(
            `${lookupBase}/purchase_order/${encodeURIComponent(externalOrderId)}`, this.accessToken, 'purchase order lookup',
          );
          purchase = await lookup.json() as EbayPurchase;
        }
      }

      if (!externalOrderId || purchase.purchaseOrderId !== externalOrderId || purchase.purchaseOrderPaymentStatus !== 'PAID') {
        return { success: false, externalOrderId, failureReason: 'eBay did not confirm payment for the order' };
      }
      return { success: true, externalOrderId };
    } catch (error) {
      return { success: false, externalOrderId, failureReason: errorMessage(error, 'eBay checkout failed') };
    }
  }
}

export interface ExecutionOutcome {
  order?: PurchaseOrder;
  inventoryItem?: InventoryItem;
  status: 'skipped' | 'shadow_recorded' | 'pending_hitl' | 'filled' | 'failed' | 'duplicate' | 'locked' | 'aborted';
  reason?: string;
}

interface ExecutionCoordinatorOptions {
  db: ArbitrageDatabase;
  config: ArbitrageConfig;
  adapter: ExecutionAdapter;
  lockTtlMs?: number;
}

interface BuyQuote {
  askPriceCents: number;
  shippingCents: number;
  taxCents: number;
  landedCostCents: number;
}

const portfolioLockKey = 'purchase-portfolio';

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function duplicate(order: PurchaseOrder): ExecutionOutcome {
  return { status: 'duplicate', order, reason: 'Idempotent order already exists' };
}

function orderQuote(listing: RawListing, config: ArbitrageConfig): BuyQuote {
  const taxCents = percentOfCents(listing.priceCents, config.salesTaxRate);
  return {
    askPriceCents: listing.priceCents,
    shippingCents: listing.shippingCents,
    taxCents,
    landedCostCents: listing.priceCents + listing.shippingCents + taxCents,
  };
}

function approvedListing(order: PurchaseOrder): RawListing {
  return {
    listingId: order.listingId, source: order.source, title: order.listingTitle, description: '',
    url: order.listingUrl, priceCents: order.askPriceCents, shippingCents: order.shippingCents,
    quantity: order.quantity, currency: 'USD', imageUrls: [], supportsAutoCheckout: false,
    seller: {
      sellerId: '', username: '', feedbackScore: 0, positivePercent: 0,
      accountAgeDays: 0, returnsAccepted: false,
    },
    listedAt: order.createdAt, fetchedAt: order.createdAt,
  };
}

export class ExecutionCoordinator {
  private readonly db: ArbitrageDatabase;
  private readonly config: ArbitrageConfig;
  private readonly adapter: ExecutionAdapter;
  private readonly lockTtlMs: number;

  constructor(options: ExecutionCoordinatorOptions) {
    this.db = options.db;
    this.config = options.config;
    this.adapter = options.adapter;
    this.lockTtlMs = options.lockTtlMs ?? 30_000;
  }

  private async withListingLock(
    listingKey: string,
    run: (expiresAt: number, ownerId: string) => Promise<ExecutionOutcome>,
  ): Promise<ExecutionOutcome> {
    const ownerId = randomUUID();
    const expiresAt = Date.now() + this.lockTtlMs;
    if (!this.db.acquirePurchaseLock(listingKey, ownerId, this.lockTtlMs)) {
      return { status: 'locked', reason: 'Purchase lock held by another worker' };
    }
    try {
      return await run(expiresAt, ownerId);
    } finally {
      this.db.releasePurchaseLock(listingKey, ownerId);
    }
  }

  private portfolioLimit(order: PurchaseOrder): string | undefined {
    const now = new Date().toISOString();
    const portfolio = this.db.getPortfolioSnapshot(this.config, now);
    // An already-approved order contributes to the snapshot as a reservation.
    const reserved = order.status === 'approved';
    const alreadyCountedToday = reserved && order.createdAt.slice(0, 10) === now.slice(0, 10);
    const incrementalSpend = alreadyCountedToday ? 0 : order.landedCostCents;
    const incrementalUnits = reserved ? 0 : order.quantity;
    if (portfolio.dailySpendCents + incrementalSpend > portfolio.dailySpendCapCents) return 'Daily spend cap exceeded';
    if ((portfolio.skuPositions[order.skuId] ?? 0) + incrementalUnits > this.config.maxPositionPerSku) {
      return 'Per-SKU max position limit reached';
    }
    if (portfolio.cashBalanceCents - order.landedCostCents < portfolio.minCashReserveCents) {
      return 'Cash reserve floor breached';
    }
    return undefined;
  }

  private checkoutBlock(order: PurchaseOrder): string | undefined {
    if (this.db.getSystemState().killSwitchEngaged) return 'Kill switch engaged';
    const inFlight = this.db.listOrders('executing', -1).some(candidate =>
      candidate.listingId === order.listingId && candidate.source === order.source);
    if (inFlight) return 'Another checkout is already in progress for this listing';
    return this.portfolioLimit(order);
  }

  private reserveCheckout(
    order: PurchaseOrder,
    expiresAt: number,
    ownerId: string,
    reserve: () => PurchaseOrder | ExecutionOutcome,
  ): PurchaseOrder | ExecutionOutcome {
    // Serialize the snapshot and order reservation across workers checking different listings.
    if (!this.db.acquirePurchaseLock(portfolioLockKey, ownerId, this.lockTtlMs)) {
      return { status: 'locked', reason: 'Portfolio reservation held by another worker' };
    }
    try {
      if (Date.now() >= expiresAt) return { status: 'aborted', reason: 'Purchase lock expired before checkout' };
      const reason = this.checkoutBlock(order);
      return reason ? { status: 'aborted', reason } : reserve();
    } finally {
      this.db.releasePurchaseLock(portfolioLockKey, ownerId);
    }
  }

  private async verifyQuote(listing: RawListing, order: BuyQuote): Promise<BuyQuote | string> {
    let live: LiveListingCheck;
    try {
      live = await this.adapter.verifyLiveListing(listing);
    } catch (error) {
      return errorMessage(error, 'Live listing verification failed');
    }
    if (!live.available) return live.reason ?? 'Listing is unavailable';
    if (!Number.isSafeInteger(live.currentPriceCents) || live.currentPriceCents <= 0 ||
        !Number.isSafeInteger(live.currentShippingCents) || live.currentShippingCents < 0) {
      return 'Live listing returned an invalid USD quote';
    }
    const quote = orderQuote({
      ...listing, priceCents: live.currentPriceCents, shippingCents: live.currentShippingCents,
    }, this.config);
    if (quote.askPriceCents + quote.shippingCents > order.askPriceCents + order.shippingCents ||
        quote.landedCostCents > order.landedCostCents) {
      return 'Live price drifted higher before checkout';
    }
    return quote;
  }

  async executeDecision(decision: ArbitrageDecision, listing: RawListing, sku?: CanonicalSku): Promise<ExecutionOutcome> {
    const { skuId, bestExit } = decision;
    if (decision.action === 'skip' || !skuId || !bestExit) {
      return { status: 'skipped', reason: decision.reasons[0] ?? 'Decision skipped' };
    }
    if (decision.source !== listing.source || decision.listingId !== listing.listingId) {
      return { status: 'aborted', reason: 'Decision does not match the listing' };
    }

    const listingKey = `${listing.source}:${listing.listingId}`;
    return this.withListingLock(listingKey, async (expiresAt, ownerId) => {
      const idempotencyKey = createHash('sha256')
        .update(`${listingKey}:${listing.priceCents}:${listing.shippingCents}`).digest('hex');
      const existing = this.db.getOrderByIdempotencyKey(idempotencyKey);
      if (existing) return duplicate(existing);

      const canonicalSku = sku?.id === skuId ? sku : this.db.getSku(skuId);
      const now = new Date().toISOString();
      const id = randomUUID();
      const status = decision.operatingMode === 'shadow' ? 'shadow_recorded'
        : decision.operatingMode === 'hitl' || decision.action === 'hitl_review' || !listing.supportsAutoCheckout
          ? 'pending_hitl' : 'executing';
      const order: PurchaseOrder = {
        id, idempotencyKey, decisionId: decision.id, listingId: listing.listingId, source: listing.source,
        listingUrl: listing.url, listingTitle: listing.title, skuId, skuName: decision.skuName ?? canonicalSku?.name ?? skuId,
        assetClass: decision.assetClass ?? canonicalSku?.assetClass ?? 'raw', status, quantity: 1,
        askPriceCents: bestExit.askPriceCents, shippingCents: bestExit.inboundShippingCents,
        taxCents: bestExit.estimatedTaxCents, landedCostCents: bestExit.landedCostCents,
        expectedNetProfitCents: bestExit.netProfitCents, expectedNetRoi: bestExit.netRoi,
        recommendedExitChannel: bestExit.exitChannel, decisionWarnings: decision.warnings, createdAt: now, updatedAt: now,
      };

      if (status !== 'executing') {
        if (status === 'shadow_recorded') order.externalOrderId = `shadow-${id}`;
        const saved = this.db.createOrderIdempotent(order);
        if (!saved.created) return duplicate(saved.order);
        this.audit(order, status);
        return { status, order: saved.order };
      }

      const blocked = this.checkoutBlock(order);
      if (blocked) return { status: 'aborted', reason: blocked };
      const quote = await this.verifyQuote(listing, order);
      if (typeof quote === 'string') return { status: 'aborted', reason: quote };
      if (quote.landedCostCents > this.config.autoBuyMaxOrderCents) {
        return { status: 'aborted', reason: 'Auto-buy single-order limit exceeded' };
      }
      const expectedNetProfitCents = bestExit.netProfitCents + bestExit.landedCostCents - quote.landedCostCents +
        bestExit.riskReserveCents - percentOfCents(quote.landedCostCents, this.config.riskReserveRates[order.assetClass]);
      const liveOrder = {
        ...order, ...quote, expectedNetProfitCents, expectedNetRoi: expectedNetProfitCents / quote.landedCostCents,
      };
      const reserved = this.reserveCheckout(liveOrder, expiresAt, ownerId, () => {
        const saved = this.db.createOrderIdempotent(liveOrder);
        return saved.created ? saved.order : duplicate(saved.order);
      });
      if (!('id' in reserved)) return reserved;
      return this.place(reserved, listing, decision.fmvCents, canonicalSku);
    });
  }

  async executeApprovedOrder(orderId: string, listing?: RawListing): Promise<ExecutionOutcome> {
    const initial = this.db.getOrder(orderId);
    if (!initial) return { status: 'aborted', reason: 'Order not found' };
    return this.withListingLock(`${initial.source}:${initial.listingId}`, async (expiresAt, ownerId) => {
      const order = this.db.getOrder(orderId);
      if (!order || order.status !== 'pending_hitl' && order.status !== 'approved') {
        return { status: 'aborted', order, reason: 'Order is not awaiting human approval or execution' };
      }
      if (listing && (listing.source !== order.source || listing.listingId !== order.listingId)) {
        return { status: 'aborted', order, reason: 'Listing does not match the approved order' };
      }
      const blocked = this.checkoutBlock(order);
      if (blocked) return { status: 'aborted', order, reason: blocked };
      if (listing) {
        const quote = await this.verifyQuote(listing, order);
        if (typeof quote === 'string') return { status: 'aborted', order, reason: quote };
      }

      const decision = this.db.listDecisions(-1).find(candidate => candidate.id === order.decisionId);
      const sku = this.db.getSku(order.skuId);
      const reserved = this.reserveCheckout(order, expiresAt, ownerId, () => {
        const current = this.db.getOrder(order.id);
        if (!current || current.status !== order.status) {
          return { status: 'aborted', order: current, reason: 'Approval status changed before checkout' };
        }
        if (current.status === 'pending_hitl') this.setOrderStatus(order.id, 'approved');
        return this.setOrderStatus(order.id, 'executing');
      });
      if (!('id' in reserved)) return { order, ...reserved };
      return this.place(reserved, listing ?? approvedListing(order), decision?.fmvCents, sku);
    });
  }

  private audit(order: PurchaseOrder, event: string): void {
    this.db.logAuditEvent(`order.${event}`, {
      orderId: order.id, decisionId: order.decisionId, listingId: order.listingId,
      source: order.source, externalOrderId: order.externalOrderId, failureReason: order.failureReason,
    });
  }

  private setOrderStatus(
    id: string,
    status: PurchaseOrder['status'],
    patch?: { externalOrderId?: string; failureReason?: string },
  ): PurchaseOrder {
    const order = this.db.updateOrderStatus(id, status, patch);
    if (!order) throw new Error(`Order ${id} disappeared during checkout`);
    return order;
  }

  private async place(
    order: PurchaseOrder, listing: RawListing, fmvCents = 0, sku?: CanonicalSku,
  ): Promise<ExecutionOutcome> {
    let result: ExecutePurchaseResult;
    try {
      result = await this.adapter.executePurchase(order, listing);
    } catch (error) {
      result = { success: false, failureReason: errorMessage(error, 'Purchase adapter failed') };
    }
    if (!result.success) {
      const reason = result.failureReason ?? 'Purchase failed';
      const failed = this.setOrderStatus(order.id, 'failed', { failureReason: reason, externalOrderId: result.externalOrderId });
      this.audit(failed, 'failed');
      return { status: 'failed', order: failed, reason };
    }

    // Save the receipt before inventory work. If a DB write fails, the executing order remains reserved.
    const receipt = this.setOrderStatus(order.id, 'executing', { externalOrderId: result.externalOrderId });
    const now = new Date().toISOString();
    const inventoryItem: InventoryItem = {
      id: `inventory-${order.id}`, orderId: order.id, skuId: order.skuId, skuName: order.skuName,
      assetClass: order.assetClass, expectedCondition: listing.conditionHint ?? (order.assetClass === 'sealed' ? 'SEALED' : 'NM'),
      grader: sku?.grader ?? listing.graderHint, grade: sku?.grade ?? listing.gradeHint,
      costBasisCents: order.landedCostCents, expectedExitChannel: order.recommendedExitChannel,
      expectedFmvCents: fmvCents, predictedNetProfitCents: order.expectedNetProfitCents,
      status: 'in_transit', acquiredAt: now, updatedAt: now,
    };
    this.db.createInventoryItem(inventoryItem);
    const filled = this.setOrderStatus(receipt.id, 'filled');
    this.audit(filled, 'filled');
    return { status: 'filled', order: filled, inventoryItem };
  }
}
