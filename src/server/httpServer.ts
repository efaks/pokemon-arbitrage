import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import type { ArbitrageConfig } from '../config.ts';
import type { ArbitrageDatabase } from '../db/database.ts';
import { CardCondition, DecisionAction, ExitChannel, OperatingMode, OrderStatus } from '../domain/types.ts';
import type { RawListing } from '../domain/types.ts';
import type { AutopilotEngine } from '../engine/autopilot.ts';
import { parseWebhookListing } from '../mcp/mcpServer.ts';
import type { InventoryManager } from '../liquidation/inventoryManager.ts';
import type { ArbitragePipeline } from '../pipeline/arbitragePipeline.ts';
import type { MarketSyncCoordinator } from '../sync/marketSync.ts';
import { FmvEngine } from '../valuation/fmvEngine.ts';

export type McpHttpHandler = (
  payload: unknown, reqHeaders?: Record<string, string | string[] | undefined>,
) => Promise<{ status: number; body?: unknown; headers?: Record<string, string> }>;

export interface ArbitrageServerOptions {
  pipeline: ArbitragePipeline;
  db: ArbitrageDatabase;
  inventoryManager: InventoryManager;
  config: ArbitrageConfig;
  mcpHandler?: McpHttpHandler;
  autopilot?: AutopilotEngine;
  marketSync?: MarketSyncCoordinator;
  fmvEngine?: FmvEngine;
  publicDir?: string;
}

class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const maxBodyBytes = 64 * 1024;
const tiers = { hot: 'hot', standard: 'standard', cold: 'cold' } as const;
const defaultIndex = new URL('../../public/index.html', import.meta.url);

function json(res: ServerResponse, status: number, body?: unknown, headers?: Record<string, string>): void {
  res.writeHead(status, {
    'Cache-Control': 'no-store',
    ...(body === undefined ? {} : { 'Content-Type': 'application/json; charset=utf-8' }),
    ...headers,
  });
  res.end(body === undefined ? undefined : JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false }) as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > maxBodyBytes) {
      req.resume();
      throw new HttpError(413, 'Request body is too large');
    }
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}

async function readObject(req: IncomingMessage): Promise<Record<string, unknown>> {
  const body = await readJson(req);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Expected a JSON object');
  return body as Record<string, unknown>;
}

function optionalText(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new HttpError(400, `${field} must be a string`);
  return value.trim() || undefined;
}

function boolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new HttpError(400, `${field} must be a boolean`);
  return value;
}

function choice<T extends string>(value: unknown, choices: Record<string, T>, field: string): T {
  const result = Object.values(choices).find(option => option === value);
  if (!result) throw new HttpError(400, `Invalid ${field}`);
  return result;
}

function cents(value: unknown, field: string, minimum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
    throw new HttpError(400, `${field} must be integer USD cents (minimum ${minimum})`);
  }
  return value;
}

function decodeId(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new HttpError(400, 'Invalid record ID');
  }
}

export function createArbitrageServer(options: ArbitrageServerOptions): Server {
  const { pipeline, db, inventoryManager, config, publicDir, mcpHandler, autopilot, marketSync } = options;
  const fmvEngine = options.fmvEngine ?? new FmvEngine();
  const indexPath = publicDir === undefined ? defaultIndex : resolve(publicDir, 'index.html');

  const requireAutopilot = () => {
    if (!autopilot) throw new HttpError(501, 'Autopilot engine not attached');
    return autopilot;
  };

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const localAddress = req.socket.localAddress;
    if ((localAddress === '127.0.0.1' || localAddress === '::1') &&
        !/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(req.headers.host ?? '')) {
      throw new HttpError(403, 'Loopback dashboard requires a local Host header');
    }
    const url = new URL(req.url ?? '/', 'http://localhost');
    const { pathname } = url;
    const method = req.method;

    if (method === 'GET') {
      switch (pathname) {
        case '/': {
          const html = await readFile(indexPath);
          res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
            'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
          });
          res.end(html);
          return;
        }
        case '/api/health':
          json(res, 200, { status: 'ok' });
          return;
        case '/api/state':
          json(res, 200, db.getDashboardMetrics(config));
          return;
        case '/api/decisions': {
          const action = url.searchParams.get('action');
          json(res, 200, db.listDecisions(undefined, action && action !== 'all' ? choice(action, DecisionAction, 'action') : undefined));
          return;
        }
        case '/api/orders': {
          const status = url.searchParams.get('status');
          json(res, 200, db.listOrders(status ? choice(status, OrderStatus, 'status') : undefined, status === 'pending_hitl' ? -1 : undefined));
          return;
        }
        case '/api/inventory':
          json(res, 200, db.listInventory());
          return;
        case '/api/audit':
          json(res, 200, db.listAuditEvents());
          return;
        case '/api/buy-book': {
          const engine = requireAutopilot();
          const queryTier = url.searchParams.get('tier');
          const tier = queryTier === null ? undefined : choice(queryTier, tiers, 'tier');
          const refresh = url.searchParams.get('refresh');
          if (refresh !== null && refresh !== 'true' && refresh !== 'false') throw new HttpError(400, 'Invalid refresh');
          if (refresh === 'true') engine.refreshBuyBook();
          json(res, 200, engine.getBuyBook().list({ tier }));
          return;
        }
        case '/api/telemetry':
          json(res, 200, requireAutopilot().getTelemetry().snapshot(db));
          return;
      }

      const exit = /^\/api\/inventory\/([^/]+)\/recommend-exit$/.exec(pathname);
      if (exit) {
        const id = decodeId(exit[1]);
        const item = db.getInventoryItem(id);
        if (!item) throw new HttpError(404, 'Inventory item not found');
        json(res, 200, inventoryManager.recommendExit(id));
        return;
      }
    }

    if (method === 'POST') {
      if (pathname === '/mcp') {
        if (!mcpHandler) throw new HttpError(501, 'MCP HTTP handler not attached');
        const result = await mcpHandler(await readJson(req), req.headers);
        json(res, result.status, result.body, result.headers);
        return;
      }

      const origin = req.headers.origin;
      if (origin && origin !== `http://${req.headers.host}` && origin !== `https://${req.headers.host}`) {
        throw new HttpError(403, 'Cross-origin dashboard requests are forbidden');
      }

      switch (pathname) {
        case '/api/scan':
          await readObject(req);
          json(res, 200, await pipeline.runCycle());
          return;
        case '/api/sync': {
          if (!marketSync) throw new HttpError(501, 'Market sync coordinator not attached');
          const { limit } = await readObject(req);
          if (limit !== undefined && (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1)) {
            throw new HttpError(400, 'limit must be a positive integer');
          }
          json(res, 200, await marketSync.syncAll({ limit, buyBook: autopilot?.getBuyBook(), fmvEngine, config }));
          return;
        }
        case '/api/webhooks/listing': {
          const engine = requireAutopilot();
          const { force, ...fields } = await readObject(req);
          const skipDeduplication = force === undefined ? false : boolean(force, 'force');
          let listing: RawListing;
          try {
            listing = parseWebhookListing(fields);
          } catch (error) {
            throw new HttpError(400, error instanceof Error ? error.message : 'Invalid listing');
          }
          json(res, 200, await engine.ingestListingFastPath(listing, { skipDeduplication }));
          return;
        }
        case '/api/autopilot/pass': {
          const engine = requireAutopilot();
          const { tier } = await readObject(req);
          const priority = tier === undefined ? undefined : choice(tier, { ...tiers, all: 'all' } as const, 'tier');
          json(res, 200, await engine.runAutopilotPass({ tier: priority }));
          return;
        }
        case '/api/kill-switch': {
          const body = await readObject(req);
          const engaged = boolean(body.engaged, 'engaged');
          const reason = optionalText(body.reason, 'reason');
          const state = db.setKillSwitch(engaged, reason);
          db.logAuditEvent('system.kill_switch_changed', { engaged, reason });
          json(res, 200, state);
          return;
        }
        case '/api/mode': {
          const body = await readObject(req);
          const mode = choice(body.mode, OperatingMode, 'mode');
          const state = db.setOperatingMode(mode);
          db.logAuditEvent('system.mode_changed', { mode });
          json(res, 200, state);
          return;
        }
      }

      const orderAction = /^\/api\/orders\/([^/]+)\/(approve|reject)$/.exec(pathname);
      if (orderAction) {
        const id = decodeId(orderAction[1]);
        const body = await readObject(req);
        const order = db.getOrder(id);
        if (!order) throw new HttpError(404, 'Order not found');
        if (order.status !== 'pending_hitl') throw new HttpError(409, `Order status is ${order.status}, expected pending_hitl`);
        if (orderAction[2] === 'reject') {
          const updated = pipeline.rejectHitlOrder(id, optionalText(body.reason, 'reason') ?? 'Rejected by operator');
          if (!updated) throw new HttpError(409, 'Order could not be rejected because its state changed or checkout is in progress');
          json(res, 200, updated);
          return;
        }
        const confirmAnomaly = body.confirmAnomaly === undefined ? undefined : boolean(body.confirmAnomaly, 'confirmAnomaly');
        const outcome = await pipeline.approveHitlOrder(id, { confirmAnomaly });
        if (outcome.status === 'filled') json(res, 200, outcome);
        else json(res, outcome.status === 'failed' ? 502 : 409, { ...outcome, error: outcome.reason ?? 'Order could not be approved' });
        return;
      }

      const inventoryAction = /^\/api\/inventory\/([^/]+)\/(qc|sell)$/.exec(pathname);
      if (inventoryAction) {
        const id = decodeId(inventoryAction[1]);
        const body = await readObject(req);
        const item = db.getInventoryItem(id);
        if (!item) throw new HttpError(404, 'Inventory item not found');
        if (item.status === 'sold') throw new HttpError(409, 'Inventory item is already sold');
        if (inventoryAction[2] === 'qc') {
          json(res, 200, inventoryManager.recordIntakeQc(id, {
            passed: boolean(body.passed, 'passed'),
            actualCondition: choice(body.actualCondition, CardCondition, 'actualCondition'),
            notes: optionalText(body.notes, 'notes'),
          }));
        } else {
          json(res, 200, inventoryManager.recordSale(id, {
            exitChannel: choice(body.exitChannel, ExitChannel, 'exitChannel'),
            soldPriceCents: cents(body.soldPriceCents, 'soldPriceCents', 1),
            exitFeesCents: body.exitFeesCents === undefined ? undefined : cents(body.exitFeesCents, 'exitFeesCents', 0),
          }));
        }
        return;
      }
    }

    throw new HttpError(404, 'Route not found');
  }

  return createServer((req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    void handle(req, res).catch((error: unknown) => {
      if (res.headersSent) {
        res.destroy();
      } else if (error instanceof HttpError) {
        json(res, error.status, { error: error.message });
      } else {
        console.error('Dashboard request failed', error);
        json(res, 500, { error: 'Internal server error' });
      }
    });
  });
}
