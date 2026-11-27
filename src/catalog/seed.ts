import type { ArbitrageDatabase } from '../db/database.ts';
import type { CanonicalSku, CardCondition, SoldComp, SourceName } from '../domain/types.ts';

type CatalogEntry = Omit<CanonicalSku, 'createdAt' | 'updatedAt'> & { fmvCents: number };

const CATALOG: CatalogEntry[] = [
  {
    id: 'sealed-151-bundle',
    name: 'Pokemon TCG: Scarlet & Violet 151 Booster Bundle',
    assetClass: 'sealed', setName: 'Scarlet & Violet 151', setCode: 'SV3pt5',
    upc: '820650853210', msrpCents: 2694, language: 'EN', variant: 'standard', fmvCents: 5500,
    aliases: ['Pokemon 151 Booster Bundle', 'SV 151 6 Pack Booster Bundle', 'SV3pt5 Booster Bundle'],
  },
  {
    id: 'sealed-pre-etb',
    name: 'Pokemon TCG: Prismatic Evolutions Elite Trainer Box',
    assetClass: 'sealed', setName: 'Prismatic Evolutions', setCode: 'SV8pt5',
    upc: '820650859427', msrpCents: 5499, language: 'EN', variant: 'standard', fmvCents: 11500,
    aliases: ['Prismatic Evolutions ETB', 'PRE Elite Trainer Box', 'Prismatic ETB'],
  },
  {
    id: 'sealed-evs-bb',
    name: 'Pokemon TCG: Sword & Shield Evolving Skies Booster Box',
    assetClass: 'sealed', setName: 'Evolving Skies', setCode: 'SWSH07',
    upc: '820650818874', msrpCents: 14364, language: 'EN', variant: 'standard', fmvCents: 85000,
    aliases: ['Evolving Skies Booster Box', 'Evolving Skies Booster Display', 'EVS 36 Pack Booster Box'],
  },
  {
    id: 'sealed-ssp-bb',
    name: 'Pokemon TCG: Scarlet & Violet Surging Sparks Booster Box',
    assetClass: 'sealed', setName: 'Surging Sparks', setCode: 'SV08',
    upc: '820650859120', msrpCents: 16164, language: 'EN', variant: 'standard', fmvCents: 16500,
    aliases: ['Surging Sparks Booster Box', 'Surging Sparks Booster Display', 'SSP 36 Pack Booster Box'],
  },
  {
    id: 'sealed-crz-etb',
    name: 'Pokemon TCG: Crown Zenith Elite Trainer Box',
    assetClass: 'sealed', setName: 'Crown Zenith', setCode: 'CRZ',
    upc: '820650851063', msrpCents: 4999, language: 'EN', variant: 'standard', fmvCents: 6800,
    aliases: ['Crown Zenith ETB', 'CRZ Elite Trainer Box'],
  },
  {
    id: 'graded-psa10-sv3pt5-199',
    name: 'Charizard ex 199/165 SIR - Pokemon 151 (PSA 10)',
    assetClass: 'graded', setName: 'Scarlet & Violet 151', setCode: 'SV3pt5',
    cardNumber: '199/165', language: 'EN', variant: 'sir', grader: 'PSA', grade: '10', fmvCents: 65000,
    aliases: ['PSA 10 Charizard ex 199/165', 'Pokemon 151 Charizard SIR PSA 10'],
  },
  {
    id: 'graded-psa10-swsh07-215',
    name: 'Umbreon VMAX 215/203 Alt Art - Evolving Skies (PSA 10)',
    assetClass: 'graded', setName: 'Evolving Skies', setCode: 'SWSH07',
    cardNumber: '215/203', language: 'EN', variant: 'alt_art', grader: 'PSA', grade: '10', fmvCents: 135000,
    aliases: ['PSA 10 Moonbreon', 'Umbreon VMAX 215/203 PSA 10'],
  },
  {
    id: 'graded-psa10-sv08-238',
    name: 'Pikachu ex 238/191 SIR - Surging Sparks (PSA 10)',
    assetClass: 'graded', setName: 'Surging Sparks', setCode: 'SV08',
    cardNumber: '238/191', language: 'EN', variant: 'sir', grader: 'PSA', grade: '10', fmvCents: 95000,
    aliases: ['Pikachu ex 238/191 PSA 10', 'Surging Sparks Pikachu SIR PSA 10'],
  },
  {
    id: 'graded-cgc10-swsh12-186',
    name: 'Lugia V 186/195 Alt Art - Silver Tempest (CGC 10)',
    assetClass: 'graded', setName: 'Silver Tempest', setCode: 'SWSH12',
    cardNumber: '186/195', language: 'EN', variant: 'alt_art', grader: 'CGC', grade: '10', fmvCents: 42000,
    aliases: ['CGC 10 Lugia V 186/195', 'Silver Tempest Lugia V Alternate Art CGC 10'],
  },
  {
    id: 'graded-psa9-base-4',
    name: 'Charizard 4/102 Holo - Base Set Unlimited (PSA 9)',
    assetClass: 'graded', setName: 'Base Set', setCode: 'BS',
    cardNumber: '4/102', language: 'EN', variant: 'holo', grader: 'PSA', grade: '9', fmvCents: 110000,
    aliases: ['PSA 9 Base Set Unlimited Charizard', 'Charizard 4/102 Unlimited PSA 9'],
  },
  {
    id: 'raw-en-sv3pt5-199',
    name: 'Charizard ex 199/165 SIR - Pokemon 151 (EN)',
    assetClass: 'raw', setName: 'Scarlet & Violet 151', setCode: 'SV3pt5',
    cardNumber: '199/165', language: 'EN', variant: 'sir', fmvCents: 21000,
    aliases: ['Charizard ex 199/165', 'Pokemon 151 Charizard ex SIR', '151 Charizard ex Special Illustration Rare'],
  },
  {
    id: 'raw-jp-sv2a-201',
    name: 'Charizard ex 201/165 SAR - Pokemon Card 151 (JP SV2a)',
    assetClass: 'raw', setName: 'Pokemon Card 151', setCode: 'SV2a',
    cardNumber: '201/165', language: 'JP', variant: 'sir', fmvCents: 12500,
    aliases: ['sv2a 201/165', 'sv2a 199/165', 'sv2a charizard ex', 'japanese charizard ex 151'],
  },
  {
    id: 'raw-en-sv3pt5-004-rh',
    name: 'Charmander 004/165 Reverse Holo - Pokemon 151 (EN)',
    assetClass: 'raw', setName: 'Scarlet & Violet 151', setCode: 'SV3pt5',
    cardNumber: '004/165', language: 'EN', variant: 'reverse_holo', fmvCents: 400,
    aliases: ['Charmander 004/165 Reverse Holo', '151 Reverse Holo Charmander'],
  },
  {
    id: 'raw-en-sv3pt5-006-holo',
    name: 'Charizard ex 006/165 Double Rare Holo - Pokemon 151 (EN)',
    assetClass: 'raw', setName: 'Scarlet & Violet 151', setCode: 'SV3pt5',
    cardNumber: '006/165', language: 'EN', variant: 'holo', fmvCents: 800,
    aliases: ['Charizard ex 006/165', 'Pokemon 151 Charizard ex Double Rare', 'Charizard ex 6/165 Holo'],
  },
  {
    id: 'raw-en-swsh07-215',
    name: 'Umbreon VMAX 215/203 Alt Art - Evolving Skies (EN)',
    assetClass: 'raw', setName: 'Evolving Skies', setCode: 'SWSH07',
    cardNumber: '215/203', language: 'EN', variant: 'alt_art', fmvCents: 98000,
    aliases: ['Moonbreon', 'Umbreon VMAX 215/203', 'Evolving Skies Umbreon VMAX Alternate Art'],
  },
  {
    id: 'raw-en-sv4pt5-232',
    name: 'Mew ex 232/091 SIR (Bubble Mew) - Paldean Fates (EN)',
    assetClass: 'raw', setName: 'Paldean Fates', setCode: 'SV4pt5',
    cardNumber: '232/091', language: 'EN', variant: 'sir', fmvCents: 31000,
    aliases: ['Bubble Mew', 'Paldean Fates Mew ex', 'Mew ex 232/091'],
  },
  {
    id: 'raw-en-sv08-238',
    name: 'Pikachu ex 238/191 SIR - Surging Sparks (EN)',
    assetClass: 'raw', setName: 'Surging Sparks', setCode: 'SV08',
    cardNumber: '238/191', language: 'EN', variant: 'sir', fmvCents: 42000,
    aliases: ['Pikachu ex 238/191', 'Surging Sparks Pikachu SIR'],
  },
  {
    id: 'raw-en-vintage-promo-snap',
    name: 'Pikachu SNAP Photo Contest Promo (Low Liquidity Vintage)',
    assetClass: 'raw', setName: 'Vintage Promos', setCode: 'PROMO',
    cardNumber: 'SNAP-01', language: 'EN', variant: 'promo', fmvCents: 60000,
    aliases: ['Snap Pikachu', 'Pikachu SNAP Photo Contest Promo'],
  },
  {
    id: 'sealed-pre-pc-etb',
    name: 'Pokemon TCG: Prismatic Evolutions Pokemon Center Elite Trainer Box',
    assetClass: 'sealed', setName: 'Prismatic Evolutions', setCode: 'SV8pt5',
    upc: '820650859434', msrpCents: 5999, language: 'EN', variant: 'promo', fmvCents: 23500,
    aliases: ['Prismatic Evolutions Pokemon Center ETB', 'Prismatic Evolutions PC ETB', 'PRE Pokemon Center Elite Trainer Box'],
  },
  {
    id: 'sealed-151-costco-bundle',
    name: 'Pokemon TCG: Scarlet & Violet 151 Mini Tins 5-Pack Costco Bundle',
    assetClass: 'sealed', setName: 'Scarlet & Violet 151', setCode: 'SV3pt5',
    upc: '820650859991', msrpCents: 3799, language: 'EN', variant: 'standard', fmvCents: 9200,
    aliases: ['Pokemon 151 Mini Tins 5-Pack Bundle', 'Costco Pokemon 151 Mini Tins 5 Pack', '151 5-Pack Mini Tin Bundle'],
  },
];

const REGULAR_COMP_AGES = [2, 4, 7, 10, 14, 18, 23, 29, 42, 56];
const PRICE_VARIATIONS_BPS = [-720, 560, -390, 250, -130, 130, -250, 390, -560, 720];
const SHIPPING_CENTS = { sealed: 650, graded: 499, raw: 199 };
const MILLISECONDS_PER_DAY = 86_400_000;

function buildComp(
  entry: CatalogEntry,
  condition: CardCondition,
  suffix: string,
  totalPriceCents: number,
  ageDays: number,
  source: SourceName,
  now: Date,
  isOutlier?: boolean,
): SoldComp {
  const shippingCents = source === 'ebay' ? SHIPPING_CENTS[entry.assetClass] : 0;
  return {
    id: `seed-${entry.id}-${suffix}`,
    skuId: entry.id,
    source,
    soldPriceCents: totalPriceCents - shippingCents,
    shippingCents,
    totalPriceCents,
    condition,
    grader: entry.grader,
    grade: entry.grade,
    soldAt: new Date(now.getTime() - ageDays * MILLISECONDS_PER_DAY).toISOString(),
    isOutlier,
  };
}

function buildSeries(
  entry: CatalogEntry,
  condition: CardCondition,
  centerCents: number,
  ages: number[],
  offset: number,
  now: Date,
): SoldComp[] {
  return ages.map((age, index) => {
    const variation = PRICE_VARIATIONS_BPS[(index + offset) % PRICE_VARIATIONS_BPS.length];
    const totalPriceCents = Math.round(centerCents * (10_000 + variation) / 10_000);
    const rawEnglish = entry.assetClass === 'raw' && entry.language === 'EN';
    const source = rawEnglish && index % 3 === 1 ? 'tcgplayer' : 'ebay';
    return buildComp(entry, condition, `${condition}-${index + 1}`, totalPriceCents, age, source, now);
  });
}

/** Seeds a fixed demo catalog and comparable sales anchored to the first insertion. */
export function seedCanonicalCatalog(
  db: ArbitrageDatabase,
  referenceNow = new Date(),
): { skusSeeded: number; compsSeeded: number } {
  const timestamp = referenceNow.toISOString();
  const comps: SoldComp[] = [];

  for (const [index, entry] of CATALOG.entries()) {
    const { fmvCents, ...sku } = entry;
    db.upsertSku({ ...sku, createdAt: timestamp, updatedAt: timestamp });

    const condition = sku.assetClass === 'sealed' ? 'SEALED' : 'NM';
    const ages = sku.id === 'raw-en-vintage-promo-snap'
      ? [33, 44]
      : REGULAR_COMP_AGES.map(age => age + index % 4);
    comps.push(...buildSeries(entry, condition, fmvCents, ages, index, referenceNow));

    if (sku.id === 'raw-en-sv3pt5-199') {
      comps.push(...buildSeries(entry, 'LP', 14500, [4, 8, 12, 17, 24, 35, 51], 0, referenceNow));
      comps.push(buildComp(entry, 'NM', 'outlier-high', 45000, 6, 'ebay', referenceNow, true));
      comps.push(buildComp(entry, 'NM', 'outlier-low', 8200, 13, 'ebay', referenceNow, true));
    }
    if (sku.id === 'sealed-151-bundle') {
      comps.push(buildComp(entry, 'SEALED', 'outlier-high', 12400, 11, 'ebay', referenceNow, true));
    }
  }

  return { skusSeeded: CATALOG.length, compsSeeded: db.insertSoldComps(comps) };
}
