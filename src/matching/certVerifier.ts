import type { CertVerificationResult, Grader } from '../domain/types.ts';

export interface CertVerifier {
  verify(grader: Grader, certNumber: string): Promise<CertVerificationResult>;
}

function mockRecord(
  grader: Grader, certNumber: string, verifiedGrade: string, verifiedTitle: string,
): CertVerificationResult {
  return { checked: true, valid: true, grader, certNumber, verifiedGrade, verifiedTitle };
}

const MOCK_REGISTRY = {
  '4318920001': mockRecord('CGC', '4318920001', '10', 'Lugia V 186/195 Alt Art - Silver Tempest'),
  '90123456': mockRecord('PSA', '90123456', '10', 'Umbreon VMAX 215/203 Alt Art - Evolving Skies'),
  '90111222': mockRecord('PSA', '90111222', '10', 'Charizard ex 199/165 SIR - Pokemon 151'),
  '90222333': mockRecord('PSA', '90222333', '10', 'Pikachu ex 238/191 SIR - Surging Sparks'),
  '90333444': mockRecord('PSA', '90333444', '9', 'Charizard 4/102 Holo - Base Set Unlimited'),
  '90999888': mockRecord('PSA', '90999888', '8', 'Charizard ex 199/165 SIR - Pokemon 151'),
  '00000000': {
    checked: true, valid: false, grader: 'PSA', certNumber: '00000000',
    reason: 'Certificate number not found in registry',
  },
} satisfies Record<string, CertVerificationResult>;

export class MockCertVerifier implements CertVerifier {
  private readonly registry: Map<string, CertVerificationResult>;

  constructor(overrides: Record<string, CertVerificationResult> = {}) {
    this.registry = new Map(Object.entries({ ...MOCK_REGISTRY, ...overrides }));
  }

  async verify(grader: Grader, certNumber: string): Promise<CertVerificationResult> {
    const cert = this.registry.get(certNumber);
    const invalid = { checked: true, valid: false, grader, certNumber };
    if (!cert) return { ...invalid, reason: 'Certificate not found in mock registry' };
    if (cert.grader && cert.grader !== grader) {
      return { ...invalid, reason: `Certificate grader mismatch: registered with ${cert.grader}, requested ${grader}` };
    }
    return { grader, certNumber, ...cert };
  }
}

interface PsaResponse {
  IsValidRequest?: boolean;
  ServerMessage?: string;
  PSACert?: {
    CertNumber?: string;
    CardGrade?: string;
    GradeDescription?: string;
    Subject?: string;
    CardNumber?: string;
    Variety?: string;
    Brand?: string;
  };
}

export class PsaHttpCertVerifier implements CertVerifier {
  private readonly token?: string;
  private readonly fetchFn: typeof fetch;

  constructor(token?: string, fetchFn: typeof fetch = fetch) {
    this.token = (token ?? process.env.PSA_API_TOKEN)?.trim();
    this.fetchFn = fetchFn;
  }

  async verify(grader: Grader, certNumber: string): Promise<CertVerificationResult> {
    const unchecked = { checked: false, valid: false, grader, certNumber };
    if (grader !== 'PSA') return { ...unchecked, reason: 'PSA API only verifies PSA certificates' };
    if (!this.token) return { ...unchecked, reason: 'PSA_API_TOKEN is missing' };
    const invalid = { ...unchecked, checked: true };
    if (!/^\d+$/.test(certNumber)) return { ...invalid, reason: 'PSA certificate number must contain only digits' };

    try {
      const response = await this.fetchFn(
        `https://api.psacard.com/publicapi/cert/GetByCertNumber/${encodeURIComponent(certNumber)}`,
        {
          headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/json' },
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (response.status === 404) return { ...invalid, reason: 'Certificate number not found in registry' };
      if (!response.ok || response.status === 204) {
        return { ...unchecked, reason: `PSA API returned HTTP ${response.status}` };
      }

      const data = await response.json() as PsaResponse | null;
      const cert = data?.PSACert;
      if (!cert || data?.IsValidRequest === false) {
        return { ...invalid, reason: data?.ServerMessage || 'PSA API returned no card certificate' };
      }
      if (cert.CertNumber !== certNumber) {
        return { ...invalid, reason: 'PSA API returned a different certificate number' };
      }

      const gradeText = cert.CardGrade || cert.GradeDescription || '';
      const verifiedGrade = gradeText.trim().match(/\b(10|[1-9])(?:\.5)?$/)?.[0];
      if (!verifiedGrade || !cert.Subject?.trim()) {
        return { ...invalid, reason: 'PSA certificate is missing a usable card grade or subject' };
      }
      const cardNumber = cert.CardNumber ? `#${cert.CardNumber.replace(/^#\s*/, '')}` : '';
      const verifiedTitle = [cert.Subject, cardNumber, cert.Variety, cert.Brand].filter(Boolean).join(' ');
      return { ...invalid, valid: true, verifiedGrade, verifiedTitle };
    } catch {
      return { ...unchecked, reason: 'PSA certificate lookup failed' };
    }
  }
}
