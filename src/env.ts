import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export type LoadEnvResult = { loaded: boolean; path: string; keysLoaded: number };

export function loadProjectEnv(envPath = '.env'): LoadEnvResult {
  const path = resolve(envPath);
  const missing = { loaded: false, path, keysLoaded: 0 };
  if (process.env.ARBITRAGE_SKIP_DOTENV === '1') return missing;

  let contents: string;
  try {
    contents = readFileSync(path, 'utf8');
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException;
    if (code === 'ENOENT' || code === 'ENOTDIR') return missing;
    throw error;
  }

  let keysLoaded = 0;
  for (const line of contents.split(/\r?\n/)) {
    const assignment = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line.trim());
    if (!assignment) continue;
    const [, key, raw] = assignment;
    if (Object.hasOwn(process.env, key) && process.env[key] !== undefined) continue;

    let value: string;
    if (raw.startsWith('"') || raw.startsWith("'")) {
      const quoted = /^(["'])(.*?)\1\s*(?:#.*)?$/.exec(raw);
      if (!quoted) continue;
      value = quoted[2];
    } else {
      value = raw.split('#', 1)[0].trimEnd();
    }
    process.env[key] = value;
    keysLoaded++;
  }
  return { loaded: true, path, keysLoaded };
}
