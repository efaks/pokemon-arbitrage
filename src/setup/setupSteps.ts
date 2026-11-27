import type { ReadinessReport } from '../engine/readiness.ts';

export const SETUP_PROFILES = ['hitl_alerts', 'live_auto_buy', 'live_closed_loop'] as const;
export type SetupProfile = typeof SETUP_PROFILES[number];

export const SETUP_STEP_IDS = [
  'catalog', 'market_data', 'supply_feeds', 'risk_and_tax', 'alerting_and_verification',
  'ebay_checkout', 'ebay_selling_and_fulfillment', 'shadow_burn_in_and_go_live',
] as const;
export type SetupStepId = typeof SETUP_STEP_IDS[number];
export type SetupPhase = 'foundation' | 'feeds_and_data' | 'risk_and_ops' | 'ebay_authorization' | 'validation_and_launch';
export type SetupStepStatus = 'complete' | 'pending' | 'blocked' | 'skipped';

export interface SetupProfileDefinition {
  id: SetupProfile;
  label: string;
  summary: string;
  requiresBuyOrderApi: boolean;
  requiresSellApi: boolean;
  targetMode: 'hitl' | 'live';
}

export const SETUP_PROFILE_DEFINITIONS: Record<SetupProfile, SetupProfileDefinition> = {
  hitl_alerts: {
    id: 'hitl_alerts', label: 'HITL alerts', summary: 'Scan listings and review alerts with operator-managed checkout.',
    requiresBuyOrderApi: false, requiresSellApi: false, targetMode: 'hitl',
  },
  live_auto_buy: {
    id: 'live_auto_buy', label: 'Live auto-buy', summary: 'Enable authorized eBay auto-buy with operator-managed selling.',
    requiresBuyOrderApi: true, requiresSellApi: false, targetMode: 'live',
  },
  live_closed_loop: {
    id: 'live_closed_loop', label: 'Live closed loop', summary: 'Enable authorized eBay auto-buy, selling, and paid-sale reconciliation.',
    requiresBuyOrderApi: true, requiresSellApi: true, targetMode: 'live',
  },
};

export interface SetupStepAcknowledgement { note: string; recordedAt: string; }
export interface SetupStepSkip { reason: string; recordedAt: string; }

export interface SetupWorkflowState {
  targetProfile: SetupProfile;
  profileSelected: boolean;
  acknowledgedSteps: Partial<Record<SetupStepId, SetupStepAcknowledgement>>;
  skippedSteps: Partial<Record<SetupStepId, SetupStepSkip>>;
  updatedAt: string;
}

export interface SetupExternalLink { label: string; url: string; }
export interface SetupAgentAction { tool: string; when: string; argsHint?: Record<string, unknown>; }

export interface SetupStep {
  id: SetupStepId;
  status: SetupStepStatus;
  missingKeys: string[];
  configuredKeys: string[];
  mcpTools: string[];
  userInstructions: string[];
  externalLinks: string[];
  order: number;
  title: string;
  phase: SetupPhase;
  required: boolean;
  skippable: boolean;
  acknowledgeable: boolean;
  summary: string;
  whyItMatters: string;
  operatorActions: string[];
  questionsForUser: string[];
  agentActions: SetupAgentAction[];
  verificationChecks: string[];
  completionCriteria: string;
  resources: SetupExternalLink[];
  acknowledgement?: SetupStepAcknowledgement;
  skip?: SetupStepSkip;
}

export interface SetupWorkflowDirective {
  targetProfile: SetupProfile;
  profileSelected: boolean;
  profileDescription: string;
  currentStepId: SetupStepId | null;
  currentStepTitle: string | null;
  completedStepCount: number;
  totalStepCount: number;
  readyForTargetProfile: boolean;
  conversationRules: string[];
  profiles: SetupProfileDefinition[];
}

export function defaultSetupWorkflowState(nowIso = new Date().toISOString()): SetupWorkflowState {
  return {
    targetProfile: 'live_closed_loop', profileSelected: false, acknowledgedSteps: {}, skippedSteps: {}, updatedAt: nowIso,
  };
}

export function isStepSkippableForProfile(stepId: SetupStepId, profile: SetupProfile): boolean {
  return stepId === 'alerting_and_verification' ||
    (stepId === 'ebay_checkout' && !SETUP_PROFILE_DEFINITIONS[profile].requiresBuyOrderApi) ||
    (stepId === 'ebay_selling_and_fulfillment' && !SETUP_PROFILE_DEFINITIONS[profile].requiresSellApi);
}

export function isStepAcknowledgeable(stepId: SetupStepId): boolean {
  return stepId === 'risk_and_tax' || stepId === 'alerting_and_verification';
}

type StepDefinition = Pick<SetupStep,
  'title' | 'phase' | 'summary' | 'whyItMatters' | 'operatorActions' | 'questionsForUser' |
  'agentActions' | 'verificationChecks' | 'completionCriteria' | 'resources'> & { settings: string[] };

const definitions: Record<SetupStepId, StepDefinition> = {
  catalog: {
    title: 'Choose a profile and load the catalog',
    phase: 'foundation',
    summary: 'Choose the onboarding target, confirm the database, and load the products you want to track.',
    whyItMatters: 'The catalog defines which listings Muse can match and which SKUs can receive sold comps.',
    operatorActions: [
      'Open the intended project in Muse and confirm the SQLite path (normally data/arbitrage.sqlite). Use a separate database for mock or sandbox runs.',
      'Choose HITL alerts (hitl_alerts), live auto-buy (live_auto_buy), or live buying and selling (live_closed_loop).',
      'Choose the starter catalog (20 SKUs) or all curated packs (95 SKUs).',
    ],
    questionsForUser: [
      'Should I set up HITL alerts, live auto-buy, or live buying and selling?',
      'Is this the intended SQLite database, and should I load the 20 starter SKUs or all 95 curated SKUs?',
    ],
    agentActions: [
      { tool: 'update_setup_workflow', when: 'After the operator chooses a profile', argsHint: { targetProfile: '<chosen profile>' } },
      { tool: 'bootstrap_catalog', when: 'If the operator chooses the starter catalog', argsHint: { includeDemoComps: false } },
      { tool: 'expand_catalog', when: 'If the operator chooses all curated packs', argsHint: { pack: 'all_curated', syncAfter: false } },
      { tool: 'check_readiness', when: 'After loading the catalog' },
    ],
    verificationChecks: ['Confirm readiness.dbPath and check that readiness.catalogSkuCount is greater than zero.'],
    completionCriteria: 'The selected database contains at least one catalog SKU.',
    resources: [],
    settings: [],
  },
  market_data: {
    title: 'Connect market data and seed sold comps',
    phase: 'feeds_and_data',
    summary: 'Connect authorized market data and import verified historical sales on day one.',
    whyItMatters: 'Valuation requires fresh comps. Importing historical sales can avoid the three-day cold start with the default ARBITRAGE_MIN_COMP_COUNT=3.',
    operatorActions: [
      'Obtain a PriceCharting Pro API token or a Pokémon TCG API key from the official provider. Enable eBay Marketplace Insights only with limited-release approval.',
      'Provide a CSV or JSON array of verified historical sales for existing SKUs, including the sale dates and prices in integer USD cents.',
      'For PriceCharting snapshots, match the column to the SKU. Use loose-price for raw, new-price for sealed and grades 8–8.5, manual-only-price for PSA 10, bgs-10-price for BGS 10, condition-17-price for CGC 10, box-only-price for 9.5, graded-price for 9, and cib-price for grades 7–7.5. SGC 10 is skipped.',
    ],
    questionsForUser: [
      'Which market data providers are you authorized to use?',
      'Do you have verified historical sales I can import today for the SKUs you plan to buy?',
    ],
    agentActions: [
      { tool: 'configure_settings', when: 'After receiving approved provider settings privately' },
      { tool: 'test_provider_connection', when: 'After configuring PriceCharting or Pokémon TCG', argsHint: { provider: '<pricecharting or pokemon_tcg>' } },
      { tool: 'import_sold_comps', when: 'When verified sales are available', argsHint: { csv: '<CSV content, or use comps for a JSON array>' } },
      { tool: 'sync_market_data', when: 'When an authorized provider is ready for a small initial sync', argsHint: { limit: 5 } },
      { tool: 'check_readiness', when: 'After importing or syncing' },
    ],
    verificationChecks: ['Review provider errors and rejected or duplicate sales. Confirm readiness.freshCompSkuCount is greater than zero.'],
    completionCriteria: 'At least one SKU has enough fresh comparable sales for valuation.',
    resources: [
      { label: 'PriceCharting API documentation', url: 'https://www.pricecharting.com/api-documentation' },
      { label: 'Pokémon TCG API documentation', url: 'https://docs.pokemontcg.io/' },
      { label: 'eBay Buy API requirements', url: 'https://developer.ebay.com/api-docs/buy/buy-requirements.html' },
    ],
    settings: ['PRICECHARTING_API_TOKEN', 'POKEMON_TCG_API_KEY', 'EBAY_INSIGHTS_ENABLED'],
  },
  supply_feeds: {
    title: 'Connect approved supply feeds',
    phase: 'feeds_and_data',
    summary: 'Enable eBay Browse or a sanctioned feed authorized by the operator.',
    whyItMatters: 'The scanner needs at least one enabled source to discover listings.',
    operatorActions: [
      'For eBay Browse, create or select a Production app at https://developer.ebay.com/my/keys and provide EBAY_CLIENT_ID and EBAY_CLIENT_SECRET privately.',
      'For other sources, obtain authorized Best Buy API or TCGplayer access, approved Shopify LGS domains (LGS_SHOPIFY_DOMAINS), or authorized Costco or Pokémon Center HTTPS JSON feeds.',
    ],
    questionsForUser: ['Which supply feed should we enable first, and do you have its approved credentials or feed URL?'],
    agentActions: [
      { tool: 'configure_settings', when: 'After confirming the provider and receiving its settings privately' },
      { tool: 'test_provider_connection', when: 'After configuring a feed with a supported probe', argsHint: { provider: '<configured provider, such as ebay_browse>' } },
      { tool: 'check_readiness', when: 'After the provider check' },
    ],
    verificationChecks: ['Review probe results and confirm the expected source appears in readiness.enabledConnectors.'],
    completionCriteria: 'At least one supply connector is enabled.',
    resources: [
      { label: 'eBay developer application keys', url: 'https://developer.ebay.com/my/keys' },
      { label: 'eBay Browse API overview', url: 'https://developer.ebay.com/api-docs/buy/browse/overview.html' },
    ],
    settings: [
      'EBAY_CLIENT_ID', 'EBAY_CLIENT_SECRET', 'EBAY_ACCESS_TOKEN', 'BESTBUY_API_KEY', 'COSTCO_FEED_URL', 'COSTCO_API_KEY',
      'POKEMON_CENTER_FEED_URL', 'POKEMON_CENTER_API_KEY', 'LGS_SHOPIFY_DOMAINS', 'TCGPLAYER_API_TOKEN',
    ],
  },
  risk_and_tax: {
    title: 'Confirm spending, tax, and intake',
    phase: 'risk_and_ops',
    summary: 'Agree on risk limits, the purchase tax estimate, and who will receive and ship inventory.',
    whyItMatters: 'Spending limits protect cash, while tax, intake QC, and fulfillment affect margins and which cards are ready to sell.',
    operatorActions: [
      'Confirm starting cash, minimum cash reserve, daily spending cap, per-order auto-buy cap, and the maximum position per SKU. Use integer USD cents for dollars and whole units for SKU positions.',
      'Confirm where your state resale certificate applies. Set ARBITRAGE_SALES_TAX_RATE=0 when the purchases are exempt or review the default estimate of 0.08.',
      'Decide who handles physical receiving, intake QC, and shipping. For $250+ cards, confirm whether PSA Vault or Fanatics Collect consignment fits the plan.',
    ],
    questionsForUser: [
      'What starting cash, reserve, daily cap, per-order cap, and per-SKU limit do you approve?',
      'Does your state resale certificate cover these purchases, and who will handle intake QC and fulfillment?',
      'Do you want me to save changes or record your approval of the current settings and fulfillment plan?',
    ],
    agentActions: [
      { tool: 'get_system_state', when: 'Before reviewing current cash and thresholds' },
      { tool: 'configure_settings', when: 'After the operator approves changes to the risk and tax settings' },
      { tool: 'update_setup_workflow', when: 'If the operator confirms the current settings and fulfillment plan',
        argsHint: { acknowledgeStep: 'risk_and_tax', note: '<confirmed limits, tax, and fulfillment plan>' } },
      { tool: 'check_readiness', when: 'After saving settings or recording acknowledgement' },
    ],
    verificationChecks: ['Check current thresholds, cash, and the tax estimate against the approved values. Refresh the guide to verify the checkpoint.'],
    completionCriteria: 'The runtime is simulated, all six risk and tax settings are configured, or the operator has acknowledged the plan.',
    resources: [],
    settings: [
      'ARBITRAGE_DAILY_CAP_CENTS', 'ARBITRAGE_AUTO_BUY_MAX_ORDER_CENTS', 'ARBITRAGE_MAX_POSITION_PER_SKU',
      'ARBITRAGE_CASH_BALANCE_CENTS', 'ARBITRAGE_MIN_CASH_RESERVE_CENTS', 'ARBITRAGE_SALES_TAX_RATE',
    ],
  },
  alerting_and_verification: {
    title: 'Choose alerts and verification',
    phase: 'risk_and_ops',
    summary: 'Choose external alerts and live verification, or record the operator’s preferred local and manual workflow.',
    whyItMatters: 'Alerts surface decisions and incidents. Certificate and photo checks flag listings that need review.',
    operatorActions: [
      'If desired, create a Discord, Slack, or custom HTTPS webhook and provide ARBITRAGE_WEBHOOK_URL privately.',
      'Request a PSA Public API token at https://www.psacard.com/publicapi and obtain an approved OpenAI-compatible vision endpoint, API key, and model.',
      'Confirm whether to use local alerts, manual certificate checks, or heuristic photo checks for omitted services.',
    ],
    questionsForUser: [
      'Which webhook and live verification providers should I connect?',
      'Should I record your mixed setup or skip external services and use local alerts, manual cert checks, and heuristic photo checks?',
    ],
    agentActions: [
      { tool: 'configure_settings', when: 'After receiving approved webhook, PSA, or vision settings' },
      { tool: 'test_provider_connection', when: 'For each configured service', argsHint: { provider: '<webhook, psa, or vision>' } },
      { tool: 'update_setup_workflow', when: 'After the operator confirms a mixed setup',
        argsHint: { acknowledgeStep: 'alerting_and_verification', note: '<confirmed mix of live and manual services>' } },
      { tool: 'update_setup_workflow', when: 'After the operator confirms an opt-out',
        argsHint: { skipStep: 'alerting_and_verification', reason: '<confirmed local and manual verification plan>' } },
      { tool: 'check_readiness', when: 'After configuring providers or recording a checkpoint' },
    ],
    verificationChecks: ['Review connection results and compare readiness.webhookAlertingEnabled, certVerifier, and visionVerifier with the chosen setup.'],
    completionCriteria: 'All three live services are enabled, the runtime is simulated, or the operator records an acknowledgement or opt-out.',
    resources: [{ label: 'PSA Public API', url: 'https://www.psacard.com/publicapi' }],
    settings: ['ARBITRAGE_WEBHOOK_URL', 'PSA_API_TOKEN', 'VISION_API_URL', 'VISION_API_KEY', 'VISION_MODEL'],
  },
  ebay_checkout: {
    title: 'Authorize eBay checkout',
    phase: 'ebay_authorization',
    summary: 'Verify limited-release eBay Buy Order API approval before requesting the buy.order scope.',
    whyItMatters: 'Automatic checkout requires authorized eBay member credentials. Browse access alone supports listing discovery.',
    operatorActions: [
      'Confirm that eBay approved production Buy Order API access for the app. If approval is pending, choose HITL alerts to continue with operator-managed checkout.',
      'Register the Production redirect name (EBAY_RU_NAME) at https://developer.ebay.com/my/auth/?env=production.',
      'Open the consent link, sign in to the intended eBay buyer account, approve only the authorized scope, and provide the redirect URL or code privately.',
    ],
    questionsForUser: [
      'Has eBay approved production Buy Order API access for this app, or should we switch the target to HITL alerts while you wait?',
      'Which registered Production RuName and buyer account should we use for consent?',
    ],
    agentActions: [
      { tool: 'update_setup_workflow', when: 'If approval is pending and the operator chooses HITL alerts', argsHint: { targetProfile: 'hitl_alerts' } },
      { tool: 'configure_settings', when: 'After the operator confirms the registered EBAY_RU_NAME' },
      { tool: 'start_ebay_oauth', when: 'After confirming production app access and the buy.order scope',
        argsHint: { sandbox: false, includeBuyOrder: true, includeSell: false } },
      { tool: 'complete_ebay_oauth', when: 'After receiving the buyer consent redirect or code privately',
        argsHint: { sandbox: false, code: '<private consent response>', saveAs: 'buy' } },
      { tool: 'check_readiness', when: 'After saving the approved buyer credentials' },
    ],
    verificationChecks: ['Confirm production access with the operator and check that readiness.checkoutCapability reports configured checkout.'],
    completionCriteria: 'Checkout capability is available, or the operator has selected the HITL alerts profile.',
    resources: [
      { label: 'Register a Production eBay RuName', url: 'https://developer.ebay.com/my/auth/?env=production' },
      { label: 'eBay Buy API requirements', url: 'https://developer.ebay.com/api-docs/buy/buy-requirements.html' },
      { label: 'eBay OAuth guide', url: 'https://developer.ebay.com/develop/guides/sell/authorization' },
    ],
    settings: ['EBAY_CLIENT_ID', 'EBAY_CLIENT_SECRET', 'EBAY_RU_NAME', 'EBAY_REFRESH_TOKEN', 'EBAY_ORDER_API_TOKEN'],
  },
  ebay_selling_and_fulfillment: {
    title: 'Authorize eBay selling and fulfillment',
    phase: 'ebay_authorization',
    summary: 'Connect an authorized seller account, business policies, merchant location, and paid-sale reconciliation.',
    whyItMatters: 'Approved policies and a location are required to publish; reconciliation records paid orders and updates available cash.',
    operatorActions: [
      'Opt in to eBay Business Policies at https://www.ebay.com/bp/manage and set up shipping, payment, and returns for the seller account.',
      'Sign in through the Sell consent link and authorize sell.inventory, sell.account.readonly, and sell.fulfillment.readonly. Provide the redirect URL or code privately.',
      'Review discovered policy IDs and the warehouse address before approving any saved defaults or merchant location creation. Prepare suitable HTTPS photos of QC-passed inventory.',
      'Consider an eBay Sandbox rehearsal using sandbox credentials, EBAY_SELL_SANDBOX=true, a separate project .env, and a separate SQLite database.',
    ],
    questionsForUser: [
      'Which seller account, business policies, and warehouse location should we use?',
      'Would you like to rehearse in the eBay Sandbox before enabling production selling?',
      'Do you approve these discovered policy IDs and this merchant location or warehouse address?',
    ],
    agentActions: [
      { tool: 'configure_settings', when: 'After confirming the registered EBAY_RU_NAME and the production or sandbox settings' },
      { tool: 'start_ebay_oauth', when: 'After confirming the selected environment, RuName, and approved scopes',
        argsHint: { includeBuyOrder: false, includeSell: true } },
      { tool: 'complete_ebay_oauth', when: 'After receiving the seller consent redirect or code privately',
        argsHint: { code: '<private consent response>', saveAs: 'sell' } },
      { tool: 'discover_ebay_policies', when: 'Before saving policies or creating a merchant location', argsHint: { autoSave: false } },
      { tool: 'discover_ebay_policies', when: 'After the operator approves the discovered defaults. Include warehouse creation only after address approval.',
        argsHint: { autoSave: true } },
      { tool: 'test_provider_connection', when: 'After saving sell settings', argsHint: { provider: 'ebay_sell_policies' } },
      { tool: 'reconcile_ebay_sales', when: 'When the operator approves recording paid orders', argsHint: { limit: 10 } },
      { tool: 'check_readiness', when: 'After the sell and fulfillment checks' },
    ],
    verificationChecks: ['Confirm the approved settings, review reconciliation errors and cash, and verify sellCapability and fulfillmentSyncEnabled.'],
    completionCriteria: 'Selling and fulfillment sync are configured, or the selected profile leaves selling with the operator.',
    resources: [
      { label: 'eBay Business Policies', url: 'https://www.ebay.com/bp/manage' },
      { label: 'eBay merchant locations', url: 'https://developer.ebay.com/api-docs/sell/static/inventory/managing-inventory-locations.html' },
    ],
    settings: [
      'EBAY_SELL_REFRESH_TOKEN', 'EBAY_SELL_API_TOKEN', 'EBAY_FULFILLMENT_POLICY_ID', 'EBAY_PAYMENT_POLICY_ID',
      'EBAY_RETURN_POLICY_ID', 'EBAY_MERCHANT_LOCATION_KEY', 'EBAY_SELL_SANDBOX',
    ],
  },
  shadow_burn_in_and_go_live: {
    title: 'Review a shadow pass and launch',
    phase: 'validation_and_launch',
    summary: 'Inspect a recorded shadow pass, then obtain explicit approval for the target operating mode.',
    whyItMatters: 'A shadow pass lets the operator inspect matching, margins, traps, and alerts before enabling checkout.',
    operatorActions: [
      'Resolve any kill switch reason with the operator before proceeding. Review listings, matches, comps, margins, seller checks, traps, alerts, and any paper orders from the shadow pass.',
      'Explicitly approve the target mode and spending limits after that review. Give separate approval for ARBITRAGE_AUTO_PUBLISH_LISTINGS=true.',
      'Choose exactly one 24/7 runner from Docker Compose, macOS launchd, Linux systemd, or scheduled Muse passes.',
    ],
    questionsForUser: [
      'Do you authorize a shadow pass against the configured feeds?',
      'After reviewing the shadow results and limits, do you approve switching to the selected target mode?',
      'If selling is configured, do you separately approve automatic publication, and which single runner should handle periodic scans?',
    ],
    agentActions: [
      { tool: 'check_readiness', when: 'Before the shadow pass, to confirm the kill switch is clear and scanning is ready' },
      { tool: 'set_operating_mode', when: 'After the operator authorizes shadow scanning', argsHint: { mode: 'shadow' } },
      { tool: 'run_autopilot_pass', when: 'In shadow mode, after checking readiness' },
      { tool: 'list_audit_events', when: 'To review the shadow cycle and any errors', argsHint: { limit: 20 } },
      { tool: 'set_operating_mode', when: 'Only after reviewing the shadow pass and obtaining explicit approval',
        argsHint: { mode: '<hitl for hitl_alerts, live for either live profile>' } },
      { tool: 'configure_settings', when: 'Only after separate approval for automatic publication',
        argsHint: { settings: { ARBITRAGE_AUTO_PUBLISH_LISTINGS: 'true' } } },
      { tool: 'check_readiness', when: 'After promotion and before scheduling a single runner' },
    ],
    verificationChecks: [
      'Check for a shadow order or a clean shadow cycle that fetched listings. Review the audit, keep the kill switch clear, and confirm readiness for the selected profile.',
      'Confirm exactly one runner owns periodic scans and syncs.',
    ],
    completionCriteria: 'A shadow pass is recorded and readiness passes for the target profile.',
    resources: [],
    settings: [],
  },
};

const conversationRules = [
  'Confirm the database path and ask the operator to choose a targetProfile if profileSelected is false, even if catalog is already complete.',
  'Start with currentStep and work one step at a time. Present its operatorActions and ask its questionsForUser as needed. Avoid listing every environment variable upfront.',
  'Use configure_settings for approved settings so the operator can keep the configuration inside Muse. Use a secure input mechanism for credentials and OAuth responses, and never echo them in chat, workflow notes, or audit events.',
  'Use update_setup_workflow to checkpoint the selected profile, approved acknowledgements, and opt-outs. Refresh get_setup_guide after each step.',
  'Use only sanctioned APIs and operator-authorized feeds. Verify configured providers with test_provider_connection where supported and recheck check_readiness before advancing.',
  'Review a recorded shadow pass before obtaining explicit approval to set hitl or live mode. Obtain separate approval before enabling automatic publication and stop when the kill switch is engaged.',
  'Use a separate rehearsal database and choose exactly one continuous runner for the approved deployment.',
];

type SetupReadiness = Pick<ReadinessReport,
  'catalogSkuCount' | 'freshCompSkuCount' | 'enabledConnectors' | 'certVerifier' | 'visionVerifier' |
  'webhookAlertingEnabled' | 'checkoutCapability' | 'sellCapability' | 'fulfillmentSyncEnabled' |
  'readyForShadowScan' | 'readyForHitlAlerts' | 'readyForLiveAutoBuy' | 'readyForLiveAutoSell' | 'killSwitchEngaged'>;

export function setupSteps(
  readiness: SetupReadiness, shadowPassRecorded: boolean, workflowState = defaultSetupWorkflowState(),
) {
  const { targetProfile, profileSelected, acknowledgedSteps, skippedSteps } = workflowState;
  const simulated = readiness.checkoutCapability === 'simulated';
  const profile = SETUP_PROFILE_DEFINITIONS[targetProfile];
  const readyForTargetProfile = targetProfile === 'hitl_alerts' ? readiness.readyForHitlAlerts
    : readiness.readyForLiveAutoBuy &&
      (!profile.requiresSellApi || simulated || (readiness.readyForLiveAutoSell && readiness.fulfillmentSyncEnabled));
  const complete: Record<SetupStepId, boolean> = {
    catalog: readiness.catalogSkuCount > 0,
    market_data: readiness.freshCompSkuCount > 0,
    supply_feeds: readiness.enabledConnectors.length > 0,
    risk_and_tax: simulated || definitions.risk_and_tax.settings.every(key => Boolean(process.env[key]?.trim())) ||
      Boolean(acknowledgedSteps.risk_and_tax),
    alerting_and_verification: simulated || Boolean(acknowledgedSteps.alerting_and_verification) ||
      (readiness.webhookAlertingEnabled && readiness.certVerifier === 'psa_live' && readiness.visionVerifier === 'openai_live'),
    ebay_checkout: readiness.checkoutCapability !== 'manual_only',
    ebay_selling_and_fulfillment: readiness.sellCapability !== 'local_only' && readiness.fulfillmentSyncEnabled,
    shadow_burn_in_and_go_live: shadowPassRecorded && readyForTargetProfile,
  };

  const steps = SETUP_STEP_IDS.map((id, index): SetupStep => {
    const { settings, ...definition } = definitions[id];
    const configuredKeys = settings.filter(key => Boolean(process.env[key]?.trim()));
    const skippable = isStepSkippableForProfile(id, targetProfile);
    const skip = skippable ? skippedSteps[id] : undefined;
    const skippedByProfile = profileSelected && (id === 'ebay_checkout' || id === 'ebay_selling_and_fulfillment');
    const blocked = id === 'shadow_burn_in_and_go_live' && (!readiness.readyForShadowScan || readiness.killSwitchEngaged);
    const status = complete[id] ? 'complete' : skippable && (skip || skippedByProfile) ? 'skipped' : blocked ? 'blocked' : 'pending';
    const acknowledgement = acknowledgedSteps[id];
    return {
      ...definition, id, status, order: index + 1, required: !skippable, skippable,
      acknowledgeable: isStepAcknowledgeable(id), configuredKeys,
      missingKeys: settings.filter(key => !configuredKeys.includes(key)),
      mcpTools: [...new Set(definition.agentActions.map(action => action.tool))],
      userInstructions: definition.operatorActions,
      externalLinks: definition.resources.map(({ url }) => url),
      ...(acknowledgement ? { acknowledgement } : {}),
      ...(skip ? { skip } : {}),
    };
  });
  const resolved = (step: SetupStep) => step.status === 'complete' || step.status === 'skipped';
  const completedStepCount = steps.filter(resolved).length;
  const currentStep = steps.find(step => !resolved(step)) ?? null;
  const nextSetupStep = currentStep?.id ?? null;
  const workflow: SetupWorkflowDirective = {
    targetProfile, profileSelected, profileDescription: profile.summary,
    currentStepId: nextSetupStep, currentStepTitle: currentStep?.title ?? null,
    completedStepCount, totalStepCount: steps.length, readyForTargetProfile, conversationRules,
    profiles: SETUP_PROFILES.map(id => SETUP_PROFILE_DEFINITIONS[id]),
  };
  return { steps, currentStep, workflow, setupProgressPct: Math.round(100 * completedStepCount / steps.length), nextSetupStep };
}
