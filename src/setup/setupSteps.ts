import type { ReadinessReport } from '../engine/readiness.ts';

export interface SetupStep {
  id: string;
  status: 'complete' | 'pending' | 'blocked';
  missingKeys: string[];
  configuredKeys: string[];
  mcpTools: string[];
  userInstructions: string[];
  externalLinks: string[];
}

export function setupSteps(readiness: Pick<ReadinessReport,
  'catalogSkuCount' | 'freshCompSkuCount' | 'enabledConnectors' | 'certVerifier' | 'visionVerifier' |
  'webhookAlertingEnabled' | 'checkoutCapability' | 'sellCapability' | 'fulfillmentSyncEnabled' |
  'readyForShadowScan' | 'readyForLiveAutoBuy' | 'killSwitchEngaged'>, shadowPassRecorded: boolean) {
  const simulated = readiness.checkoutCapability === 'simulated';
  const step = (
    id: string, ready: boolean, keys: string[], mcpTools: string[], userInstructions: string[], externalLinks: string[] = [],
    blocked = false,
  ): SetupStep => {
    const configuredKeys = keys.filter(key => Boolean(process.env[key]?.trim()));
    return {
      id, status: ready ? 'complete' : blocked ? 'blocked' : 'pending', configuredKeys,
      missingKeys: keys.filter(key => !configuredKeys.includes(key)), mcpTools, userInstructions, externalLinks,
    };
  };
  const steps = [
    step('catalog', readiness.catalogSkuCount > 0, [], ['bootstrap_catalog', 'expand_catalog'],
      ['Load the starter SKUs or select a curated pack. Use a separate database for sample sales.']),
    step('market_data', readiness.freshCompSkuCount > 0,
      ['PRICECHARTING_API_TOKEN', 'POKEMON_TCG_API_KEY', 'EBAY_INSIGHTS_ENABLED'],
      ['test_provider_connection', 'sync_market_data', 'import_sold_comps', 'check_readiness'],
      ['Test a configured provider, sync a small batch or import verified sales, and confirm fresh comps for the SKUs you plan to buy.'],
      ['https://www.pricecharting.com/api-documentation', 'https://docs.pokemontcg.io/']),
    step('supply_feeds', readiness.enabledConnectors.length > 0,
      ['EBAY_CLIENT_ID', 'EBAY_CLIENT_SECRET', 'EBAY_ACCESS_TOKEN', 'BESTBUY_API_KEY', 'COSTCO_FEED_URL', 'COSTCO_API_KEY',
        'POKEMON_CENTER_FEED_URL', 'POKEMON_CENTER_API_KEY', 'LGS_SHOPIFY_DOMAINS', 'TCGPLAYER_API_TOKEN'],
      ['configure_settings', 'test_provider_connection'],
      ['Configure eBay Browse or an approved retail feed and run a read-only connection test.'],
      ['https://developer.ebay.com/api-docs/buy/browse/overview.html']),
    step('risk_and_tax', simulated || [
      'ARBITRAGE_DAILY_CAP_CENTS', 'ARBITRAGE_AUTO_BUY_MAX_ORDER_CENTS', 'ARBITRAGE_MAX_POSITION_PER_SKU',
      'ARBITRAGE_CASH_BALANCE_CENTS', 'ARBITRAGE_MIN_CASH_RESERVE_CENTS', 'ARBITRAGE_SALES_TAX_RATE',
    ].every(key => Boolean(process.env[key]?.trim())),
    ['ARBITRAGE_DAILY_CAP_CENTS', 'ARBITRAGE_AUTO_BUY_MAX_ORDER_CENTS', 'ARBITRAGE_MAX_POSITION_PER_SKU',
      'ARBITRAGE_CASH_BALANCE_CENTS', 'ARBITRAGE_MIN_CASH_RESERVE_CENTS', 'ARBITRAGE_SALES_TAX_RATE'],
    ['get_system_state', 'configure_settings'],
    ['Review the current spend limits, available capital, reserve, and tax estimate with the operator. Enter approved monetary amounts in USD cents.']),
    step('alerting_and_verification', simulated ||
      (readiness.webhookAlertingEnabled && readiness.certVerifier === 'psa_live' && readiness.visionVerifier === 'openai_live'),
    ['ARBITRAGE_WEBHOOK_URL', 'PSA_API_TOKEN', 'VISION_API_URL', 'VISION_API_KEY', 'VISION_MODEL'],
    ['configure_settings', 'test_provider_connection'],
    ['Select authorized alert and verification providers. Confirm whether the operator will use manual verification and local alerts for any omitted services.']),
    step('ebay_checkout', readiness.checkoutCapability !== 'manual_only',
      ['EBAY_CLIENT_ID', 'EBAY_CLIENT_SECRET', 'EBAY_RU_NAME', 'EBAY_REFRESH_TOKEN', 'EBAY_ORDER_API_TOKEN'],
      ['start_ebay_oauth', 'complete_ebay_oauth', 'check_readiness'],
      ['Confirm Order API access before requesting the buy.order scope. Sign in to eBay on the consent page and submit the code through the OAuth completion tool.'],
      ['https://developer.ebay.com/develop/guides/sell/authorization']),
    step('ebay_selling_and_fulfillment', readiness.sellCapability !== 'local_only' && readiness.fulfillmentSyncEnabled,
      ['EBAY_SELL_REFRESH_TOKEN', 'EBAY_SELL_API_TOKEN', 'EBAY_FULFILLMENT_POLICY_ID', 'EBAY_PAYMENT_POLICY_ID',
        'EBAY_RETURN_POLICY_ID', 'EBAY_MERCHANT_LOCATION_KEY', 'EBAY_SELL_SANDBOX'],
      ['start_ebay_oauth', 'complete_ebay_oauth', 'discover_ebay_policies', 'reconcile_ebay_sales'],
      ['Authorize the Sell scopes, review discovered policies and locations, then save approved IDs. Confirm the address before creating a warehouse.'],
      ['https://developer.ebay.com/api-docs/sell/static/inventory/managing-inventory-locations.html']),
    step('shadow_burn_in_and_go_live', shadowPassRecorded && readiness.readyForLiveAutoBuy, [],
      ['set_operating_mode', 'run_autopilot_pass', 'check_readiness', 'list_audit_events'],
      ['Review a shadow pass, including pricing, seller checks, decisions, and alerts. Obtain operator approval before enabling live mode and scheduling exactly one daemon.'],
      [], !readiness.readyForShadowScan || readiness.killSwitchEngaged),
  ];
  return {
    steps, setupProgressPct: Math.round(100 * steps.filter(item => item.status === 'complete').length / steps.length),
    nextSetupStep: steps.find(item => item.status !== 'complete')?.id ?? null,
  };
}
