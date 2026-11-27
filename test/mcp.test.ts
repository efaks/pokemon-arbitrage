import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createSystemRuntime } from '../src/cli.ts';
import type { SystemRuntimeOptions } from '../src/cli.ts';
import type { AuditEvent, InventoryItem, PurchaseOrder } from '../src/domain/types.ts';
import { ArbitrageMcpServer } from '../src/mcp/mcpServer.ts';
import { JSON_RPC_ERROR_CODES as codes } from '../src/mcp/protocol.ts';
import type {
  JsonRpcResponse, McpInitializeResult, McpPromptDefinition, McpPromptMessage,
  McpResourceContent, McpResourceDefinition, McpToolCallResult, McpToolDefinition,
} from '../src/mcp/protocol.ts';
import { createArbitrageServer } from '../src/server/httpServer.ts';

const request = (id: number | string, method: string, params?: unknown) => ({ jsonrpc: '2.0', id, method, params });
const notification = { jsonrpc: '2.0', method: 'notifications/initialized' };
const toolCall = (id: number, name: string, args?: unknown) => request(id, 'tools/call', { name, arguments: args });
const cleanListing = {
  title: 'Pokemon TCG Scarlet & Violet Surging Sparks Booster Box Factory Sealed',
  priceCents: 9500, upc: '820650859120', supportsAutoCheckout: true,
};
const toolNames = [
  'get_system_state', 'set_operating_mode', 'set_kill_switch', 'run_scan_cycle', 'list_catalog_skus',
  'upsert_catalog_sku', 'evaluate_listing', 'list_decisions', 'list_orders', 'approve_hitl_order', 'reject_hitl_order',
  'list_inventory', 'record_intake_qc', 'recommend_exit_channel', 'record_inventory_sale', 'list_audit_events',
  'get_buy_book', 'get_alpha_telemetry', 'ingest_webhook_listing', 'run_autonomous_triage', 'run_repricing_cycle',
];
const resourceUris = ['state', 'hitl-queue', 'catalog', 'inventory', 'decisions/recent', 'audit/recent', 'buy-book', 'telemetry']
  .map(path => 'pokemon-arbitrage://' + path);
const promptNames = ['review_hitl_queue', 'daily_arbitrage_briefing', 'incident_triage', 'autopilot_optimization'];

function setup(t: TestContext, options: SystemRuntimeOptions = {}) {
  const runtime = createSystemRuntime({
    dbPath: ':memory:', mode: 'shadow', useMock: true, quiet: true, ...options,
    configOverrides: { dailySpendCapCents: 150_000, ...options.configOverrides },
  });
  t.after(() => runtime.db.close());
  const server = new ArbitrageMcpServer({ runtime });
  const send = (method: string, params?: unknown) => server.handleMessage(request(1, method, params));
  const call = async (name: string, args?: unknown): Promise<McpToolCallResult> =>
    result<McpToolCallResult>(await send('tools/call', { name, arguments: args }));
  const data = async <T>(name: string, args?: unknown): Promise<T> => {
    const response = await call(name, args);
    assert.equal(response.isError, undefined, response.content[0].text);
    assert.deepEqual(JSON.parse(response.content[0].text), JSON.parse(JSON.stringify(response.structuredContent)));
    return response.structuredContent as T;
  };
  return { runtime, server, send, call, data };
}

function result<T>(response: JsonRpcResponse | JsonRpcResponse[] | undefined): T {
  assert.ok(response && !Array.isArray(response));
  assert.equal(response.jsonrpc, '2.0');
  assert.equal(response.error, undefined, JSON.stringify(response.error));
  assert.ok('result' in response);
  return response.result as T;
}

function assertRpcError(response: JsonRpcResponse | JsonRpcResponse[] | undefined, code: number) {
  assert.ok(response && !Array.isArray(response));
  assert.equal(response.jsonrpc, '2.0');
  assert.equal(response.error?.code, code);
}

function assertToolError(response: McpToolCallResult, message: RegExp) {
  assert.equal(response.isError, true);
  assert.match(response.content[0].text, message);
}

test('MCP negotiates protocol versions and handles lifecycle messages and JSON-RPC batches', async t => {
  const { runtime, server, send } = setup(t);
  const named = new ArbitrageMcpServer({ runtime, name: 'custom', version: '1.0' });
  const init = result<McpInitializeResult>(await named.handleMessage(request('init', 'initialize', {
    protocolVersion: '2024-11-05', clientInfo: { name: 'test', version: '1' }, capabilities: {},
  })));
  assert.equal(init.protocolVersion, '2024-11-05');
  assert.deepEqual(init.serverInfo, { name: 'custom', version: '1.0' });
  assert.deepEqual(init.capabilities, { tools: {}, resources: {}, prompts: {} });
  assert.match(init.instructions, /kill switch/i);
  assert.equal(result<McpInitializeResult>(await send('initialize', { protocolVersion: '2025-03-26' })).protocolVersion,
    '2025-03-26');
  assert.equal(result<McpInitializeResult>(await send('initialize', { protocolVersion: 'unrecognized' })).protocolVersion,
    '2025-03-26');
  assert.equal(await server.handleMessage(notification), undefined);
  const cancelled = { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } };
  assert.equal(await server.handleMessage([notification, cancelled]), undefined);
  assert.deepEqual(result(await send('ping')), {});
  assertRpcError(await send('unimplemented'), codes.METHOD_NOT_FOUND);
  assertRpcError(await send('initialize', { protocolVersion: 3 }), codes.INVALID_PARAMS);
  assertRpcError(await server.handleMessage([]), codes.INVALID_REQUEST);
  assertRpcError(await server.handleMessage(null), codes.INVALID_REQUEST);
  assertRpcError(await server.handleMessage({ ...request(1, 'ping'), id: {} }), codes.INVALID_REQUEST);
  const batch = await server.handleMessage([notification, request(2, 'ping'), false, request('3', 'unimplemented')]);
  assert.ok(Array.isArray(batch));
  assert.deepEqual(batch.map(response => response.id), [2, null, '3']);
  assert.deepEqual(result(batch[0]), {});
  assertRpcError(batch[1], codes.INVALID_REQUEST);
  assertRpcError(batch[2], codes.METHOD_NOT_FOUND);
});

test('MCP exposes exactly 21 validated tools, 8 resources, and 4 prompts', async t => {
  const { send, server } = setup(t);
  const { tools } = result<{ tools: McpToolDefinition[] }>(await send('tools/list'));
  assert.deepEqual(tools.map(tool => tool.name), toolNames);
  assert.ok(tools.every(tool => tool.inputSchema.type === 'object' && tool.inputSchema.additionalProperties === false &&
    tool.description && typeof tool.annotations.readOnlyHint === 'boolean'));
  assert.equal(tools.find(tool => tool.name === 'evaluate_listing')?.annotations.readOnlyHint, true);

  const { resources } = result<{ resources: McpResourceDefinition[] }>(await send('resources/list'));
  assert.deepEqual(resources.map(resource => resource.uri), resourceUris);
  assert.deepEqual(result<{ prompts: McpPromptDefinition[] }>(await send('prompts/list')).prompts.map(prompt => prompt.name),
    promptNames);

  const invalidCalls = [
    toolCall(2, 'set_operating_mode'), toolCall(2, 'set_operating_mode', { mode: 'invalid' }),
    toolCall(2, 'set_kill_switch', { engaged: 'true' }), toolCall(2, 'get_system_state', { extra: true }),
    toolCall(2, 'list_orders', null), toolCall(2, 'list_orders', { limit: -1 }), toolCall(2, 'list_orders', { status: 'other' }),
    toolCall(2, 'evaluate_listing', { ...cleanListing, priceCents: 2.5 }),
    toolCall(2, 'evaluate_listing', { ...cleanListing, shippingCents: -1 }),
    toolCall(2, 'evaluate_listing', { ...cleanListing, seller: { username: 'incomplete' } }),
    toolCall(2, 'reject_hitl_order', { orderId: 'existing', reason: '   ' }),
    toolCall(2, 'record_inventory_sale', { inventoryId: 'item', exitChannel: 'ebay', soldPriceCents: 10.5 }),
    toolCall(2, 'get_buy_book', { tier: 'all' }),
    toolCall(2, 'run_autonomous_triage', { maxApproveCents: -1 }),
    toolCall(2, 'ingest_webhook_listing', { ...cleanListing, skipDeduplication: 'true' }),
    toolCall(2, 'ingest_webhook_listing', { ...cleanListing, currency: 'EUR' }),
    toolCall(2, 'get_alpha_telemetry', { refresh: true }),
    toolCall(2, 'run_repricing_cycle', { inventoryId: 'existing' }),
    toolCall(2, 'unknown'), request(2, 'tools/call', []), request(2, 'resources/read', { uri: 'invalid' }),
    request(2, 'prompts/get', { name: 'review_hitl_queue', arguments: { focusOrderId: false } }),
  ];
  for (const call of invalidCalls) assertRpcError(await server.handleMessage(call), codes.INVALID_PARAMS);
});

test('MCP workflow completes scans, human approvals, QC, exit planning, and a sale', async t => {
  const { runtime, data, call } = setup(t, { seedCatalog: false });
  const before = await data<{
    metrics: { systemState: { operatingMode: string } }; enabledConnectors: string[]; riskThresholds: Record<string, unknown>;
  }>('get_system_state');
  assert.equal(before.metrics.systemState.operatingMode, 'shadow');
  assert.deepEqual(before.enabledConnectors, ['Mock Scenario Feed']);
  assert.equal(before.riskThresholds.dailySpendCapCents, 150_000);
  assert.equal(Object.hasOwn(before.riskThresholds, 'dbPath'), false);

  await data('set_operating_mode', { mode: 'hitl' });
  assert.equal(runtime.config.operatingMode, 'hitl');
  assert.equal(runtime.db.getSystemState().operatingMode, 'hitl');
  assert.equal(runtime.db.listSkus().length, 0);
  const scan = await data<{
    summary: { fetchedCount: number; autoBoughtCount: number }; pendingHitlOrders: PurchaseOrder[]; filledOrders: PurchaseOrder[];
  }>('run_scan_cycle', { useMock: true });
  assert.equal(scan.summary.fetchedCount, 17);
  assert.equal(scan.summary.autoBoughtCount, 0);
  assert.equal(runtime.db.listSkus().length, 20);
  assert.equal(scan.pendingHitlOrders.length, 8);
  assert.deepEqual(scan.filledOrders, []);

  const { decisions } = await data<{ decisions: Array<{ action: string }> }>('list_decisions', { action: 'skip', limit: 2 });
  assert.equal(decisions.length, 2);
  assert.ok(decisions.every(decision => decision.action === 'skip'));

  const { orders } = await data<{ orders: PurchaseOrder[] }>('list_orders', { status: 'pending_hitl' });
  const anomaly = orders.find(order => order.listingId === 'mock-evs-bb-anomaly');
  const normal = orders.find(order => order.listingId === 'mock-ssp-bb-clean');
  const retailer = orders.find(order => order.listingId === 'mock-pre-etb-retailer');
  assert.ok(anomaly && normal && retailer);

  assertToolError(await call('approve_hitl_order', { orderId: 'missing' }), /Order not found/);
  assertToolError(await call('approve_hitl_order', { orderId: anomaly.id }), /confirmAnomaly=true/);
  assert.equal(runtime.db.getOrder(anomaly.id)?.status, 'pending_hitl');
  await data('set_kill_switch', { engaged: true, reason: 'Operator stop' });
  assertToolError(await call('approve_hitl_order', { orderId: normal.id }), /Kill switch engaged/);
  await data('set_kill_switch', { engaged: false });

  assert.equal((await data<{ status: string }>('approve_hitl_order', {
    orderId: anomaly.id, confirmAnomaly: true,
  })).status, 'filled');
  const filled = await data<{ order: PurchaseOrder; inventoryItem: InventoryItem }>('approve_hitl_order', { orderId: normal.id });
  assert.equal(filled.order.status, 'filled');
  assert.equal(filled.inventoryItem.orderId, normal.id);
  assertToolError(await call('approve_hitl_order', { orderId: normal.id }), /expected pending_hitl/);
  assert.equal((await data<{ order: PurchaseOrder }>('reject_hitl_order', {
    orderId: retailer.id, reason: 'Unable to verify stock',
  })).order.status, 'rejected');
  assertToolError(await call('reject_hitl_order', { orderId: retailer.id, reason: 'Already rejected' }), /pending HITL/);

  const inventoryId = filled.inventoryItem.id;
  const intake = { inventoryId, passed: true, actualCondition: 'SEALED' };
  assertToolError(await call('record_intake_qc', { ...intake, inventoryId: 'missing' }), /not found/);
  assert.equal((await data<{ item: InventoryItem }>('record_intake_qc', intake)).item.status, 'qc_passed');
  const { items } = await data<{ items: InventoryItem[] }>('list_inventory', { status: 'qc_passed' });
  assert.deepEqual(items.map(item => item.id), [inventoryId]);
  const exit = await data<{ recommendedChannel: string; channels: unknown[] }>('recommend_exit_channel', { inventoryId });
  assert.equal(exit.channels.length, 4);

  const sale = { inventoryId, exitChannel: exit.recommendedChannel, soldPriceCents: 20_000, exitFeesCents: 2_000 };
  const { item } = await data<{ item: InventoryItem }>('record_inventory_sale', sale);
  assert.equal(item.status, 'sold');
  assert.equal(item.realizedProfitCents, 18_000 - filled.inventoryItem.costBasisCents);
  assertToolError(await call('record_inventory_sale', sale), /already sold/);
  const { pnlAttribution } = await data<{ pnlAttribution: { soldItems: number } }>('list_inventory');
  assert.equal(pnlAttribution.soldItems, 1);

  const { events } = await data<{ events: AuditEvent[] }>('list_audit_events', { limit: 100 });
  for (const expected of [
    'mcp.mode_changed', 'mcp.kill_switch_updated', 'cycle.completed', 'order.hitl_approved',
    'order.hitl_rejected', 'inventory.qc_recorded', 'inventory.sold',
  ]) assert.ok(events.some(event => event.eventType === expected), expected);
});

test('MCP with the kill switch engaged leaves a live fixture scan without executable orders', async t => {
  const { data } = setup(t, { mode: 'live' });
  await data('set_kill_switch', { engaged: true });
  const scan = await data<{ summary: { autoBoughtCount: number }; pendingHitlOrders: unknown[]; filledOrders: unknown[] }>(
    'run_scan_cycle',
  );
  assert.equal(scan.summary.autoBoughtCount, 0);
  assert.deepEqual(scan.pendingHitlOrders, []);
  assert.deepEqual(scan.filledOrders, []);
});

test('MCP fixture scan waits for a running regular scan before selecting the fixture feed', async t => {
  const { runtime, data } = setup(t);
  const [original] = runtime.connectors;
  let complete!: () => void;
  const pending = new Promise<void>(resolve => { complete = resolve; });
  runtime.connectors[0] = {
    name: 'Slow feed', source: original.source, supportsAutoCheckout: original.supportsAutoCheckout,
    pollIntervalMs: original.pollIntervalMs, isEnabled: () => true,
    fetchListings: async () => { await pending; return []; },
  };
  const regular = runtime.pipeline.runCycle();
  const mock = data<{ summary: { fetchedCount: number } }>('run_scan_cycle', { useMock: true });
  complete();
  assert.equal((await regular).fetchedCount, 0);
  assert.equal((await mock).summary.fetchedCount, 17);
});

test('MCP evaluates a listing without side effects and can persist decisions without placing orders', async t => {
  const { runtime, data } = setup(t, { mode: 'live' });
  const listing = { ...cleanListing, listingId: 'dry-run-mcp' };
  const evaluation = await data<{ match: { status: string }; decision: { id: string } }>('evaluate_listing', listing);
  assert.equal(evaluation.match.status, 'matched');
  assert.deepEqual(runtime.db.listDecisions(), []);
  assert.deepEqual(runtime.db.listOrders(), []);
  assert.equal(runtime.db.hasUnchangedListing('mock_feed', listing.listingId, listing.priceCents, 1), false);
  const persisted = await data<typeof evaluation>('evaluate_listing', { ...listing, persistDecision: true });
  assert.deepEqual(runtime.db.listDecisions().map(decision => decision.id), [persisted.decision.id]);
  assert.deepEqual(runtime.db.listOrders(), []);
});

test('MCP upserts catalog SKUs and validates sold comps before insertion', async t => {
  const { runtime, data, server } = setup(t);
  const sku = {
    id: 'test-new', name: 'Test Box', assetClass: 'sealed', language: 'EN', variant: 'standard',
    setName: 'Test Set', setCode: 'MCP', aliases: ['unique match alias'], msrpCents: 4200,
  };
  const comp = {
    id: 'test-comp', source: 'ebay', soldPriceCents: 5000, shippingCents: 200, condition: 'SEALED',
    soldAt: new Date(Date.now() - 86_400_000).toISOString(),
  };
  assertRpcError(await server.handleMessage(toolCall(1, 'upsert_catalog_sku', {
    ...sku, initialComps: [{ ...comp, totalPriceCents: 5201 }],
  })), codes.INVALID_PARAMS);
  assertRpcError(await server.handleMessage(toolCall(1, 'upsert_catalog_sku', {
    ...sku, initialComps: [{ ...comp, shippingCents: 2.5 }],
  })), codes.INVALID_PARAMS);
  assert.equal(runtime.db.getSku(sku.id), undefined);

  const first = await data<{ compsInserted: number }>('upsert_catalog_sku', { ...sku, initialComps: [comp] });
  assert.equal(first.compsInserted, 1);
  const second = await data<typeof first>('upsert_catalog_sku', { ...sku, initialComps: [comp] });
  assert.equal(second.compsInserted, 0);
  const catalog = await data<{
    skus: Array<{ id: string; valuation: { fmvCents: number }; skuPositionCount: number }>;
  }>('list_catalog_skus', { assetClass: 'sealed', language: 'EN', query: 'Unique Match Alias', includeValuation: true });
  assert.deepEqual(catalog.skus.map(candidate => candidate.id), [sku.id]);
  assert.equal(catalog.skus[0].valuation.fmvCents, 5200);
  assert.equal(catalog.skus[0].skuPositionCount, 0);
});

test('MCP reads all resources and renders all prompts from current data', async t => {
  const { data, send } = setup(t, {
    mode: 'live', simulationOverrides: { 'mock-ssp-bb-clean': { failureReason: 'Payment declined' } },
  });
  const scan = await send('tools/call', { name: 'run_scan_cycle' });
  assertToolError(result(scan), /scan completed with errors/i);
  await data('set_kill_switch', { engaged: true, reason: 'Incident under review' });

  const snapshots = new Map<string, unknown>();
  for (const uri of resourceUris) {
    const { contents } = result<{ contents: McpResourceContent[] }>(await send('resources/read', { uri }));
    assert.equal(contents.length, 1);
    assert.equal(contents[0].uri, uri);
    assert.equal(contents[0].mimeType, 'application/json');
    snapshots.set(uri, JSON.parse(contents[0].text));
  }
  const queue = snapshots.get('pokemon-arbitrage://hitl-queue') as PurchaseOrder[];
  assert.ok(queue.length > 0);
  assert.match(JSON.stringify(snapshots.get('pokemon-arbitrage://state')), /Incident under review/);
  assert.match(JSON.stringify(snapshots.get('pokemon-arbitrage://catalog')), /sealed-ssp-bb/);
  assert.match(JSON.stringify(snapshots.get('pokemon-arbitrage://inventory')), /pnlAttribution/);
  assert.match(JSON.stringify(snapshots.get('pokemon-arbitrage://decisions/recent')), /mock-ssp-bb-clean/);
  assert.match(JSON.stringify(snapshots.get('pokemon-arbitrage://audit/recent')), /mcp.kill_switch_updated/);

  assert.match(JSON.stringify(snapshots.get('pokemon-arbitrage://buy-book')), /maxAutoBuyAskCents/);
  assert.match(JSON.stringify(snapshots.get('pokemon-arbitrage://telemetry')), /detectToDecision/);

  const focusOrderId = queue[0].id;
  for (const [name, args, expected] of [
    ['review_hitl_queue', { focusOrderId }, ['focusOrderId', focusOrderId, 'confirmAnomaly=true']],
    ['daily_arbitrage_briefing', undefined, ['pnlAttribution', 'recentDecisions', 'mock-ssp-bb-clean']],
    ['incident_triage', undefined, ['killSwitchEngaged', 'mcp.kill_switch_updated', 'Payment declined']],
    ['autopilot_optimization', undefined, ['buyBook', 'detectToDecision', 'autopilotConfig']],
  ] as const) {
    const { messages } = result<{ messages: McpPromptMessage[] }>(await send('prompts/get', { name, arguments: args }));
    assert.equal(messages.length, 1);
    assert.equal(messages[0].role, 'user');
    for (const value of expected) assert.ok(messages[0].content.text.includes(value), value);
  }
});

test('MCP Wave 5 tools share listing intake, triage, repricing, and telemetry', async t => {
  const { data, runtime } = setup(t, { mode: 'hitl' });
  const { entries } = await data<{ entries: { skuId: string; priorityTier: string }[] }>('get_buy_book', {
    tier: 'standard', refresh: true,
  });
  assert.ok(entries.some(entry => entry.skuId === 'sealed-ssp-bb'));
  assert.ok(entries.every(entry => entry.priorityTier === 'standard'));
  const listing = {
    ...cleanListing, title: 'Surging Spaks Boster Box', listingId: 'wave5-mcp',
    seller: {
      sellerId: 'verified', username: 'Longtime Seller', feedbackScore: 300,
      positivePercent: 100, accountAgeDays: 250, returnsAccepted: true,
    },
    metadata: { sourceRecord: '310' },
  };
  const first = await data<{ execution: { status: string; order: PurchaseOrder }; recovery: { recovered: boolean } }>(
    'ingest_webhook_listing', listing,
  );
  assert.equal(first.execution.status, 'pending_hitl');
  assert.equal(first.recovery.recovered, true);
  assert.equal((await data<{ deduplicated: boolean }>('ingest_webhook_listing', listing)).deduplicated, true);
  assert.equal((await data<{ execution: { status: string } }>('ingest_webhook_listing', {
    ...listing, skipDeduplication: true,
  })).execution.status, 'duplicate');
  assert.equal((await data<{ heldCount: number }>('run_autonomous_triage', { maxApproveCents: 10_000 })).heldCount, 1);
  assert.equal((await data<{ approvedCount: number }>('run_autonomous_triage')).approvedCount, 1);
  const [item] = runtime.db.listInventory();
  await data('record_intake_qc', { inventoryId: item.id, passed: true, actualCondition: 'SEALED' });
  assert.equal((await data<{ repricedCount: number }>('run_repricing_cycle')).repricedCount, 1);
  const telemetry = await data<{ samplesCount: number; fuzzyRecoveriesCount: number; fillRate: number }>('get_alpha_telemetry');
  assert.equal(telemetry.samplesCount, 2);
  assert.equal(telemetry.fuzzyRecoveriesCount, 2);
  assert.equal(telemetry.fillRate, 1);
});

test('spawned MCP stdio CLI flushes every JSON-RPC response at EOF with clean stdout', { timeout: 10_000 }, async t => {
  const child = spawn(process.execPath, ['src/cli.ts', 'mcp', '--db', ':memory:', '--mock', '--mode', 'live'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
  });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
  const closed = once(child, 'close');
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });

  const messages = [
    request(1, 'initialize', { protocolVersion: '2025-03-26' }), notification,
    request(2, 'tools/list'), toolCall(3, 'run_scan_cycle'), toolCall(4, 'get_system_state'),
    toolCall(5, 'ingest_webhook_listing', { ...cleanListing, listingId: 'stdio-push' }),
    toolCall(6, 'get_alpha_telemetry'),
  ];
  child.stdin.end('\n{bad json}\n' + messages.map(message => JSON.stringify(message)).join('\n') + '\n');
  assert.deepEqual(await closed, [0, null], stderr);
  assert.ok(stdout.endsWith('\n'));
  const responses = stdout.slice(0, -1).split('\n').map(line => JSON.parse(line) as JsonRpcResponse);
  assert.deepEqual(responses.map(response => response.id), [null, 1, 2, 3, 4, 5, 6]);
  assertRpcError(responses[0], codes.PARSE_ERROR);
  assert.equal(result<McpInitializeResult>(responses[1]).protocolVersion, '2025-03-26');
  assert.equal(result<{ tools: McpToolDefinition[] }>(responses[2]).tools.length, 21);
  const scan = result<McpToolCallResult>(responses[3]);
  assert.equal(scan.isError, undefined);
  assert.equal((scan.structuredContent?.summary as { fetchedCount: number }).fetchedCount, 17);
  const state = result<McpToolCallResult>(responses[4]);
  assert.equal((state.structuredContent?.metrics as { systemState: { operatingMode: string } }).systemState.operatingMode, 'live');
  const pushed = result<McpToolCallResult>(responses[5]);
  assert.equal((pushed.structuredContent?.decision as { action: string }).action, 'skip');
  assert.equal(result<McpToolCallResult>(responses[6]).structuredContent?.samplesCount, 1);
});

test('HTTP POST /mcp accepts requests, notifications, and batches on a loopback ephemeral port', async t => {
  const { runtime, server: mcpServer } = setup(t);
  const server = createArbitrageServer({ ...runtime, mcpHandler: mcpServer.createHttpHandler() });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const url = 'http://127.0.0.1:' + address.port + '/mcp';
    const post = (body: unknown, origin?: string) => fetch(url, {
      method: 'POST', headers: {
        'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
        ...(origin === undefined ? {} : { Origin: origin }),
      },
      body: JSON.stringify(body),
    });
    const initialize = await post(request(1, 'initialize', { protocolVersion: '2024-11-05' }));
    assert.equal(initialize.status, 200);
    assert.equal(initialize.headers.get('mcp-protocol-version'), '2024-11-05');
    assert.equal(result<McpInitializeResult>(await initialize.json()).protocolVersion, '2024-11-05');

    const acknowledged = await post(notification);
    assert.equal(acknowledged.status, 202);
    assert.equal(acknowledged.headers.get('mcp-protocol-version'), '2024-11-05');
    assert.equal(await acknowledged.text(), '');
    assert.equal((await post([notification])).status, 202);

    const batch = await post([notification, request(2, 'ping'), toolCall(3, 'get_system_state')]);
    assert.equal(batch.status, 200);
    const responses = await batch.json() as JsonRpcResponse[];
    assert.deepEqual(responses.map(response => response.id), [2, 3]);
    assert.deepEqual(result(responses[0]), {});
    assert.ok(result<McpToolCallResult>(responses[1]).structuredContent?.metrics);

    const evaluated = await post(toolCall(4, 'evaluate_listing', cleanListing), new URL(url).origin);
    assert.equal(evaluated.status, 200);
    const evaluation = result<McpToolCallResult>(await evaluated.json());
    assert.equal((evaluation.structuredContent?.match as { status: string }).status, 'matched');
    assert.deepEqual(runtime.db.listDecisions(), []);

    const forbidden = await post(toolCall(5, 'set_kill_switch', { engaged: true }), 'https://other.example');
    assert.equal(forbidden.status, 403);
    assert.equal(runtime.db.getSystemState().killSwitchEngaged, false);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
