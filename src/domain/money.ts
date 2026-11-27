const MILLISECONDS_PER_DAY = 86_400_000;

const usdFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
});

/** Formats integer USD cents for display. */
export function formatUsd(cents: number): string {
  return usdFormatter.format(cents / 100);
}

/** Converts a dollar amount at an input boundary to integer USD cents. */
export function toCents(dollars: number): number {
  return Math.round(dollars * 100);
}

export function percentOfCents(cents: number, rate: number): number {
  return Math.round(cents * rate);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Returns the absolute elapsed time in days, including fractional days. */
export function daysBetween(isoA: string, isoB: string): number {
  return Math.abs(ageInDays(isoA, isoB));
}

/** Returns signed elapsed days from the first timestamp to the second. */
export function ageInDays(fromIso: string, toIso: string): number {
  return (Date.parse(toIso) - Date.parse(fromIso)) / MILLISECONDS_PER_DAY;
}
