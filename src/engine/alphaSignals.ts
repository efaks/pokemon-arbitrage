import type { ArbitrageConfig } from '../config.ts';
import { percentOfCents } from '../domain/money.ts';
import type { AssetClass, CanonicalSku, Grader, ProfitBreakdown, RawListing } from '../domain/types.ts';
import { calculateNetProfit, evaluateExitChannels } from '../valuation/profitCalculator.ts';
import type { BuyBook } from './buyBook.ts';

export interface FuzzyRecoveryResult {
  recovered: boolean;
  originalTitle: string;
  normalizedTitle: string;
  corrections: string[];
  extractedCardNumbers: string[];
}

const typos = new Map(Object.entries({
  charzard: 'charizard', chrizard: 'charizard', chariard: 'charizard',
  umbrion: 'umbreon', umbron: 'umbreon', umbrean: 'umbreon',
  pikchu: 'pikachu', pickachu: 'pikachu', pikachuu: 'pikachu', lugya: 'lugia',
  evoving: 'evolving', evoling: 'evolving', skys: 'skies', primatic: 'prismatic',
  prismatc: 'prismatic', evlutions: 'evolutions', surgnig: 'surging', surgin: 'surging',
  spaks: 'sparks', paldan: 'paldean', fats: 'fates', boster: 'booster',
  bundel: 'bundle', pokmon: 'pokemon', altart: 'alt art', moonbrean: 'moonbreon',
}));
const knownNumbers = ['199/165', '201/165', '215/203', '238/191', '186/195', '232/091', '4/102', '006/165', '004/165'];
const missingSlash = new RegExp(
  String.raw`(?<![/])\b(?:${knownNumbers.map(number => number.replace('/', String.raw`(?:\s*[-–—]\s*|\s+)`)).join('|')})\b(?![/])`, 'g',
);

export function normalizeMisspelledListing(listing: RawListing): { listing: RawListing; recovery: FuzzyRecoveryResult } {
  const originalTitle = listing.title;
  const corrections: string[] = [];
  const normalizedTitle = originalTitle.replace(/\p{L}+/gu, word => {
    const corrected = typos.get(word.toLowerCase());
    if (!corrected) return word;
    corrections.push(`${word} → ${corrected}`);
    return corrected;
  }).replace(missingSlash, pair => {
    const corrected = pair.replace(/[^\d]+/, '/');
    corrections.push(`${pair} → ${corrected}`);
    return corrected;
  });
  const extractedCardNumbers = [...new Set(Array.from(
    normalizedTitle.matchAll(/\b[a-z]{0,4}\d{1,4}\s*\/\s*[a-z]{0,4}\d{1,4}\b/gi),
    ([number]) => number.replace(/\s/g, ''),
  ))];
  return {
    listing: { ...listing, title: normalizedTitle },
    recovery: { recovered: corrections.length > 0, originalTitle, normalizedTitle, corrections, extractedCardNumbers },
  };
}

export interface GradingEvResult {
  rawSkuId: string;
  gradedSkuId: string;
  grader: Grader;
  targetGrade: string;
  rawLandedCostCents: number;
  gradedFmvCents: number;
  gradingFeeCents: number;
  probTopGrade: number;
  probRunnerUpGrade: number;
  expectedGradedProceedsCents: number;
  expectedGradingProfitCents: number;
  expectedGradingRoi: number;
  viable: boolean;
}

export function evaluateRawToGradeEv(
  rawSku: CanonicalSku, listing: RawListing, catalogSkus: CanonicalSku[], buyBook: BuyBook, config: ArbitrageConfig,
  { gradingFeeCents = 2500, probTopGrade = 0.60, probRunnerUpGrade = 0.30 }: {
    gradingFeeCents?: number; probTopGrade?: number; probRunnerUpGrade?: number;
  } = {},
): GradingEvResult | undefined {
  if (rawSku.assetClass !== 'raw' || !rawSku.cardNumber) return undefined;
  const raw = buyBook.get(rawSku.id);
  if (!raw || raw.isStale || raw.fmvCents <= 0) return undefined;
  const [graded] = catalogSkus.flatMap(sku => {
    if (sku.assetClass !== 'graded' || sku.setCode !== rawSku.setCode || sku.cardNumber !== rawSku.cardNumber ||
        sku.language !== rawSku.language || sku.variant !== rawSku.variant || !sku.grader || !sku.grade) return [];
    const entry = buyBook.get(sku.id);
    if (!entry || entry.isStale || entry.fmvCents <= 0) return [];
    return [{ sku, grader: sku.grader, grade: sku.grade, fmvCents: entry.fmvCents }];
  }).sort((a, b) => Number(b.grade) - Number(a.grade) || b.fmvCents - a.fmvCents || a.sku.id.localeCompare(b.sku.id));
  if (!graded) return undefined;

  if (!Number.isSafeInteger(gradingFeeCents) || gradingFeeCents < 0 ||
      ![probTopGrade, probRunnerUpGrade].every(prob => Number.isFinite(prob) && prob >= 0 && prob <= 1) ||
      probTopGrade + probRunnerUpGrade > 1) throw new RangeError('Invalid grading fee or outcome probabilities');
  const rawLandedCostCents = listing.priceCents + listing.shippingCents + percentOfCents(listing.priceCents, config.salesTaxRate);
  const proceeds = (fmvCents: number, assetClass: AssetClass) =>
    evaluateExitChannels(listing, fmvCents, assetClass, config).bestExit.netProceedsCents;
  const topProceeds = proceeds(graded.fmvCents, 'graded');
  const runnerUpProceeds = proceeds(percentOfCents(graded.fmvCents, 0.55), 'graded');
  const rawFallbackProceeds = proceeds(raw.fmvCents, 'raw');
  const expectedGradedProceedsCents = Math.round(probTopGrade * topProceeds + probRunnerUpGrade * runnerUpProceeds +
    (1 - probTopGrade - probRunnerUpGrade) * rawFallbackProceeds);
  const costCents = rawLandedCostCents + gradingFeeCents;
  const expectedGradingProfitCents = expectedGradedProceedsCents - costCents;
  const expectedGradingRoi = costCents > 0 ? expectedGradingProfitCents / costCents : 0;
  return {
    rawSkuId: rawSku.id, gradedSkuId: graded.sku.id, grader: graded.grader, targetGrade: graded.grade,
    rawLandedCostCents, gradedFmvCents: graded.fmvCents, gradingFeeCents, probTopGrade, probRunnerUpGrade,
    expectedGradedProceedsCents, expectedGradingProfitCents, expectedGradingRoi,
    viable: expectedGradingProfitCents >= config.minNetProfitCents && expectedGradingRoi >= config.minNetRoi,
  };
}

export interface BuylistFloorSignal {
  isBuylistFloorArb: boolean;
  buylistBreakdown: ProfitBreakdown;
}

export function detectBuylistFloorArbitrage(
  listing: RawListing, assetClass: AssetClass, fmvCents: number, config: ArbitrageConfig,
): BuylistFloorSignal {
  const buylistBreakdown = calculateNetProfit(listing, fmvCents, assetClass, 'buylist', config);
  return {
    isBuylistFloorArb: buylistBreakdown.netProfitCents >= config.minNetProfitCents && buylistBreakdown.netRoi >= config.minNetRoi,
    buylistBreakdown,
  };
}
