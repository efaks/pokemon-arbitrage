import { createHash } from 'node:crypto';
import { createConfig } from '../config.ts';
import type { ArbitrageConfig } from '../config.ts';
import type { ArbitrageDatabase } from '../db/database.ts';
import { toCents } from '../domain/money.ts';
import { CardCondition, Grader, SourceName } from '../domain/types.ts';
import type { SoldComp } from '../domain/types.ts';
import type { BuyBook } from '../engine/buyBook.ts';
import { FmvEngine } from '../valuation/fmvEngine.ts';

export interface ImportCompInput {
  id?: string;
  skuId: string;
  source: SourceName;
  soldPriceCents: number;
  shippingCents?: number;
  condition?: CardCondition;
  grader?: Grader;
  grade?: string;
  soldAt: string;
}

export interface ImportCompsResult {
  received: number;
  inserted: number;
  duplicatesSkipped: number;
  rejected: number;
  errors: string[];
}

function csvRows(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let closedQuote = false;
  const finishField = () => {
    row.push(field.trim());
    field = '';
    closedQuote = false;
  };
  for (let index = 0; index < input.length; index++) {
    const char = input[index];
    if (quoted) {
      if (char === '"' && input[index + 1] === '"') {
        field += char;
        index++;
      } else if (char === '"') {
        quoted = false;
        closedQuote = true;
      } else {
        field += char;
      }
    } else if (char === ',') {
      finishField();
    } else if (char === '\r' || char === '\n') {
      if (char === '\r' && input[index + 1] === '\n') index++;
      finishField();
      if (row.length > 1 || row[0]) rows.push(row);
      row = [];
    } else if (char === '"' && !closedQuote && !field.trim()) {
      field = '';
      quoted = true;
    } else if (char === '"' || (closedQuote && char.trim())) {
      throw new SyntaxError('Unexpected character in sold comps CSV quoted field');
    } else {
      field += char;
    }
  }
  if (quoted) throw new SyntaxError('Unterminated quote in sold comps CSV');
  finishField();
  if (row.length > 1 || row[0]) rows.push(row);
  return rows;
}

export function parseSoldCompsCsv(csvText: string): ImportCompInput[] {
  const [header, ...rows] = csvRows(csvText.replace(/^\uFEFF/, ''));
  if (!header) return [];
  const columns = new Set(header);
  if (columns.size !== header.length || !['skuId', 'source', 'soldAt'].every(key => columns.has(key)) ||
      !['soldPriceCents', 'soldPriceUsd'].some(key => columns.has(key))) {
    throw new SyntaxError('Sold comps CSV requires unique headers including skuId, source, soldAt, and soldPriceCents or soldPriceUsd');
  }
  const amount = (cents?: string, usd?: string) => {
    if (cents) return /^-?\d+$/.test(cents) ? Number(cents) : NaN;
    if (usd) return /^-?(?:\d+(?:\.\d+)?|\.\d+)$/.test(usd) ? toCents(Number(usd)) : NaN;
  };
  return rows.map((row, index) => {
    if (row.length > header.length) throw new SyntaxError(`CSV row ${index + 2} has more values than headers`);
    const [skuId, source, soldPriceCents, soldPriceUsd, shippingCents, shippingUsd, condition, grader, grade, soldAt, id] =
      ['skuId', 'source', 'soldPriceCents', 'soldPriceUsd', 'shippingCents', 'shippingUsd', 'condition', 'grader', 'grade', 'soldAt', 'id']
        .map(key => row[header.indexOf(key)] || undefined);
    return {
      skuId: skuId ?? '', source: source as SourceName, soldAt: soldAt ?? '', id,
      soldPriceCents: amount(soldPriceCents, soldPriceUsd) ?? NaN,
      shippingCents: amount(shippingCents, shippingUsd), condition: condition as CardCondition | undefined,
      grader: grader as Grader | undefined, grade,
    };
  });
}

function isoTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return;
  const day = value.slice(0, 10);
  const date = new Date(`${day}T00:00:00Z`);
  const timestamp = Date.parse(value);
  if (Number.isFinite(timestamp) && date.toISOString().startsWith(day)) return new Date(timestamp).toISOString();
}

function validatedComp(db: ArbitrageDatabase, input: ImportCompInput): SoldComp {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Expected a sold comp object');
  const sku = typeof input.skuId === 'string' ? db.getSku(input.skuId.trim()) : undefined;
  if (!sku) throw new Error('Unknown skuId');
  const { source, soldPriceCents } = input;
  const shippingCents = input.shippingCents === undefined ? 0 : input.shippingCents;
  const condition = input.condition === undefined ? (sku.assetClass === 'sealed' ? 'SEALED' : 'NM') : input.condition;
  const grader = input.grader === undefined ? sku.grader : input.grader;
  const grade = input.grade === undefined ? sku.grade : input.grade;
  if (!Object.values(SourceName).includes(source)) throw new Error('Invalid source');
  if (!Object.values(CardCondition).includes(condition)) throw new Error('Invalid condition');
  if (grader !== undefined && !Object.values(Grader).includes(grader)) throw new Error('Invalid grader');
  if (grade !== undefined && (typeof grade !== 'string' || !grade.trim())) throw new Error('Invalid grade');
  if (input.id !== undefined && typeof input.id !== 'string') throw new Error('Invalid id');
  if (!Number.isSafeInteger(soldPriceCents) || soldPriceCents <= 0) throw new Error('soldPriceCents must be a positive integer');
  if (!Number.isSafeInteger(shippingCents) || shippingCents < 0) throw new Error('shippingCents must be a nonnegative integer');
  const totalPriceCents = soldPriceCents + shippingCents;
  if (!Number.isSafeInteger(totalPriceCents)) throw new Error('Total price exceeds the safe integer limit');
  const soldAt = isoTimestamp(input.soldAt);
  if (!soldAt) throw new Error('soldAt must be an ISO 8601 timestamp with a timezone');
  const id = input.id?.trim() || 'imported-' + createHash('sha256')
    .update(JSON.stringify([sku.id, source, soldPriceCents, shippingCents, condition, grader, grade, soldAt]))
    .digest('hex').slice(0, 24);
  return { id, skuId: sku.id, source, soldPriceCents, shippingCents, totalPriceCents, condition, grader, grade, soldAt };
}

export function importSoldComps(
  db: ArbitrageDatabase, inputs: readonly ImportCompInput[],
  options: { buyBook?: BuyBook; fmvEngine?: FmvEngine; config?: ArbitrageConfig; nowIso?: string } = {},
): ImportCompsResult {
  const { buyBook, fmvEngine, config, nowIso } = options;
  const valid: SoldComp[] = [];
  const errors: string[] = [];
  for (const [index, input] of inputs.entries()) {
    try {
      valid.push(validatedComp(db, input));
    } catch (error) {
      errors.push(`Row ${index + 1}: ${error instanceof Error ? error.message : 'Invalid sold comp'}`);
    }
  }
  const inserted = valid.length ? db.insertSoldComps(valid) : 0;
  const result = {
    received: inputs.length, inserted, duplicatesSkipped: valid.length - inserted, rejected: errors.length, errors,
  };
  db.logAuditEvent('market.comps_imported', result);
  buyBook?.refresh(db, fmvEngine ?? new FmvEngine(), config ?? createConfig(), nowIso);
  return result;
}
