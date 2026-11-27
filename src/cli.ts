import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { seedCanonicalCatalog } from './catalog/seed.ts';
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
import { EbayOrderApiExecutor, ExecutionCoordinator, SimulatedApiExecutor } from './execution/executor.ts';
import { InventoryManager } from './liquidation/inventoryManager.ts';
import { MockCertVerifier, PsaHttpCertVerifier } from './matching/certVerifier.ts';
import { EntityResolver } from './matching/entityResolver.ts';
import { ArbitrageMcpServer } from './mcp/mcpServer.ts';
import { StdioMcpTransport } from './mcp/stdioTransport.ts';
import { ConsoleNotifier, NullNotifier } from './notifications/notifier.ts';
import { ArbitragePipeline } from './pipeline/arbitragePipeline.ts';
import { createArbitrageServer } from './server/httpServer.ts';
import { FmvEngine } from './valuation/fmvEngine.ts';

export interface SystemRuntimeOptions {
  dbPath?: string;
  mode?: OperatingMode;
  useMock?: boolean;
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
  pipeline: ArbitragePipeline;
  connectors: SupplyConnector[];
}

export function createSystemRuntime(options: SystemRuntimeOptions = {}): SystemRuntime {
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
    if (explicitMode !== undefined) db.setOperatingMode(explicitMode);
    config.operatingMode = db.getSystemState().operatingMode;

    const connectors = options.useMock
      ? [new MockScenarioConnector()]
      : [
        new EbayBrowseConnector(), new BestBuyApiConnector(), new CostcoConnector(), new PokemonCenterConnector(),
        new ShopifyStorefrontConnector(), new TcgplayerFeedConnector(),
      ];
    const certVerifier = options.useMock ? new MockCertVerifier() : new PsaHttpCertVerifier();
    const resolver = new EntityResolver({ config, certVerifier });
    const fmvEngine = new FmvEngine();
    const riskEngine = new RiskEngine();
    // The coordinator checks the persisted mode. Keep the real adapter ready for dashboard mode changes.
    const adapter = options.useMock ? new SimulatedApiExecutor(options.simulationOverrides) : new EbayOrderApiExecutor();
    const executor = new ExecutionCoordinator({ db, config, adapter });
    const inventoryManager = new InventoryManager(db, fmvEngine, config);
    const notifier = options.quiet ? new NullNotifier() : new ConsoleNotifier();
    const pipeline = new ArbitragePipeline({ db, config, connectors, resolver, fmvEngine, riskEngine, executor, notifier });

    return { db, config, resolver, fmvEngine, riskEngine, executor, inventoryManager, pipeline, connectors };
  } catch (error) {
    db.close();
    throw error;
  }
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
  for (const error of summary.errors) console.error(error);
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
  const { actions, ...repricingTotals } = summary.repricing;
  console.table([repricingTotals]);
  if (actions.length) console.table(actions.map(action => ({
    Inventory: action.inventoryId, Route: action.fulfillment.route, Channel: action.listedChannel,
    'Listed price': formatUsd(action.listedPriceCents), 'Expected net': formatUsd(action.expectedNetProfitCents),
  })));
  const { detectToDecision, decisionToFill, ...telemetry } = summary.telemetry;
  console.log(`Latency telemetry (${telemetry.samplesCount} decisions, milliseconds)`);
  const roundLatency = ({ p50Ms, p95Ms, p99Ms, maxMs }: typeof detectToDecision) => ({
    P50: p50Ms.toFixed(2), P95: p95Ms.toFixed(2), P99: p99Ms.toFixed(2), Max: maxMs.toFixed(2),
  });
  console.table({ 'Detect to decision': roundLatency(detectToDecision), 'Decision to fill': roundLatency(decisionToFill) });
  console.log(`Fill rate ${percentage.format(telemetry.fillRate)} · Miss rate ${percentage.format(telemetry.missRate)}`);
}

const usage = `Usage: node src/cli.ts <command>
  demo
  scan  [--mode shadow|hitl|live] [--db data/arbitrage.sqlite] [--mock]
  serve [--port 3000] [--mode hitl] [--db data/arbitrage.sqlite] [--mock] [--poll-ms 0]
  mcp   [--mode shadow|hitl|live] [--db data/arbitrage.sqlite] [--mock]
  autopilot [--mode live|hitl|shadow] [--db data/arbitrage.sqlite] [--mock] [--once]
            [--hot-ms 5000] [--standard-ms 30000] [--reprice-ms 60000]`;

function integerOption(value: string, label: string, max: number): number {
  const number = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number > max) {
    throw new Error(`--${label} must be an integer between 0 and ${max}`);
  }
  return number;
}

async function main(args: string[]): Promise<void> {
  const [command, ...flags] = args;
  if (command === '--help' || command === '-h') {
    console.log(usage);
    return;
  }
  if (command === 'demo' && flags.length === 0) return demo();
  if (command !== 'scan' && command !== 'serve' && command !== 'mcp' && command !== 'autopilot') throw new Error(usage);

  const { values } = parseArgs({
    args: flags,
    options: {
      mode: { type: 'string' }, db: { type: 'string' }, mock: { type: 'boolean' },
      port: { type: 'string' }, 'poll-ms': { type: 'string' },
      once: { type: 'boolean' }, 'hot-ms': { type: 'string' }, 'standard-ms': { type: 'string' }, 'reprice-ms': { type: 'string' },
    },
  });
  const mode = Object.values(OperatingMode).find(candidate => candidate === values.mode);
  if (values.mode !== undefined && mode === undefined) throw new Error('--mode must be shadow, hitl, or live');
  if (command !== 'serve' && (values.port !== undefined || values['poll-ms'] !== undefined)) throw new Error(usage);

  if (command !== 'autopilot' && [values.once, values['hot-ms'], values['standard-ms'], values['reprice-ms']]
    .some(value => value !== undefined)) throw new Error(usage);

  if (command === 'autopilot') {
    const interval = (flag: 'hot-ms' | 'standard-ms' | 'reprice-ms', fallback: string) => {
      const ms = integerOption(values[flag] ?? fallback, flag, 2_147_483_647);
      if (ms === 0) throw new Error(`--${flag} must be at least 1 millisecond`);
      return ms;
    };
    const hotIntervalMs = interval('hot-ms', '5000');
    const standardIntervalMs = interval('standard-ms', '30000');
    const repriceIntervalMs = interval('reprice-ms', '60000');
    const runtime = createSystemRuntime({ dbPath: values.db, mode, useMock: values.mock, quiet: values.once === true });
    const autopilot = new AutopilotEngine(runtime);
    try {
      if (values.once) {
        printAutopilot(await autopilot.runAutopilotPass());
      } else {
        autopilot.startDaemon({ hotIntervalMs, standardIntervalMs, repriceIntervalMs });
        console.log(`Autopilot running in ${runtime.db.getSystemState().operatingMode} mode`);
        let finish!: () => void;
        const stopped = new Promise<void>(resolve => { finish = resolve; });
        const stop = () => {
          autopilot.stopDaemon();
          finish();
        };
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
        try {
          await stopped;
          await autopilot.waitForIdle();
        } finally {
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
    const runtime = createSystemRuntime({ dbPath: values.db, mode, useMock: values.mock, quiet: true });
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
  const runtime = createSystemRuntime({ dbPath: values.db, mode: mode ?? 'hitl', useMock: values.mock });
  const autopilot = new AutopilotEngine(runtime);
  const mcpServer = new ArbitrageMcpServer({ runtime, autopilot });
  const server = createArbitrageServer({ ...runtime, autopilot, mcpHandler: mcpServer.createHttpHandler() });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    const address = server.address();
    console.log(`Pokémon Arbitrage dashboard at http://127.0.0.1:${typeof address === 'object' ? address?.port : port}`);
    if (pollMs > 0) runtime.pipeline.startLoop(pollMs);
    const shutdown = () => {
      runtime.pipeline.stopLoop();
      server.close();
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    try {
      await new Promise<void>(resolve => { server.once('close', resolve); });
      await Promise.all([runtime.pipeline.waitForIdle(), autopilot.waitForIdle()]);
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
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
