import type { ArbitrageConfig } from '../config.ts';
import { ageInDays, clamp } from '../domain/money.ts';
import type { CanonicalSku, CardCondition, Grader, SoldComp, ValuationResult } from '../domain/types.ts';

export interface FmvEvaluateOptions {
  condition?: CardCondition;
  grader?: Grader;
  grade?: string;
  nowIso?: string;
}

const PRICE_HALF_LIFE_DAYS = 14;
const LIQUIDITY_WINDOW_DAYS = 30;
const FULL_LIQUIDITY_SALES = 10;
const NO_RECENT_SALES_ESTIMATE_DAYS = 60;

type DatedComp = { comp: SoldComp; ageDays: number };

function quantile(sortedValues: number[], fraction: number): number {
  const index = (sortedValues.length - 1) * fraction;
  const lower = sortedValues[Math.floor(index)];
  const upper = sortedValues[Math.ceil(index)];
  return lower + (upper - lower) * (index % 1);
}

function trimPriceOutliers(comps: DatedComp[], sortedPrices: number[]): DatedComp[] {
  if (comps.length < 4) return comps;

  const q1 = quantile(sortedPrices, 0.25);
  const q3 = quantile(sortedPrices, 0.75);
  const iqr = q3 - q1;
  if (iqr > 0) {
    const margin = 1.5 * iqr;
    return comps.filter(({ comp }) => comp.totalPriceCents >= q1 - margin && comp.totalPriceCents <= q3 + margin);
  }

  const median = quantile(sortedPrices, 0.5);
  const deviations = sortedPrices.map(price => Math.abs(price - median)).sort((a, b) => a - b);
  const mad = quantile(deviations, 0.5);
  // A modified z-score of 3.5 is the cutoff. If MAD is zero, keep the cluster at the median.
  const margin = (3.5 / 0.67448975) * mad;
  return comps.filter(({ comp }) => Math.abs(comp.totalPriceCents - median) <= margin);
}

function weightedMedian(sortedComps: DatedComp[], newestAgeDays: number): number {
  if (sortedComps.length === 0) return 0;

  // Divide every weight by the newest weight to avoid underflow when all sales are old.
  const referenceAge = Math.max(0, newestAgeDays);
  const weights = sortedComps.map(({ ageDays }) => {
    const relativeAge = Math.max(0, ageDays) - referenceAge;
    return Math.exp(-Math.LN2 * relativeAge / PRICE_HALF_LIFE_DAYS);
  });
  const midpoint = weights.reduce((sum, weight) => sum + weight, 0) / 2;
  let cumulative = 0;
  for (let index = 0; index < sortedComps.length; index++) {
    cumulative += weights[index];
    if (cumulative >= midpoint) return sortedComps[index].comp.totalPriceCents;
  }
  return sortedComps[sortedComps.length - 1].comp.totalPriceCents;
}

export class FmvEngine {
  evaluate(
    sku: CanonicalSku,
    comps: SoldComp[],
    config: ArbitrageConfig,
    options: FmvEvaluateOptions = {},
  ): ValuationResult {
    const nowIso = options.nowIso ?? new Date().toISOString();
    const condition = sku.assetClass === 'sealed' ? 'SEALED'
      : sku.assetClass === 'raw' ? options.condition ?? 'NM' : undefined;
    const grader = sku.assetClass === 'graded' ? sku.grader ?? options.grader : undefined;
    const grade = sku.assetClass === 'graded' ? sku.grade ?? options.grade : undefined;
    const sortedComps = comps.filter(comp =>
      comp.skuId === sku.id
      && (condition === undefined || comp.condition === condition)
      && (grader === undefined || comp.grader === grader)
      && (grade === undefined || comp.grade === grade))
      .sort((a, b) => a.totalPriceCents - b.totalPriceCents)
      .map(comp => ({ comp, ageDays: ageInDays(comp.soldAt, nowIso) }));
    const prices = sortedComps.map(({ comp }) => comp.totalPriceCents);
    const rawMedianCents = prices.length > 0 ? Math.round(quantile(prices, 0.5)) : 0;
    const trimmed = trimPriceOutliers(sortedComps, prices);
    const newest = trimmed.reduce<DatedComp | undefined>(
      (latest, sale) => latest === undefined || sale.ageDays < latest.ageDays ? sale : latest,
      undefined,
    );
    const newestAge = newest?.ageDays ?? Infinity;
    const trailing30dCount = trimmed.filter(({ ageDays }) => ageDays >= 0 && ageDays <= LIQUIDITY_WINDOW_DAYS).length;
    const trimmedCompCount = trimmed.length;
    const trimmedMinCents = trimmed[0]?.comp.totalPriceCents ?? 0;
    const trimmedMaxCents = trimmed[trimmedCompCount - 1]?.comp.totalPriceCents ?? 0;
    let priceStdDevCents = 0;
    let dispersionFactor = 0;
    if (trimmedCompCount > 0) {
      const average = trimmed.reduce((sum, { comp }) => sum + comp.totalPriceCents / trimmedCompCount, 0);
      const variance = trimmed.reduce((sum, { comp }) => sum + (comp.totalPriceCents - average) ** 2, 0)
        / trimmedCompCount;
      const standardDeviation = Math.sqrt(variance);
      priceStdDevCents = Math.round(standardDeviation);
      dispersionFactor = average > 0 ? 1 / (1 + 2 * standardDeviation / average) : 0;
    }

    const velocity = clamp(trailing30dCount / FULL_LIQUIDITY_SALES, 0, 1);
    const freshness = Math.exp(-Math.LN2 * Math.max(0, newestAge) / LIQUIDITY_WINDOW_DAYS);
    const liquidityScore = velocity * freshness * dispersionFactor;
    const medianDaysToSell = trailing30dCount > 0
      ? clamp(LIQUIDITY_WINDOW_DAYS / trailing30dCount, 1, NO_RECENT_SALES_ESTIMATE_DAYS)
      : NO_RECENT_SALES_ESTIMATE_DAYS;
    const tooFewComps = trimmedCompCount < config.minCompCount;
    const tooOld = newestAge > config.staleCompMaxAgeDays;

    const reasons: string[] = [];
    const outlierCount = sortedComps.length - trimmedCompCount;
    if (outlierCount > 0) reasons.push(`Trimmed ${outlierCount} statistical price outlier(s)`);
    if (tooFewComps) reasons.push(`Insufficient sold comps (${trimmedCompCount} retained, minimum ${config.minCompCount})`);
    if (newest === undefined) reasons.push('No eligible sold comps');
    else if (tooOld) reasons.push(`Newest retained sale exceeds the ${config.staleCompMaxAgeDays}-day freshness limit`);

    return {
      skuId: sku.id,
      fmvCents: Math.round(weightedMedian(trimmed, newestAge)),
      rawMedianCents,
      trimmedMinCents,
      trimmedMaxCents,
      priceStdDevCents,
      compCount: sortedComps.length,
      trimmedCompCount,
      trailing30dCount,
      medianDaysToSell,
      liquidityScore,
      isStale: tooFewComps || newest === undefined || tooOld,
      newestCompAt: newest?.comp.soldAt,
      valuationCondition: condition,
      valuationGrade: grade,
      reasons,
    };
  }
}
