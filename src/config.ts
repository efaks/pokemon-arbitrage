import { OperatingMode } from './domain/types.ts';
import type { AssetClass, ExitChannel } from './domain/types.ts';

export interface ExitFeeSchedule {
  percentFee: number;
  fixedFeeCents: number;
  priceMultiplier: number;
}

export interface ArbitrageConfig {
  operatingMode: OperatingMode;
  minNetProfitCents: number;
  minNetRoi: number;
  minLiquidityScore: number;
  minMatchConfidence: number;
  maxAnomalyDiscount: number;
  allowRawAutoBuy: boolean;
  autoBuyMaxOrderCents: number;
  dailySpendCapCents: number;
  maxPositionPerSku: number;
  cashBalanceCents: number;
  minCashReserveCents: number;
  salesTaxRate: number;
  staleCompMaxAgeDays: number;
  minCompCount: number;
  exitFeeSchedules: Record<ExitChannel, ExitFeeSchedule>;
  outboundShippingCents: Record<AssetClass, number>;
  packagingCents: Record<AssetClass, number>;
  riskReserveRates: Record<AssetClass, number>;
  sellerMinFeedback: number;
  sellerMinPositivePercent: number;
  sellerMinAccountAgeDays: number;
  circuitBreakerMaxErrorsPerWindow: number;
  dbPath: string;
}

function envNumber(name: string, fallback: number, valid = Number.isFinite): number {
  const raw = process.env[`ARBITRAGE_${name}`]?.trim();
  const value = raw ? Number(raw) : NaN;
  return valid(value) ? value : fallback;
}

function envInteger(name: string, fallback: number): number {
  return envNumber(name, fallback, Number.isSafeInteger);
}

function envMode(): OperatingMode {
  const raw = process.env.ARBITRAGE_MODE?.trim();
  return Object.values(OperatingMode).find(mode => mode === raw) ?? 'shadow';
}

/** Explicit overrides take precedence over valid environment values and defaults. */
export function createConfig(overrides: Partial<ArbitrageConfig> = {}): ArbitrageConfig {
  const allowRawAutoBuy = process.env.ARBITRAGE_ALLOW_RAW_AUTO_BUY?.trim().toLowerCase();

  const config: ArbitrageConfig = {
    operatingMode: envMode(),
    minNetProfitCents: envInteger('MIN_PROFIT_CENTS', 1500),
    minNetRoi: envNumber('MIN_NET_ROI', 0.15),
    minLiquidityScore: envNumber('MIN_LIQUIDITY_SCORE', 0.30),
    minMatchConfidence: envNumber('MIN_MATCH_CONFIDENCE', 0.80),
    maxAnomalyDiscount: envNumber('MAX_ANOMALY_DISCOUNT', 0.60),
    allowRawAutoBuy: allowRawAutoBuy === 'true' || allowRawAutoBuy === '1',
    autoBuyMaxOrderCents: envInteger('AUTO_BUY_MAX_ORDER_CENTS', 50000),
    dailySpendCapCents: envInteger('DAILY_CAP_CENTS', 100000),
    maxPositionPerSku: envInteger('MAX_POSITION_PER_SKU', 5),
    cashBalanceCents: envInteger('CASH_BALANCE_CENTS', 500000),
    minCashReserveCents: envInteger('MIN_CASH_RESERVE_CENTS', 50000),
    salesTaxRate: envNumber('SALES_TAX_RATE', 0.08),
    staleCompMaxAgeDays: envInteger('STALE_COMP_MAX_AGE_DAYS', 21),
    minCompCount: envInteger('MIN_COMP_COUNT', 3),
    exitFeeSchedules: {
      ebay: { percentFee: 0.1325, fixedFeeCents: 30, priceMultiplier: 1.0 },
      tcgplayer: { percentFee: 0.1275, fixedFeeCents: 30, priceMultiplier: 1.0 },
      cardmarket: { percentFee: 0.05, fixedFeeCents: 0, priceMultiplier: 1.0 },
      buylist: { percentFee: 0, fixedFeeCents: 0, priceMultiplier: 0.72 },
    },
    outboundShippingCents: { sealed: 850, graded: 550, raw: 450 },
    packagingCents: { sealed: 200, graded: 125, raw: 75 },
    riskReserveRates: { sealed: 0.01, graded: 0.02, raw: 0.05 },
    sellerMinFeedback: envInteger('SELLER_MIN_FEEDBACK', 50),
    sellerMinPositivePercent: envNumber('SELLER_MIN_POSITIVE_PERCENT', 98.5),
    sellerMinAccountAgeDays: envInteger('SELLER_MIN_ACCOUNT_AGE_DAYS', 90),
    circuitBreakerMaxErrorsPerWindow: envInteger('CIRCUIT_BREAKER_MAX_ERRORS_PER_WINDOW', 5),
    dbPath: process.env.ARBITRAGE_DB_PATH?.trim() || 'data/arbitrage.sqlite',
    ...overrides,
  };

  const monetaryAmounts = [
    config.minNetProfitCents,
    config.autoBuyMaxOrderCents,
    config.dailySpendCapCents,
    config.cashBalanceCents,
    config.minCashReserveCents,
    ...Object.values(config.exitFeeSchedules).map(schedule => schedule.fixedFeeCents),
    ...Object.values(config.outboundShippingCents),
    ...Object.values(config.packagingCents),
  ];
  if (!monetaryAmounts.every(Number.isSafeInteger)) {
    throw new RangeError('Monetary configuration must use integer USD cents');
  }
  return config;
}
