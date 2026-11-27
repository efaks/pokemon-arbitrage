import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { seedCanonicalCatalog } from '../src/catalog/seed.ts';
import { createConfig } from '../src/config.ts';
import { ArbitrageDatabase } from '../src/db/database.ts';
import type { CanonicalSku, RawListing, SellerProfile } from '../src/domain/types.ts';
import { MockCertVerifier, PsaHttpCertVerifier } from '../src/matching/certVerifier.ts';
import { EntityResolver } from '../src/matching/entityResolver.ts';
import { assessRedFlags, detectLanguage, evaluateSellerTrust } from '../src/matching/redFlags.ts';
import { HeuristicVisionVerifier, OpenAICompatibleVisionVerifier } from '../src/matching/visionVerifier.ts';

const NOW = '2026-11-26T12:00:00.000Z';
const db = new ArbitrageDatabase(':memory:');
seedCanonicalCatalog(db, new Date(NOW));
const catalog = db.listSkus();
after(() => db.close());

const config = createConfig({ sellerMinFeedback: 50, sellerMinPositivePercent: 98.5, sellerMinAccountAgeDays: 90 });
const resolver = new EntityResolver({ config, certVerifier: new MockCertVerifier() });
const trustedSeller: SellerProfile = {
  sellerId: 'seller-1', username: 'cardshop', feedbackScore: 500,
  positivePercent: 99.7, accountAgeDays: 500, returnsAccepted: true,
};

function listing(title: string, overrides: Partial<RawListing> = {}): RawListing {
  return {
    listingId: 'listing-1', source: 'mock_feed', title, description: '',
    url: 'https://market.example.test/listing-1', priceCents: 9_999, shippingCents: 0, quantity: 1,
    currency: 'USD', imageUrls: ['https://images.example.test/front.jpg'], seller: trustedSeller,
    supportsAutoCheckout: false, listedAt: NOW, fetchedAt: NOW, ...overrides,
  };
}

function sku(id: string): CanonicalSku {
  const found = catalog.find(entry => entry.id === id);
  assert.ok(found);
  return found;
}

for (const [id, upc] of [
  ['sealed-151-bundle', '820650853210'],
  ['sealed-ssp-bb', '820650859120'],
]) {
  test(`matches ${id} by exact UPC`, async () => {
    const match = await resolver.resolve(listing('Pokemon Trading Card Game', { upc, source: 'bestbuy' }), catalog);
    assert.equal(match.status, 'matched');
    assert.equal(match.skuId, id);
    assert.equal(match.matchedCondition, 'SEALED');
    assert.equal(match.confidence, 0.97);
  });
}

test('matches an ETB or booster display alias while enforcing product type', async () => {
  const etb = await resolver.resolve(listing('Prismatic Evolutions Pokémon ETB Factory Sealed'), catalog);
  assert.equal(etb.skuId, 'sealed-pre-etb');
  const display = await resolver.resolve(listing('Pokemon Evolving Skies Booster Display'), catalog);
  assert.equal(display.skuId, 'sealed-evs-bb');
  const wrongProduct = await resolver.resolve(listing('Prismatic Evolutions Booster Bundle'), catalog);
  assert.equal(wrongProduct.status, 'unmatched');
});

test('separates Pokémon Center and regular Prismatic Evolutions ETBs with and without UPCs', async () => {
  const regular = sku('sealed-pre-etb');
  const exclusive = sku('sealed-pre-pc-etb');
  for (const [title, expected, other] of [
    ['Prismatic Evolutions Pokémon Center Elite Trainer Box', exclusive, regular],
    ['Prismatic Evolutions PC ETB', exclusive, regular],
    ['Prismatic Evolutions Elite Trainer Box', regular, exclusive],
  ] as const) {
    const byTitle = await resolver.resolve(listing(title), catalog);
    assert.equal(byTitle.skuId, expected.id);
    assert.equal(byTitle.confidence, 0.92);
    const byUpc = await resolver.resolve(listing(title, { upc: expected.upc }), catalog);
    assert.equal(byUpc.skuId, expected.id);
    assert.equal(byUpc.confidence, 0.97);
    assert.equal((await resolver.resolve(listing(title), [other])).status, 'unmatched');
    assert.equal((await resolver.resolve(listing(title, { upc: other.upc }), catalog)).status, 'unmatched');
  }
});

test('matches the Costco 151 five-pack by title without treating it as a single tin or booster bundle', async () => {
  const bundle = sku('sealed-151-costco-bundle');
  for (const title of [
    'Pokemon TCG Scarlet & Violet 151 Mini Tins 5-Pack Costco Bundle',
    'Costco Pokemon 151 Mini Tins 5 Pack',
    '151 5-Pack Mini Tin Bundle',
  ]) {
    assert.equal((await resolver.resolve(listing(title), catalog)).skuId, bundle.id);
  }
  assert.equal((await resolver.resolve(listing('Pokemon Scarlet & Violet 151 Mini Tin'), catalog)).status, 'unmatched');
  assert.equal((await resolver.resolve(listing('Pokemon 151 Booster Bundle'), catalog)).skuId, 'sealed-151-bundle');
});

for (const [title, flag, upc] of [
  ['Evolving Skies Booster Box EMPTY Display Box Only', 'empty display', '820650818874'],
  ['Charizard ex 199/165 Gold Metal Custom Proxy', 'gold metal'],
  ['PTCG Live Digital Code Card', 'code card'],
]) {
  test(`rejects ${flag} trap before matching`, async () => {
    const result = await resolver.resolve(listing(title, { upc }), catalog);
    assert.equal(result.status, 'rejected');
    assert.equal(result.confidence, 0);
    assert.ok(result.blockingRedFlags.includes(flag));
    assert.ok(result.reasons.some(reason => reason.includes(flag)));
    assert.equal(result.sellerTrust.trusted, true);
  });
}

test('checks descriptions and respects word boundaries and non-blocking warnings', () => {
  const result = assessRedFlags(listing('Undamaged Charizard Ex', {
    description: 'Read description. Stock photo. No returns. Unsearched.',
  }));
  assert.deepEqual(result.flags, ['read description', 'no returns', 'stock photo', 'unsearched']);
  assert.deepEqual(result.blockingFlags, []);
  assert.ok(result.passed);
  const repack = assessRedFlags(listing('Pokémon', { description: 'Mystery-pack, resealed by seller.' }));
  assert.ok(repack.blockingFlags.includes('mystery pack'));
  assert.ok(repack.blockingFlags.includes('resealed'));
  assert.ok(assessRedFlags(listing('Heavily played Charizard')).blockingFlags.includes('heavy play'));
});

test('detects explicit languages and preserves an uncontradicted hint', () => {
  assert.equal(detectLanguage('Japanese Charizard', 'EN'), 'JP');
  assert.equal(detectLanguage('リザードン'), 'JP');
  assert.equal(detectLanguage('Traditional Chinese 噴火龍'), 'CN');
  assert.equal(detectLanguage('噴火龍', 'CN'), 'CN');
  assert.equal(detectLanguage('Korean Charizard', 'JP'), 'KR');
  assert.equal(detectLanguage('Charizard ex', 'KR'), 'KR');
  assert.equal(detectLanguage('Charizard ex'), 'EN');
});

test('separates zero-padded Double Rare Holo, reverse holo, and SIR', async () => {
  const doubleRare = await resolver.resolve(listing('Pokemon 151 Charizard ex 6/165 Double Rare Holo LP'), catalog);
  assert.equal(doubleRare.skuId, 'raw-en-sv3pt5-006-holo');
  assert.equal(doubleRare.matchedCondition, 'LP');
  assert.equal(doubleRare.matchedVariant, 'holo');

  const reverse = await resolver.resolve(listing('Charmander 4/165 Reverse Holo'), catalog);
  assert.equal(reverse.skuId, 'raw-en-sv3pt5-004-rh');
  assert.equal(reverse.matchedVariant, 'reverse_holo');

  for (const title of ['Charizard ex 199/165 Reverse Holo', 'Charizard ex 006/165 SIR']) {
    const conflicting = await resolver.resolve(listing(title), catalog);
    assert.equal(conflicting.status, 'unmatched');
    assert.equal(conflicting.skuId, undefined);
  }
});

test('maps Japanese canonical and set-qualified alternate card numbers to the Japanese SKU', async () => {
  for (const title of ['SV2a Japanese Charizard ex 201/165 SAR', 'SV2a Japanese Charizard ex 199/165']) {
    const jp = await resolver.resolve(listing(title), catalog);
    assert.equal(jp.skuId, 'raw-jp-sv2a-201');
    assert.equal(jp.matchedLanguage, 'JP');
  }
  assert.equal((await resolver.resolve(listing('Japanese Charizard ex 199/165'), catalog)).status, 'unmatched');
  const en = await resolver.resolve(listing('English Pokemon 151 Charizard ex 199/165'), catalog);
  assert.equal(en.skuId, 'raw-en-sv3pt5-199');
});

test('parses alphanumeric promo number and condition hint', async () => {
  const promo = await resolver.resolve(listing('Pikachu SNAP-01 Near Mint', { conditionHint: 'MP' }), catalog);
  assert.equal(promo.skuId, 'raw-en-vintage-promo-snap');
  assert.equal(promo.matchedCondition, 'MP');
});

test('keeps raw and graded identities apart using text and structured hints', async () => {
  const raw = listing('Umbreon VMAX 215/203 Alt Art');
  const graded = { ...raw, graderHint: 'PSA' as const, gradeHint: '10' };
  const describedSlab = { ...raw, description: 'Professionally graded and slabbed.' };
  assert.equal((await resolver.resolve(raw, catalog.filter(entry => entry.assetClass === 'graded'))).status, 'unmatched');
  assert.equal((await resolver.resolve(graded, catalog.filter(entry => entry.assetClass === 'raw'))).status, 'unmatched');
  assert.equal((await resolver.resolve(describedSlab, catalog)).status, 'unmatched');
  const pending = await resolver.resolve(graded, catalog);
  assert.equal(pending.skuId, 'graded-psa10-swsh07-215');
  assert.equal(pending.status, 'matched');
  assert.equal(pending.certVerification?.reason, 'No cert number provided');
  assert.equal(pending.certVerification?.checked, false);
  assert.ok(pending.confidence <= 0.85);
});

for (const [title, id, grader, number] of [
  ['CGC 10 Lugia V 186/195 Alt Art Cert #4318920001', 'graded-cgc10-swsh12-186', 'CGC', '4318920001'],
  ['Umbreon VMAX 215/203 PSA 10 Cert No. 90123456', 'graded-psa10-swsh07-215', 'PSA', '90123456'],
]) {
  test(`verifies ${grader} 10 cert ${number}`, async () => {
    const result = await resolver.resolve(listing(title), catalog);
    assert.equal(result.status, 'matched');
    assert.equal(result.skuId, id);
    assert.equal(result.matchedGrader, grader);
    assert.equal(result.matchedGrade, '10');
    assert.equal(result.certVerification?.valid, true);
    assert.equal(result.certVerification?.certNumber, number);
  });
}

for (const [number, reasonPattern] of [
  ['90999888', /grade mismatch.*verified 8/],
  ['00000000', /not found/],
  ['90123456', /title contradicts/],
  ['4318920001', /grader mismatch/],
] as const) {
  test(`rejects incompatible cert ${number}`, async () => {
    const result = await resolver.resolve(listing('PSA 10 Charizard ex 199/165 SIR', { certNumber: number }), catalog);
    assert.equal(result.status, 'rejected');
    assert.match(result.reasons.join(' '), reasonPattern);
  });
}

test('rejects a certificate for the same card name with a different number', async () => {
  const certVerifier = new MockCertVerifier({
    '99999999': { checked: true, valid: true, verifiedGrade: '10', verifiedTitle: 'Charizard ex #006 Pokemon 151' },
  });
  const customResolver = new EntityResolver({ config, certVerifier });
  const result = await customResolver.resolve(listing('PSA 10 Charizard ex 199/165 Cert 99999999'), catalog);
  assert.equal(result.status, 'rejected');
  assert.match(result.reasons.join(' '), /title contradicts/);
  assert.equal((await certVerifier.verify('PSA', '12345678')).reason, 'Certificate not found in mock registry');
});

test('evaluates seller thresholds and notes no returns separately', () => {
  const trusted = evaluateSellerTrust(trustedSeller, config);
  assert.deepEqual(trusted, { trusted: true, score: 1, reasons: [] });
  const untrusted = evaluateSellerTrust({
    ...trustedSeller, feedbackScore: 10, positivePercent: 96, accountAgeDays: 20, returnsAccepted: false,
  }, config);
  assert.equal(untrusted.trusted, false);
  assert.ok(untrusted.score >= 0 && untrusted.score < 1);
  assert.equal(untrusted.reasons.length, 4);
  const noReturns = evaluateSellerTrust({ ...trustedSeller, returnsAccepted: false }, config);
  assert.equal(noReturns.trusted, true);
  assert.deepEqual(noReturns.reasons, ['Seller does not accept returns']);
});

test('applies photo adjustments for high-value or borderline raw listings', async () => {
  const expensive = listing('Pokémon 151 Charizard ex 199/165 SIR', { priceCents: 10_000, imageUrls: [] });
  const noPhotos = await resolver.resolve(expensive, catalog);
  assert.equal(noPhotos.visionVerification?.verified, false);
  assert.equal(noPhotos.visionVerification?.confidenceAdjustment, -0.12);
  assert.ok(noPhotos.confidence < 0.90);

  const twoPhotos = await resolver.resolve({ ...expensive, imageUrls: [
    'https://images.example.test/front.jpg', 'https://images.example.test/back.jpg',
  ] }, catalog);
  assert.equal(twoPhotos.visionVerification?.verified, true);
  assert.equal(twoPhotos.visionVerification?.confidenceAdjustment, 0.02);

  const borderline = await resolver.resolve(listing('Charizard ex SIR from Pokemon 151', {
    imageUrls: ['https://images.example.test/placeholder.png'],
  }), catalog);
  assert.equal(borderline.skuId, 'raw-en-sv3pt5-199');
  assert.equal(borderline.visionVerification?.verified, false);
  assert.ok(borderline.visionVerification!.confidenceAdjustment < 0);
});

test('leaves single official sealed images neutral in the photo heuristic', async () => {
  const verifier = new HeuristicVisionVerifier();
  const result = await verifier.verify(listing('151 Booster Bundle', {
    imageUrls: ['https://images.example.test/default-product.png'],
  }), sku('sealed-151-bundle'));
  assert.equal(result.verified, true);
  assert.equal(result.confidenceAdjustment, 0);
});

test('PSA HTTP adapter validates the certificate payload and handles lookup failures', async () => {
  const cert = new PsaHttpCertVerifier('test-token', async (input, init) => {
    assert.equal(String(input), 'https://api.psacard.com/publicapi/cert/GetByCertNumber/90111222');
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer test-token');
    return Response.json({
      IsValidRequest: true, PSACert: {
        CertNumber: '90111222', CardGrade: 'GEM MT 10', CardNumber: '199',
        Subject: 'Charizard ex', Brand: 'Pokemon 151',
      },
    });
  });
  assert.deepEqual(await cert.verify('PSA', '90111222'), {
    checked: true, valid: true, grader: 'PSA', certNumber: '90111222',
    verifiedGrade: '10', verifiedTitle: 'Charizard ex #199 Pokemon 151',
  });
  assert.equal((await cert.verify('CGC', '90111222')).checked, false);
  assert.equal((await new PsaHttpCertVerifier('').verify('PSA', '90111222')).checked, false);
  const unavailable = new PsaHttpCertVerifier('test-token', async () => new Response(null, { status: 503 }));
  assert.match((await unavailable.verify('PSA', '90111222')).reason ?? '', /503/);
  const offline = new PsaHttpCertVerifier('test-token', async () => { throw new Error('Network unavailable'); });
  assert.equal((await offline.verify('PSA', '90111222')).valid, false);
});

test('vision adapter sends image inputs and handles unconfigured or malformed assessments', async () => {
  const expectedSku = sku('raw-en-sv3pt5-199');
  const sample = listing(expectedSku.name);
  let sent: unknown;
  const configured = new OpenAICompatibleVisionVerifier({
    apiKey: 'test-key', apiUrl: 'https://vision.example.test/v1', model: 'test-model',
    fetchFn: async (url, init) => {
      assert.equal(String(url), 'https://vision.example.test/v1/chat/completions');
      sent = JSON.parse(String(init?.body));
      return Response.json({ choices: [{ message: { content: JSON.stringify({
        verified: true, confidenceAdjustment: 0.04, notes: ['Visible number matches'],
      }) } }] });
    },
  });
  assert.deepEqual(await configured.verify(sample, expectedSku), {
    checked: true, verified: true, confidenceAdjustment: 0.04, notes: ['Visible number matches'],
  });
  assert.match(JSON.stringify(sent), /test-model/);
  assert.match(JSON.stringify(sent), /image_url/);
  assert.match(JSON.stringify(sent), /front\.jpg/);

  const unconfigured = new OpenAICompatibleVisionVerifier({ apiKey: '', apiUrl: '' });
  assert.deepEqual(await unconfigured.verify(sample, expectedSku), {
    checked: false, verified: true, confidenceAdjustment: 0, notes: ['Vision API unconfigured; skipped'],
  });
  const malformed = new OpenAICompatibleVisionVerifier({
    apiKey: 'test-key', apiUrl: 'https://vision.example.test/v1/chat/completions',
    fetchFn: async () => Response.json({ choices: [{ message: { content: '{}' } }] }),
  });
  assert.equal((await malformed.verify(sample, expectedSku)).checked, false);
});
