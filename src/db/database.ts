import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue, SQLOutputValue } from 'node:sqlite';
import { redactSecrets } from '../setup/secrets.ts';
import { defaultSetupWorkflowState, SETUP_PROFILES, SETUP_STEP_IDS } from '../setup/setupSteps.ts';
import type { SetupStepId, SetupWorkflowState } from '../setup/setupSteps.ts';
import type { ArbitrageConfig } from '../config.ts';
import type {
  ArbitrageDecision,
  AssetClass,
  AuditEvent,
  CanonicalSku,
  CardCondition,
  CardLanguage,
  CardVariant,
  DashboardMetrics,
  DecisionAction,
  ExitChannel,
  Grader,
  InventoryItem,
  InventoryStatus,
  OperatingMode,
  OrderStatus,
  PortfolioSnapshot,
  ProfitBreakdown,
  PurchaseOrder,
  SoldComp,
  SourceName,
  SystemState,
} from '../domain/types.ts';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS canonical_skus (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    asset_class TEXT NOT NULL,
    set_name TEXT NOT NULL,
    set_code TEXT NOT NULL,
    card_number TEXT,
    upc TEXT,
    language TEXT NOT NULL,
    variant TEXT NOT NULL,
    grader TEXT,
    grade TEXT,
    msrp_cents INTEGER,
    aliases TEXT NOT NULL,
    reference_image_url TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS canonical_skus_upc ON canonical_skus (upc);

  CREATE TABLE IF NOT EXISTS sold_comps (
    id TEXT PRIMARY KEY,
    sku_id TEXT NOT NULL REFERENCES canonical_skus (id),
    source TEXT NOT NULL,
    sold_price_cents INTEGER NOT NULL,
    shipping_cents INTEGER NOT NULL,
    total_price_cents INTEGER NOT NULL,
    condition TEXT NOT NULL,
    grader TEXT,
    grade TEXT,
    sold_at TEXT NOT NULL,
    is_outlier INTEGER
  ) STRICT;
  CREATE INDEX IF NOT EXISTS sold_comps_sku_sold_at ON sold_comps (sku_id, sold_at);

  CREATE TABLE IF NOT EXISTS seen_listings (
    source TEXT NOT NULL,
    listing_id TEXT NOT NULL,
    price_cents INTEGER NOT NULL,
    quantity INTEGER NOT NULL,
    seen_at TEXT NOT NULL,
    PRIMARY KEY (source, listing_id)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS decisions (
    id TEXT PRIMARY KEY,
    listing_id TEXT NOT NULL,
    source TEXT NOT NULL,
    listing_url TEXT NOT NULL,
    listing_title TEXT NOT NULL,
    sku_id TEXT REFERENCES canonical_skus (id),
    sku_name TEXT,
    asset_class TEXT,
    action TEXT NOT NULL,
    intended_action TEXT NOT NULL,
    operating_mode TEXT NOT NULL,
    match_confidence REAL NOT NULL,
    fmv_cents INTEGER,
    liquidity_score REAL,
    best_exit TEXT,
    all_exits TEXT,
    warnings TEXT NOT NULL,
    reasons TEXT NOT NULL,
    anomaly_flagged INTEGER NOT NULL,
    decided_at TEXT NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS decisions_decided_at ON decisions (decided_at);

  CREATE TABLE IF NOT EXISTS purchase_locks (
    listing_key TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    expires_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    idempotency_key TEXT NOT NULL UNIQUE,
    decision_id TEXT NOT NULL REFERENCES decisions (id),
    listing_id TEXT NOT NULL,
    source TEXT NOT NULL,
    listing_url TEXT NOT NULL,
    listing_title TEXT NOT NULL,
    sku_id TEXT NOT NULL REFERENCES canonical_skus (id),
    sku_name TEXT NOT NULL,
    asset_class TEXT NOT NULL,
    status TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    ask_price_cents INTEGER NOT NULL,
    shipping_cents INTEGER NOT NULL,
    tax_cents INTEGER NOT NULL,
    landed_cost_cents INTEGER NOT NULL,
    expected_net_profit_cents INTEGER NOT NULL,
    expected_net_roi REAL NOT NULL,
    recommended_exit_channel TEXT NOT NULL,
    external_order_id TEXT,
    failure_reason TEXT,
    decision_warnings TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS orders_status_created_at ON orders (status, created_at);
  CREATE INDEX IF NOT EXISTS orders_sku_id ON orders (sku_id);

  CREATE TABLE IF NOT EXISTS inventory_items (
    id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL REFERENCES orders (id),
    sku_id TEXT NOT NULL REFERENCES canonical_skus (id),
    sku_name TEXT NOT NULL,
    asset_class TEXT NOT NULL,
    expected_condition TEXT NOT NULL,
    actual_condition TEXT,
    grader TEXT,
    grade TEXT,
    cost_basis_cents INTEGER NOT NULL,
    expected_exit_channel TEXT NOT NULL,
    expected_fmv_cents INTEGER NOT NULL,
    predicted_net_profit_cents INTEGER NOT NULL,
    status TEXT NOT NULL,
    qc_notes TEXT,
    listed_channel TEXT,
    listed_price_cents INTEGER,
    external_offer_id TEXT,
    external_listing_id TEXT,
    external_listing_url TEXT,
    sold_channel TEXT,
    sold_price_cents INTEGER,
    exit_fees_cents INTEGER,
    realized_profit_cents INTEGER,
    acquired_at TEXT NOT NULL,
    sold_at TEXT,
    updated_at TEXT NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS inventory_items_sku_id ON inventory_items (sku_id);

  CREATE TABLE IF NOT EXISTS system_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    operating_mode TEXT NOT NULL,
    kill_switch_engaged INTEGER NOT NULL,
    kill_switch_reason TEXT,
    consecutive_errors INTEGER NOT NULL,
    last_scan_at TEXT,
    updated_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS audit_events (
    id TEXT PRIMARY KEY,
    event_type TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS audit_events_type_created_at ON audit_events (event_type, created_at);

  CREATE TABLE IF NOT EXISTS setup_workflow (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    target_profile TEXT NOT NULL,
    profile_selected INTEGER NOT NULL,
    acknowledged_steps TEXT NOT NULL,
    skipped_steps TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;
`;

const OPEN_ORDER_STATUSES = "('approved', 'executing')";
const SPEND_ORDER_STATUSES = "('approved', 'executing', 'filled')";
const ACTIVE_INVENTORY_STATUSES = "('in_transit', 'qc_passed', 'listed')";
const DEFAULT_LIST_LIMIT = 100;
const MILLISECONDS_PER_DAY = 86_400_000;

type Row = Record<string, SQLOutputValue>;

function one<T>(row: Row | undefined, decode: (row: Row) => T): T | undefined {
  return row === undefined ? undefined : decode(row);
}

function withoutUndefined<T extends object>(record: T): T {
  for (const key of Object.keys(record) as (keyof T)[]) {
    if (record[key] === undefined) delete record[key];
  }
  return record;
}

function optional<T extends string | number>(value: SQLOutputValue): T | undefined {
  return value === null ? undefined : value as T;
}

function json<T>(value: SQLOutputValue): T {
  return JSON.parse(value as string) as T;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readJsonRecord(value: SQLOutputValue): Record<string, unknown> {
  try {
    return asRecord(json<unknown>(value));
  } catch (error) {
    if (error instanceof SyntaxError) return {};
    throw error;
  }
}

function readSetupCheckpoints<K extends 'note' | 'reason'>(value: SQLOutputValue, field: K) {
  const entries = readJsonRecord(value);
  const checkpoints: Partial<Record<SetupStepId, Record<K | 'recordedAt', string>>> = {};
  for (const id of SETUP_STEP_IDS) {
    const entry = asRecord(entries[id]);
    const message = entry[field];
    const { recordedAt } = entry;
    if (typeof message === 'string' && message.trim() && typeof recordedAt === 'string' && Number.isFinite(Date.parse(recordedAt))) {
      checkpoints[id] = { [field]: redactSecrets(message), recordedAt } as Record<K | 'recordedAt', string>;
    }
  }
  return checkpoints;
}

function readSetupWorkflow(row: Row): SetupWorkflowState {
  const defaults = defaultSetupWorkflowState(row.updated_at as string);
  const profile = SETUP_PROFILES.find(value => value === row.target_profile);
  return {
    ...defaults, targetProfile: profile ?? defaults.targetProfile, profileSelected: profile !== undefined && row.profile_selected === 1,
    acknowledgedSteps: readSetupCheckpoints(row.acknowledged_steps, 'note'),
    skippedSteps: readSetupCheckpoints(row.skipped_steps, 'reason'),
  };
}

function bindings(fields: Record<string, SQLInputValue | undefined>): Record<string, SQLInputValue> {
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, value ?? null]));
}

function checkExitCents(exit: ProfitBreakdown): void {
  for (const [field, value] of Object.entries(exit)) {
    if (field.endsWith('Cents') && !Number.isSafeInteger(value)) {
      throw new RangeError(`${field} must be an integer number of cents`);
    }
  }
}

function readSku(row: Row): CanonicalSku {
  return withoutUndefined({
    id: row.id as string,
    name: row.name as string,
    assetClass: row.asset_class as AssetClass,
    setName: row.set_name as string,
    setCode: row.set_code as string,
    cardNumber: optional<string>(row.card_number),
    upc: optional<string>(row.upc),
    language: row.language as CardLanguage,
    variant: row.variant as CardVariant,
    grader: optional<Grader>(row.grader),
    grade: optional<string>(row.grade),
    msrpCents: optional<number>(row.msrp_cents),
    aliases: json<string[]>(row.aliases),
    referenceImageUrl: optional<string>(row.reference_image_url),
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  });
}

function readComp(row: Row): SoldComp {
  return withoutUndefined({
    id: row.id as string,
    skuId: row.sku_id as string,
    source: row.source as SoldComp['source'],
    soldPriceCents: row.sold_price_cents as number,
    shippingCents: row.shipping_cents as number,
    totalPriceCents: row.total_price_cents as number,
    condition: row.condition as CardCondition,
    grader: optional<Grader>(row.grader),
    grade: optional<string>(row.grade),
    soldAt: row.sold_at as string,
    isOutlier: row.is_outlier === null ? undefined : Boolean(row.is_outlier),
  });
}

function readDecision(row: Row): ArbitrageDecision {
  return withoutUndefined({
    id: row.id as string,
    listingId: row.listing_id as string,
    source: row.source as SourceName,
    listingUrl: row.listing_url as string,
    listingTitle: row.listing_title as string,
    skuId: optional<string>(row.sku_id),
    skuName: optional<string>(row.sku_name),
    assetClass: optional<AssetClass>(row.asset_class),
    action: row.action as DecisionAction,
    intendedAction: row.intended_action as DecisionAction,
    operatingMode: row.operating_mode as OperatingMode,
    matchConfidence: row.match_confidence as number,
    fmvCents: optional<number>(row.fmv_cents),
    liquidityScore: optional<number>(row.liquidity_score),
    bestExit: row.best_exit === null ? undefined : json<ProfitBreakdown>(row.best_exit),
    allExits: row.all_exits === null ? undefined : json<ProfitBreakdown[]>(row.all_exits),
    warnings: json<string[]>(row.warnings),
    reasons: json<string[]>(row.reasons),
    anomalyFlagged: Boolean(row.anomaly_flagged),
    decidedAt: row.decided_at as string,
  });
}

function readOrder(row: Row): PurchaseOrder {
  return withoutUndefined({
    id: row.id as string,
    idempotencyKey: row.idempotency_key as string,
    decisionId: row.decision_id as string,
    listingId: row.listing_id as string,
    source: row.source as SourceName,
    listingUrl: row.listing_url as string,
    listingTitle: row.listing_title as string,
    skuId: row.sku_id as string,
    skuName: row.sku_name as string,
    assetClass: row.asset_class as AssetClass,
    status: row.status as OrderStatus,
    quantity: row.quantity as number,
    askPriceCents: row.ask_price_cents as number,
    shippingCents: row.shipping_cents as number,
    taxCents: row.tax_cents as number,
    landedCostCents: row.landed_cost_cents as number,
    expectedNetProfitCents: row.expected_net_profit_cents as number,
    expectedNetRoi: row.expected_net_roi as number,
    recommendedExitChannel: row.recommended_exit_channel as ExitChannel,
    externalOrderId: optional<string>(row.external_order_id),
    failureReason: optional<string>(row.failure_reason),
    decisionWarnings: json<string[]>(row.decision_warnings),
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  });
}

function readInventory(row: Row): InventoryItem {
  return withoutUndefined({
    id: row.id as string,
    orderId: row.order_id as string,
    skuId: row.sku_id as string,
    skuName: row.sku_name as string,
    assetClass: row.asset_class as AssetClass,
    expectedCondition: row.expected_condition as CardCondition,
    actualCondition: optional<CardCondition>(row.actual_condition),
    grader: optional<Grader>(row.grader),
    grade: optional<string>(row.grade),
    costBasisCents: row.cost_basis_cents as number,
    expectedExitChannel: row.expected_exit_channel as ExitChannel,
    expectedFmvCents: row.expected_fmv_cents as number,
    predictedNetProfitCents: row.predicted_net_profit_cents as number,
    status: row.status as InventoryStatus,
    qcNotes: optional<string>(row.qc_notes),
    listedChannel: optional<ExitChannel>(row.listed_channel),
    listedPriceCents: optional<number>(row.listed_price_cents),
    externalOfferId: optional<string>(row.external_offer_id),
    externalListingId: optional<string>(row.external_listing_id),
    externalListingUrl: optional<string>(row.external_listing_url),
    soldChannel: optional<ExitChannel>(row.sold_channel),
    soldPriceCents: optional<number>(row.sold_price_cents),
    exitFeesCents: optional<number>(row.exit_fees_cents),
    realizedProfitCents: optional<number>(row.realized_profit_cents),
    acquiredAt: row.acquired_at as string,
    soldAt: optional<string>(row.sold_at),
    updatedAt: row.updated_at as string,
  });
}

function readSystemState(row: Row): SystemState {
  return withoutUndefined({
    operatingMode: row.operating_mode as OperatingMode,
    killSwitchEngaged: Boolean(row.kill_switch_engaged),
    killSwitchReason: optional<string>(row.kill_switch_reason),
    consecutiveErrors: row.consecutive_errors as number,
    lastScanAt: optional<string>(row.last_scan_at),
    updatedAt: row.updated_at as string,
  });
}

function readAuditEvent(row: Row): AuditEvent {
  return {
    id: row.id as string,
    eventType: row.event_type as string,
    payload: json<Record<string, unknown>>(row.payload),
    createdAt: row.created_at as string,
  };
}

const INVENTORY_COLUMNS = {
  id: 'id',
  orderId: 'order_id',
  skuId: 'sku_id',
  skuName: 'sku_name',
  assetClass: 'asset_class',
  expectedCondition: 'expected_condition',
  actualCondition: 'actual_condition',
  grader: 'grader',
  grade: 'grade',
  costBasisCents: 'cost_basis_cents',
  expectedExitChannel: 'expected_exit_channel',
  expectedFmvCents: 'expected_fmv_cents',
  predictedNetProfitCents: 'predicted_net_profit_cents',
  status: 'status',
  qcNotes: 'qc_notes',
  listedChannel: 'listed_channel',
  listedPriceCents: 'listed_price_cents',
  externalOfferId: 'external_offer_id',
  externalListingId: 'external_listing_id',
  externalListingUrl: 'external_listing_url',
  soldChannel: 'sold_channel',
  soldPriceCents: 'sold_price_cents',
  exitFeesCents: 'exit_fees_cents',
  realizedProfitCents: 'realized_profit_cents',
  acquiredAt: 'acquired_at',
  soldAt: 'sold_at',
  updatedAt: 'updated_at',
} as const satisfies Record<keyof InventoryItem, string>;

const INVENTORY_KEYS = Object.keys(INVENTORY_COLUMNS) as (keyof InventoryItem)[];

/** SQLite persistence. Callers supply timestamps in UTC using Date.toISOString(). */
export class ArbitrageDatabase {
  private readonly db: DatabaseSync;

  constructor(dbPath: string = 'data/arbitrage.sqlite') {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath, { timeout: 5000 });

    try {
      this.db.exec('PRAGMA foreign_keys = ON;');
      if (dbPath !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL;');
      this.db.exec(SCHEMA);
      this.transaction('BEGIN IMMEDIATE', () => {
        const columns = new Set(this.db.prepare('PRAGMA table_info(inventory_items)').all().map(row => row.name));
        for (const column of ['external_offer_id', 'external_listing_id', 'external_listing_url']) {
          if (!columns.has(column)) this.db.exec(`ALTER TABLE inventory_items ADD COLUMN ${column} TEXT`);
        }
      });
      this.db.prepare(`
        INSERT OR IGNORE INTO system_state
          (id, operating_mode, kill_switch_engaged, consecutive_errors, updated_at)
        VALUES (1, 'shadow', 0, 0, ?)
      `).run(new Date().toISOString());
      this.db.prepare(`
        INSERT OR IGNORE INTO setup_workflow (id, target_profile, profile_selected, acknowledged_steps, skipped_steps, updated_at)
        VALUES (1, 'live_closed_loop', 0, '{}', '{}', ?)
      `).run(new Date().toISOString());
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  private transaction<T>(begin: 'BEGIN' | 'BEGIN IMMEDIATE', operation: () => T): T {
    this.db.exec(begin);
    try {
      const result = operation();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /** Runs synchronous writes under one SQLite write lock. */
  withWriteTransaction<T>(operation: () => T): T {
    return this.transaction('BEGIN IMMEDIATE', operation);
  }

  upsertSku(sku: CanonicalSku): void {
    this.db.prepare(`
      INSERT INTO canonical_skus (
        id, name, asset_class, set_name, set_code, card_number, upc, language, variant,
        grader, grade, msrp_cents, aliases, reference_image_url, created_at, updated_at
      ) VALUES (
        $id, $name, $assetClass, $setName, $setCode, $cardNumber, $upc, $language, $variant,
        $grader, $grade, $msrpCents, $aliases, $referenceImageUrl, $createdAt, $updatedAt
      )
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name, asset_class = excluded.asset_class, set_name = excluded.set_name,
        set_code = excluded.set_code, card_number = excluded.card_number, upc = excluded.upc,
        language = excluded.language, variant = excluded.variant, grader = excluded.grader,
        grade = excluded.grade, msrp_cents = excluded.msrp_cents, aliases = excluded.aliases,
        reference_image_url = excluded.reference_image_url, updated_at = excluded.updated_at
    `).run(bindings({
      cardNumber: undefined, upc: undefined, grader: undefined, grade: undefined,
      msrpCents: undefined, referenceImageUrl: undefined,
      ...sku, aliases: JSON.stringify(sku.aliases),
    }));
  }

  getSku(id: string): CanonicalSku | undefined {
    return one(this.db.prepare('SELECT * FROM canonical_skus WHERE id = ?').get(id), readSku);
  }

  listSkus(filter?: { assetClass?: AssetClass; language?: CardLanguage }): CanonicalSku[] {
    return this.db.prepare(`
      SELECT * FROM canonical_skus
      WHERE ($assetClass IS NULL OR asset_class = $assetClass)
        AND ($language IS NULL OR language = $language)
      ORDER BY id
    `).all(bindings({ assetClass: filter?.assetClass, language: filter?.language })).map(readSku);
  }

  findSkuByUpc(upc: string): CanonicalSku | undefined {
    return one(this.db.prepare('SELECT * FROM canonical_skus WHERE upc = ? ORDER BY id LIMIT 1').get(upc), readSku);
  }

  insertSoldComps(comps: SoldComp[]): number {
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO sold_comps (
        id, sku_id, source, sold_price_cents, shipping_cents, total_price_cents,
        condition, grader, grade, sold_at, is_outlier
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    return this.transaction('BEGIN IMMEDIATE', () => {
      let inserted = 0;
      for (const comp of comps) {
        const result = insert.run(
          comp.id, comp.skuId, comp.source, comp.soldPriceCents, comp.shippingCents,
          comp.totalPriceCents, comp.condition, comp.grader ?? null, comp.grade ?? null,
          comp.soldAt, comp.isOutlier === undefined ? null : Number(comp.isOutlier),
        );
        inserted += Number(result.changes);
      }
      return inserted;
    });
  }

  getSoldComps(skuId: string, condition?: CardCondition, grader?: Grader, grade?: string): SoldComp[] {
    return this.db.prepare(`
      SELECT * FROM sold_comps
      WHERE sku_id = $skuId
        AND ($condition IS NULL OR condition = $condition)
        AND ($grader IS NULL OR grader = $grader)
        AND ($grade IS NULL OR grade = $grade)
      ORDER BY sold_at DESC, id
    `).all(bindings({ skuId, condition, grader, grade })).map(readComp);
  }

  hasUnchangedListing(source: SourceName, listingId: string, priceCents: number, quantity: number): boolean {
    return this.db.prepare(`
      SELECT 1 FROM seen_listings
      WHERE source = ? AND listing_id = ? AND price_cents = ? AND quantity = ?
    `).get(source, listingId, priceCents, quantity) !== undefined;
  }

  markListingSeen(source: SourceName, listingId: string, priceCents: number, quantity: number, seenAt = new Date().toISOString()): void {
    this.db.prepare(`
      INSERT INTO seen_listings (source, listing_id, price_cents, quantity, seen_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(source, listing_id) DO UPDATE SET
        price_cents = excluded.price_cents, quantity = excluded.quantity, seen_at = excluded.seen_at
    `).run(source, listingId, priceCents, quantity, seenAt);
  }

  saveDecision(decision: ArbitrageDecision): void {
    if (decision.bestExit) checkExitCents(decision.bestExit);
    decision.allExits?.forEach(checkExitCents);
    this.db.prepare(`
      INSERT INTO decisions (
        id, listing_id, source, listing_url, listing_title, sku_id, sku_name, asset_class,
        action, intended_action, operating_mode, match_confidence, fmv_cents, liquidity_score,
        best_exit, all_exits, warnings, reasons, anomaly_flagged, decided_at
      ) VALUES (
        $id, $listingId, $source, $listingUrl, $listingTitle, $skuId, $skuName, $assetClass,
        $action, $intendedAction, $operatingMode, $matchConfidence, $fmvCents, $liquidityScore,
        $bestExit, $allExits, $warnings, $reasons, $anomalyFlagged, $decidedAt
      )
    `).run(bindings({
      skuId: undefined, skuName: undefined, assetClass: undefined, fmvCents: undefined, liquidityScore: undefined,
      ...decision,
      bestExit: JSON.stringify(decision.bestExit),
      allExits: JSON.stringify(decision.allExits),
      warnings: JSON.stringify(decision.warnings),
      reasons: JSON.stringify(decision.reasons),
      anomalyFlagged: Number(decision.anomalyFlagged),
    }));
  }

  listDecisions(limit = DEFAULT_LIST_LIMIT, action?: DecisionAction): ArbitrageDecision[] {
    return this.db.prepare(`
      SELECT * FROM decisions WHERE ($action IS NULL OR action = $action)
      ORDER BY decided_at DESC, rowid DESC LIMIT $limit
    `).all(bindings({ action, limit })).map(readDecision);
  }

  acquirePurchaseLock(listingKey: string, ownerId: string, ttlMs: number): boolean {
    return this.transaction('BEGIN IMMEDIATE', () => {
      const now = Date.now();
      this.db.prepare('DELETE FROM purchase_locks WHERE listing_key = ? AND expires_at <= ?')
        .run(listingKey, new Date(now).toISOString());
      const result = this.db.prepare(`
        INSERT OR IGNORE INTO purchase_locks (listing_key, owner_id, expires_at) VALUES (?, ?, ?)
      `).run(listingKey, ownerId, new Date(now + ttlMs).toISOString());
      return result.changes > 0;
    });
  }

  releasePurchaseLock(listingKey: string, ownerId: string): boolean {
    return this.db.prepare('DELETE FROM purchase_locks WHERE listing_key = ? AND owner_id = ?')
      .run(listingKey, ownerId).changes > 0;
  }

  createOrderIdempotent(order: PurchaseOrder): { order: PurchaseOrder; created: boolean } {
    return this.transaction('BEGIN IMMEDIATE', () => {
      const existing = this.getOrderByIdempotencyKey(order.idempotencyKey);
      if (existing) return { order: existing, created: false };
      this.db.prepare(`
        INSERT INTO orders (
          id, idempotency_key, decision_id, listing_id, source, listing_url, listing_title, sku_id, sku_name,
          asset_class, status, quantity, ask_price_cents, shipping_cents, tax_cents, landed_cost_cents,
          expected_net_profit_cents, expected_net_roi, recommended_exit_channel, external_order_id,
          failure_reason, decision_warnings, created_at, updated_at
        ) VALUES (
          $id, $idempotencyKey, $decisionId, $listingId, $source, $listingUrl, $listingTitle, $skuId, $skuName,
          $assetClass, $status, $quantity, $askPriceCents, $shippingCents, $taxCents, $landedCostCents,
          $expectedNetProfitCents, $expectedNetRoi, $recommendedExitChannel, $externalOrderId,
          $failureReason, $decisionWarnings, $createdAt, $updatedAt
        )
      `).run(bindings({
        externalOrderId: undefined, failureReason: undefined,
        ...order, decisionWarnings: JSON.stringify(order.decisionWarnings),
      }));
      return { order, created: true };
    });
  }

  getOrder(id: string): PurchaseOrder | undefined {
    return one(this.db.prepare('SELECT * FROM orders WHERE id = ?').get(id), readOrder);
  }

  getOrderByIdempotencyKey(key: string): PurchaseOrder | undefined {
    return one(this.db.prepare('SELECT * FROM orders WHERE idempotency_key = ?').get(key), readOrder);
  }

  listOrders(status?: OrderStatus, limit = DEFAULT_LIST_LIMIT): PurchaseOrder[] {
    return this.db.prepare(`
      SELECT * FROM orders WHERE ($status IS NULL OR status = $status)
      ORDER BY created_at DESC, rowid DESC LIMIT $limit
    `).all(bindings({ status, limit })).map(readOrder);
  }

  updateOrderStatus(
    id: string,
    status: OrderStatus,
    patch: Partial<Pick<PurchaseOrder, 'externalOrderId' | 'failureReason' | 'updatedAt'>> = {},
  ): PurchaseOrder | undefined {
    const row = this.db.prepare(`
      UPDATE orders SET status = $status,
        external_order_id = CASE WHEN $changeExternalId THEN $externalOrderId ELSE external_order_id END,
        failure_reason = CASE WHEN $changeFailureReason THEN $failureReason ELSE failure_reason END,
        updated_at = $updatedAt
      WHERE id = $id RETURNING *
    `).get(bindings({
      id, status, externalOrderId: patch.externalOrderId, failureReason: patch.failureReason,
      changeExternalId: Number(Object.hasOwn(patch, 'externalOrderId')),
      changeFailureReason: Number(Object.hasOwn(patch, 'failureReason')),
      updatedAt: patch.updatedAt ?? new Date().toISOString(),
    }));
    return one(row, readOrder);
  }

  getDailySpendCents(sinceIso: string): number {
    const row = this.db.prepare(`
      SELECT COALESCE(SUM(landed_cost_cents), 0) AS total
      FROM orders WHERE status IN ${SPEND_ORDER_STATUSES} AND created_at >= ?
    `).get(sinceIso);
    return row?.total as number;
  }

  /** Counts units in approved/executing orders and each active inventory item once. */
  getSkuPositionCount(skuId: string): number {
    const row = this.db.prepare(`
      SELECT (
        (SELECT COALESCE(SUM(quantity), 0) FROM orders
          WHERE sku_id = $skuId AND status IN ${OPEN_ORDER_STATUSES}) +
        (SELECT COUNT(*) FROM inventory_items
          WHERE sku_id = $skuId AND status IN ${ACTIVE_INVENTORY_STATUSES})
      ) AS total
    `).get({ skuId });
    return row?.total as number;
  }

  getPortfolioSnapshot(config: ArbitrageConfig, nowIso = new Date().toISOString()): PortfolioSnapshot {
    return this.transaction('BEGIN', () => this.readPortfolioSnapshot(config, nowIso));
  }

  /** Daily spend resets at midnight UTC. Available cash includes all commitments and sales. */
  private readPortfolioSnapshot(config: ArbitrageConfig, nowIso: string): PortfolioSnapshot {
    const dayStart = `${new Date(nowIso).toISOString().slice(0, 10)}T00:00:00.000Z`;
    const dailySpendCents = this.getDailySpendCents(dayStart);
    const cashLedger = this.db.prepare(`
      SELECT
        (SELECT COALESCE(SUM(landed_cost_cents), 0)
          FROM orders WHERE status IN ${SPEND_ORDER_STATUSES}) AS committed,
        (SELECT COALESCE(SUM(sold_price_cents - COALESCE(exit_fees_cents, 0)), 0)
          FROM inventory_items WHERE status = 'sold') AS proceeds
    `).get();
    const totalCommittedSpendCents = cashLedger?.committed as number;
    const totalRealizedProceedsCents = cashLedger?.proceeds as number;
    const positions = this.db.prepare(`
      SELECT sku_id, SUM(units) AS units FROM (
        SELECT sku_id, quantity AS units FROM orders WHERE status IN ${OPEN_ORDER_STATUSES}
        UNION ALL
        SELECT sku_id, 1 AS units FROM inventory_items WHERE status IN ${ACTIVE_INVENTORY_STATUSES}
      ) GROUP BY sku_id ORDER BY sku_id
    `).all();
    const activeInventory = this.db.prepare(`
      SELECT COUNT(*) AS count, COALESCE(SUM(cost_basis_cents), 0) AS cost
      FROM inventory_items WHERE status IN ${ACTIVE_INVENTORY_STATUSES}
    `).get();
    return {
      dailySpendCents,
      dailySpendCapCents: config.dailySpendCapCents,
      cashBalanceCents: Math.max(0, config.cashBalanceCents - totalCommittedSpendCents + totalRealizedProceedsCents),
      minCashReserveCents: config.minCashReserveCents,
      skuPositions: Object.fromEntries(positions.map(row => [row.sku_id as string, row.units as number])),
      activeInventoryCostCents: activeInventory?.cost as number,
      activeInventoryCount: activeInventory?.count as number,
    };
  }

  createInventoryItem(item: InventoryItem): void {
    this.db.prepare(`
      INSERT INTO inventory_items (${INVENTORY_KEYS.map(key => INVENTORY_COLUMNS[key]).join(', ')})
      VALUES (${INVENTORY_KEYS.map(() => '?').join(', ')})
    `).run(...INVENTORY_KEYS.map(key => item[key] ?? null));
  }

  getInventoryItem(id: string): InventoryItem | undefined {
    return one(this.db.prepare('SELECT * FROM inventory_items WHERE id = ?').get(id), readInventory);
  }

  listInventory(status?: InventoryStatus): InventoryItem[] {
    return this.db.prepare(`
      SELECT * FROM inventory_items WHERE ($status IS NULL OR status = $status)
      ORDER BY acquired_at DESC, rowid DESC
    `).all(bindings({ status })).map(readInventory);
  }

  updateInventoryItem(id: string, patch: Partial<InventoryItem>): InventoryItem | undefined {
    const fields = { ...patch, updatedAt: patch.updatedAt ?? new Date().toISOString() };
    const keys = INVENTORY_KEYS.filter(key => key !== 'id' && Object.hasOwn(fields, key));
    const row = this.db.prepare(`
      UPDATE inventory_items SET ${keys.map(key => `${INVENTORY_COLUMNS[key]} = ?`).join(', ')}
      WHERE id = ? RETURNING *
    `).get(...keys.map(key => fields[key] ?? null), id);
    return one(row, readInventory);
  }

  getSystemState(): SystemState {
    const row = this.db.prepare('SELECT * FROM system_state WHERE id = 1').get();
    if (!row) throw new Error('System state row is missing');
    return readSystemState(row);
  }

  getSetupWorkflowState(): SetupWorkflowState {
    const row = this.db.prepare('SELECT * FROM setup_workflow WHERE id = 1').get();
    if (!row) throw new Error('Setup workflow row is missing');
    return readSetupWorkflow(row);
  }

  saveSetupWorkflowState(state: SetupWorkflowState): SetupWorkflowState {
    const { targetProfile, profileSelected, acknowledgedSteps, skippedSteps, updatedAt } = state;
    const row = this.db.prepare(`
      UPDATE setup_workflow SET target_profile = ?, profile_selected = ?, acknowledged_steps = ?, skipped_steps = ?, updated_at = ?
      WHERE id = 1 RETURNING *
    `).get(targetProfile, Number(profileSelected), JSON.stringify(redactSecrets(acknowledgedSteps)),
      JSON.stringify(redactSecrets(skippedSteps)), updatedAt);
    if (!row) throw new Error('Setup workflow row is missing');
    return readSetupWorkflow(row);
  }

  hasCompletedShadowPass(): boolean {
    if (this.db.prepare("SELECT 1 FROM orders WHERE status = 'shadow_recorded' LIMIT 1").get()) return true;
    const recentCycles = this.db.prepare(`
      SELECT payload FROM audit_events WHERE event_type = 'cycle.completed' ORDER BY created_at DESC, rowid DESC LIMIT 50
    `).all();
    return recentCycles.some(row => {
      const { operatingMode, errorCount, fetchedCount } = readJsonRecord(row.payload);
      return operatingMode === 'shadow' && errorCount === 0 && typeof fetchedCount === 'number' && fetchedCount > 0;
    });
  }

  /** Updates the singleton and reads back the exact state written by this operation. */
  private updateSystemState(assignments: string, ...values: SQLInputValue[]): SystemState {
    const row = this.db.prepare(`
      UPDATE system_state SET ${assignments}, updated_at = ? WHERE id = 1 RETURNING *
    `).get(...values, new Date().toISOString());
    if (!row) throw new Error('System state row is missing');
    return readSystemState(row);
  }

  setOperatingMode(mode: OperatingMode): SystemState {
    return this.updateSystemState('operating_mode = ?', mode);
  }

  setKillSwitch(engaged: boolean, reason?: string): SystemState {
    return this.updateSystemState(
      'kill_switch_engaged = ?, kill_switch_reason = ?', Number(engaged), engaged ? reason ?? null : null,
    );
  }

  recordScanTimestamp(scanIso: string): SystemState {
    return this.updateSystemState('last_scan_at = ?', scanIso);
  }

  incrementConsecutiveErrors(): SystemState {
    return this.updateSystemState('consecutive_errors = consecutive_errors + 1');
  }

  resetConsecutiveErrors(): SystemState {
    return this.updateSystemState('consecutive_errors = 0');
  }

  logAuditEvent(eventType: string, payload: Record<string, unknown> = {}): AuditEvent {
    const event = { id: randomUUID(), eventType: redactSecrets(eventType), payload: redactSecrets(payload), createdAt: new Date().toISOString() };
    this.db.prepare('INSERT INTO audit_events (id, event_type, payload, created_at) VALUES (?, ?, ?, ?)')
      .run(event.id, event.eventType, JSON.stringify(event.payload), event.createdAt);
    return event;
  }

  listAuditEvents(limit = DEFAULT_LIST_LIMIT): AuditEvent[] {
    return this.db.prepare('SELECT * FROM audit_events ORDER BY created_at DESC, rowid DESC LIMIT ?')
      .all(limit).map(readAuditEvent);
  }

  /** Summarizes order outcomes, inventory profit, and decisions from the preceding 24 hours. */
  getDashboardMetrics(config: ArbitrageConfig, nowIso = new Date().toISOString()): DashboardMetrics {
    const sinceIso = new Date(Date.parse(nowIso) - MILLISECONDS_PER_DAY).toISOString();
    return this.transaction('BEGIN', () => {
      const orders = this.db.prepare(`
        SELECT COUNT(*) FILTER (WHERE status = 'pending_hitl') AS pending,
          COUNT(*) FILTER (WHERE status = 'filled') AS filled,
          COUNT(*) FILTER (WHERE status = 'shadow_recorded') AS shadow
        FROM orders
      `).get();
      const inventory = this.db.prepare(`
        SELECT COALESCE(SUM(predicted_net_profit_cents), 0) AS predicted,
          COALESCE(SUM(realized_profit_cents) FILTER (WHERE status = 'sold'), 0) AS realized,
          COUNT(*) FILTER (WHERE status = 'sold') AS sold
        FROM inventory_items
      `).get();
      const recentDecisions = this.db.prepare(`
        SELECT COUNT(*) AS count FROM decisions WHERE decided_at >= ? AND decided_at <= ?
      `).get(sinceIso, nowIso);

      return {
        systemState: this.getSystemState(),
        portfolio: this.readPortfolioSnapshot(config, nowIso),
        pendingHitlCount: orders?.pending as number,
        totalOrdersFilled: orders?.filled as number,
        shadowOrdersCount: orders?.shadow as number,
        totalPredictedProfitCents: inventory?.predicted as number,
        totalRealizedProfitCents: inventory?.realized as number,
        soldCount: inventory?.sold as number,
        recentDecisionsCount: recentDecisions?.count as number,
      };
    });
  }

  close(): void {
    this.db.close();
  }
}
