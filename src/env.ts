import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export type LoadEnvResult = { loaded: boolean; path: string; keysLoaded: number };

// Only values introduced by the loader are replaceable during reload. Preserve launch overrides.
const fileValues = new Map<string, string>();
export const envAssignment = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;
export const encodedEnvMarker = '# arbitrage-escaped';
const escapedValue = /^("(?:[^"\\]|\\.)*")\s+# arbitrage-escaped(?=\s|$)\s*(#.*)?\s*$/;
const quotedValue = /^(["'])(.*?)\1\s*(#.*)?\s*$/;
const unquotedValue = /^(.*?)\s*(#.*)?$/;

function parseEnvValue(raw: string): { value?: string; comment?: string } {
  const escaped = escapedValue.exec(raw);
  if (escaped) {
    try {
      return { value: JSON.parse(escaped[1]) as string, comment: escaped[2] };
    } catch {
      return {};
    }
  }
  if (raw.startsWith('"') || raw.startsWith("'")) {
    const quoted = quotedValue.exec(raw);
    return { value: quoted?.[2], comment: quoted?.[3] };
  }
  const plain = unquotedValue.exec(raw);
  return { value: plain?.[1], comment: plain?.[2] };
}

export function envValueComment(raw: string): string | undefined {
  return parseEnvValue(raw).comment;
}

export function readEnvFile(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
    return undefined;
  }
}

export function loadProjectEnv(envPath = '.env', { reload = false } = {}): LoadEnvResult {
  const path = resolve(envPath);
  if (process.env.ARBITRAGE_SKIP_DOTENV === '1') return { loaded: false, path, keysLoaded: 0 };
  const contents = readEnvFile(path);
  if (reload) {
    for (const [key, value] of fileValues) {
      if (process.env[key] === value) delete process.env[key];
    }
    fileValues.clear();
  }
  let keysLoaded = 0;
  for (const line of contents?.split(/\r?\n/) ?? []) {
    const assignment = envAssignment.exec(line);
    if (!assignment) continue;
    const [, key, raw] = assignment;
    if (process.env[key] !== undefined) continue;

    const { value } = parseEnvValue(raw);
    if (value === undefined || /[\r\n\0]/.test(value)) continue;
    process.env[key] = value;
    fileValues.set(key, value);
    keysLoaded++;
  }
  return { loaded: contents !== undefined, path, keysLoaded };
}

export function applyEnvUpdate(key: string, value: string | null): void {
  if (value === null) {
    delete process.env[key];
    fileValues.delete(key);
  } else {
    process.env[key] = value;
    fileValues.set(key, value);
  }
}
