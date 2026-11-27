export const SECRET_ENV_KEYS: ReadonlySet<string> = new Set([
  'EBAY_CLIENT_SECRET', 'EBAY_REFRESH_TOKEN', 'EBAY_SELL_REFRESH_TOKEN', 'EBAY_ACCESS_TOKEN',
  'EBAY_ORDER_API_TOKEN', 'EBAY_SELL_API_TOKEN', 'PRICECHARTING_API_TOKEN', 'POKEMON_TCG_API_KEY',
  'BESTBUY_API_KEY', 'COSTCO_API_KEY', 'POKEMON_CENTER_API_KEY', 'TCGPLAYER_API_TOKEN',
  'PSA_API_TOKEN', 'VISION_API_KEY', 'ARBITRAGE_WEBHOOK_URL',
]);

const knownSecrets = new Set<string>();
export const secretMask = '[redacted]';

export function rememberSecret(value?: string | null): void {
  if (value) knownSecrets.add(value);
  if (value?.trim()) knownSecrets.add(value.trim());
}

export function rememberConfiguredSecrets(): void {
  for (const key of SECRET_ENV_KEYS) rememberSecret(process.env[key]);
}

export function redactSecrets<T>(data: T): T {
  rememberConfiguredSecrets();
  if (!knownSecrets.size) return data;
  const secrets = [...knownSecrets].sort((a, b) => b.length - a.length);
  const pattern = new RegExp(secrets.map(secret => secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
  const cleanText = (value: string) => value.replace(pattern, secretMask);
  const clean = (value: unknown): unknown => {
    if (typeof value === 'string') return cleanText(value);
    if (Array.isArray(value)) return value.map(clean);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, field]) => [cleanText(key), clean(field)]));
    }
    return value;
  };
  return clean(data) as T;
}
