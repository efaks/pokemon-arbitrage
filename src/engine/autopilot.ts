import { randomUUID } from 'node:crypto';
import type { SystemRuntime } from '../cli.ts';
import type { SupplyConnector } from '../connectors/base.ts';
import { ageInDays, clamp, percentOfCents } from '../domain/money.ts';
import type { CycleSummary, ExitChannel, RawListing } from '../domain/types.ts';
import type { ExecutionOutcome } from '../execution/executor.ts';
import type { ExitRecommendation } from '../liquidation/inventoryManager.ts';
import { evaluateSellerTrust } from '../matching/redFlags.ts';
import type { EvaluateListingResult } from '../pipeline/arbitragePipeline.ts';
import { detectBuylistFloorArbitrage, evaluateRawToGradeEv, normalizeMisspelledListing } from './alphaSignals.ts';
import type { BuylistFloorSignal, FuzzyRecoveryResult, GradingEvResult } from './alphaSignals.ts';
import { BuyBook } from './buyBook.ts';
import type { BuyBookEntry, PriorityTier, QuickScreenResult } from './buyBook.ts';
import { AlphaTelemetry } from './telemetry.ts';

export interface AutopilotConfig {
  autonomousTriageEnabled: boolean;
  autonomousMaxApproveCents: number;
  allowAutonomousRawApproval: boolean;
  autoRejectAnomalies: boolean;
  suppressFallingKnife: boolean;
  vaultThresholdCents: number;
  repricingTargetDays: number;
  repricingMaxDiscountPct: number;
  repricingFloorProfitCents: number;
}

export function createAutopilotConfig(overrides: Partial<AutopilotConfig> = {}): AutopilotConfig {
  const config: AutopilotConfig = {
    autonomousTriageEnabled: true, autonomousMaxApproveCents: 50_000, allowAutonomousRawApproval: true,
    autoRejectAnomalies: false, suppressFallingKnife: true, vaultThresholdCents: 25_000,
    repricingTargetDays: 14, repricingMaxDiscountPct: 0.08, repricingFloorProfitCents: 500, ...overrides,
  };
  if (![config.autonomousMaxApproveCents, config.vaultThresholdCents, config.repricingFloorProfitCents]
    .every(value => Number.isSafeInteger(value) && value >= 0)) throw new RangeError('Autopilot monetary limits must be nonnegative integer cents');
  if (!Number.isFinite(config.repricingTargetDays) || config.repricingTargetDays <= 0 ||
      !Number.isFinite(config.repricingMaxDiscountPct) || config.repricingMaxDiscountPct < 0 || config.repricingMaxDiscountPct > 1) {
    throw new RangeError('Invalid repricing target days or maximum discount');
  }
  return config;
}

export interface FastPathOutcome {
  listing: RawListing;
  deduplicated: boolean;
  outsidePriorityTier?: boolean;
  match?: EvaluateListingResult['match'];
  valuation?: EvaluateListingResult['valuation'];
  decision?: EvaluateListingResult['decision'];
  execution?: ExecutionOutcome;
  recovery?: FuzzyRecoveryResult;
  quickScreen?: QuickScreenResult;
  buylistSignal?: BuylistFloorSignal;
  gradingEv?: GradingEvResult;
  alphaNotes: string[];
}

export interface AutonomousTriageSummary {
  inspectedCount: number;
  approvedCount: number;
  rejectedCount: number;
  heldCount: number;
  failedCount: number;
  skippedReason?: string;
  actions: { orderId: string; action: 'approved' | 'rejected' | 'held' | 'failed'; reason?: string }[];
}

export interface FulfillmentRoute {
  inventoryId: string;
  route: 'buylist_instant' | 'vault_consignment' | 'direct_marketplace';
  channel: ExitChannel;
  expectedFmvCents: number;
  expectedNetProfitCents: number;
}

export interface RepricingAction {
  inventoryId: string;
  fulfillment: FulfillmentRoute;
  previousPriceCents?: number;
  listedChannel: ExitChannel;
  listedPriceCents: number;
  expectedNetProfitCents: number;
  ageDays: number;
}

export interface RepricingCycleSummary {
  inspectedCount: number;
  repricedCount: number;
  skippedBelowFloorCount: number;
  actions: RepricingAction[];
}

export interface AutopilotCycleSummary {
  buyBook: Record<PriorityTier, number>;
  cycle: CycleSummary;
  triage: AutonomousTriageSummary;
  repricing: RepricingCycleSummary;
  telemetry: ReturnType<AlphaTelemetry['snapshot']>;
}

interface CycleOptions {
  tier?: 'all' | PriorityTier;
  connectors?: SupplyConnector[];
  nowIso?: string;
}

interface IngestOptions {
  nowIso?: string;
  skipDeduplication?: boolean;
  targetSkuIds?: ReadonlySet<string>;
  detectedAtMs?: number;
}

const fallingKnifeReason = 'Momentum guard: falling knife detected';
const sourceThrottleReason = 'Source auto-throttled due to negative realized P&L or high failure rate';
const bookRefreshMs = 60_000;
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

export class AutopilotEngine {
  private readonly runtime: SystemRuntime;
  private readonly options: AutopilotConfig;
  private readonly now: () => Date;
  private readonly buyBook = new BuyBook();
  private readonly telemetry = new AlphaTelemetry();
  private readonly pending = new Set<Promise<unknown>>();
  private refreshedAt?: string;
  private scanTail = Promise.resolve();
  private daemon?: Set<ReturnType<typeof setTimeout>>;

  constructor(runtime: SystemRuntime, options: { autopilotConfig?: Partial<AutopilotConfig>; nowFn?: () => Date } = {}) {
    this.runtime = runtime;
    this.options = createAutopilotConfig(options.autopilotConfig);
    this.now = options.nowFn ?? (() => new Date());
  }

  getBuyBook(): BuyBook {
    if (this.refreshedAt === undefined) this.refreshBuyBook();
    return this.buyBook;
  }

  getTelemetry(): AlphaTelemetry {
    return this.telemetry;
  }

  getAutopilotConfig(): AutopilotConfig {
    return { ...this.options };
  }

  refreshBuyBook(nowIso = this.now().toISOString()): BuyBookEntry[] {
    const { db, fmvEngine, config } = this.runtime;
    const entries = this.buyBook.refresh(db, fmvEngine, config, nowIso);
    this.refreshedAt = nowIso;
    return entries;
  }

  private track<T>(task: Promise<T>): Promise<T> {
    const tracked = task.finally(() => { this.pending.delete(tracked); });
    this.pending.add(tracked);
    return tracked;
  }

  ingestListingFastPath(listing: RawListing, options: Omit<IngestOptions, 'targetSkuIds' | 'detectedAtMs'> = {}): Promise<FastPathOutcome> {
    const nowIso = options.nowIso ?? this.now().toISOString();
    return this.track(this.ingest(listing, { ...options, nowIso }));
  }

  private async ingest(rawListing: RawListing, options: IngestOptions): Promise<FastPathOutcome> {
    const started = options.detectedAtMs ?? performance.now();
    const { db, config, pipeline, executor } = this.runtime;
    const { source, listingId, priceCents, quantity } = rawListing;
    const nowIso = options.nowIso ?? this.now().toISOString();
    this.telemetry.recordSource(source, 'fetched');
    const seen = () => !options.skipDeduplication && db.hasUnchangedListing(source, listingId, priceCents, quantity);
    const duplicate: FastPathOutcome = { listing: rawListing, deduplicated: true, alphaNotes: [] };
    if (seen()) return duplicate;
    if (this.refreshedAt === undefined || Math.abs(Date.parse(nowIso) - Date.parse(this.refreshedAt)) >= bookRefreshMs) {
      this.refreshBuyBook(nowIso);
    }

    const { listing, recovery } = normalizeMisspelledListing(rawListing);
    const { match, valuation, decision } = await pipeline.evaluateListing(listing, { persistDecision: false, nowIso });
    if (match.skuId && options.targetSkuIds && !options.targetSkuIds.has(match.skuId)) {
      return { listing, deduplicated: false, outsidePriorityTier: true, alphaNotes: [] };
    }
    // Resolution can yield to a webhook or another connector reporting the same listing.
    if (seen()) return duplicate;

    const result: FastPathOutcome = { listing, match, valuation, decision, recovery, deduplicated: false, alphaNotes: [] };
    if (recovery.recovered) {
      this.telemetry.recordSignal('fuzzyRecoveriesCount');
      result.alphaNotes.push(`Fuzzy title recovery: ${recovery.corrections.join(', ')}`);
    }
    if (match.status === 'matched' && match.canonicalSku && valuation) {
      this.telemetry.recordSource(source, 'matched');
      const sku = match.canonicalSku;
      result.quickScreen = this.buyBook.quickScreen(sku.id, listing.priceCents, listing.shippingCents);
      if (this.options.suppressFallingKnife && result.quickScreen.isFallingKnife && decision.action !== 'skip') {
        decision.action = 'skip';
        decision.reasons.unshift(fallingKnifeReason);
        this.telemetry.recordSignal('fallingKnifeBlockedCount');
      }
      if (decision.action === 'auto_buy' && this.telemetry.isSourceThrottled(db, source).throttled) {
        decision.action = 'skip';
        decision.reasons.unshift(sourceThrottleReason);
      }
      result.buylistSignal = detectBuylistFloorArbitrage(listing, sku.assetClass, valuation.fmvCents, config);
      if (result.buylistSignal.isBuylistFloorArb) {
        this.telemetry.recordSignal('buylistFloorHitsCount');
        result.alphaNotes.push(`Buylist floor meets profit and ROI thresholds (${result.buylistSignal.buylistBreakdown.netProfitCents} cents net)`);
      }
      if (sku.assetClass === 'raw') {
        result.gradingEv = evaluateRawToGradeEv(sku, listing, db.listSkus({ assetClass: 'graded', language: sku.language }), this.buyBook, config);
      }
      if (result.gradingEv?.viable) {
        this.telemetry.recordSignal('gradingEvHitsCount');
        result.alphaNotes.push(`Grading EV meets profit and ROI thresholds (${result.gradingEv.expectedGradingProfitCents} cents expected net)`);
      }
    }
    decision.reasons.push(...result.alphaNotes);
    db.saveDecision(decision);
    db.markListingSeen(source, listingId, priceCents, quantity, nowIso);
    pipeline.cacheListing(listing);
    const decided = performance.now();
    this.telemetry.recordDetection(decided - started);
    const execution = await executor.executeDecision(decision, listing, match.canonicalSku);
    result.execution = execution;
    this.recordExecution(source, execution, decided);
    db.logAuditEvent('autopilot.fast_path', {
      source, listingId, decisionId: decision.id, skuId: decision.skuId, action: decision.action,
      status: execution.status, alphaNotes: result.alphaNotes, detectToDecisionMs: decided - started,
    });
    return result;
  }

  private recordExecution(source: RawListing['source'], execution: ExecutionOutcome, decided: number): void {
    if (execution.status === 'filled') this.telemetry.recordFill(performance.now() - decided);
    if (execution.status === 'aborted' || execution.status === 'locked') this.telemetry.recordSource(source, 'aborted');
  }

  runConcurrentPriorityCycle(options: CycleOptions = {}): Promise<CycleSummary> {
    const task = this.scanTail.then(() => this.scan(options));
    this.scanTail = task.then(() => undefined, () => undefined);
    return this.track(task);
  }

  private async scan(options: CycleOptions): Promise<CycleSummary> {
    const { db, config, pipeline } = this.runtime;
    const notifier = pipeline.getNotifier();
    const startedAt = options.nowIso ?? this.now().toISOString();
    const summary: CycleSummary = {
      cycleId: randomUUID(), startedAt, finishedAt: startedAt, operatingMode: db.getSystemState().operatingMode,
      fetchedCount: 0, deduplicatedCount: 0, matchedCount: 0, rejectedCount: 0, autoBoughtCount: 0, hitlQueuedCount: 0,
      skippedCount: 0, shadowRecordedCount: 0, errorCount: 0, errors: [], killSwitchTriggered: false,
    };
    const alert = async (notify: () => void | Promise<void>) => {
      try {
        await notify();
      } catch (error) {
        summary.errors.push(`Notification failed: ${errorMessage(error)}`);
      }
    };
    const allSkus = db.listSkus();
    this.refreshBuyBook(startedAt);
    const tier = options.tier ?? 'all';
    const skus = tier === 'all' ? allSkus : allSkus.filter(sku => this.buyBook.get(sku.id)?.priorityTier === tier);
    const targetSkuIds = tier === 'all' ? undefined : new Set(skus.map(sku => sku.id));
    let connectorSucceeded = false;
    let connectorFailed = false;

    const connectors = options.connectors ?? this.runtime.connectors;
    const results = await Promise.allSettled((targetSkuIds?.size === 0 ? [] : connectors).map(async connector => {
      let listings: RawListing[];
      try {
        if (!connector.isEnabled()) return;
        listings = await connector.fetchListings(skus);
        connectorSucceeded = true;
      } catch (error) {
        connectorFailed = true;
        const reason = `${connector.name}: ${errorMessage(error)}`;
        summary.errors.push(reason);
        const state = db.incrementConsecutiveErrors();
        if (state.consecutiveErrors >= config.circuitBreakerMaxErrorsPerWindow && !state.killSwitchEngaged) {
          const tripReason = `Circuit breaker after ${state.consecutiveErrors} connector errors: ${reason}`;
          db.setKillSwitch(true, tripReason);
          summary.killSwitchTriggered = true;
          await alert(() => notifier.notifyCircuitBreaker(tripReason));
        }
        return;
      }

      const detectedAtMs = performance.now();
      summary.fetchedCount += listings.length;
      for (const listing of listings) {
        const { source, listingId } = listing;
        try {
          const candidate = connector.supportsAutoCheckout ? listing : { ...listing, supportsAutoCheckout: false };
          const { deduplicated, outsidePriorityTier, match, decision, execution } = await this.ingest(candidate, {
            nowIso: startedAt, targetSkuIds, detectedAtMs,
          });
          if (outsidePriorityTier) continue;
          if (deduplicated) {
            summary.deduplicatedCount++;
            continue;
          }
          if (match?.status === 'matched') summary.matchedCount++;
          if (match?.status === 'rejected') summary.rejectedCount++;
          if (execution?.status === 'filled') summary.autoBoughtCount++;
          if (execution?.status === 'pending_hitl') summary.hitlQueuedCount++;
          if (execution?.status === 'shadow_recorded') summary.shadowRecordedCount++;
          if (decision?.action === 'skip' || execution?.status === 'aborted' || execution?.status === 'locked') summary.skippedCount++;
          if (execution?.status === 'failed') summary.errors.push(`${source}:${listingId}: ${execution.reason ?? 'Purchase failed'}`);
          if (decision && decision.action !== 'skip') await alert(() => notifier.notifyDecision(decision));
          const order = execution?.order;
          if (order && ['filled', 'pending_hitl', 'failed'].includes(execution.status)) {
            await alert(() => notifier.notifyOrder(order, execution.status));
          }
        } catch (error) {
          summary.errors.push(`${source}:${listingId}: ${errorMessage(error)}`);
        }
      }
    }));
    for (const result of results) {
      if (result.status === 'rejected') summary.errors.push(errorMessage(result.reason));
    }
    if (connectorSucceeded && !connectorFailed) db.resetConsecutiveErrors();
    summary.errorCount = summary.errors.length;
    summary.finishedAt = options.nowIso ?? this.now().toISOString();
    db.recordScanTimestamp(summary.finishedAt);
    db.logAuditEvent('cycle.completed', { ...summary, engine: 'autopilot', tier });
    return summary;
  }

  runAutonomousTriage(options: { maxApproveCents?: number; autoRejectAnomalies?: boolean; nowIso?: string } = {}): Promise<AutonomousTriageSummary> {
    return this.track(this.triage(options));
  }

  private async triage(
    options: { maxApproveCents?: number; autoRejectAnomalies?: boolean; nowIso?: string },
    useCurrentBook = false,
  ): Promise<AutonomousTriageSummary> {
    const { db, config, pipeline } = this.runtime;
    const maxApproveCents = options.maxApproveCents ?? this.options.autonomousMaxApproveCents;
    if (!Number.isSafeInteger(maxApproveCents) || maxApproveCents < 0) throw new RangeError('Approval cap must be nonnegative integer cents');
    const autoRejectAnomalies = options.autoRejectAnomalies ?? this.options.autoRejectAnomalies;
    const summary: AutonomousTriageSummary = { inspectedCount: 0, approvedCount: 0, rejectedCount: 0, heldCount: 0, failedCount: 0, actions: [] };
    const stopReason = () => {
      const state = db.getSystemState();
      if (state.killSwitchEngaged) return 'Kill switch engaged';
      if (state.operatingMode === 'shadow') return 'Shadow mode active';
      if (!this.options.autonomousTriageEnabled) return 'Autonomous triage disabled';
    };
    summary.skippedReason = stopReason();
    if (summary.skippedReason) return summary;
    if (!useCurrentBook) this.refreshBuyBook(options.nowIso ?? this.now().toISOString());
    const anomalousDecisions = new Set(db.listDecisions(-1).filter(decision => decision.anomalyFlagged).map(decision => decision.id));

    const add = (orderId: string, action: AutonomousTriageSummary['actions'][number]['action'], reason?: string) => {
      summary.actions.push({ orderId, action, reason });
      summary[`${action}Count`]++;
    };
    for (const order of db.listOrders('pending_hitl', -1)) {
      summary.skippedReason = stopReason();
      if (summary.skippedReason) break;
      summary.inspectedCount++;
      const reject = (reason: string) => add(order.id, pipeline.rejectHitlOrder(order.id, reason) ? 'rejected' : 'held', reason);
      if (anomalousDecisions.has(order.decisionId) || order.decisionWarnings.some(warning => /anomaly/i.test(warning))) {
        if (autoRejectAnomalies) reject('Autonomous triage rejected anomaly-flagged order');
        else add(order.id, 'held', 'Anomaly requires operator review');
        continue;
      }
      if (this.buyBook.get(order.skuId)?.momentumStatus === 'falling_knife') {
        reject(fallingKnifeReason);
        continue;
      }
      const listing = pipeline.getCachedListing(order.source, order.listingId);
      let holdReason: string | undefined;
      if (!listing?.supportsAutoCheckout || order.decisionWarnings.some(warning => /does not support sanctioned/i.test(warning))) {
        holdReason = 'Sanctioned automated checkout could not be established';
      } else if (listing.title !== order.listingTitle || listing.priceCents !== order.askPriceCents ||
          listing.shippingCents !== order.shippingCents) {
        holdReason = 'Listing changed after the order was queued';
      } else if (order.landedCostCents > maxApproveCents) {
        holdReason = 'Landed cost exceeds autonomous approval cap';
      } else if (order.assetClass === 'graded' && order.decisionWarnings.some(warning => /lacks verified certification/i.test(warning))) {
        holdReason = 'Graded slab requires verified certification';
      } else if (order.assetClass === 'raw' && (!this.options.allowAutonomousRawApproval || listing.imageUrls.length < 2 ||
          !evaluateSellerTrust(listing.seller, config).trusted)) {
        holdReason = 'Raw approval requires at least two photos and a trusted seller';
      } else if (this.telemetry.isSourceThrottled(db, order.source).throttled) {
        holdReason = sourceThrottleReason;
      }
      if (holdReason) {
        add(order.id, 'held', holdReason);
        continue;
      }
      const decided = performance.now();
      const outcome = await pipeline.approveHitlOrder(order.id);
      this.recordExecution(order.source, outcome, decided);
      add(order.id, outcome.status === 'filled' ? 'approved' : outcome.status === 'failed' ? 'failed' : 'held', outcome.reason);
    }
    return summary;
  }

  recommendFulfillmentRoute(inventoryId: string, nowIso = this.now().toISOString()): FulfillmentRoute {
    const { inventoryManager, db } = this.runtime;
    const recommendation = inventoryManager.recommendExit(inventoryId, nowIso);
    return this.route(recommendation, db.getInventoryItem(inventoryId)!.assetClass);
  }

  private route(recommendation: ExitRecommendation, assetClass: BuyBookEntry['assetClass']): FulfillmentRoute {
    const { inventoryId, expectedFmvCents, expectedNetProfitCents, recommendedChannel, channels } = recommendation;
    const buylist = channels.find(exit => exit.exitChannel === 'buylist');
    if (buylist && buylist.netProfitCents >= this.runtime.config.minNetProfitCents &&
        buylist.netProfitCents >= expectedNetProfitCents * 0.90) {
      return { inventoryId, route: 'buylist_instant', channel: 'buylist', expectedFmvCents, expectedNetProfitCents: buylist.netProfitCents };
    }
    const exit = channels.find(candidate => candidate.exitChannel !== 'buylist');
    const route = expectedFmvCents >= this.options.vaultThresholdCents && assetClass !== 'sealed'
      ? 'vault_consignment' : 'direct_marketplace';
    return {
      inventoryId, route, channel: exit?.exitChannel ?? recommendedChannel, expectedFmvCents,
      expectedNetProfitCents: exit?.netProfitCents ?? expectedNetProfitCents,
    };
  }

  runRepricingCycle(nowIso = this.now().toISOString()): RepricingCycleSummary {
    const { db, config, inventoryManager } = this.runtime;
    const items = [...db.listInventory('qc_passed'), ...db.listInventory('listed')];
    const summary: RepricingCycleSummary = { inspectedCount: items.length, repricedCount: 0, skippedBelowFloorCount: 0, actions: [] };
    for (const item of items) {
      const recommendation = inventoryManager.recommendExit(item.id, nowIso);
      const fulfillment = this.route(recommendation, item.assetClass);
      const channel = fulfillment.channel;
      const exit = recommendation.channels.find(candidate => candidate.exitChannel === channel)!;
      const schedule = config.exitFeeSchedules[channel];
      const netProfit = (gross: number) => gross - percentOfCents(gross, schedule.percentFee) - schedule.fixedFeeCents -
        exit.outboundShippingCents - exit.packagingCents - item.costBasisCents;
      const target = exit.expectedExitPriceCents;
      const floor = this.options.repricingFloorProfitCents;
      if (target < 1 || netProfit(target) < floor) {
        summary.skippedBelowFloorCount++;
        continue;
      }

      const ageDays = Math.max(0, ageInDays(item.acquiredAt, nowIso));
      const discount = clamp(ageDays / this.options.repricingTargetDays, 0, 1) * this.options.repricingMaxDiscountPct;
      let low = Math.max(1, percentOfCents(target, 1 - discount));
      let high = target;
      while (low < high) {
        const mid = low + Math.floor((high - low) / 2);
        if (netProfit(mid) >= floor) high = mid;
        else low = mid + 1;
      }
      const listedPriceCents = low;
      if (item.status === 'listed' && item.listedChannel === channel && item.listedPriceCents === listedPriceCents) continue;
      db.updateInventoryItem(item.id, { listedChannel: channel, listedPriceCents, status: 'listed' });
      const action: RepricingAction = {
        inventoryId: item.id, fulfillment, previousPriceCents: item.listedPriceCents, listedChannel: channel,
        listedPriceCents, expectedNetProfitCents: netProfit(listedPriceCents), ageDays,
      };
      db.logAuditEvent('autopilot.repriced', { ...action });
      summary.actions.push(action);
    }
    summary.repricedCount = summary.actions.length;
    return summary;
  }

  runAutopilotPass(options: CycleOptions = {}): Promise<AutopilotCycleSummary> {
    return this.track(this.pass(options));
  }

  private async pass(options: CycleOptions): Promise<AutopilotCycleSummary> {
    const cycle = await this.runConcurrentPriorityCycle(options);
    const buyBook = {
      hot: this.buyBook.list({ tier: 'hot' }).length,
      standard: this.buyBook.list({ tier: 'standard' }).length,
      cold: this.buyBook.list({ tier: 'cold' }).length,
    };
    const triage = await this.triage({ nowIso: options.nowIso }, true);
    const repricing = this.runRepricingCycle(options.nowIso);
    return { buyBook, cycle, triage, repricing, telemetry: this.telemetry.snapshot(this.runtime.db) };
  }

  startDaemon({ hotIntervalMs = 5000, standardIntervalMs = 30_000, repriceIntervalMs = 60_000, syncIntervalMs }: {
    hotIntervalMs?: number; standardIntervalMs?: number; repriceIntervalMs?: number; syncIntervalMs?: number;
  } = {}): void {
    for (const interval of [hotIntervalMs, standardIntervalMs, repriceIntervalMs, syncIntervalMs]) {
      if (interval === undefined) continue;
      if (!Number.isSafeInteger(interval) || interval < 1 || interval > 2_147_483_647) {
        throw new RangeError('Autopilot interval must be between 1 and 2147483647 milliseconds');
      }
    }
    this.stopDaemon();
    const daemon = new Set<ReturnType<typeof setTimeout>>();
    this.daemon = daemon;
    const schedule = (interval: number, work: () => Promise<unknown> | unknown) => {
      if (this.daemon !== daemon) return;
      const timer = setTimeout(() => {
        daemon.delete(timer);
        const tick = async () => {
          try {
            await work();
          } catch (error) {
            console.error('Scheduled autopilot task failed', error);
          } finally {
            schedule(interval, work);
          }
        };
        void this.track(tick());
      }, interval);
      daemon.add(timer);
    };
    const scan = async (tier: PriorityTier) => {
      await this.runConcurrentPriorityCycle({ tier });
      if (this.daemon === daemon) await this.triage({}, true);
    };
    schedule(hotIntervalMs, () => scan('hot'));
    schedule(standardIntervalMs, () => scan('standard'));
    schedule(repriceIntervalMs, () => this.runRepricingCycle());
    if (syncIntervalMs !== undefined) {
      const { marketSync, fmvEngine, config } = this.runtime;
      schedule(syncIntervalMs, async () => {
        const nowIso = this.now().toISOString();
        await marketSync.syncAll({ nowIso, buyBook: this.buyBook, fmvEngine, config });
        this.refreshedAt = nowIso;
      });
    }
  }

  stopDaemon(): void {
    for (const timer of this.daemon ?? []) clearTimeout(timer);
    this.daemon = undefined;
  }

  async waitForIdle(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled(this.pending);
  }
}
