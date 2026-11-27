import { redactSecrets } from '../setup/secrets.ts';
import { randomUUID } from 'node:crypto';
import type { ArbitrageConfig } from '../config.ts';
import type { SupplyConnector } from '../connectors/base.ts';
import type { ArbitrageDatabase } from '../db/database.ts';
import type { RiskEngine } from '../decision/riskEngine.ts';
import type {
  ArbitrageDecision, CycleSummary, MatchResult, PurchaseOrder, RawListing, ValuationResult,
} from '../domain/types.ts';
import type { ExecutionCoordinator, ExecutionOutcome } from '../execution/executor.ts';
import type { EntityResolver } from '../matching/entityResolver.ts';
import type { AlertNotifier } from '../notifications/notifier.ts';
import type { FmvEngine } from '../valuation/fmvEngine.ts';

export interface ArbitragePipelineOptions {
  db: ArbitrageDatabase;
  config: ArbitrageConfig;
  connectors: SupplyConnector[];
  resolver: EntityResolver;
  fmvEngine: FmvEngine;
  riskEngine: RiskEngine;
  executor: ExecutionCoordinator;
  notifier: AlertNotifier;
  nowFn?: () => Date;
}

export interface EvaluateListingResult {
  listing: RawListing;
  match: MatchResult;
  valuation?: ValuationResult;
  decision: ArbitrageDecision;
}

interface CycleOptions {
  connectors?: SupplyConnector[];
  nowIso?: string;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class ArbitragePipeline {
  private readonly options: ArbitragePipelineOptions;
  private readonly now: () => Date;
  private readonly cachedListings = new Map<string, RawListing>();
  private activeCycle?: Promise<CycleSummary>;
  private loop?: { timer?: ReturnType<typeof setTimeout> };

  constructor(options: ArbitragePipelineOptions) {
    this.options = options;
    this.now = options.nowFn ?? (() => new Date());
  }

  getDatabase(): ArbitrageDatabase {
    return this.options.db;
  }

  getConfig(): ArbitrageConfig {
    return this.options.config;
  }

  getConnectors(): readonly SupplyConnector[] {
    return this.options.connectors;
  }

  getNotifier(): AlertNotifier {
    return this.options.notifier;
  }

  getCachedListing(source: RawListing['source'], listingId: string): RawListing | undefined {
    return this.cachedListings.get(`${source}:${listingId}`);
  }

  cacheListing(listing: RawListing): void {
    this.cachedListings.set(`${listing.source}:${listing.listingId}`, listing);
  }

  async evaluateListing(
    listing: RawListing,
    options: { persistDecision?: boolean; nowIso?: string } = {},
  ): Promise<EvaluateListingResult> {
    const { db, config, resolver, riskEngine, fmvEngine } = this.options;
    const nowIso = options.nowIso ?? this.now().toISOString();
    const match = await resolver.resolve(listing, db.listSkus());
    let valuation: ValuationResult | undefined;
    if (match.status === 'matched' && match.canonicalSku) {
      valuation = fmvEngine.evaluate(match.canonicalSku, db.getSoldComps(match.canonicalSku.id), config, {
        condition: match.matchedCondition, grader: match.matchedGrader, grade: match.matchedGrade, nowIso,
      });
    }
    const portfolio = db.getPortfolioSnapshot(config, nowIso);
    const decision = riskEngine.decide({ listing, match, valuation, portfolio, systemState: db.getSystemState(), config, nowIso });
    if (options.persistDecision === true) db.saveDecision(decision);
    return { listing, match, valuation, decision };
  }

  runCycle(options: CycleOptions = {}): Promise<CycleSummary> {
    if (!this.activeCycle) {
      this.activeCycle = this.scan(options).finally(() => { this.activeCycle = undefined; });
    }
    return this.activeCycle;
  }

  private async scan(options: CycleOptions): Promise<CycleSummary> {
    const { db, config, executor, notifier } = this.options;
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
        summary.errors.push(`Notification failed: ${message(error)}`);
      }
    };

    let connectorSucceeded = false;
    let connectorFailed = false;
    const skus = db.listSkus();

    for (const connector of options.connectors ?? this.options.connectors) {
      let listings: RawListing[];
      try {
        if (!connector.isEnabled()) continue;
        listings = await connector.fetchListings(skus);
        connectorSucceeded = true;
      } catch (error) {
        connectorFailed = true;
        const reason = `${connector.name}: ${message(error)}`;
        summary.errors.push(reason);
        const state = db.incrementConsecutiveErrors();
        if (state.consecutiveErrors >= config.circuitBreakerMaxErrorsPerWindow && !state.killSwitchEngaged) {
          const tripReason = `Circuit breaker after ${state.consecutiveErrors} connector errors: ${reason}`;
          db.setKillSwitch(true, tripReason);
          summary.killSwitchTriggered = true;
          await alert(() => notifier.notifyCircuitBreaker(tripReason));
        }
        continue;
      }

      summary.fetchedCount += listings.length;
      for (const listing of listings) {
        const { source, listingId, priceCents, quantity } = listing;
        try {
          if (db.hasUnchangedListing(source, listingId, priceCents, quantity)) {
            summary.deduplicatedCount++;
            continue;
          }
          db.markListingSeen(source, listingId, priceCents, quantity, startedAt);
          this.cacheListing(listing);
          const { match, decision } = await this.evaluateListing(listing, { persistDecision: true, nowIso: startedAt });
          if (match.status === 'matched') summary.matchedCount++;
          if (match.status === 'rejected') summary.rejectedCount++;

          const outcome = await executor.executeDecision(decision, listing, match.canonicalSku);
          if (outcome.status === 'filled') summary.autoBoughtCount++;
          if (outcome.status === 'pending_hitl') summary.hitlQueuedCount++;
          if (outcome.status === 'shadow_recorded') summary.shadowRecordedCount++;
          if (decision.action === 'skip' || outcome.status === 'skipped' || outcome.status === 'aborted') summary.skippedCount++;
          if (outcome.status === 'failed') summary.errors.push(`${source}:${listingId}: ${outcome.reason ?? 'Purchase failed'}`);

          if (decision.action === 'auto_buy' || decision.action === 'hitl_review') {
            await alert(() => notifier.notifyDecision(decision));
          }
          const order = outcome.order;
          if (order && (outcome.status === 'filled' || outcome.status === 'pending_hitl' || outcome.status === 'failed')) {
            await alert(() => notifier.notifyOrder(order, outcome.status));
          }
        } catch (error) {
          summary.errors.push(`${source}:${listingId}: ${message(error)}`);
        }
      }
    }

    if (connectorSucceeded && !connectorFailed) db.resetConsecutiveErrors();
    summary.errorCount = summary.errors.length;
    summary.finishedAt = options.nowIso ?? this.now().toISOString();
    db.recordScanTimestamp(summary.finishedAt);
    db.logAuditEvent('cycle.completed', { ...summary });
    return summary;
  }

  private activePoll?: Promise<CycleSummary>;

  startLoop(intervalMs: number, runCycle = () => this.runCycle()): void {
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 1 || intervalMs > 2_147_483_647) {
      throw new RangeError('Scan interval must be between 1 and 2147483647 milliseconds');
    }
    this.stopLoop();
    const loop: NonNullable<ArbitragePipeline['loop']> = {};
    this.loop = loop;
    const schedule = () => {
      if (this.loop === loop) loop.timer = setTimeout(tick, intervalMs);
    };
    const tick = async () => {
      try {
        this.activePoll = runCycle();
        await this.activePoll;
      } catch (error) {
        console.error('Scheduled scan failed', redactSecrets(error instanceof Error ? error.message : String(error)));
      } finally {
        this.activePoll = undefined;
        schedule();
      }
    };
    schedule();
  }

  stopLoop(): void {
    clearTimeout(this.loop?.timer);
    this.loop = undefined;
  }

  async waitForIdle(): Promise<void> {
    await Promise.allSettled([this.activeCycle, this.activePoll]);
  }

  async approveHitlOrder(orderId: string, options: { confirmAnomaly?: boolean } = {}): Promise<ExecutionOutcome> {
    const { db, executor, notifier } = this.options;
    const order = db.getOrder(orderId);
    if (!order) return { status: 'aborted', reason: 'Order not found' };
    if (order.status !== 'pending_hitl') {
      return { status: 'aborted', order, reason: `Order status is ${order.status}, expected pending_hitl` };
    }
    const anomalous = order.decisionWarnings.some(warning => /anomaly/i.test(warning));
    if (anomalous && options.confirmAnomaly !== true) {
      return { status: 'aborted', order, reason: 'Order is anomaly-flagged; explicit confirmAnomaly=true is required to approve' };
    }

    if (db.getSystemState().operatingMode === 'shadow') {
      return { status: 'aborted', order, reason: 'Order approval is unavailable in shadow mode' };
    }

    const outcome = await executor.executeApprovedOrder(orderId, this.getCachedListing(order.source, order.listingId));
    if (outcome.status === 'filled' || outcome.status === 'failed') {
      db.logAuditEvent('order.hitl_approved', { orderId, status: outcome.status, confirmAnomaly: options.confirmAnomaly === true });
      if (outcome.order) {
        try {
          await notifier.notifyOrder(outcome.order, outcome.status);
        } catch (error) {
          db.logAuditEvent('notification.failed', { orderId, error: message(error) });
        }
      }
    }
    return outcome;
  }

  rejectHitlOrder(orderId: string, reason: string): PurchaseOrder | undefined {
    const { db } = this.options;
    const initial = db.getOrder(orderId);
    if (initial?.status !== 'pending_hitl') return undefined;
    const key = `${initial.source}:${initial.listingId}`;
    const owner = randomUUID();
    if (!db.acquirePurchaseLock(key, owner, 5_000)) return undefined;
    try {
      if (db.getOrder(orderId)?.status !== 'pending_hitl') return undefined;
      const order = db.updateOrderStatus(orderId, 'rejected', { failureReason: reason });
      if (order) db.logAuditEvent('order.hitl_rejected', { orderId, reason });
      return order;
    } finally {
      db.releasePurchaseLock(key, owner);
    }
  }
}
