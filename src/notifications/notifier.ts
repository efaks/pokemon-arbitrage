import type { FetchLike } from '../connectors/base.ts';
import { formatUsd } from '../domain/money.ts';
import type { ArbitrageDecision, PurchaseOrder } from '../domain/types.ts';

export interface AlertNotifier {
  notifyDecision(decision: ArbitrageDecision): void | Promise<void>;
  notifyOrder(order: PurchaseOrder, event: string): void | Promise<void>;
  notifyCircuitBreaker(reason: string): void | Promise<void>;
}

function decisionMessage(decision: ArbitrageDecision): string {
  const details = [
    `Decision ${decision.id} · ${decision.action} (${decision.operatingMode})`,
    decision.skuName ?? decision.listingTitle,
    decision.bestExit && `Landed cost ${formatUsd(decision.bestExit.landedCostCents)} · expected profit ${formatUsd(decision.bestExit.netProfitCents)}`,
    ...decision.warnings,
    decision.reasons[0],
    decision.listingUrl,
  ];
  return details.filter(Boolean).join('\n');
}

function orderMessage(order: PurchaseOrder, event: string): string {
  return [
    `Order ${order.id} · ${event} (${order.status})`,
    `${order.skuName} · ${formatUsd(order.landedCostCents)}`,
    order.failureReason,
    order.listingUrl,
  ].filter(Boolean).join('\n');
}

export class NullNotifier implements AlertNotifier {
  notifyDecision(_decision: ArbitrageDecision): void {}
  notifyOrder(_order: PurchaseOrder, _event: string): void {}
  notifyCircuitBreaker(_reason: string): void {}
}

export class ConsoleNotifier implements AlertNotifier {
  notifyDecision(decision: ArbitrageDecision): void {
    console.info(decisionMessage(decision));
  }

  notifyOrder(order: PurchaseOrder, event: string): void {
    console.info(orderMessage(order, event));
  }

  notifyCircuitBreaker(reason: string): void {
    console.warn(`Circuit breaker engaged\n${reason}`);
  }
}

export class WebhookNotifier implements AlertNotifier {
  private readonly webhookUrl?: string;
  private readonly fetchFn: FetchLike;

  constructor(options: { webhookUrl?: string; fetchFn?: FetchLike } = {}) {
    this.webhookUrl = (options.webhookUrl ?? process.env.ARBITRAGE_WEBHOOK_URL)?.trim();
    this.fetchFn = options.fetchFn ?? fetch;
  }

  notifyDecision(decision: ArbitrageDecision): Promise<void> {
    return this.send(decisionMessage(decision));
  }

  notifyOrder(order: PurchaseOrder, event: string): Promise<void> {
    return this.send(orderMessage(order, event));
  }

  notifyCircuitBreaker(reason: string): Promise<void> {
    return this.send(`Circuit breaker engaged\n${reason}`);
  }

  private async send(message: string): Promise<void> {
    if (!this.webhookUrl) return;
    try {
      const url = new URL(this.webhookUrl);
      const slack = { text: message.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'),
        unfurl_links: false, unfurl_media: false };
      const discord = { content: message.slice(0, 2000), allowed_mentions: { parse: [] } };
      const payload = /(?:^|\.)slack(?:-gov)?\.com$/i.test(url.hostname) ? slack
        : /(?:^|\.)discord(?:app)?\.com$/i.test(url.hostname) ? discord
          : { ...slack, ...discord };
      const response = await this.fetchFn(url.href, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
        signal: AbortSignal.timeout(5_000), redirect: 'error',
      });
      await response.body?.cancel();
    } catch {
      // Alerts are best effort and must not interrupt execution.
    }
  }
}
