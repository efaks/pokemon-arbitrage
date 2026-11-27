import { readFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { installCatalogPack, listCatalogPacks } from './catalog/catalogPacks.ts';
import { seedCanonicalCatalog, seedStarterSkus } from './catalog/seed.ts';
import { createConfig } from './config.ts';
import type { ArbitrageConfig } from './config.ts';
import type { SupplyConnector } from './connectors/base.ts';
import { EbayBrowseConnector } from './connectors/ebayConnector.ts';
import { MockScenarioConnector } from './connectors/mockScenarioConnector.ts';
import {
  BestBuyApiConnector, CostcoConnector, PokemonCenterConnector, ShopifyStorefrontConnector, TcgplayerFeedConnector,
} from './connectors/retailerConnectors.ts';
import { ArbitrageDatabase } from './db/database.ts';
import { RiskEngine } from './decision/riskEngine.ts';
import { formatUsd } from './domain/money.ts';
import { OperatingMode } from './domain/types.ts';
import type { CycleSummary, PurchaseOrder } from './domain/types.ts';
import { AutopilotEngine } from './engine/autopilot.ts';
import type { AutopilotCycleSummary } from './engine/autopilot.ts';
import { evaluateReadiness } from './engine/readiness.ts';
import type { ReadinessReport } from './engine/readiness.ts';
import { loadProjectEnv } from './env.ts';
import { EbayOrderApiExecutor, ExecutionCoordinator, SimulatedApiExecutor } from './execution/executor.ts';
import { EbayFulfillmentAdapter, SalesReconciler, SimulatedFulfillmentAdapter } from './liquidation/ebayFulfillment.ts';
import { InventoryManager } from './liquidation/inventoryManager.ts';
import { EbaySellInventoryAdapter, SimulatedSellerAdapter } from './liquidation/ebaySellerAdapter.ts';
import { MockCertVerifier, PsaHttpCertVerifier } from './matching/certVerifier.ts';
import { EntityResolver } from './matching/entityResolver.ts';
import { HeuristicVisionVerifier, OpenAICompatibleVisionVerifier } from './matching/visionVerifier.ts';
import { ArbitrageMcpServer } from './mcp/mcpServer.ts';
import { StdioMcpTransport } from './mcp/stdioTransport.ts';
import { CompositeNotifier, ConsoleNotifier, NullNotifier, WebhookNotifier } from './notifications/notifier.ts';
import { ArbitragePipeline } from './pipeline/arbitragePipeline.ts';
import { createArbitrageServer } from './server/httpServer.ts';
import { buildSetupGuide } from './setup/configManager.ts';
import type { SetupGuideReport } from './setup/configManager.ts';
import { redactSecrets, rememberConfiguredSecrets } from './setup/secrets.ts';
import { importSoldComps, parseSoldCompsCsv } from './sync/compImporter.ts';
import type { ImportCompInput } from './sync/compImporter.ts';
import { EbaySoldCompsSyncer, MarketSyncCoordinator, PokemonTcgApiCatalogSyncer, PriceChartingSyncer } from './sync/marketSync.ts';
import { FmvEngine } from './valuation/fmvEngine.ts';

export interface SystemRuntimeOptions {
  dbPath?: string;
  mode?: OperatingMode;
  useMock?: boolean;
  envFileLoaded?: boolean;
  envPath?: string;
  seedCatalog?: boolean;
  quiet?: boolean;
  configOverrides?: Partial<ArbitrageConfig>;
  simulationOverrides?: Record<string, {
    available?: boolean;
    currentPriceCents?: number;
    currentShippingCents?: number;
    failureReason?: string;
  }>;
}

export interface SystemRuntime {
  db: ArbitrageDatabase;
  config: ArbitrageConfig;
  resolver: EntityResolver;
  fmvEngine: FmvEngine;
  riskEngine: RiskEngine;
  executor: ExecutionCoordinator;
  inventoryManager: InventoryManager;
  salesReconciler: SalesReconciler;
  pipeline: ArbitragePipeline;
  connectors: SupplyConnector[];
  marketSync: MarketSyncCoordinator;
  useMock?: boolean;
  envFileLoaded?: boolean;
  envPath?: string;
  quiet?: boolean;
  simulationOverrides?: SystemRuntimeOptions['simulationOverrides'];
}

export function createSystemRuntime(options: SystemRuntimeOptions = {}): SystemRuntime {
  const envPath = resolve(options.envPath ?? '.env');
  const envFileLoaded = options.envFileLoaded ?? (options.envPath ? loadProjectEnv(envPath).loaded : undefined);
  const config = createConfig({
    ...options.configOverrides,
    ...(options.dbPath !== undefined ? { dbPath: options.dbPath } : {}),
    ...(options.mode !== undefined ? { operatingMode: options.mode } : {}),
  });
  const db = new ArbitrageDatabase(config.dbPath);
  try {
    if (options.seedCatalog ?? options.useMock) seedCanonicalCatalog(db);
    const envMode = Object.values(OperatingMode).find(mode => mode === process.env.ARBITRAGE_MODE?.trim());
    const explicitMode = options.mode ?? options.configOverrides?.operatingMode ?? envMode;
    config.operatingMode = explicitMode ?? db.getSystemState().operatingMode;
    const components = buildRuntimeComponents(db, config, options);
    if (explicitMode !== undefined) db.setOperatingMode(explicitMode);
    return { db, config, ...components, envPath, envFileLoaded, useMock: options.useMock, quiet: options.quiet,
      simulationOverrides: options.simulationOverrides };
  } catch (error) {
    db.close();
    throw error;
  }
}

function buildRuntimeComponents(db: ArbitrageDatabase, config: ArbitrageConfig, options: SystemRuntimeOptions) {
  const connectors = options.useMock
    ? [new MockScenarioConnector()]
    : [
      new EbayBrowseConnector(), new BestBuyApiConnector(), new CostcoConnector(), new PokemonCenterConnector(),
      new ShopifyStorefrontConnector(), new TcgplayerFeedConnector(),
    ];
  const certVerifier = options.useMock ? new MockCertVerifier() : new PsaHttpCertVerifier();
  const visionVerifier = !options.useMock && process.env.VISION_API_KEY?.trim() && process.env.VISION_API_URL?.trim()
    ? new OpenAICompatibleVisionVerifier() : new HeuristicVisionVerifier();
  const resolver = new EntityResolver({ config, certVerifier, visionVerifier });
  const fmvEngine = new FmvEngine();
  const riskEngine = new RiskEngine();
  // The coordinator checks the persisted mode. Keep the real adapter ready for dashboard mode changes.
  const adapter = options.useMock ? new SimulatedApiExecutor(options.simulationOverrides) : new EbayOrderApiExecutor();
  const executor = new ExecutionCoordinator({ db, config, adapter });
  const sellerAdapter = options.useMock ? new SimulatedSellerAdapter() : new EbaySellInventoryAdapter();
  const inventoryManager = new InventoryManager(db, fmvEngine, config, sellerAdapter);
  const fulfillmentAdapter = options.useMock ? new SimulatedFulfillmentAdapter() : new EbayFulfillmentAdapter();
  const salesReconciler = new SalesReconciler(db, inventoryManager, fulfillmentAdapter);
  const notifier = !options.useMock && process.env.ARBITRAGE_WEBHOOK_URL?.trim()
    ? new CompositeNotifier([new WebhookNotifier(), ...(options.quiet ? [] : [new ConsoleNotifier()])])
    : options.quiet ? new NullNotifier() : new ConsoleNotifier();
  const pipeline = new ArbitragePipeline({ db, config, connectors, resolver, fmvEngine, riskEngine, executor, notifier });
  const marketSync = new MarketSyncCoordinator(db, [
    new PokemonTcgApiCatalogSyncer(options.useMock ? { apiKey: '' } : undefined),
    new PriceChartingSyncer(options.useMock ? { apiToken: '' } : undefined),
    new EbaySoldCompsSyncer(options.useMock ? { enabled: false } : undefined),
  ]);

  return { resolver, fmvEngine, riskEngine, executor, inventoryManager, salesReconciler, pipeline, connectors, marketSync };
}

export function reloadSystemRuntime(runtime: SystemRuntime): SystemRuntime {
  // Capture credentials used by in-flight adapters before replacing file values.
  rememberConfiguredSecrets();
  const envFileLoaded = loadProjectEnv(runtime.envPath, { reload: true }).loaded;
  const { db, useMock } = runtime;
  const persistedMode = db.getSystemState().operatingMode;
  const envMode = Object.values(OperatingMode).find(mode => mode === process.env.ARBITRAGE_MODE?.trim());
  const config = createConfig({ dbPath: runtime.config.dbPath, operatingMode: useMock ? persistedMode : envMode ?? persistedMode });
  const components = buildRuntimeComponents(db, config, runtime);
  if (config.operatingMode !== persistedMode) db.setOperatingMode(config.operatingMode);
  return Object.assign(runtime, components, { config, envFileLoaded });
}

const percentage = new Intl.NumberFormat('en-US', { style: 'percent', maximumFractionDigits: 1 });

function printCycle(summary: CycleSummary): void {
  console.log(`\nCycle totals (${summary.operatingMode})`);
  console.table([{
    Fetched: summary.fetchedCount, Deduplicated: summary.deduplicatedCount, Matched: summary.matchedCount,
    Rejected: summary.rejectedCount, 'Auto-bought': summary.autoBoughtCount, 'HITL queue': summary.hitlQueuedCount,
    Skipped: summary.skippedCount, Shadow: summary.shadowRecordedCount, Errors: summary.errorCount,
    'Circuit breaker': summary.killSwitchTriggered ? 'Tripped' : '—',
  }]);
  for (const error of summary.errors) console.error(redactSecrets(error));
}

function orderDetails(order: PurchaseOrder) {
  return {
    Listing: order.listingId,
    'Landed cost': formatUsd(order.landedCostCents),
    'Expected profit': formatUsd(order.expectedNetProfitCents),
    ROI: percentage.format(order.expectedNetRoi),
  };
}

async function demo(): Promise<void> {
  const { db, pipeline } = createSystemRuntime({
    dbPath: ':memory:', mode: 'live', useMock: true, seedCatalog: true, quiet: true,
    configOverrides: { dailySpendCapCents: 150_000 },
  });
  try {
    console.log('Simulated feed · $1,500 daily cap');
    printCycle(await pipeline.runCycle());
    console.log('\nAuto-Bought Orders (simulated)');
    console.table(db.listOrders('filled').reverse().map(order => ({
      ...orderDetails(order), 'External order ID': order.externalOrderId,
    })));
    console.log('\nHITL Review Queue');
    console.table(db.listOrders('pending_hitl').reverse().map(order => ({
      ...orderDetails(order), 'Review required': order.decisionWarnings.join(' · '),
    })));
    console.log('\nRejected / Skipped Traps');
    console.table(db.listDecisions(-1, 'skip').reverse().map(decision => ({
      Listing: decision.listingId,
      SKU: decision.skuName ?? '—',
      Reason: decision.reasons[0] ?? '—',
    })));
  } finally {
    db.close();
  }
}

function printAutopilot(summary: AutopilotCycleSummary): void {
  console.log('Buy Book tiers');
  console.table(summary.buyBook);
  printCycle(summary.cycle);
  console.log('Autonomous triage');
  const { actions: triageActions, ...triageTotals } = summary.triage;
  console.table([triageTotals]);
  if (triageActions.length) console.table(triageActions);
  console.log('Repricing and vault routing');
  const { actions, errors, ...repricingTotals } = summary.repricing;
  console.table([repricingTotals]);
  if (actions.length) console.table(actions.map(action => ({
    Inventory: action.inventoryId, Route: action.fulfillment.route, Channel: action.listedChannel,
    'Listed price': formatUsd(action.listedPriceCents), 'Expected net': formatUsd(action.expectedNetProfitCents),
  })));
  for (const error of errors ?? []) console.error(`Repricing failed for ${redactSecrets(error)}`);
  if (summary.reconciliation) console.log('Sale reconciliation', redactSecrets(summary.reconciliation));
  const { detectToDecision, decisionToFill, ...telemetry } = summary.telemetry;
  console.log(`Latency telemetry (${telemetry.samplesCount} decisions, milliseconds)`);
  const roundLatency = ({ p50Ms, p95Ms, p99Ms, maxMs }: typeof detectToDecision) => ({
    P50: p50Ms.toFixed(2), P95: p95Ms.toFixed(2), P99: p99Ms.toFixed(2), Max: maxMs.toFixed(2),
  });
  console.table({ 'Detect to decision': roundLatency(detectToDecision), 'Decision to fill': roundLatency(decisionToFill) });
  console.log(`Fill rate ${percentage.format(telemetry.fillRate)} · Miss rate ${percentage.format(telemetry.missRate)}`);
}

function printReadiness(report: ReadinessReport): void {
  const { blockingIssues, warnings, recommendedNextActions, ...status } = report;
  console.table(Object.entries(status).map(([check, value]) => ({
    Check: check, Status: Array.isArray(value) ? value.join(', ') || '—' : value ?? '—',
  })));
  for (const [heading, items] of [
    ['Blocking issues', blockingIssues], ['Warnings', warnings], ['Recommended next actions', recommendedNextActions],
  ] as const) {
    if (items.length === 0) continue;
    console.log('\n' + heading);
    for (const item of items) console.log('- ' + item);
  }
}

function printSetupGuide(report: SetupGuideReport): void {
  const { currentStep, workflow, steps, setupProgressPct } = report;
  const profile = workflow.profiles.find(item => item.id === workflow.targetProfile);
  const profileStatus = workflow.profileSelected ? 'selected' : 'default';
  console.log(`Profile: ${profile?.label ?? workflow.targetProfile} (${workflow.targetProfile}, ${profileStatus})`);
  console.log(`Setup ${setupProgressPct}% complete. Next step: ${currentStep?.title ?? 'Complete!'}`);
  const statusLabels = { complete: 'DONE', skipped: 'SKIP', blocked: 'BLOCKED', pending: 'WAIT' };
  for (const step of steps) {
    const label = step.status === 'pending' && step.id === currentStep?.id ? 'NEXT' : statusLabels[step.status];
    console.log(`[${label}] ${step.order}. ${step.id} · ${step.title} (${step.phase})`);
  }
  if (currentStep) {
    console.log(`\nCurrent Step · ${currentStep.title}\n${currentStep.summary}\n${currentStep.whyItMatters}`);
    for (const [heading, items] of [
      ['Operator actions', currentStep.operatorActions],
      ['Questions for the operator', currentStep.questionsForUser],
      ['Resources', currentStep.resources.map(({ label, url }) => `${label} · ${url}`)],
      ['Muse actions', currentStep.agentActions.map(({ tool, when }) => `${tool} · ${when}`)],
      ['Verification checks', currentStep.verificationChecks],
    ] as const) {
      if (!items.length) continue;
      console.log('\n' + heading);
      for (const item of items) console.log('- ' + item);
    }
    console.log(`\nCompletion criteria\n${currentStep.completionCriteria}`);
  }
  console.log('\nOpen guided_setup_wizard in Muse to continue interactively, or use --json for the full setup guide.');
}

const usage = `Usage: node src/cli.ts <command>
  demo
  doctor [--db data/arbitrage.sqlite] [--mock] [--json]
  bootstrap [--db data/arbitrage.sqlite]
  setup [--db data/arbitrage.sqlite] [--json]
  expand-catalog [--pack all_curated] [--db data/arbitrage.sqlite]
  reconcile-sales [--db data/arbitrage.sqlite] [--mock]
  scan  [--mode shadow|hitl|live] [--db data/arbitrage.sqlite] [--mock]
  serve [--host 127.0.0.1] [--port 3000] [--mode shadow|hitl|live] [--db data/arbitrage.sqlite] [--mock] [--poll-ms 0]
  mcp   [--mode shadow|hitl|live] [--db data/arbitrage.sqlite] [--mock]
  sync  [--db data/arbitrage.sqlite] [--limit 50]
  import-comps --file <path> [--db data/arbitrage.sqlite]
  autopilot [--mode live|hitl|shadow] [--db data/arbitrage.sqlite] [--mock] [--once]
            [--hot-ms 5000] [--standard-ms 30000] [--reprice-ms 60000] [--sync-ms milliseconds]`;

function integerOption(value: string, label: string, max: number): number {
  const number = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number > max) {
    throw new Error(`--${label} must be an integer between 0 and ${max}`);
  }
  return number;
}

async function main(args: string[]): Promise<void> {
  const { loaded: envFileLoaded } = loadProjectEnv();
  const [command, ...flags] = args;
  if (command === '--help' || command === '-h') {
    console.log(usage);
    return;
  }
  if (command === 'demo' && flags.length === 0) return demo();
  if (!['scan', 'serve', 'mcp', 'autopilot', 'sync', 'bootstrap', 'doctor', 'import-comps', 'setup', 'expand-catalog', 'reconcile-sales'].includes(command)) {
    throw new Error(usage);
  }

  const { values } = parseArgs({
    args: flags,
    options: {
      mode: { type: 'string' }, db: { type: 'string' }, mock: { type: 'boolean' },
      port: { type: 'string' }, host: { type: 'string' }, pack: { type: 'string' }, 'poll-ms': { type: 'string' },
      once: { type: 'boolean' }, 'hot-ms': { type: 'string' }, 'standard-ms': { type: 'string' }, 'reprice-ms': { type: 'string' },
      'sync-ms': { type: 'string' }, limit: { type: 'string' }, json: { type: 'boolean' }, file: { type: 'string' },
    },
  });
  const mode = Object.values(OperatingMode).find(candidate => candidate === values.mode);
  if (values.mode !== undefined && mode === undefined) throw new Error('--mode must be shadow, hitl, or live');
  if (command !== 'serve' && (values.host !== undefined || values.port !== undefined || values['poll-ms'] !== undefined)) throw new Error(usage);

  if (command !== 'autopilot' && [values.once, values['hot-ms'], values['standard-ms'], values['reprice-ms'], values['sync-ms']]
    .some(value => value !== undefined)) throw new Error(usage);
  if (command !== 'sync' && values.limit !== undefined) throw new Error(usage);
  if (command !== 'expand-catalog' && values.pack !== undefined) throw new Error(usage);
  if (command !== 'doctor' && command !== 'setup' && values.json !== undefined) throw new Error(usage);
  if (command !== 'import-comps' && values.file !== undefined) throw new Error(usage);

  if (['sync', 'doctor', 'bootstrap', 'import-comps', 'setup', 'expand-catalog', 'reconcile-sales'].includes(command) && mode !== undefined) throw new Error(usage);
  if (['sync', 'bootstrap', 'import-comps', 'setup', 'expand-catalog'].includes(command) && values.mock !== undefined) throw new Error(usage);

  if (command === 'import-comps') {
    if (!values.file) throw new Error('import-comps requires --file');
    const extension = extname(values.file).toLowerCase();
    if (extension !== '.csv' && extension !== '.json') throw new Error('Sold comp file must be .csv or .json');
    const file = readFileSync(values.file, 'utf8');
    const inputs: unknown = extension === '.csv' ? parseSoldCompsCsv(file) : JSON.parse(file);
    if (!Array.isArray(inputs)) throw new Error('Sold comp JSON must contain an array');
    const { dbPath } = createConfig(values.db === undefined ? {} : { dbPath: values.db });
    const db = new ArbitrageDatabase(dbPath);
    try {
      console.log(JSON.stringify(importSoldComps(db, inputs as ImportCompInput[]), null, 2));
    } finally {
      db.close();
    }
    return;
  }

  if (command === 'bootstrap') {
    const { dbPath } = createConfig(values.db === undefined ? {} : { dbPath: values.db });
    const db = new ArbitrageDatabase(dbPath);
    try {
      console.log(JSON.stringify({ ...seedStarterSkus(db), compsSeeded: 0, nextAction: 'npm run sync' }, null, 2));
    } finally {
      db.close();
    }
    return;
  }

  if (command === 'expand-catalog') {
    const pack = listCatalogPacks().find(candidate => candidate.name === (values.pack ?? 'all_curated'))?.name;
    if (!pack) throw new Error('Unknown catalog pack');
    const db = new ArbitrageDatabase(createConfig(values.db === undefined ? {} : { dbPath: values.db }).dbPath);
    try {
      console.log(JSON.stringify(installCatalogPack(db, pack), null, 2));
    } finally {
      db.close();
    }
    return;
  }

  if (command === 'reconcile-sales') {
    const runtime = createSystemRuntime({ dbPath: values.db, useMock: values.mock, quiet: true, envFileLoaded });
    try {
      console.log(JSON.stringify(redactSecrets(await runtime.salesReconciler.reconcileSoldOrders()), null, 2));
    } finally {
      runtime.db.close();
    }
    return;
  }

  if (command === 'setup') {
    const runtime = createSystemRuntime({ dbPath: values.db, quiet: true, envFileLoaded });
    try {
      const report = buildSetupGuide(runtime);
      if (values.json) console.log(JSON.stringify(report, null, 2));
      else printSetupGuide(report);
    } finally {
      runtime.db.close();
    }
    return;
  }

  if (command === 'doctor') {
    const runtime = createSystemRuntime({ dbPath: values.db, useMock: values.mock, quiet: true, envFileLoaded });
    try {
      const report = evaluateReadiness(runtime);
      if (values.json) console.log(JSON.stringify(redactSecrets(report), null, 2));
      else printReadiness(redactSecrets(report));
    } finally {
      runtime.db.close();
    }
    return;
  }

  if (command === 'sync') {
    const limit = integerOption(values.limit ?? '50', 'limit', Number.MAX_SAFE_INTEGER);
    if (limit === 0) throw new Error('--limit must be a positive integer');
    const { db, marketSync } = createSystemRuntime({ dbPath: values.db, quiet: true });
    try {
      console.log(JSON.stringify(await marketSync.syncAll({ limit }), null, 2));
    } finally {
      db.close();
    }
    return;
  }

  if (command === 'autopilot') {
    const interval = (flag: 'hot-ms' | 'standard-ms' | 'reprice-ms' | 'sync-ms', fallback: string) => {
      const ms = integerOption(values[flag] ?? fallback, flag, 2_147_483_647);
      if (ms === 0) throw new Error(`--${flag} must be at least 1 millisecond`);
      return ms;
    };
    const hotIntervalMs = interval('hot-ms', '5000');
    const standardIntervalMs = interval('standard-ms', '30000');
    const repriceIntervalMs = interval('reprice-ms', '60000');
    const syncIntervalMs = values['sync-ms'] === undefined ? undefined : interval('sync-ms', '');
    const runtime = createSystemRuntime({ dbPath: values.db, mode, useMock: values.mock, quiet: values.once === true });
    const autopilot = new AutopilotEngine(runtime);
    const reload = () => {
      try {
        reloadSystemRuntime(runtime);
        autopilot.refreshBuyBook();
      } catch (error) {
        console.error('Autopilot configuration reload failed', redactSecrets(error instanceof Error ? error.message : String(error)));
      }
    };
    try {
      if (values.once) {
        printAutopilot(await autopilot.runAutopilotPass());
      } else {
        autopilot.startDaemon({ hotIntervalMs, standardIntervalMs, repriceIntervalMs, syncIntervalMs });
        console.log(`Autopilot running in ${runtime.db.getSystemState().operatingMode} mode`);
        let finish!: () => void;
        const stopped = new Promise<void>(resolve => { finish = resolve; });
        const stop = () => {
          autopilot.stopDaemon();
          finish();
        };
        process.on('SIGHUP', reload);
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
        try {
          await stopped;
          await autopilot.waitForIdle();
        } finally {
          process.off('SIGHUP', reload);
          process.off('SIGINT', stop);
          process.off('SIGTERM', stop);
        }
      }
    } finally {
      runtime.db.close();
    }
    return;
  }

  if (command === 'scan') {
    const { db, pipeline } = createSystemRuntime({ dbPath: values.db, mode, useMock: values.mock, quiet: true });
    try {
      printCycle(await pipeline.runCycle());
    } finally {
      db.close();
    }
    return;
  }

  if (command === 'mcp') {
    const runtime = createSystemRuntime({ dbPath: values.db, mode, useMock: values.mock, quiet: true, envFileLoaded });
    const autopilot = new AutopilotEngine(runtime);
    const transport = new StdioMcpTransport(new ArbitrageMcpServer({ runtime, autopilot }));
    const shutdown = () => transport.stop();
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    try {
      await transport.start();
    } finally {
      process.off('SIGINT', shutdown);
      process.off('SIGTERM', shutdown);
      runtime.db.close();
    }
    return;
  }

  const port = integerOption(values.port ?? '3000', 'port', 65535);
  const pollMs = integerOption(values['poll-ms'] ?? '0', 'poll-ms', 2_147_483_647);
  const runtime = createSystemRuntime({ dbPath: values.db, mode, useMock: values.mock, envFileLoaded });
  const autopilot = new AutopilotEngine(runtime);
  const mcpServer = new ArbitrageMcpServer({ runtime, autopilot });
  const server = createArbitrageServer({ ...runtime, runtime, autopilot, mcpHandler: mcpServer.createHttpHandler() });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, values.host ?? process.env.ARBITRAGE_HTTP_HOST ?? '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    const address = server.address();
    console.log(`Pokémon Arbitrage dashboard at http://127.0.0.1:${typeof address === 'object' ? address?.port : port}`);
    const poller = runtime.pipeline;
    if (pollMs > 0) poller.startLoop(pollMs, () => runtime.pipeline.runCycle());
    const shutdown = () => {
      poller.stopLoop();
      server.close();
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    try {
      await new Promise<void>(resolve => { server.once('close', resolve); });
      await Promise.all([poller.waitForIdle(), runtime.pipeline.waitForIdle(), autopilot.waitForIdle()]);
    } finally {
      process.off('SIGINT', shutdown);
      process.off('SIGTERM', shutdown);
    }
  } finally {
    runtime.db.close();
  }
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(redactSecrets(error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
  }
}
