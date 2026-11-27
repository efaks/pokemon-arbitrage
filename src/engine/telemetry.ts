import type { ArbitrageDatabase } from '../db/database.ts';
import type { SourceName } from '../domain/types.ts';

export interface LatencyStats {
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
}

export interface SourceAlphaStats {
  source: SourceName;
  fetched: number;
  matched: number;
  filled: number;
  failed: number;
  aborted: number;
  predictedProfitCents: number;
  realizedProfitCents: number;
  throttled: boolean;
  throttleReason?: string;
}

export interface AlphaTelemetrySnapshot {
  samplesCount: number;
  detectToDecision: LatencyStats;
  decisionToFill: LatencyStats;
  fillRate: number;
  missRate: number;
  fuzzyRecoveriesCount: number;
  buylistFloorHitsCount: number;
  fallingKnifeBlockedCount: number;
  gradingEvHitsCount: number;
  sources: SourceAlphaStats[];
}

type Signal = 'fuzzyRecoveriesCount' | 'buylistFloorHitsCount' | 'fallingKnifeBlockedCount' | 'gradingEvHitsCount';
type SourceCounts = Pick<SourceAlphaStats, 'fetched' | 'matched' | 'aborted'>;
type SourceHistory = Pick<SourceAlphaStats, 'filled' | 'failed' | 'predictedProfitCents' | 'realizedProfitCents'> & { soldCount: number };
const maxSamples = 1024;

function latencyStats(samples: number[]): LatencyStats {
  const sorted = samples.slice().sort((a, b) => a - b);
  const percentile = (fraction: number) => sorted[Math.ceil(sorted.length * fraction) - 1] ?? 0;
  return { p50Ms: percentile(0.50), p95Ms: percentile(0.95), p99Ms: percentile(0.99), maxMs: sorted.at(-1) ?? 0 };
}

function appendSample(samples: number[], milliseconds: number): void {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return;
  if (samples.length >= maxSamples) samples.shift();
  samples.push(milliseconds);
}

function emptyHistory(): SourceHistory {
  return { filled: 0, failed: 0, predictedProfitCents: 0, realizedProfitCents: 0, soldCount: 0 };
}

function throttle(history: SourceHistory): { throttled: boolean; reason?: string } {
  const { soldCount, realizedProfitCents, filled, failed } = history;
  if (soldCount >= 3 && realizedProfitCents < 0) return { throttled: true, reason: 'Negative realized P&L after at least three sales' };
  if (filled + failed >= 3 && failed > filled) return { throttled: true, reason: 'More than half of completed checkout attempts failed' };
  return { throttled: false };
}

function readHistory(db: ArbitrageDatabase, source?: SourceName): Map<SourceName, SourceHistory> {
  const history = new Map<SourceName, SourceHistory>();
  const orderSources = new Map<string, SourceName>();
  for (const order of db.listOrders(undefined, -1)) {
    if (source !== undefined && order.source !== source) continue;
    const stats = history.get(order.source) ?? emptyHistory();
    history.set(order.source, stats);
    orderSources.set(order.id, order.source);
    if (order.status === 'filled') {
      stats.filled++;
      stats.predictedProfitCents += order.expectedNetProfitCents;
    }
    if (order.status === 'failed') stats.failed++;
  }
  for (const item of db.listInventory('sold')) {
    const orderSource = orderSources.get(item.orderId);
    if (!orderSource) continue;
    const stats = history.get(orderSource)!;
    stats.soldCount++;
    stats.realizedProfitCents += item.realizedProfitCents ?? 0;
  }
  return history;
}

export class AlphaTelemetry {
  private readonly detectToDecisionMs: number[] = [];
  private readonly decisionToFillMs: number[] = [];
  private readonly counters = new Map<SourceName, SourceCounts>();
  private readonly signals: Record<Signal, number> = {
    fuzzyRecoveriesCount: 0, buylistFloorHitsCount: 0, fallingKnifeBlockedCount: 0, gradingEvHitsCount: 0,
  };

  recordDetection(milliseconds: number): void {
    appendSample(this.detectToDecisionMs, milliseconds);
  }

  recordFill(milliseconds: number): void {
    appendSample(this.decisionToFillMs, milliseconds);
  }

  recordSource(source: SourceName, field: keyof SourceCounts, count = 1): void {
    const stats = this.counters.get(source) ?? { fetched: 0, matched: 0, aborted: 0 };
    stats[field] += count;
    this.counters.set(source, stats);
  }

  recordSignal(signal: Signal): void {
    this.signals[signal]++;
  }

  isSourceThrottled(db: ArbitrageDatabase, source: SourceName): { throttled: boolean; reason?: string } {
    return throttle(readHistory(db, source).get(source) ?? emptyHistory());
  }

  snapshot(db: ArbitrageDatabase): AlphaTelemetrySnapshot {
    const history = readHistory(db);
    const sources: SourceAlphaStats[] = [...new Set([...this.counters.keys(), ...history.keys()])].sort().map(source => {
      const { soldCount, ...outcomes } = history.get(source) ?? emptyHistory();
      const { throttled, reason: throttleReason } = throttle({ soldCount, ...outcomes });
      return { source, fetched: 0, matched: 0, aborted: 0, ...this.counters.get(source), ...outcomes, throttled, throttleReason };
    });
    const filled = sources.reduce((sum, source) => sum + source.filled, 0);
    const missed = sources.reduce((sum, source) => sum + source.failed + source.aborted, 0);
    const attempts = filled + missed;
    return {
      samplesCount: this.detectToDecisionMs.length,
      detectToDecision: latencyStats(this.detectToDecisionMs), decisionToFill: latencyStats(this.decisionToFillMs),
      fillRate: attempts ? filled / attempts : 0, missRate: attempts ? missed / attempts : 0, ...this.signals, sources,
    };
  }
}
