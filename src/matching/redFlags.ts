import type { ArbitrageConfig } from '../config.ts';
import { clamp } from '../domain/money.ts';
import type { CardLanguage, RawListing, RedFlagAssessment, SellerProfile, SellerTrustResult } from '../domain/types.ts';

const BLOCKING_FLAGS = [
  'proxy', 'custom card', 'custom art', 'fan art', 'orica', 'metal card', 'gold metal',
  'silver metal', 'gold foil', 'replica', 'repro', 'bootleg', 'homemade',
  'digital', 'code card', 'ptcg live', 'ptcgl', 'ptcgo', 'online code',
  'empty box', 'empty display', 'box only', 'empty tin', 'tin only', 'acrylic case only',
  'case only', 'display box only', 'wrapper only', 'empty pack',
  'jumbo', 'oversized', 'world championship',
  'damaged', 'creased', 'heavy play', 'hp', 'bent', 'water damage',
  'mystery pack', 'mystery box', 'mystery', 'repack', 'resealed', 'bulk lot', 'lot of',
];
const WARNING_FLAGS = ['read description', 'no returns', 'stock photo', 'unsearched'];

const FLAG_PATTERNS = [...BLOCKING_FLAGS, ...WARNING_FLAGS].map(flag => ({
  flag,
  pattern: flag === 'heavy play'
    ? /\bheav(?:y|ily)[\s_-]+play(?:ed)?\b/i
    : new RegExp('\\b' + flag.replaceAll(' ', '[\\s_-]+') + '\\b', 'i'),
  blocking: BLOCKING_FLAGS.includes(flag),
}));

export function detectLanguage(text: string, hint?: CardLanguage): CardLanguage {
  if (/\b(?:korean|kr)\b/i.test(text)) return 'KR';
  if (/\b(?:chinese|cn)\b/i.test(text)) return 'CN';
  if (/\b(?:japanese|jpn|jp|sv2a|s12a|sv4a|sar)\b|[\u3040-\u30ff]/i.test(text)) return 'JP';
  if (/\b(?:english|en)\b/i.test(text)) return 'EN';
  if (/[\u4e00-\u9faf]/u.test(text)) return hint === 'CN' || hint === 'KR' ? hint : 'JP';
  return hint ?? 'EN';
}

export function assessRedFlags(listing: RawListing): RedFlagAssessment {
  const title = listing.title.normalize('NFKC');
  const description = listing.description.normalize('NFKC');
  const detected = FLAG_PATTERNS.filter(({ pattern }) => pattern.test(title) || pattern.test(description));
  const blockingFlags = detected.filter(({ blocking }) => blocking).map(({ flag }) => flag);

  return {
    passed: blockingFlags.length === 0,
    flags: detected.map(({ flag }) => flag),
    blockingFlags,
    detectedLanguage: detectLanguage(`${title} ${description}`, listing.languageHint),
  };
}

export function evaluateSellerTrust(seller: SellerProfile, config: ArbitrageConfig): SellerTrustResult {
  const checks = [
    { value: seller.feedbackScore, minimum: config.sellerMinFeedback, label: 'Feedback score' },
    { value: seller.positivePercent, minimum: config.sellerMinPositivePercent, label: 'Positive feedback percent' },
  ];
  if (seller.accountAgeUnknown !== true) {
    checks.push({ value: seller.accountAgeDays, minimum: config.sellerMinAccountAgeDays, label: 'Account age in days' });
  }
  const reasons: string[] = [];
  const scores = checks.map(({ value, minimum, label }) => {
    if (Number.isFinite(value) && value >= minimum) return 1;
    reasons.push(`${label} ${value} is below the required minimum of ${minimum}`);
    return Number.isFinite(value) && minimum > 0 ? clamp(value / minimum, 0, 1) : 0;
  });
  const trusted = reasons.length === 0;
  if (!seller.returnsAccepted) reasons.push('Seller does not accept returns');
  scores.push(Number(seller.returnsAccepted));

  return { trusted, score: scores.reduce((sum, score) => sum + score, 0) / scores.length, reasons };
}
