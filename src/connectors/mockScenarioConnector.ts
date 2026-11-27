import type { CanonicalSku, RawListing } from '../domain/types.ts';
import type { SupplyConnector } from './base.ts';

type Scenario = Pick<RawListing, 'listingId' | 'title' | 'priceCents'> & Partial<RawListing>;
const timestamp = '2026-11-26T12:00:00.000Z';

const scenarios: Scenario[] = [
  {
    listingId: 'mock-ssp-bb-clean',
    title: 'Pokemon TCG Scarlet & Violet Surging Sparks Booster Box Factory Sealed',
    upc: '820650859120', priceCents: 9500, conditionHint: 'SEALED',
  },
  {
    listingId: 'mock-lugia-cgc10-clean',
    title: 'CGC 10 Lugia V 186/195 Alt Art Silver Tempest Cert 4318920001',
    certNumber: '4318920001', graderHint: 'CGC', gradeHint: '10', priceCents: 28500, shippingCents: 500,
  },
  {
    listingId: 'mock-pre-etb-retailer',
    title: 'Pokemon TCG Prismatic Evolutions Elite Trainer Box - Best Buy Drop',
    upc: '820650859427', priceCents: 5499, conditionHint: 'SEALED', supportsAutoCheckout: false,
    seller: {
      sellerId: 'mock-bestbuy', username: 'Best Buy', feedbackScore: 12300, positivePercent: 99.8,
      accountAgeDays: 3200, returnsAccepted: true,
    },
  },
  {
    listingId: 'mock-moonbreon-psa10-highcap',
    title: 'PSA 10 Umbreon VMAX 215/203 Alt Art Evolving Skies Cert 90123456',
    certNumber: '90123456', graderHint: 'PSA', gradeHint: '10', priceCents: 82000,
  },
  {
    listingId: 'mock-zard-raw-nm',
    title: 'Pokemon 151 Charizard ex 199/165 SIR Near Mint', conditionHint: 'NM', priceCents: 13000,
    imageUrls: [
      'https://images.example.test/mock-zard-raw-nm/front.jpg',
      'https://images.example.test/mock-zard-raw-nm/back.jpg',
    ],
  },
  {
    listingId: 'mock-evs-bb-anomaly',
    title: 'Sword & Shield Evolving Skies Booster Box Sealed',
    upc: '820650818874', priceCents: 21000, conditionHint: 'SEALED',
  },
  {
    listingId: 'mock-zard-cert-mismatch',
    title: 'PSA 10 Charizard ex 199/165 SIR Pokemon 151 Slab',
    certNumber: '90999888', graderHint: 'PSA', gradeHint: '10', priceCents: 42000,
  },
  {
    listingId: 'mock-zard-proxy-trap',
    title: 'Charizard ex 199/165 Gold Metal Custom Proxy Fan Art Card', priceCents: 4500,
  },
  {
    listingId: 'mock-evs-empty-box',
    title: 'Evolving Skies Booster Box EMPTY Display Box Only No Packs', upc: '820650818874', priceCents: 3000,
  },
  {
    listingId: 'mock-zard-jp-sv2a',
    title: 'Pokemon Card 151 SV2a Japanese Charizard ex 201/165 SAR NM',
    languageHint: 'JP', conditionHint: 'NM', priceCents: 11500,
  },
  {
    listingId: 'mock-zard-006-holo',
    title: 'Pokemon 151 Charizard ex 006/165 Double Rare Holo NM', conditionHint: 'NM', priceCents: 2500,
  },
  {
    listingId: 'mock-crz-sketchy-seller',
    title: 'Crown Zenith Elite Trainer Box Sealed', upc: '820650851063', priceCents: 3500,
    conditionHint: 'SEALED',
    seller: {
      sellerId: 'mock-new-seller', username: 'newcarddeals26', feedbackScore: 4, positivePercent: 82,
      accountAgeDays: 5, returnsAccepted: false,
    },
  },
  {
    listingId: 'mock-snap-illiquid',
    title: 'Pikachu SNAP Photo Contest Promo SNAP-01 NM', conditionHint: 'NM', priceCents: 35000,
  },
  {
    listingId: 'mock-151-thin-margin',
    title: 'Pokemon 151 Booster Bundle Sealed', upc: '820650853210', priceCents: 4200, conditionHint: 'SEALED',
  },
  {
    listingId: 'mock-digital-code-trap',
    title: 'Pokemon 151 Charizard ex 199/165 PTCG Live Digital Code Card', priceCents: 1000,
  },
];

export class MockScenarioConnector implements SupplyConnector {
  readonly name = 'Mock Scenario Feed';
  readonly source = 'mock_feed';
  readonly supportsAutoCheckout = true;
  readonly pollIntervalMs = 60_000;

  isEnabled(): boolean {
    return true;
  }

  async fetchListings(_skus: CanonicalSku[]): Promise<RawListing[]> {
    return scenarios.map(scenario => ({
      source: this.source,
      description: scenario.title,
      url: `https://listings.example.test/${scenario.listingId}`,
      shippingCents: 0,
      quantity: 1,
      currency: 'USD',
      supportsAutoCheckout: true,
      languageHint: 'EN',
      listedAt: timestamp,
      fetchedAt: timestamp,
      ...scenario,
      imageUrls: [...(scenario.imageUrls ?? [`https://images.example.test/${scenario.listingId}/front.jpg`])],
      seller: scenario.seller ? { ...scenario.seller } : {
        sellerId: 'mock-trusted-seller', username: 'collectorsvault', feedbackScore: 840, positivePercent: 99.7,
        accountAgeDays: 1200, returnsAccepted: true,
      },
    }));
  }
}
