import type { ArbitrageConfig } from '../config.ts';
import { percentOfCents } from '../domain/money.ts';
import { ExitChannel } from '../domain/types.ts';
import type { AssetClass, ProfitBreakdown, RawListing } from '../domain/types.ts';

export function calculateNetProfit(
  listing: RawListing,
  fmvCents: number,
  assetClass: AssetClass,
  exitChannel: ExitChannel,
  config: ArbitrageConfig,
): ProfitBreakdown {
  const askPriceCents = listing.priceCents;
  const inboundShippingCents = listing.shippingCents;
  const estimatedTaxCents = percentOfCents(askPriceCents, config.salesTaxRate);
  const landedCostCents = askPriceCents + inboundShippingCents + estimatedTaxCents;

  const schedule = config.exitFeeSchedules[exitChannel];
  const expectedExitPriceCents = percentOfCents(fmvCents, schedule.priceMultiplier);
  const exitFeeCents = percentOfCents(expectedExitPriceCents, schedule.percentFee) + schedule.fixedFeeCents;
  const outboundShippingCents = config.outboundShippingCents[assetClass];
  const packagingCents = config.packagingCents[assetClass];
  const netProceedsCents = expectedExitPriceCents - exitFeeCents - outboundShippingCents - packagingCents;
  const riskReserveCents = percentOfCents(landedCostCents, config.riskReserveRates[assetClass]);
  const netProfitCents = netProceedsCents - landedCostCents - riskReserveCents;

  return {
    exitChannel,
    askPriceCents,
    inboundShippingCents,
    estimatedTaxCents,
    landedCostCents,
    expectedExitPriceCents,
    exitFeeCents,
    outboundShippingCents,
    packagingCents,
    netProceedsCents,
    riskReserveCents,
    netProfitCents,
    netRoi: landedCostCents > 0 ? netProfitCents / landedCostCents : 0,
    discountToFmv: fmvCents > 0 ? (fmvCents - askPriceCents) / fmvCents : 0,
  };
}

export function evaluateExitChannels(
  listing: RawListing,
  fmvCents: number,
  assetClass: AssetClass,
  config: ArbitrageConfig,
): { bestExit: ProfitBreakdown; allExits: ProfitBreakdown[] } {
  const allExits = Object.values(ExitChannel)
    .map(channel => calculateNetProfit(listing, fmvCents, assetClass, channel, config))
    .sort((a, b) => b.netProfitCents - a.netProfitCents);
  return { bestExit: allExits[0], allExits };
}
