import type { ArbitrageConfig } from '../config.ts';
import type { ArbitrageDatabase } from '../db/database.ts';
import { ageInDays } from '../domain/money.ts';
import type { AssetClass, CardLanguage, ExitChannel, ProfitBreakdown, RawListing, SoldComp } from '../domain/types.ts';
import type { FmvEngine } from '../valuation/fmvEngine.ts';
import { calculateNetProfit, evaluateExitChannels } from '../valuation/profitCalculator.ts';

export type MomentumStatus = 'rising' | 'stable' | 'cooling' | 'falling_knife';
export type PriorityTier = 'hot' | 'standard' | 'cold';

export interface BuyBookEntry {
  skuId: string;
  skuName: string;
  assetClass: AssetClass;
  language: CardLanguage;
  upc?: string;
  fmvCents: number;
  liquidityScore: number;
  isStale: boolean;
  momentumStatus: MomentumStatus;
  momentumPct: number;
  bestExitChannel: ExitChannel;
  maxAutoBuyAskCents: number;
  buylistFloorAskCents: number;
  anomalyFloorAskCents: number;
  priorityTier: PriorityTier;
  computedAt: string;
}

export interface QuickScreenResult {
  found: boolean;
  eligible: boolean;
  isBuylistFloorArb: boolean;
  isFallingKnife: boolean;
  estimatedHeadroomCents: number;
  entry?: BuyBookEntry;
  reason: string;
}

function doubledMedian(prices: number[]): number {
  prices.sort((a, b) => a - b);
  return prices[Math.floor((prices.length - 1) / 2)] + prices[Math.floor(prices.length / 2)];
}

function momentum(comps: SoldComp[], nowIso: string): Pick<BuyBookEntry, 'momentumStatus' | 'momentumPct'> {
  const recent: number[] = [];
  const older: number[] = [];
  for (const comp of comps) {
    const age = ageInDays(comp.soldAt, nowIso);
    if (age >= 0 && age <= 10) recent.push(comp.totalPriceCents);
    else if (age > 10 && age <= 60) older.push(comp.totalPriceCents);
  }
  if (recent.length < 2 || older.length < 2) return { momentumPct: 0, momentumStatus: 'stable' };
  const baseline = doubledMedian(older);
  const momentumPct = baseline > 0 ? (doubledMedian(recent) - baseline) / baseline : 0;
  const momentumStatus = momentumPct <= -0.15 ? 'falling_knife'
    : momentumPct <= -0.05 ? 'cooling' : momentumPct >= 0.05 ? 'rising' : 'stable';
  return { momentumPct, momentumStatus };
}

function highestAsk(fmvCents: number, config: ArbitrageConfig, profitAt: (ask: number) => ProfitBreakdown): number {
  let low = 1;
  let high = fmvCents;
  while (low <= high) {
    const ask = low + Math.floor((high - low) / 2);
    const profit = profitAt(ask);
    if (profit.netProfitCents >= config.minNetProfitCents && profit.netRoi >= config.minNetRoi) low = ask + 1;
    else high = ask - 1;
  }
  return Math.max(0, high);
}

export class BuyBook {
  private entries = new Map<string, BuyBookEntry>();
  private upcs = new Map<string, BuyBookEntry>();
  private maxAnomalyDiscount = 0;

  refresh(db: ArbitrageDatabase, fmvEngine: FmvEngine, config: ArbitrageConfig, nowIso = new Date().toISOString()): BuyBookEntry[] {
    const entries = new Map<string, BuyBookEntry>();
    const upcs = new Map<string, BuyBookEntry>();
    for (const sku of db.listSkus()) {
      const comps = db.getSoldComps(sku.id);
      const condition = sku.assetClass === 'sealed' ? 'SEALED' : 'NM';
      const { fmvCents, liquidityScore, isStale } = fmvEngine.evaluate(sku, comps, config, {
        condition, grader: sku.grader, grade: sku.grade, nowIso,
      });
      const listing: RawListing = {
        listingId: sku.id, source: 'mock_feed', title: sku.name, description: '', url: '',
        priceCents: 0, shippingCents: 0, quantity: 1, currency: 'USD', conditionHint: condition, imageUrls: [],
        seller: { sellerId: '', username: '', feedbackScore: 0, positivePercent: 0, accountAgeDays: 0, returnsAccepted: false },
        supportsAutoCheckout: false, listedAt: nowIso, fetchedAt: nowIso,
      };
      const bestExitAt = (ask: number) =>
        evaluateExitChannels({ ...listing, priceCents: ask }, fmvCents, sku.assetClass, config).bestExit;
      const priorityTier = !isStale && liquidityScore >= 0.70 && fmvCents >= 10_000 ? 'hot'
        : !isStale && liquidityScore >= config.minLiquidityScore ? 'standard' : 'cold';
      const entry: BuyBookEntry = {
        skuId: sku.id, skuName: sku.name, assetClass: sku.assetClass, language: sku.language, upc: sku.upc,
        fmvCents, liquidityScore, isStale, ...momentum(comps, nowIso),
        bestExitChannel: bestExitAt(0).exitChannel,
        maxAutoBuyAskCents: highestAsk(fmvCents, config, bestExitAt),
        buylistFloorAskCents: highestAsk(fmvCents, config, ask =>
          calculateNetProfit({ ...listing, priceCents: ask }, fmvCents, sku.assetClass, 'buylist', config)),
        anomalyFloorAskCents: Math.floor(fmvCents * (1 - config.maxAnomalyDiscount)),
        priorityTier, computedAt: nowIso,
      };
      entries.set(sku.id, entry);
      if (sku.upc && !upcs.has(sku.upc)) upcs.set(sku.upc, entry);
    }
    this.entries = entries;
    this.upcs = upcs;
    this.maxAnomalyDiscount = config.maxAnomalyDiscount;
    return this.list();
  }

  get(skuId: string): BuyBookEntry | undefined {
    return this.entries.get(skuId);
  }

  getByUpc(upc: string): BuyBookEntry | undefined {
    return this.upcs.get(upc);
  }

  list(filter: { tier?: PriorityTier; momentum?: MomentumStatus } = {}): BuyBookEntry[] {
    return [...this.entries.values()].filter(entry =>
      (!filter.tier || entry.priorityTier === filter.tier) && (!filter.momentum || entry.momentumStatus === filter.momentum));
  }

  quickScreen(skuId: string, askPriceCents: number, shippingCents = 0): QuickScreenResult {
    const entry = this.get(skuId);
    const result: QuickScreenResult = {
      found: Boolean(entry), entry, eligible: false, isBuylistFloorArb: false, isFallingKnife: false,
      estimatedHeadroomCents: 0, reason: 'SKU is absent from the Buy Book',
    };
    if (!entry) return result;
    result.isFallingKnife = entry.momentumStatus === 'falling_knife';
    if (!Number.isSafeInteger(askPriceCents) || askPriceCents < 1 ||
        !Number.isSafeInteger(shippingCents) || shippingCents < 0 || !Number.isSafeInteger(askPriceCents + shippingCents)) {
      return { ...result, reason: 'Invalid ask or shipping amount' };
    }
    // Charging shipping against the zero-shipping ceiling is conservative under nonnegative purchase tax.
    const deliveredAsk = askPriceCents + shippingCents;
    result.estimatedHeadroomCents = entry.maxAutoBuyAskCents - deliveredAsk;
    result.isBuylistFloorArb = deliveredAsk <= entry.buylistFloorAskCents;
    if (result.isFallingKnife) return { ...result, reason: 'Momentum guard: falling knife detected' };
    if (entry.priorityTier === 'cold') return { ...result, reason: 'Valuation is stale or liquidity is below threshold' };
    if (entry.fmvCents > 0 && (entry.fmvCents - askPriceCents) / entry.fmvCents > this.maxAnomalyDiscount) {
      return { ...result, reason: 'Ask falls below the anomaly floor' };
    }
    if (result.estimatedHeadroomCents < 0) return { ...result, reason: 'Delivered ask exceeds the Buy Book ceiling' };
    return { ...result, eligible: true, reason: 'Passed preliminary Buy Book screen' };
  }
}
