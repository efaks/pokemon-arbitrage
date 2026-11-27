import { randomUUID } from 'node:crypto';
import type { ArbitrageConfig } from '../config.ts';
import { formatUsd } from '../domain/money.ts';
import type {
  ArbitrageDecision,
  DecisionAction,
  MatchResult,
  PortfolioSnapshot,
  RawListing,
  SystemState,
  ValuationResult,
} from '../domain/types.ts';
import { evaluateExitChannels } from '../valuation/profitCalculator.ts';

export interface RiskDecisionInput {
  listing: RawListing;
  match: MatchResult;
  valuation?: ValuationResult;
  portfolio: PortfolioSnapshot;
  systemState: SystemState;
  config: ArbitrageConfig;
  nowIso?: string;
}

const percentFormatter = new Intl.NumberFormat('en-US', { style: 'percent', maximumFractionDigits: 20 });

export class RiskEngine {
  decide(input: RiskDecisionInput): ArbitrageDecision {
    const { listing, match, valuation, portfolio, systemState, config } = input;
    const sku = match.canonicalSku;
    const operatingMode = systemState.operatingMode ?? config.operatingMode;
    const decision: ArbitrageDecision = {
      id: randomUUID(),
      listingId: listing.listingId,
      source: listing.source,
      listingUrl: listing.url,
      listingTitle: listing.title,
      skuId: sku?.id,
      skuName: sku?.name,
      assetClass: sku?.assetClass,
      action: 'skip',
      intendedAction: 'skip',
      operatingMode,
      matchConfidence: match.confidence,
      fmvCents: valuation?.fmvCents,
      liquidityScore: valuation?.liquidityScore,
      warnings: [...match.redFlags],
      reasons: [],
      anomalyFlagged: false,
      decidedAt: input.nowIso ?? new Date().toISOString(),
    };
    const skip = (...reasons: string[]): ArbitrageDecision => ({ ...decision, reasons });

    if (systemState.killSwitchEngaged) {
      return skip(`Kill switch engaged${systemState.killSwitchReason ? ` (${systemState.killSwitchReason})` : ''}`);
    }
    if (match.status !== 'matched' || !sku || match.blockingRedFlags.length > 0) {
      const reasons = [...new Set([...match.reasons, ...match.blockingRedFlags])];
      return skip(...(reasons.length > 0 ? reasons : ['Listing failed catalog match or red flag checks']));
    }
    if (!match.sellerTrust.trusted) {
      const { reasons } = match.sellerTrust;
      return skip(...(reasons.length > 0 ? reasons : ['Seller did not pass trust checks']));
    }
    if (match.confidence < config.minMatchConfidence) {
      return skip(`Match confidence ${match.confidence} is below minimum ${config.minMatchConfidence}`);
    }
    if (!valuation || valuation.fmvCents <= 0 || valuation.isStale) {
      return skip('Stale or insufficient sold comps', ...(valuation?.reasons ?? []));
    }
    if (valuation.liquidityScore < config.minLiquidityScore) {
      return skip('Liquidity score below minimum');
    }

    const { bestExit, allExits } = evaluateExitChannels(listing, valuation.fmvCents, sku.assetClass, config);
    decision.bestExit = bestExit;
    decision.allExits = allExits;
    const profitReasons: string[] = [];
    if (bestExit.netProfitCents < config.minNetProfitCents) {
      profitReasons.push(`Net profit ${formatUsd(bestExit.netProfitCents)} is below minimum ${formatUsd(config.minNetProfitCents)}`);
    }
    if (bestExit.netRoi < config.minNetRoi) {
      const actual = percentFormatter.format(bestExit.netRoi);
      const minimum = percentFormatter.format(config.minNetRoi);
      profitReasons.push(`Net ROI ${actual} is below minimum ${minimum}`);
    }
    if (profitReasons.length > 0) return skip(...profitReasons);

    if (portfolio.dailySpendCents + bestExit.landedCostCents > portfolio.dailySpendCapCents) {
      return skip('Daily spend cap exceeded');
    }
    if ((portfolio.skuPositions[sku.id] ?? 0) + listing.quantity > config.maxPositionPerSku) {
      return skip('Per-SKU max position limit reached');
    }
    if (portfolio.cashBalanceCents - bestExit.landedCostCents < portfolio.minCashReserveCents) {
      return skip('Cash reserve floor breached');
    }

    const { warnings } = decision;
    const anomalyFlagged = bestExit.discountToFmv > config.maxAnomalyDiscount;
    let intendedAction: DecisionAction = 'auto_buy';
    if (anomalyFlagged) {
      intendedAction = 'hitl_review';
      warnings.push('Anomaly: discount exceeds threshold (possible fake, wrong variant, or damage)');
    }
    if (sku.assetClass === 'raw' && !config.allowRawAutoBuy) {
      intendedAction = 'hitl_review';
      warnings.push('Raw single requires human photo/condition verification');
    }
    if (!listing.supportsAutoCheckout) {
      intendedAction = 'hitl_review';
      warnings.push('Source does not support sanctioned automated checkout');
    }
    if (bestExit.landedCostCents > config.autoBuyMaxOrderCents) {
      intendedAction = 'hitl_review';
      warnings.push('Order cost exceeds auto-buy single-order limit');
    }
    if (sku.assetClass === 'graded' && !match.certVerification?.valid) {
      intendedAction = 'hitl_review';
      warnings.push('Graded slab lacks verified certification lookup');
    }

    let action = intendedAction;
    const reasons = [...match.reasons];
    if (operatingMode === 'hitl' && intendedAction === 'auto_buy') {
      action = 'hitl_review';
      reasons.push('Operating mode is HITL; auto-buy downgraded to human review');
    }
    if (operatingMode === 'shadow') {
      reasons.push('Shadow mode active: paper-trading only');
    }

    return { ...decision, action, intendedAction, anomalyFlagged, reasons };
  }
}
