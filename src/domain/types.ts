/** All fields ending in Cents are integer USD cents. Timestamps are UTC ISO 8601 strings. */
export const AssetClass = { SEALED: 'sealed', GRADED: 'graded', RAW: 'raw' } as const;
export type AssetClass = (typeof AssetClass)[keyof typeof AssetClass];

export const CardCondition = { SEALED: 'SEALED', NM: 'NM', LP: 'LP', MP: 'MP', HP: 'HP', DMG: 'DMG' } as const;
export type CardCondition = (typeof CardCondition)[keyof typeof CardCondition];

export const Grader = { PSA: 'PSA', BGS: 'BGS', CGC: 'CGC', SGC: 'SGC' } as const;
export type Grader = (typeof Grader)[keyof typeof Grader];

export const CardLanguage = { EN: 'EN', JP: 'JP', KR: 'KR', CN: 'CN' } as const;
export type CardLanguage = (typeof CardLanguage)[keyof typeof CardLanguage];

export const CardVariant = {
  STANDARD: 'standard',
  HOLO: 'holo',
  REVERSE_HOLO: 'reverse_holo',
  FIRST_EDITION: 'first_edition',
  SHADOWLESS: 'shadowless',
  ALT_ART: 'alt_art',
  SIR: 'sir',
  PROMO: 'promo',
  STAFF_STAMP: 'staff_stamp',
} as const;
export type CardVariant = (typeof CardVariant)[keyof typeof CardVariant];

export const SourceName = {
  EBAY: 'ebay',
  TCGPLAYER: 'tcgplayer',
  CARDMARKET: 'cardmarket',
  BESTBUY: 'bestbuy',
  COSTCO: 'costco',
  POKEMON_CENTER: 'pokemon_center',
  WALMART: 'walmart',
  LGS_SHOPIFY: 'lgs_shopify',
  DISTRIBUTOR: 'distributor',
  MOCK_FEED: 'mock_feed',
} as const;
export type SourceName = (typeof SourceName)[keyof typeof SourceName];

export const OperatingMode = { SHADOW: 'shadow', HITL: 'hitl', LIVE: 'live' } as const;
export type OperatingMode = (typeof OperatingMode)[keyof typeof OperatingMode];

export const ExitChannel = { EBAY: 'ebay', TCGPLAYER: 'tcgplayer', CARDMARKET: 'cardmarket', BUYLIST: 'buylist' } as const;
export type ExitChannel = (typeof ExitChannel)[keyof typeof ExitChannel];

export const DecisionAction = { AUTO_BUY: 'auto_buy', HITL_REVIEW: 'hitl_review', SKIP: 'skip' } as const;
export type DecisionAction = (typeof DecisionAction)[keyof typeof DecisionAction];

export const OrderStatus = {
  SHADOW_RECORDED: 'shadow_recorded',
  PENDING_HITL: 'pending_hitl',
  APPROVED: 'approved',
  EXECUTING: 'executing',
  FILLED: 'filled',
  REJECTED: 'rejected',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
} as const;
export type OrderStatus = (typeof OrderStatus)[keyof typeof OrderStatus];

export const InventoryStatus = {
  IN_TRANSIT: 'in_transit',
  QC_PASSED: 'qc_passed',
  QC_DISPUTED: 'qc_disputed',
  LISTED: 'listed',
  SOLD: 'sold',
} as const;
export type InventoryStatus = (typeof InventoryStatus)[keyof typeof InventoryStatus];

/** A distinct catalog product, including language, print variant, and grade when applicable. */
export interface CanonicalSku {
  id: string;
  name: string;
  assetClass: AssetClass;
  setName: string;
  setCode: string;
  cardNumber?: string;
  upc?: string;
  language: CardLanguage;
  variant: CardVariant;
  grader?: Grader;
  grade?: string;
  msrpCents?: number;
  aliases: string[];
  referenceImageUrl?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SellerProfile {
  sellerId: string;
  username: string;
  feedbackScore: number;
  /** Positive feedback on a 0–100 scale. */
  positivePercent: number;
  accountAgeDays: number;
  returnsAccepted: boolean;
}

/** Source listing before catalog matching or trust checks. */
export interface RawListing {
  listingId: string;
  source: SourceName;
  title: string;
  description: string;
  url: string;
  priceCents: number;
  shippingCents: number;
  quantity: number;
  currency: 'USD';
  upc?: string;
  conditionHint?: CardCondition;
  languageHint?: CardLanguage;
  graderHint?: Grader;
  gradeHint?: string;
  certNumber?: string;
  imageUrls: string[];
  seller: SellerProfile;
  supportsAutoCheckout: boolean;
  listedAt: string;
  fetchedAt: string;
  metadata?: Record<string, unknown>;
}

export interface RedFlagAssessment {
  passed: boolean;
  flags: string[];
  blockingFlags: string[];
  detectedLanguage?: CardLanguage;
}

export interface SellerTrustResult {
  trusted: boolean;
  /** A score from 0 to 1. */
  score: number;
  reasons: string[];
}

export interface CertVerificationResult {
  checked: boolean;
  valid: boolean;
  grader?: Grader;
  certNumber?: string;
  verifiedGrade?: string;
  verifiedTitle?: string;
  reason?: string;
}

export interface VisionVerificationResult {
  checked: boolean;
  verified: boolean;
  confidenceAdjustment: number;
  notes: string[];
}

export interface MatchResult {
  status: 'matched' | 'unmatched' | 'rejected';
  skuId?: string;
  canonicalSku?: CanonicalSku;
  matchedCondition?: CardCondition;
  matchedGrader?: Grader;
  matchedGrade?: string;
  matchedLanguage?: CardLanguage;
  matchedVariant?: CardVariant;
  confidence: number;
  redFlags: string[];
  blockingRedFlags: string[];
  sellerTrust: SellerTrustResult;
  certVerification?: CertVerificationResult;
  visionVerification?: VisionVerificationResult;
  reasons: string[];
}

export interface SoldComp {
  id: string;
  skuId: string;
  source: SourceName;
  soldPriceCents: number;
  shippingCents: number;
  totalPriceCents: number;
  condition: CardCondition;
  grader?: Grader;
  grade?: string;
  soldAt: string;
  isOutlier?: boolean;
}

export interface ValuationResult {
  skuId: string;
  fmvCents: number;
  rawMedianCents: number;
  trimmedMinCents: number;
  trimmedMaxCents: number;
  priceStdDevCents: number;
  compCount: number;
  trimmedCompCount: number;
  trailing30dCount: number;
  medianDaysToSell: number;
  liquidityScore: number;
  isStale: boolean;
  newestCompAt?: string;
  valuationCondition?: CardCondition;
  valuationGrade?: string;
  reasons: string[];
}

export interface ProfitBreakdown {
  exitChannel: ExitChannel;
  askPriceCents: number;
  inboundShippingCents: number;
  estimatedTaxCents: number;
  landedCostCents: number;
  expectedExitPriceCents: number;
  exitFeeCents: number;
  outboundShippingCents: number;
  packagingCents: number;
  netProceedsCents: number;
  riskReserveCents: number;
  netProfitCents: number;
  /** Ratios, so 0.15 represents 15 percent. */
  netRoi: number;
  discountToFmv: number;
}

export interface ArbitrageDecision {
  id: string;
  listingId: string;
  source: SourceName;
  listingUrl: string;
  listingTitle: string;
  skuId?: string;
  skuName?: string;
  assetClass?: AssetClass;
  action: DecisionAction;
  /** The action recommended before applying restrictions from the operating mode. */
  intendedAction: DecisionAction;
  operatingMode: OperatingMode;
  matchConfidence: number;
  fmvCents?: number;
  liquidityScore?: number;
  bestExit?: ProfitBreakdown;
  allExits?: ProfitBreakdown[];
  warnings: string[];
  reasons: string[];
  anomalyFlagged: boolean;
  decidedAt: string;
}

export interface PurchaseOrder {
  id: string;
  idempotencyKey: string;
  decisionId: string;
  listingId: string;
  source: SourceName;
  listingUrl: string;
  listingTitle: string;
  skuId: string;
  skuName: string;
  assetClass: AssetClass;
  status: OrderStatus;
  quantity: number;
  askPriceCents: number;
  shippingCents: number;
  taxCents: number;
  landedCostCents: number;
  expectedNetProfitCents: number;
  expectedNetRoi: number;
  recommendedExitChannel: ExitChannel;
  externalOrderId?: string;
  failureReason?: string;
  decisionWarnings: string[];
  createdAt: string;
  updatedAt: string;
}

/** A single acquired unit tracked through quality control and resale. */
export interface InventoryItem {
  id: string;
  orderId: string;
  skuId: string;
  skuName: string;
  assetClass: AssetClass;
  expectedCondition: CardCondition;
  actualCondition?: CardCondition;
  grader?: Grader;
  grade?: string;
  costBasisCents: number;
  expectedExitChannel: ExitChannel;
  expectedFmvCents: number;
  predictedNetProfitCents: number;
  status: InventoryStatus;
  qcNotes?: string;
  listedChannel?: ExitChannel;
  listedPriceCents?: number;
  soldChannel?: ExitChannel;
  soldPriceCents?: number;
  exitFeesCents?: number;
  realizedProfitCents?: number;
  acquiredAt: string;
  soldAt?: string;
  updatedAt: string;
}

export interface SystemState {
  operatingMode: OperatingMode;
  killSwitchEngaged: boolean;
  killSwitchReason?: string;
  consecutiveErrors: number;
  lastScanAt?: string;
  updatedAt: string;
}

export interface AuditEvent {
  id: string;
  eventType: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface PortfolioSnapshot {
  dailySpendCents: number;
  dailySpendCapCents: number;
  cashBalanceCents: number;
  minCashReserveCents: number;
  skuPositions: Record<string, number>;
  activeInventoryCostCents: number;
  activeInventoryCount: number;
}

export interface DashboardMetrics {
  systemState: SystemState;
  portfolio: PortfolioSnapshot;
  pendingHitlCount: number;
  totalOrdersFilled: number;
  shadowOrdersCount: number;
  totalPredictedProfitCents: number;
  totalRealizedProfitCents: number;
  soldCount: number;
  recentDecisionsCount: number;
}

export interface CycleSummary {
  cycleId: string;
  startedAt: string;
  finishedAt: string;
  operatingMode: OperatingMode;
  fetchedCount: number;
  deduplicatedCount: number;
  matchedCount: number;
  rejectedCount: number;
  autoBoughtCount: number;
  hitlQueuedCount: number;
  skippedCount: number;
  shadowRecordedCount: number;
  errorCount: number;
  errors: string[];
  killSwitchTriggered: boolean;
}
