import type { ArbitrageConfig } from '../config.ts';
import { clamp } from '../domain/money.ts';
import type {
  AssetClass, CanonicalSku, CardCondition, CardLanguage, CardVariant, CertVerificationResult, Grader,
  MatchResult, RawListing, VisionVerificationResult,
} from '../domain/types.ts';
import { PsaHttpCertVerifier } from './certVerifier.ts';
import type { CertVerifier } from './certVerifier.ts';
import { assessRedFlags, evaluateSellerTrust } from './redFlags.ts';
import { HeuristicVisionVerifier } from './visionVerifier.ts';
import type { VisionVerifier } from './visionVerifier.ts';

export interface EntityResolverOptions {
  config: ArbitrageConfig;
  certVerifier?: CertVerifier;
  visionVerifier?: VisionVerifier;
}

const CARD_NUMBER = /\b(?:[a-z]{0,4}\d{1,4}\s*\/\s*[a-z]{0,4}\d{1,4}|(?:snap|svp|swsh|sm|xy|bw|hgss|dp)-\d{1,4})\b/gi;
const GRADING = /\b(PSA|BGS|CGC|SGC)\s*[-:]?\s*(?:(?:gem mint|pristine|mint)\s+)?(10|[1-9])(?:\.(\d+))?(?![\w.]|\s*\/)/gi;
const GRADER = /\b(PSA|BGS|CGC|SGC)\b/i;
const CERT_NUMBER = /\bcert(?:ificate|ification)?\s*(?:(?:no\.?|number)\s*)?[:#]?\s*(\d{7,10})\b/i;

const VARIANTS: [CardVariant, RegExp][] = [
  ['reverse_holo', /\b(?:reverse[\s_-]+(?:holo(?:graphic|foil)?|foil)|rh)\b/i],
  ['staff_stamp', /\bstaff(?:[\s_-]+stamp(?:ed)?)?\b/i],
  ['first_edition', /\b(?:1st|first)[\s_-]*(?:edition|ed)\b/i],
  ['shadowless', /\bshadowless\b/i],
  ['sir', /\b(?:sir|sar|special[\s_-]+(?:illustration|art)[\s_-]+rare)\b/i],
  ['alt_art', /\b(?:alt|alternate)[\s_-]+art\b/i],
  ['promo', /\bpromo(?:tional)?\b/i],
  ['holo', /\b(?:holo(?:graphic|foil)?|double[\s_-]+rare)\b/i],
  ['standard', /\b(?:nonholo|standard(?!\s+(?:shipping|delivery|size)\b))\b/i],
];

const CONDITIONS: [CardCondition, RegExp][] = [
  ['DMG', /\b(?:dmg|damaged)\b/i],
  ['HP', /\b(?:hp|heavy play(?:ed)?|heavily play(?:ed)?)\b/i],
  ['MP', /\b(?:mp|moderate(?:ly)? play(?:ed)?)\b/i],
  ['LP', /\b(?:lp|light(?:ly)? play(?:ed)?)\b/i],
  ['NM', /\b(?:nm|near[\s-]+mint)\b/i],
];

const SEALED_TYPES = [
  ['elite trainer box', /\b(?:elite[\s-]+trainer[\s-]+box(?:es)?|etbs?)\b/gi],
  ['booster bundle', /\bbooster[\s-]+bundles?\b/gi],
  ['booster box', /\bbooster[\s-]+(?:box(?:es)?|displays?)\b/gi],
  ['booster pack', /\bbooster[\s-]+packs?\b/gi],
  ['collection box', /\bcollection[\s-]+box(?:es)?\b/gi],
  ['case', /\b(?:sealed[\s-]+case|case[\s-]+of)\b/gi],
  ['blister', /\bblisters?\b/gi],
  ['tin', /\btins?\b/gi],
  ['deck', /\bdecks?\b/gi],
] as const;

function normalizeCardNumber(number: string): string {
  return number.toLowerCase().replace(/\s/g, '').replace(/\d+/g, digits => String(Number(digits)));
}

function cardNumbers(text: string): string[] {
  return Array.from(text.matchAll(CARD_NUMBER), ([number]) => normalizeCardNumber(number));
}

function words(text: string): string[] {
  return text.normalize('NFKD').toLowerCase().replace(/\p{M}/gu, '').match(/[\p{L}\p{N}]+/gu) ?? [];
}

function includesPhrase(text: string, phrase: string): boolean {
  return text.includes(` ${words(phrase).join(' ')} `);
}

function productTypes(text: string): string[] {
  return SEALED_TYPES.filter(([, pattern]) => [...text.matchAll(pattern)].length > 0).map(([kind]) => kind);
}

function sealedWords(text: string): string[] {
  for (const [kind, pattern] of SEALED_TYPES) text = text.replace(pattern, kind);
  return words(text).filter(word => !/^(?:pokemon|tcg|scarlet|violet|sword|shield|and|the)$/.test(word));
}

function scoreSealed(title: string, kinds: string[], upc: string | undefined, sku: CanonicalSku): number {
  if (upc) return sku.upc === upc ? 0.97 : 0;
  const expectedKinds = productTypes([sku.name, ...sku.aliases].join(' '));
  if (kinds.length && !kinds.every(kind => expectedKinds.includes(kind))) return 0;
  if (!kinds.length) return 0;

  const tokens = new Set(sealedWords(title));
  const matches = [sku.name, ...sku.aliases].some(name => {
    const nameTokens = sealedWords(name);
    return nameTokens.length >= 3 && nameTokens.every(token => tokens.has(token));
  });
  return matches ? 0.92 : 0;
}

function cardLabel(sku: CanonicalSku): string {
  return sku.name.split(CARD_NUMBER)[0].trim();
}

function listingNumbersMatch(
  numbers: string[], text: string, sku: CanonicalSku,
): boolean {
  if (!numbers.length || !sku.cardNumber) return true;

  const canonical = normalizeCardNumber(sku.cardNumber);
  // A numbered alias is set-specific evidence, so the listing must also identify that set.
  const aliasNumbers = includesPhrase(text, sku.setCode)
    ? sku.aliases.filter(alias => includesPhrase(` ${words(alias).join(' ')} `, sku.setCode)).flatMap(cardNumbers)
    : [];
  return numbers.every(number => number === canonical || aliasNumbers.includes(number));
}

function scoreCard(
  text: string, numbers: string[], variant: CardVariant | undefined, sku: CanonicalSku,
): number {
  if (variant && sku.variant !== variant) return 0;
  if (!listingNumbersMatch(numbers, text, sku)) return 0;

  const labelWords = words(cardLabel(sku));
  const aliasMatch = sku.aliases.some(alias => includesPhrase(text, alias));
  const nameMatch = Boolean(labelWords[0] && text.includes(` ${labelWords[0]} `));
  if (!aliasMatch && !nameMatch) return 0;

  const printedSet = sku.name.split(' - ')[1]?.split(' (')[0];
  const setMatch = [sku.setName, sku.setCode, printedSet].some(set => set && includesPhrase(text, set));
  if (numbers.length && sku.cardNumber) {
    return numbers.includes(normalizeCardNumber(sku.cardNumber)) ? 0.96 : 0.94;
  }
  if (aliasMatch) return 0.91;
  if (setMatch) return variant ? 0.89 : 0.84;
  return 0;
}

function certContradictsSku(title: string, sku: CanonicalSku): boolean {
  const text = ` ${words(title).join(' ')} `;
  const label = words(cardLabel(sku))[0];
  if (label && !text.includes(` ${label} `) && !sku.aliases.some(alias => includesPhrase(text, alias))) return true;

  if (sku.cardNumber) {
    const canonical = normalizeCardNumber(sku.cardNumber);
    const fullNumbers = cardNumbers(title);
    if (fullNumbers.some(number => number !== canonical)) return true;
    const shortNumber = title.match(/#\s*([a-z]{0,4}\d{1,4})\b/i)?.[1];
    if (!fullNumbers.length && shortNumber && normalizeCardNumber(shortNumber) !== canonical.split('/')[0]) return true;
  }

  return false;
}

function parseVariant(text: string): CardVariant | undefined {
  // Preserve the specific print marker when a title also mentions its foil finish.
  const withoutNonHolo = text.replace(/\bnon[\s_-]*holo(?:graphic|foil)?\b/gi, ' nonholo ');
  return VARIANTS.find(([, pattern]) => pattern.test(withoutNonHolo))?.[0];
}

export class EntityResolver {
  private readonly config: ArbitrageConfig;
  private readonly certVerifier: CertVerifier;
  private readonly visionVerifier: VisionVerifier;

  constructor({ config, certVerifier = new PsaHttpCertVerifier(), visionVerifier = new HeuristicVisionVerifier() }: EntityResolverOptions) {
    this.config = config;
    this.certVerifier = certVerifier;
    this.visionVerifier = visionVerifier;
  }

  async resolve(listing: RawListing, catalogSkus: CanonicalSku[]): Promise<MatchResult> {
    const redFlags = assessRedFlags(listing);
    const sellerTrust = evaluateSellerTrust(listing.seller, this.config);
    const language = redFlags.detectedLanguage ?? 'EN';
    const result = {
      confidence: 0, redFlags: redFlags.flags, blockingRedFlags: redFlags.blockingFlags,
      sellerTrust, matchedLanguage: language,
    };
    if (!redFlags.passed) {
      return {
        ...result, status: 'rejected',
        reasons: redFlags.blockingFlags.map(flag => `Blocking listing red flag: ${flag}`),
      };
    }

    const title = listing.title.normalize('NFKC');
    const description = listing.description.normalize('NFKC');
    const text = `${title} ${description}`;
    const normalizedText = ` ${words(text).join(' ')} `;
    const numbers = cardNumbers(text);
    const variant = parseVariant(text);
    const grading = Array.from(text.matchAll(GRADING), ([, grader, whole, decimal]) => ({
      grader: grader.toUpperCase() as Grader,
      grade: String(Number(decimal ? `${whole}.${decimal}` : whole)),
    }));
    const mentionedGrader = text.match(GRADER)?.[1]?.toUpperCase() as Grader | undefined;
    const grader = grading[0]?.grader ?? listing.graderHint ?? mentionedGrader;
    const gradeHint = listing.gradeHint?.trim();
    const grade = grading[0]?.grade ?? (gradeHint && String(Number(gradeHint)));
    const certNumber = listing.certNumber?.trim() || text.match(CERT_NUMBER)?.[1];
    const upc = listing.upc?.trim();
    const titleKinds = productTypes(title);
    const kinds = titleKinds.length ? titleKinds : productTypes(description);
    const hasGrading = Boolean(grader || grade || certNumber
      || /\b(?:graded|slabbed|slab)\b/i.test(text.replace(/\b(?:not|never)\s+graded\b/gi, '')));

    if (grading.some(signal => signal.grader !== grader || signal.grade !== grade)
      || (listing.graderHint && listing.graderHint !== grader)
      || (gradeHint && Number(gradeHint) !== Number(grade))) {
      return { ...result, status: 'unmatched', reasons: ['Listing contains conflicting grader or grade information'] };
    }

    let assetClass: AssetClass = 'raw';
    if (hasGrading) assetClass = 'graded';
    else if ((upc && catalogSkus.some(sku => sku.assetClass === 'sealed' && sku.upc === upc))
      || listing.conditionHint === 'SEALED' || (kinds.length && !numbers.length)) assetClass = 'sealed';
    const condition = assetClass === 'sealed' ? 'SEALED'
      : CONDITIONS.find(([value, pattern]) => value === listing.conditionHint || pattern.test(text))?.[0] ?? 'NM';

    const candidates = catalogSkus.filter(sku =>
      sku.assetClass === assetClass && sku.language === language
      && (assetClass !== 'graded' || (grader && grade && sku.grader === grader && Number(sku.grade) === Number(grade))),
    ).map(sku => ({
      sku,
      score: assetClass === 'sealed'
        ? scoreSealed(`${title} ${description}`, kinds, upc, sku)
        : scoreCard(normalizedText, numbers, variant, sku),
    })).filter(candidate => candidate.score > 0).sort((a, b) => b.score - a.score);

    const best = candidates[0];
    if (!best) {
      return { ...result, status: 'unmatched', reasons: [`No compatible ${language} ${assetClass} catalog SKU`] };
    }
    if (best.score === candidates[1]?.score) {
      return { ...result, status: 'unmatched', confidence: best.score, reasons: ['Multiple catalog SKUs match equally well'] };
    }

    const { sku } = best;
    let confidence = best.score;
    const reasons = [assetClass === 'sealed' && upc ? 'Exact sealed UPC match' : 'Compatible catalog title and listing details'];
    const candidate = {
      ...result, skuId: sku.id, canonicalSku: sku, matchedCondition: condition,
      matchedGrader: sku.grader, matchedGrade: sku.grade, matchedVariant: sku.variant,
    };

    let certVerification: CertVerificationResult | undefined;
    if (assetClass === 'graded' && sku.grader) {
      if (!certNumber) {
        const reason = 'No cert number provided';
        certVerification = { checked: false, valid: false, grader: sku.grader, reason };
        reasons.push(reason);
        confidence = Math.min(confidence, 0.85);
      } else {
        certVerification = await this.certVerifier.verify(sku.grader, certNumber);
        let rejection: string | undefined;
        if (!certVerification.checked || !certVerification.valid) {
          rejection = certVerification.reason ?? 'Certificate verification did not confirm a valid certificate';
        } else if ((certVerification.grader && certVerification.grader !== sku.grader)
          || (certVerification.certNumber && certVerification.certNumber !== certNumber)) {
          rejection = 'Verified certificate grader or number differs from the listing';
        } else if (certVerification.verifiedGrade !== sku.grade) {
          rejection = `Certificate grade mismatch: verified ${certVerification.verifiedGrade ?? 'unknown'}, expected ${sku.grade}`;
        } else if (certVerification.verifiedTitle && certContradictsSku(certVerification.verifiedTitle, sku)) {
          rejection = `Certificate title contradicts the matched card: ${certVerification.verifiedTitle}`;
        }
        if (rejection) return { ...candidate, status: 'rejected', certVerification, reasons: [rejection] };
        reasons.push('Certificate verified');
      }
    }

    let visionVerification: VisionVerificationResult | undefined;
    if ((assetClass === 'raw' && listing.priceCents >= 10_000) || confidence < 0.90) {
      visionVerification = await this.visionVerifier.verify(listing, sku);
      confidence = clamp(confidence + visionVerification.confidenceAdjustment, 0, 1);
      if (certVerification && !certVerification.valid) confidence = Math.min(confidence, 0.85);
      reasons.push(...visionVerification.notes);
    }

    if (confidence < 0.70) {
      reasons.push('Match confidence fell below 0.70');
      return { ...result, status: 'unmatched', confidence, certVerification, visionVerification, reasons };
    }
    return { ...candidate, status: 'matched', confidence, certVerification, visionVerification, reasons };
  }
}
