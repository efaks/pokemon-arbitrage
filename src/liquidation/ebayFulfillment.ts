import { fetchWithBackoff } from '../connectors/base.ts';
import type { FetchLike } from '../connectors/base.ts';
import { EbayOAuthTokenManager, withEbayToken } from '../connectors/ebayAuth.ts';
import type { EbayTokenProvider } from '../connectors/ebayAuth.ts';
import type { ArbitrageDatabase } from '../db/database.ts';
import { toCents } from '../domain/money.ts';
import type { InventoryManager } from './inventoryManager.ts';

export interface ExternalSoldOrder {
  externalOrderId: string;
  externalListingId?: string;
  inventorySku?: string;
  soldPriceCents: number;
  exitFeesCents?: number;
  soldAt: string;
  buyerPaid: boolean;
}

export interface FulfillmentSyncSummary {
  adapterName: string;
  enabled: boolean;
  ordersFetched: number;
  reconciledCount: number;
  skippedCount: number;
  reconciledInventoryIds: string[];
  errors: string[];
}

type FetchOrdersOptions = { sinceIso?: string; limit?: number };

export interface FulfillmentAdapter {
  readonly name: string;
  isConfigured(): boolean;
  fetchPaidOrders(options?: FetchOrdersOptions): Promise<ExternalSoldOrder[]>;
}

export class DisabledFulfillmentAdapter implements FulfillmentAdapter {
  readonly name = 'Disabled fulfillment';
  isConfigured(): boolean { return false; }
  async fetchPaidOrders(): Promise<ExternalSoldOrder[]> { return []; }
}

export class SimulatedFulfillmentAdapter implements FulfillmentAdapter {
  readonly name = 'Simulated fulfillment';
  orders: ExternalSoldOrder[];

  constructor(orders: ExternalSoldOrder[] = []) {
    this.orders = orders;
  }

  isConfigured(): boolean { return true; }

  async fetchPaidOrders({ sinceIso, limit }: FetchOrdersOptions = {}): Promise<ExternalSoldOrder[]> {
    return this.orders.filter(order => order.buyerPaid &&
      (sinceIso === undefined || Date.parse(order.soldAt) >= Date.parse(sinceIso))).slice(0, limit);
  }
}

interface EbayFulfillmentOptions {
  tokenProvider?: EbayTokenProvider;
  accessToken?: string;
  refreshToken?: string;
  clientId?: string;
  clientSecret?: string;
  sandbox?: boolean;
  baseUrl?: string;
  fetchFn?: FetchLike;
}

interface EbayAmount {
  value?: string;
  currency?: string;
  convertedFromValue?: string;
  convertedFromCurrency?: string;
}

interface EbayOrder {
  orderId?: string;
  orderPaymentStatus?: string;
  creationDate?: string;
  cancelStatus?: { cancelState?: string };
  lineItems?: { sku?: string; legacyItemId?: string; lineItemCost?: EbayAmount }[];
  pricingSummary?: { total?: EbayAmount };
  paymentSummary?: { totalDueSeller?: EbayAmount };
  totalMarketplaceFee?: EbayAmount;
}

function usdCents(amount?: EbayAmount): number | undefined {
  const value = amount?.currency === 'USD' || amount?.currency === undefined ? amount?.value
    : amount.convertedFromCurrency === 'USD' ? amount.convertedFromValue : undefined;
  if (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value)) return undefined;
  const cents = toCents(Number(value));
  return Number.isSafeInteger(cents) ? cents : undefined;
}

function paidOrderLines(order: EbayOrder): ExternalSoldOrder[] {
  if (order.orderPaymentStatus !== 'PAID' || order.cancelStatus?.cancelState === 'CANCELED' ||
      !order.orderId || !order.creationDate || !Number.isFinite(Date.parse(order.creationDate))) return [];
  const externalOrderId = order.orderId;
  const soldAt = order.creationDate;
  const lines = order.lineItems ?? [];
  const orderTotal = usdCents(order.pricingSummary?.total);
  const linePrices = lines.map(line => usdCents(line.lineItemCost) ?? (lines.length === 1 ? orderTotal : undefined));
  const lineTotal = linePrices.every(value => value !== undefined) ? linePrices.reduce((sum, value) => sum + value, 0) : undefined;
  const gross = orderTotal ?? lineTotal;
  const payout = usdCents(order.paymentSummary?.totalDueSeller);
  const fees = usdCents(order.totalMarketplaceFee) ??
    (gross !== undefined && payout !== undefined && gross >= payout ? gross - payout : undefined);
  let cumulativePrice = 0;
  let allocatedFees = 0;
  return lines.flatMap((line, index) => {
    const soldPriceCents = linePrices[index];
    if (soldPriceCents === undefined || soldPriceCents <= 0) return [];
    let exitFeesCents: number | undefined;
    // Allocate order-level fees across all lines, including products outside our inventory.
    if (fees !== undefined && lineTotal && Number.isSafeInteger(lineTotal)) {
      cumulativePrice += soldPriceCents;
      const cumulativeFees = Math.round(cumulativePrice / lineTotal * fees);
      exitFeesCents = cumulativeFees - allocatedFees;
      allocatedFees = cumulativeFees;
    }
    return [{
      externalOrderId, externalListingId: line.legacyItemId, inventorySku: line.sku,
      soldPriceCents, exitFeesCents, soldAt, buyerPaid: true,
    }];
  });
}

export class EbayFulfillmentAdapter implements FulfillmentAdapter {
  readonly name = 'eBay Sell Fulfillment API';
  private readonly tokenProvider: EbayTokenProvider;
  private readonly baseUrl: string;
  private readonly fetchFn?: FetchLike;

  constructor(options: EbayFulfillmentOptions = {}) {
    const sandbox = options.sandbox ?? process.env.EBAY_SELL_SANDBOX === 'true';
    const accessToken = (options.accessToken ?? process.env.EBAY_SELL_API_TOKEN ?? '').trim();
    const refreshToken = (options.refreshToken ?? (process.env.EBAY_SELL_REFRESH_TOKEN?.trim() || process.env.EBAY_REFRESH_TOKEN || '')).trim();
    const clientId = (options.clientId ?? process.env.EBAY_CLIENT_ID ?? '').trim();
    const clientSecret = (options.clientSecret ?? process.env.EBAY_CLIENT_SECRET ?? '').trim();
    const useOAuth = Boolean(refreshToken && clientId && clientSecret);
    this.baseUrl = (options.baseUrl ?? `https://api.${sandbox ? 'sandbox.' : ''}ebay.com`).replace(/\/+$/, '');
    this.fetchFn = options.fetchFn;
    this.tokenProvider = options.tokenProvider ?? new EbayOAuthTokenManager({
      staticToken: accessToken, refreshToken, clientId: useOAuth ? clientId : '', clientSecret: useOAuth ? clientSecret : '',
      sandbox, fetchFn: this.fetchFn, scopes: ['https://api.ebay.com/oauth/api_scope/sell.fulfillment.readonly'],
    });
  }

  isConfigured(): boolean { return this.tokenProvider.isConfigured(); }

  async fetchPaidOrders({ sinceIso, limit = 50 }: FetchOrdersOptions = {}): Promise<ExternalSoldOrder[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
      throw new RangeError('eBay fulfillment limit must be an integer from 1 to 200');
    }
    const query = new URLSearchParams({ limit: String(limit) });
    if (sinceIso) query.set('filter', `creationdate:[${sinceIso}..]`);
    const response = await withEbayToken(this.tokenProvider, token => fetchWithBackoff(`${this.baseUrl}/sell/fulfillment/v1/order?${query}`, {
      method: 'GET', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      redirect: 'error', signal: AbortSignal.timeout(15_000),
    }, { fetchFn: this.fetchFn }));
    const data = await response.json() as { orders?: EbayOrder[] };
    return (data.orders ?? []).flatMap(paidOrderLines);
  }
}

export class SalesReconciler {
  private readonly db: ArbitrageDatabase;
  private readonly inventoryManager: InventoryManager;
  private readonly adapter: FulfillmentAdapter;

  constructor(db: ArbitrageDatabase, inventoryManager: InventoryManager, adapter: FulfillmentAdapter) {
    this.db = db;
    this.inventoryManager = inventoryManager;
    this.adapter = adapter;
  }

  getAdapter(): FulfillmentAdapter { return this.adapter; }

  isConfigured(): boolean { return this.adapter.isConfigured(); }

  async reconcileSoldOrders(options?: FetchOrdersOptions): Promise<FulfillmentSyncSummary> {
    const summary: FulfillmentSyncSummary = {
      adapterName: this.adapter.name, enabled: this.isConfigured(), ordersFetched: 0, reconciledCount: 0,
      skippedCount: 0, reconciledInventoryIds: [], errors: [],
    };
    if (!summary.enabled) return summary;

    let orders: ExternalSoldOrder[];
    try {
      orders = await this.adapter.fetchPaidOrders(options);
    } catch (error) {
      summary.errors.push(error instanceof Error ? error.message : 'Could not fetch paid fulfillment orders');
      return summary;
    }
    summary.ordersFetched = orders.length;
    const inventory = this.db.listInventory();
    const bySku = new Map(inventory.map(item => [`pa-${item.id}`, item]));
    for (const order of orders) {
      const item = order.buyerPaid ? bySku.get(order.inventorySku ?? '') ??
        inventory.find(item => order.externalListingId && item.externalListingId === order.externalListingId) : undefined;
      if (!item || item.status === 'sold') {
        summary.skippedCount++;
        continue;
      }
      try {
        const sold = this.db.withWriteTransaction(() => {
          // Another process may have recorded this sale or changed the listing since the snapshot.
          const current = this.db.getInventoryItem(item.id);
          if (!current || current.status === 'sold') return false;
          if (order.inventorySku !== `pa-${current.id}` &&
              (!order.externalListingId || current.externalListingId !== order.externalListingId)) return false;
          this.inventoryManager.recordSale(item.id, {
            exitChannel: 'ebay', soldPriceCents: order.soldPriceCents, exitFeesCents: order.exitFeesCents, soldAt: order.soldAt,
          });
          this.db.logAuditEvent('inventory.sale_reconciled', { inventoryId: item.id, externalOrderId: order.externalOrderId });
          return true;
        });
        if (sold) {
          summary.reconciledCount++;
          summary.reconciledInventoryIds.push(item.id);
        } else {
          summary.skippedCount++;
        }
      } catch (error) {
        summary.errors.push(`${order.externalOrderId}: ${error instanceof Error ? error.message : 'Could not record sale'}`);
      }
    }
    return summary;
  }
}
