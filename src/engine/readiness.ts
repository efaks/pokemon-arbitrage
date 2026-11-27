import type { SystemRuntime } from '../cli.ts';
import type { OperatingMode } from '../domain/types.ts';
import type { AutopilotEngine } from './autopilot.ts';
import { EbaySellInventoryAdapter, SimulatedSellerAdapter } from '../liquidation/ebaySellerAdapter.ts';

export type CheckoutCapability = 'simulated' | 'ebay_oauth_live' | 'ebay_static_token' | 'manual_only';
export type SellCapability = 'simulated' | 'ebay_sell_oauth_live' | 'ebay_sell_static_token' | 'local_only';

export interface ReadinessReport {
  nodeVersion: string;
  dbPath: string;
  operatingMode: OperatingMode;
  killSwitchEngaged: boolean;
  killSwitchReason?: string;
  envFileLoaded: boolean;
  catalogSkuCount: number;
  freshCompSkuCount: number;
  staleCompSkuCount: number;
  enabledConnectors: string[];
  disabledConnectors: string[];
  enabledSyncers: string[];
  disabledSyncers: string[];
  checkoutCapability: CheckoutCapability;
  sellCapability: SellCapability;
  certVerifier: 'mock' | 'psa_live' | 'psa_unconfigured';
  visionVerifier: 'openai_live' | 'heuristic';
  webhookAlertingEnabled: boolean;
  readyForShadowScan: boolean;
  readyForHitlAlerts: boolean;
  readyForLiveAutoBuy: boolean;
  readyForLiveAutoSell: boolean;
  blockingIssues: string[];
  warnings: string[];
  recommendedNextActions: string[];
}

type ReadinessRuntime = Pick<SystemRuntime, 'db' | 'config' | 'fmvEngine' | 'envFileLoaded' | 'useMock'>
  & Partial<Pick<SystemRuntime, 'connectors' | 'marketSync' | 'inventoryManager'>>;

function splitByEnabled(sources: readonly { name: string; isEnabled(): boolean }[]) {
  const enabled: string[] = [];
  const disabled: string[] = [];
  for (const source of sources) (source.isEnabled() ? enabled : disabled).push(source.name);
  return { enabled, disabled };
}

export function evaluateReadiness(
  runtime: ReadinessRuntime,
  options: { autopilot?: AutopilotEngine; useMock?: boolean; envFileLoaded?: boolean; nowIso?: string } = {},
): ReadinessReport {
  const { db, config, fmvEngine } = runtime;
  const useMock = options.useMock ?? runtime.useMock ?? false;
  const envFileLoaded = options.envFileLoaded ?? runtime.envFileLoaded ?? false;
  const nowIso = options.nowIso ?? new Date().toISOString();
  const { operatingMode, killSwitchEngaged, killSwitchReason } = db.getSystemState();
  const skus = db.listSkus();
  const catalogSkuCount = skus.length;
  const freshCompSkuCount = skus.filter(sku =>
    !fmvEngine.evaluate(sku, db.getSoldComps(sku.id), config, { nowIso }).isStale).length;
  const staleCompSkuCount = catalogSkuCount - freshCompSkuCount;
  const { enabled: enabledConnectors, disabled: disabledConnectors } = splitByEnabled(runtime.connectors ?? []);
  const { enabled: enabledSyncers, disabled: disabledSyncers } = splitByEnabled(runtime.marketSync?.getProviders() ?? []);
  const envSet = (key: string) => Boolean(process.env[key]?.trim());
  const ebayOAuth = ['EBAY_CLIENT_ID', 'EBAY_CLIENT_SECRET', 'EBAY_REFRESH_TOKEN'].every(envSet);
  const checkoutCapability: CheckoutCapability = useMock ? 'simulated'
    : ebayOAuth ? 'ebay_oauth_live'
      : envSet('EBAY_ORDER_API_TOKEN') ? 'ebay_static_token' : 'manual_only';
  const seller = runtime.inventoryManager?.getSellerAdapter() ?? new EbaySellInventoryAdapter();
  const sellCapability: SellCapability = useMock || seller instanceof SimulatedSellerAdapter ? 'simulated'
    : seller instanceof EbaySellInventoryAdapter && seller.isConfigured()
      ? seller.getAuthKind() === 'oauth' ? 'ebay_sell_oauth_live' : 'ebay_sell_static_token'
      : 'local_only';
  const certVerifier = useMock ? 'mock' : envSet('PSA_API_TOKEN') ? 'psa_live' : 'psa_unconfigured';
  const visionVerifier = !useMock && envSet('VISION_API_KEY') && envSet('VISION_API_URL') ? 'openai_live' : 'heuristic';
  const webhookAlertingEnabled = !useMock && envSet('ARBITRAGE_WEBHOOK_URL');

  const readyForShadowScan = !killSwitchEngaged && catalogSkuCount > 0 && freshCompSkuCount > 0 && enabledConnectors.length > 0;
  const readyForHitlAlerts = readyForShadowScan && (operatingMode === 'hitl' || operatingMode === 'live');
  const readyForLiveAutoBuy = readyForShadowScan && operatingMode === 'live' && checkoutCapability !== 'manual_only';
  const readyForLiveAutoSell = readyForShadowScan && operatingMode === 'live' && sellCapability !== 'local_only';
  const blockingIssues: string[] = [];
  const warnings: string[] = [];
  const recommendedNextActions: string[] = [];

  if (!envFileLoaded && !useMock) {
    warnings.push('No .env file was loaded. Settings can also come from the launch environment.');
    recommendedNextActions.push('Use .env.example to configure any missing settings, then restart the CLI or MCP server.');
  }
  if (killSwitchEngaged) {
    blockingIssues.push('The kill switch is engaged.');
    recommendedNextActions.push('Resolve the kill switch reason with the operator before clearing the stop.');
  }
  if (catalogSkuCount === 0) {
    blockingIssues.push('The catalog is empty.');
    recommendedNextActions.push('Run bootstrap_catalog or npm run bootstrap to load the starter SKUs.');
  }
  if (enabledSyncers.length === 0 && !useMock) {
    warnings.push('No market data providers are enabled.');
    if (freshCompSkuCount === 0) recommendedNextActions.push('Configure an authorized market data provider or import verified sold comps.');
  }
  if (freshCompSkuCount === 0) {
    blockingIssues.push('No catalog SKUs have enough fresh comparable sales for valuation.');
  } else if (staleCompSkuCount > 0) {
    warnings.push(`${staleCompSkuCount} SKU(s) have stale, insufficient, or missing comparable sales.`);
  }
  if ((freshCompSkuCount === 0 || staleCompSkuCount > 0) && enabledSyncers.length > 0) {
    recommendedNextActions.push('Run sync_market_data or npm run sync, then inspect comp freshness and provider errors.');
  }
  if (enabledConnectors.length === 0) {
    blockingIssues.push('No supply connectors are enabled.');
    recommendedNextActions.push('Configure eBay Browse or an authorized retailer feed using .env.example.');
  }
  if (operatingMode === 'shadow') warnings.push('Shadow mode records paper trades and prevents live checkout.');
  if (checkoutCapability === 'manual_only') {
    blockingIssues.push('Live auto-buy requires eBay member Order API credentials.');
    recommendedNextActions.push('Configure approved eBay OAuth member credentials or an EBAY_ORDER_API_TOKEN for checkout.');
  } else if (checkoutCapability === 'ebay_static_token') {
    warnings.push('The static eBay Order token expires and must be rotated by the operator.');
  } else if (useMock) {
    warnings.push('The mock runtime uses simulated checkout.');
  }
  if (sellCapability === 'local_only') {
    warnings.push('Selling is local only. eBay Sell Inventory credentials, policies, or location are missing.');
    recommendedNextActions.push('Configure authorized eBay Sell Inventory credentials, all three business policy IDs, and the merchant location key.');
  }
  if (certVerifier === 'psa_unconfigured') warnings.push('PSA_API_TOKEN is missing. Graded listings may require certificate review.');
  if (!useMock && visionVerifier === 'heuristic') warnings.push('Photo assessment uses heuristics. Set VISION_API_URL and VISION_API_KEY for live vision.');
  if (!useMock && !webhookAlertingEnabled) warnings.push('External webhook alerts are disabled. Set ARBITRAGE_WEBHOOK_URL to enable them.');
  if (readyForShadowScan && operatingMode !== 'live') {
    recommendedNextActions.push('Review a shadow pass and confirm operator approval before switching to live.');
  }

  return {
    nodeVersion: process.version, dbPath: config.dbPath, operatingMode, killSwitchEngaged, killSwitchReason,
    envFileLoaded, catalogSkuCount, freshCompSkuCount, staleCompSkuCount, enabledConnectors, disabledConnectors,
    enabledSyncers, disabledSyncers, checkoutCapability, sellCapability, certVerifier, visionVerifier, webhookAlertingEnabled,
    readyForShadowScan, readyForHitlAlerts, readyForLiveAutoBuy, readyForLiveAutoSell, blockingIssues, warnings, recommendedNextActions,
  };
}
