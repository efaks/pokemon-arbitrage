import type { ArbitrageConfig } from '../config.ts';
import type { ArbitrageDatabase } from '../db/database.ts';
import { percentOfCents } from '../domain/money.ts';
import type { CardCondition, ExitChannel, InventoryItem, ProfitBreakdown, RawListing } from '../domain/types.ts';
import type { FmvEngine } from '../valuation/fmvEngine.ts';
import { evaluateExitChannels } from '../valuation/profitCalculator.ts';
import { DisabledSellerAdapter } from './ebaySellerAdapter.ts';
import type { PublishListingInput, SellListingAdapter } from './ebaySellerAdapter.ts';

export interface ExitRecommendation {
  inventoryId: string;
  skuId: string;
  recommendedChannel: ExitChannel;
  expectedFmvCents: number;
  expectedNetProceedsCents: number;
  expectedNetProfitCents: number;
  channels: ProfitBreakdown[];
  rationale: string;
}

export interface PnLAttributionSummary {
  totalItems: number;
  soldItems: number;
  /** Items currently in transit, cleared by QC, or listed. */
  activeItems: number;
  disputedCount: number;
  totalCostBasisCents: number;
  totalPredictedProfitCents: number;
  totalRealizedProfitCents: number;
  /** Realized profit minus the original forecast for the sold items. */
  realizedVsPredictedDeltaCents: number;
}

const conditionRank: Record<CardCondition, number> = { SEALED: 6, NM: 5, LP: 4, MP: 3, HP: 2, DMG: 1 };

function assertCents(value: number, label: string, minimum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new RangeError(`${label} must be an integer number of cents (minimum ${minimum})`);
  }
}

export class InventoryListingError extends Error {
  readonly status: 409 | 502;

  constructor(message: string, status: 409 | 502 = 409) {
    super(message);
    this.status = status;
  }
}

export class InventoryManager {
  private readonly db: ArbitrageDatabase;
  private readonly fmvEngine: FmvEngine;
  private readonly config: ArbitrageConfig;
  private readonly sellerAdapter: SellListingAdapter;
  private readonly listingOperations = new Set<string>();

  constructor(
    db: ArbitrageDatabase, fmvEngine: FmvEngine, config: ArbitrageConfig,
    sellerAdapter: SellListingAdapter = new DisabledSellerAdapter(),
  ) {
    this.db = db;
    this.fmvEngine = fmvEngine;
    this.config = config;
    this.sellerAdapter = sellerAdapter;
  }

  getSellerAdapter(): SellListingAdapter {
    return this.sellerAdapter;
  }

  private assertListingIdle(id: string): void {
    if (this.listingOperations.has(id)) throw new InventoryListingError('A listing operation is already in progress');
  }

  private async withListingOperation<T>(id: string, operation: () => Promise<T>): Promise<T> {
    this.assertListingIdle(id);
    this.listingOperations.add(id);
    try {
      return await operation();
    } finally {
      this.listingOperations.delete(id);
    }
  }

  private requireItem(id: string): InventoryItem {
    const item = this.db.getInventoryItem(id);
    if (!item) throw new Error(`Inventory item ${id} not found`);
    return item;
  }

  private update(id: string, patch: Partial<InventoryItem>): InventoryItem {
    const updated = this.db.updateInventoryItem(id, patch);
    if (!updated) throw new Error(`Inventory item ${id} not found`);
    return updated;
  }

  recordIntakeQc(
    inventoryId: string, input: { passed: boolean; actualCondition: CardCondition; notes?: string },
  ): InventoryItem {
    const item = this.requireItem(inventoryId);
    this.assertListingIdle(inventoryId);
    if (item.status === 'sold') throw new Error('QC cannot be updated after sale');
    if (item.externalOfferId && item.status === 'listed') throw new InventoryListingError('Withdraw the active listing before changing QC');
    const degraded = conditionRank[input.actualCondition] < conditionRank[item.expectedCondition];
    const status = input.passed && !degraded ? 'qc_passed' : 'qc_disputed';
    const updated = this.update(inventoryId, { status, actualCondition: input.actualCondition, qcNotes: input.notes });
    this.db.logAuditEvent('inventory.qc_recorded', { inventoryId, status, expectedCondition: item.expectedCondition, ...input, degraded });
    return updated;
  }

  recommendExit(inventoryId: string, nowIso?: string): ExitRecommendation {
    const item = this.requireItem(inventoryId);
    const sku = this.db.getSku(item.skuId);
    if (!sku) throw new Error(`SKU ${item.skuId} not found`);
    const condition = item.actualCondition ?? item.expectedCondition;
    const valuation = this.fmvEngine.evaluate(sku, this.db.getSoldComps(item.skuId), this.config, {
      condition, grader: item.grader, grade: item.grade, nowIso,
    });
    const listing: RawListing = {
      listingId: inventoryId, source: 'mock_feed', title: item.skuName, description: '', url: '',
      priceCents: item.costBasisCents, shippingCents: 0, quantity: 1, currency: 'USD', conditionHint: condition,
      imageUrls: [], supportsAutoCheckout: false, listedAt: item.acquiredAt, fetchedAt: item.acquiredAt,
      seller: { sellerId: '', username: '', feedbackScore: 0, positivePercent: 0, accountAgeDays: 0, returnsAccepted: false },
    };
    // The stored basis already includes purchase tax and inbound shipping.
    const { bestExit, allExits } = evaluateExitChannels(listing, valuation.fmvCents, item.assetClass, {
      ...this.config, salesTaxRate: 0,
    });
    const market = allExits.find(exit => exit.exitChannel !== 'buylist');
    const buylist = allExits.find(exit => exit.exitChannel === 'buylist');
    let rationale = 'Highest estimated net profit after selling costs and risk reserve.';
    if (bestExit.exitChannel === 'buylist') {
      rationale += ' Buylist also offers immediate cash turnover.';
    } else if (market && buylist && market.netProfitCents > 0 &&
        buylist.netProfitCents >= market.netProfitCents - percentOfCents(market.netProfitCents, 0.05)) {
      rationale += ' Buylist is within 5% of the best market profit and offers immediate cash turnover.';
    }
    if (valuation.isStale) rationale += ' Comparable sales are stale or insufficient.';
    return {
      inventoryId, skuId: sku.id, recommendedChannel: bestExit.exitChannel, expectedFmvCents: valuation.fmvCents,
      expectedNetProceedsCents: bestExit.netProceedsCents, expectedNetProfitCents: bestExit.netProfitCents,
      channels: allExits, rationale,
    };
  }

  markListed(inventoryId: string, channel: ExitChannel, listedPriceCents: number): InventoryItem {
    const item = this.requireItem(inventoryId);
    this.assertListingIdle(inventoryId);
    if (item.status !== 'qc_passed' && item.status !== 'listed') throw new Error('Inventory must pass QC before listing');
    if (item.externalOfferId) throw new InventoryListingError('Update the active listing through its selling adapter or withdraw it first');
    assertCents(listedPriceCents, 'Listed price', 1);
    const updated = this.update(inventoryId, { status: 'listed', listedChannel: channel, listedPriceCents });
    this.db.logAuditEvent('inventory.listed', { inventoryId, channel, listedPriceCents });
    return updated;
  }

  async publishListing(
    inventoryId: string,
    input: Partial<PublishListingInput> & { channel?: ExitChannel; listedPriceCents?: number; pushLive?: boolean } = {},
  ): Promise<InventoryItem> {
    this.assertListingIdle(inventoryId);
    const item = this.requireItem(inventoryId);
    if (item.status !== 'qc_passed' && item.status !== 'listed') throw new InventoryListingError('Inventory must pass QC before listing');
    const channel = input.channel ?? item.expectedExitChannel;
    const fmv = input.listedPriceCents === undefined && input.priceCents === undefined
      ? this.recommendExit(inventoryId).expectedFmvCents : 0;
    const priceCents = input.listedPriceCents ?? input.priceCents ?? (fmv > 0 ? fmv : item.expectedFmvCents);
    assertCents(priceCents, 'Listed price', 1);
    if (input.pushLive === false || channel !== this.sellerAdapter.channel || !this.sellerAdapter.isConfigured()) {
      return this.markListed(inventoryId, channel, priceCents);
    }
    const sku = this.db.getSku(item.skuId);
    if (!sku) throw new InventoryListingError(`SKU ${item.skuId} not found`);
    return this.withListingOperation(inventoryId, async () => {
      const result = await this.sellerAdapter.publishListing(item, sku, { ...input, priceCents });
      const { externalOfferId, externalListingId, externalListingUrl } = result;
      if (!result.success || !externalOfferId || !externalListingId) {
        throw new InventoryListingError(result.failureReason ?? 'Selling adapter did not confirm publication', 502);
      }
      const updated = this.update(inventoryId, {
        externalOfferId, externalListingId, externalListingUrl, status: 'listed', listedChannel: channel, listedPriceCents: priceCents,
      });
      this.db.logAuditEvent('inventory.published_live', { inventoryId, channel, priceCents, externalOfferId, externalListingId, externalListingUrl });
      return updated;
    });
  }

  async syncReprice(inventoryId: string, newPriceCents: number): Promise<InventoryItem> {
    return this.withListingOperation(inventoryId, async () => {
      const item = this.requireItem(inventoryId);
      if (item.status !== 'listed') throw new InventoryListingError('Inventory must be listed before repricing');
      assertCents(newPriceCents, 'Listed price', 1);
      if (item.externalOfferId) {
        if (!this.sellerAdapter.isConfigured()) throw new InventoryListingError('Configure the selling adapter before repricing the active offer');
        const result = await this.sellerAdapter.updateListingPrice(item, newPriceCents);
        if (!result.success) throw new InventoryListingError(result.failureReason ?? 'Selling adapter could not update the price', 502);
      }
      return this.update(inventoryId, { listedPriceCents: newPriceCents });
    });
  }

  async withdrawListing(inventoryId: string, reason?: string): Promise<InventoryItem> {
    return this.withListingOperation(inventoryId, async () => {
      const item = this.requireItem(inventoryId);
      if (item.status !== 'listed') throw new InventoryListingError('Inventory must be listed before withdrawal');
      if (item.externalOfferId) {
        if (!this.sellerAdapter.isConfigured()) throw new InventoryListingError('Configure the selling adapter before withdrawing the active offer');
        const result = await this.sellerAdapter.withdrawListing(item);
        if (!result.success) throw new InventoryListingError(result.failureReason ?? 'Selling adapter could not withdraw the listing', 502);
      }
      const updated = this.update(inventoryId, {
        status: 'qc_passed', listedChannel: undefined, listedPriceCents: undefined,
        externalOfferId: undefined, externalListingId: undefined, externalListingUrl: undefined,
      });
      this.db.logAuditEvent('inventory.withdrawn', {
        inventoryId, reason, externalOfferId: item.externalOfferId, externalListingId: item.externalListingId,
      });
      return updated;
    });
  }

  recordSale(
    inventoryId: string,
    input: { exitChannel: ExitChannel; soldPriceCents: number; exitFeesCents?: number; soldAt?: string },
  ): InventoryItem {
    const item = this.requireItem(inventoryId);
    this.assertListingIdle(inventoryId);
    if (item.status === 'sold') throw new Error('Inventory item is already sold');
    assertCents(input.soldPriceCents, 'Sold price', 1);
    const schedule = this.config.exitFeeSchedules[input.exitChannel];
    const exitFeesCents = input.exitFeesCents ?? (
      percentOfCents(input.soldPriceCents, schedule.percentFee) + schedule.fixedFeeCents +
      this.config.outboundShippingCents[item.assetClass] + this.config.packagingCents[item.assetClass]
    );
    assertCents(exitFeesCents, 'Exit fees', 0);
    const realizedProfitCents = input.soldPriceCents - exitFeesCents - item.costBasisCents;
    const soldAt = input.soldAt ?? new Date().toISOString();
    const updated = this.update(inventoryId, {
      status: 'sold', soldChannel: input.exitChannel, soldPriceCents: input.soldPriceCents,
      exitFeesCents, realizedProfitCents, soldAt,
    });
    this.db.logAuditEvent('inventory.sold', {
      inventoryId, exitChannel: input.exitChannel, soldPriceCents: input.soldPriceCents, exitFeesCents, realizedProfitCents, soldAt,
    });
    return updated;
  }

  getPnLAttribution(): PnLAttributionSummary {
    const items = this.db.listInventory();
    const summary: PnLAttributionSummary = {
      totalItems: items.length, soldItems: 0, activeItems: 0, disputedCount: 0, totalCostBasisCents: 0,
      totalPredictedProfitCents: 0, totalRealizedProfitCents: 0, realizedVsPredictedDeltaCents: 0,
    };
    for (const item of items) {
      summary.totalCostBasisCents += item.costBasisCents;
      summary.totalPredictedProfitCents += item.predictedNetProfitCents;
      if (item.status === 'qc_disputed') {
        summary.disputedCount++;
      } else if (item.status === 'sold') {
        summary.soldItems++;
        const realized = item.realizedProfitCents ?? 0;
        summary.totalRealizedProfitCents += realized;
        summary.realizedVsPredictedDeltaCents += realized - item.predictedNetProfitCents;
      } else {
        summary.activeItems++;
      }
    }
    return summary;
  }
}
