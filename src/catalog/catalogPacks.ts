import type { ArbitrageDatabase } from '../db/database.ts';
import type { CanonicalSku, CardLanguage, CardVariant, Grader } from '../domain/types.ts';
import { seedStarterSkus } from './seed.ts';

export type CatalogPackName = 'starter' | 'expanded_sealed' | 'expanded_slabs' | 'expanded_raw' | 'all_curated';

export interface CatalogInstallResult {
  pack: CatalogPackName;
  skusUpserted: number;
  totalCatalogSkus: number;
}

type CatalogSku = Omit<CanonicalSku, 'createdAt' | 'updatedAt'>;
type Expansion = readonly [setName: string, setCode: string];

function sealed(
  id: string, [setName, setCode]: Expansion, name: string, aliases: string[], upc?: string,
): CatalogSku {
  return { id: `sealed-${id}`, name, assetClass: 'sealed', setName, setCode, upc, aliases, language: 'EN', variant: 'standard' };
}

const battleStyles = ['Battle Styles', 'SWSH05'] as const;
const chillingReign = ['Chilling Reign', 'SWSH06'] as const;
const evolvingSkies = ['Evolving Skies', 'SWSH07'] as const;
const fusionStrike = ['Fusion Strike', 'SWSH08'] as const;
const brilliantStars = ['Brilliant Stars', 'SWSH09'] as const;
const lostOrigin = ['Lost Origin', 'SWSH11'] as const;
const silverTempest = ['Silver Tempest', 'SWSH12'] as const;
const crownZenith = ['Crown Zenith', 'CRZ'] as const;
const paldeaEvolved = ['Paldea Evolved', 'SV02'] as const;
const pokemon151 = ['Scarlet & Violet 151', 'SV3pt5'] as const;
const paldeanFates = ['Paldean Fates', 'SV4pt5'] as const;
const twilightMasquerade = ['Twilight Masquerade', 'SV06'] as const;
const surgingSparks = ['Surging Sparks', 'SV08'] as const;
const prismaticEvolutions = ['Prismatic Evolutions', 'SV8pt5'] as const;
const megaEvolution = ['Mega Evolution', 'MEG'] as const;
const phantasmalFlames = ['Phantasmal Flames', 'PFL'] as const;
const teamUp = ['Team Up', 'SM9'] as const;
const baseSet = ['Base Set', 'BS'] as const;

// Retailer SKUs and marketplace product IDs are omitted from the UPC field.
const expandedSealed: CatalogSku[] = [
  sealed('bst-bb', battleStyles, 'Battle Styles Booster Box', ['Battle Styles Booster Display', 'BST 36 Pack Booster Box']),
  sealed('cre-bb', chillingReign, 'Chilling Reign Booster Box', ['Chilling Reign Booster Display', 'CRE 36 Pack Booster Box']),
  sealed('fst-bb', fusionStrike, 'Fusion Strike Booster Box', ['Fusion Strike Booster Display', 'FST 36 Pack Booster Box']),
  sealed('brs-bb', brilliantStars, 'Brilliant Stars Booster Box', ['Brilliant Stars Booster Display', 'BRS 36 Pack Booster Box']),
  sealed('lor-bb', lostOrigin, 'Lost Origin Booster Box', ['Lost Origin Booster Display', 'LOR 36 Pack Booster Box']),
  sealed('sit-bb', silverTempest, 'Silver Tempest Booster Box', ['Silver Tempest Booster Display', 'SIT 36 Pack Booster Box']),
  sealed('crz-bundle', crownZenith, 'Crown Zenith Booster Bundle', ['Crown Zenith 6 Pack Booster Bundle', 'CRZ Booster Bundle'], '820650858963'),
  sealed('pal-bb', paldeaEvolved, 'Paldea Evolved Booster Box', ['Paldea Evolved Booster Display', 'PAL 36 Pack Booster Box'], '820650863493'),
  sealed('twm-bb', twilightMasquerade, 'Twilight Masquerade Booster Box', ['Twilight Masquerade Booster Display', 'TWM 36 Pack Booster Box'], '820650867743'),
  sealed('151-etb', pokemon151, 'Scarlet & Violet 151 Elite Trainer Box', ['Pokemon 151 ETB', '151 Snorlax Elite Trainer Box'], '820650853159'),
  sealed('151-pc-etb', pokemon151, 'Scarlet & Violet 151 Pokemon Center Elite Trainer Box', ['Pokemon 151 PC ETB', 'Pokemon Center 151 Elite Trainer Box']),
  sealed('151-upc', pokemon151, 'Scarlet & Violet 151 Ultra-Premium Collection', ['Pokemon 151 UPC', '151 Mew Ultra Premium Collection'], '820650875410'),
  sealed('paf-etb', paldeanFates, 'Paldean Fates Elite Trainer Box', ['Paldean Fates ETB', 'PAF Mimikyu ETB'], '820650856181'),
  sealed('paf-bundle', paldeanFates, 'Paldean Fates Booster Bundle', ['Paldean Fates 6 Pack Booster Bundle', 'PAF Booster Bundle'], '820650856174'),
  sealed('paf-costco-bundle', paldeanFates, 'Paldean Fates Mini Tins 5-Pack Costco Bundle', ['Costco Paldean Fates 5 Pack Mini Tins', 'Paldean Fates 5-Pack Mini Tin Bundle']),
  sealed('ssp-etb', surgingSparks, 'Surging Sparks Elite Trainer Box', ['Surging Sparks ETB', 'SSP Magneton Elite Trainer Box'], '820650859526'),
  sealed('ssp-pc-etb', surgingSparks, 'Surging Sparks Pokemon Center Elite Trainer Box', ['Surging Sparks PC ETB', 'Pokemon Center Surging Sparks ETB']),
  sealed('pre-bundle', prismaticEvolutions, 'Prismatic Evolutions Booster Bundle', ['Prismatic Evolutions 6 Pack Booster Bundle', 'PRE Booster Bundle'], '196214112544'),
  sealed('meg-bb', megaEvolution, 'Mega Evolution Booster Box', ['Mega Evolution Booster Display', 'MEG 36 Pack Booster Box'], '196214136120'),
  sealed('meg-bundle', megaEvolution, 'Mega Evolution Booster Bundle', ['Mega Evolution 6 Pack Booster Bundle', 'MEG Booster Bundle'], '196214115545'),
  sealed('pfl-bundle', phantasmalFlames, 'Phantasmal Flames Booster Bundle', ['Phantasmal Flames 6 Pack Booster Bundle', 'PFL Booster Bundle'], '196214143371'),
  sealed('pfl-charizard-upc', phantasmalFlames, 'Mega Charizard X ex Ultra-Premium Collection', ['Mega Charizard X ex UPC', 'Phantasmal Flames Charizard Ultra Premium Collection'], '196214130685'),
  sealed('hif-etb', ['Hidden Fates', 'HIF'], 'Hidden Fates Elite Trainer Box', ['Hidden Fates ETB', 'HIF Elite Trainer Box'], '820650824739'),
  sealed('team-up-etb', teamUp, 'Sun & Moon Team Up Elite Trainer Box', ['Team Up ETB', 'Sun & Moon Team Up ETB'], '820650824982'),
  sealed('evo-bb', ['Evolutions', 'EVO'], 'XY Evolutions Booster Box', ['XY Evolutions Booster Display', 'XY12 36 Pack Booster Box']),
];

interface CardPrint {
  label: string;
  expansion: Expansion;
  number: string;
  variant: CardVariant;
  language: CardLanguage;
  nickname?: string;
}

function card(
  label: string, expansion: Expansion, number: string, variant: CardVariant,
  language: CardLanguage = 'EN', nickname?: string,
): CardPrint {
  return { label, expansion, number, variant, language, nickname };
}

const variantLabels: Partial<Record<CardVariant, string>> = {
  holo: 'Holo', first_edition: '1st Edition Holo', alt_art: 'Alt Art', sir: 'SIR', promo: 'Promo',
};

function single(print: CardPrint, grading?: readonly [grader: Grader, grade: string]): CatalogSku {
  const { label, expansion: [setName, setCode], number, variant, language, nickname } = print;
  const [grader, grade] = grading ?? [];
  const gradeLabel = grading?.join(' ');
  const variantLabel = language === 'JP' && variant === 'sir' ? 'SAR' : variantLabels[variant];
  const product = [label, number, variantLabel].filter(Boolean).join(' ');
  const languageLabel = language === 'JP' ? 'Japanese' : undefined;
  const qualifier = [gradeLabel, languageLabel].filter(Boolean).join(' ');
  const key = [setCode.toLowerCase().replaceAll(':', '-'), number.split('/')[0].toLowerCase()].join('-');
  const suffix = variant === 'first_edition' ? '-1st' : '';
  return {
    id: grading ? `graded-${grader!.toLowerCase()}${grade!.replace('.', '')}-${key}${suffix}`
      : `raw-${language.toLowerCase()}-${key}${suffix}`,
    name: `${product} - ${setName}${qualifier ? ` (${qualifier})` : ''}`,
    assetClass: grading ? 'graded' : 'raw', setName, setCode, cardNumber: number, language, variant, grader, grade,
    aliases: [
      [label, number, qualifier].filter(Boolean).join(' '),
      [setName, label, variantLabel, qualifier].filter(Boolean).join(' '),
      ...(nickname ? [[nickname, qualifier].filter(Boolean).join(' ')] : []),
    ],
  };
}

const rayquaza = card('Rayquaza VMAX', evolvingSkies, '218/203', 'alt_art');
const gengar = card('Gengar VMAX', fusionStrike, '271/264', 'alt_art');
const espeon = card('Espeon VMAX', fusionStrike, '270/264', 'alt_art');
const giratina = card('Giratina V', lostOrigin, '186/196', 'alt_art');
const lugia = card('Lugia V', silverTempest, '186/195', 'alt_art');
const blaziken = card('Blaziken VMAX', chillingReign, '201/198', 'alt_art');
const latiasAndLatios = card('Latias & Latios-GX', teamUp, '170/181', 'alt_art');
const gengarAndMimikyu = card('Gengar & Mimikyu-GX', teamUp, '165/181', 'alt_art');
const greninja = card('Greninja ex', twilightMasquerade, '214/167', 'sir');
const magikarp = card('Magikarp', paldeaEvolved, '203/193', 'holo', 'EN', 'Paldea Evolved Magikarp Illustration Rare');
const venusaur = card('Venusaur ex', pokemon151, '198/165', 'sir');
const blastoise = card('Blastoise ex', pokemon151, '200/165', 'sir');
const shinyCharizard = card('Charizard ex', paldeanFates, '234/091', 'sir');
const umbreon = card('Umbreon ex', prismaticEvolutions, '161/131', 'sir');
const latias = card('Latias ex', surgingSparks, '239/191', 'sir');
const baseCharizard = card('Charizard', baseSet, '4/102', 'holo', 'EN', 'Base Set Unlimited Charizard');
const japanese151 = ['Pokemon Card 151', 'SV2a'] as const;
const vstarUniverse = ['VSTAR Universe', 'S12a'] as const;
const japaneseUmbreon = card('Umbreon VMAX', ['Eevee Heroes', 'S6a'], '095/069', 'alt_art', 'JP');
const japaneseMew = card('Mew ex', ['Shiny Treasure ex', 'SV4a'], '347/190', 'sir', 'JP', 'Bubble Mew');
const japaneseGiratina = card('Giratina VSTAR', vstarUniverse, '261/172', 'sir', 'JP');

const expandedRaw = [
  rayquaza, gengar, espeon, giratina, lugia, blaziken, latiasAndLatios, gengarAndMimikyu, greninja, magikarp,
  venusaur, blastoise, shinyCharizard, umbreon, latias, baseCharizard,
  japaneseUmbreon, japaneseMew, japaneseGiratina,
  card('Erika\'s Invitation', japanese151, '206/165', 'sir', 'JP'),
  card('Venusaur ex', japanese151, '200/165', 'sir', 'JP'),
  card('Blastoise ex', japanese151, '202/165', 'sir', 'JP'),
  card('Arceus VSTAR', vstarUniverse, '262/172', 'sir', 'JP'),
  card('Mewtwo VSTAR', vstarUniverse, '221/172', 'sir', 'JP'),
  card('Iono', ['Clay Burst', 'SV2D'], '096/071', 'sir', 'JP'),
].map(print => single(print));

const expandedSlabs = [
  single(rayquaza, ['PSA', '10']),
  single(gengar, ['PSA', '10']),
  single(giratina, ['PSA', '10']),
  single(lugia, ['PSA', '10']),
  single(lugia, ['BGS', '9.5']),
  single(blaziken, ['CGC', '10']),
  single(latiasAndLatios, ['PSA', '10']),
  single(gengarAndMimikyu, ['PSA', '9']),
  single(greninja, ['PSA', '10']),
  single(magikarp, ['PSA', '10']),
  single(venusaur, ['PSA', '10']),
  single(blastoise, ['PSA', '10']),
  single(shinyCharizard, ['PSA', '10']),
  single(umbreon, ['PSA', '10']),
  single(japaneseUmbreon, ['PSA', '10']),
  single(japaneseMew, ['CGC', '10']),
  single(japaneseGiratina, ['PSA', '10']),
  single(card('Mewtwo VSTAR', ['Crown Zenith Galarian Gallery', 'CRZ:GG'], 'GG44/GG70', 'alt_art'), ['PSA', '10']),
  single(card('Blastoise', baseSet, '2/102', 'holo', 'EN', 'Base Set Unlimited Blastoise'), ['PSA', '9']),
  single(card('Venusaur', baseSet, '15/102', 'holo', 'EN', 'Base Set Unlimited Venusaur'), ['PSA', '9']),
  single(card('Lugia', ['Neo Genesis', 'N1'], '9/111', 'first_edition'), ['PSA', '9']),
  single(card('Shining Charizard', ['Neo Destiny', 'N4'], '107/105', 'holo'), ['PSA', '9']),
  single(card('Shining Mewtwo', ['Neo Destiny', 'N4'], '109/105', 'holo'), ['PSA', '9']),
  single(card('Rayquaza Gold Star', ['EX Deoxys', 'DX'], '107/107', 'holo'), ['PSA', '9']),
  single(card('Umbreon Gold Star', ['POP Series 5', 'POP5'], '17/17', 'standard'), ['PSA', '9']),
];

type ExpandedPack = Exclude<CatalogPackName, 'starter' | 'all_curated'>;
const expandedPacks: Record<ExpandedPack, CatalogSku[]> = {
  expanded_sealed: expandedSealed, expanded_slabs: expandedSlabs, expanded_raw: expandedRaw,
};
const allExpanded = Object.values(expandedPacks).flat();
const starterCount = 20;

export function listCatalogPacks(): { name: CatalogPackName; count: number; description: string }[] {
  return [
    { name: 'starter', count: starterCount, description: 'Starter catalog' },
    { name: 'expanded_sealed', count: expandedSealed.length, description: 'Booster displays, trainer boxes, bundles, and premium collections' },
    { name: 'expanded_slabs', count: expandedSlabs.length, description: 'Modern chase cards and vintage staples in graded slabs' },
    { name: 'expanded_raw', count: expandedRaw.length, description: 'English and Japanese chase singles' },
    { name: 'all_curated', count: starterCount + allExpanded.length, description: 'Starter catalog and all three expansion packs' },
  ];
}

export function installCatalogPack(db: ArbitrageDatabase, pack: CatalogPackName, referenceNow = new Date()): CatalogInstallResult {
  return db.withWriteTransaction(() => {
    const timestamp = referenceNow.toISOString();
    const skus = pack === 'starter' ? [] : pack === 'all_curated' ? allExpanded : expandedPacks[pack];
    if (!skus) throw new RangeError(`Unknown catalog pack: ${pack}`);
    const starterUpserts = pack === 'starter' || pack === 'all_curated' ? seedStarterSkus(db, referenceNow).skusSeeded : 0;
    for (const sku of skus) {
      const existing = db.getSku(sku.id);
      db.upsertSku({ ...sku, referenceImageUrl: existing?.referenceImageUrl ?? sku.referenceImageUrl, createdAt: timestamp, updatedAt: timestamp });
    }
    return { pack, skusUpserted: starterUpserts + skus.length, totalCatalogSkus: db.listSkus().length };
  });
}
