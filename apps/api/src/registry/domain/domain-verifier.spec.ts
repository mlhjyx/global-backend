import { describe, expect, it } from 'vitest';
import {
  MultiRouteDomainResolver,
  type DomainSearchProvider,
} from './domain-resolver';
import {
  extractRegisterEvidence,
  toDomainResolutionDrafts,
  verifyDomainCandidate,
  verifyDomainCandidates,
  type LegalPageText,
  type VatValidator,
  type VerifierEntity,
} from './domain-verifier';

// ── 夹具：法律页文本（全部为虚构样例） ─────────────────────────────────────

const DE_IMPRESSUM_MATCH = `Muster Pumpen GmbH
Sitz der Gesellschaft: Musterstraße 5, 80331 München
Handelsregister: Amtsgericht München, HRB 12345
USt-IdNr.: DE291499156
Telefon: +49 89 123456
Vertreten durch: Geschäftsführer Hans Muster`;

const DE_IMPRESSUM_MISMATCH = `Muster Pumpen GmbH
Handelsregister: Amtsgericht München, HRB 99999
USt-IdNr.: DE291499156`;

const DE_IMPRESSUM_WRONG_COURT = `Muster Pumpen GmbH
Handelsregister: Amtsgericht Köln, HRB 12345
USt-IdNr.: DE291499156`;

const FR_MENTIONS = `POMPES MARTIN SAS
Mentions légales
SIREN : 529 990 001
Siège social : 12 rue des Puits, 69003 Lyon
Directeur de la publication : M. Martin`;

const GB_LEGAL = `Beispiel Ventile Limited
Registered in England and Wales No. 12345678
Registered office: 45 King Road, Leeds LS1 2AB`;

const DE_NAME_ADDRESS_ONLY = `Beispiel Ventile GmbH
Anschrift: Industrieweg 7, 80331 München
Telefon: +49 89 999999`;

const PARKED = `This domain may be for sale. Contact us for a price.`;

function page(text: string, kind: LegalPageText['kind'] = 'impressum'): LegalPageText {
  return { kind, url: 'https://muster-pumpen.example/impressum', text };
}

const DE_ENTITY: VerifierEntity = {
  scheme: 'de_hrb',
  regNumber: 'HRB 12345',
  name: 'Muster Pumpen GmbH',
  country: 'DE',
  city: 'München',
  postalCode: '80331',
  vatId: 'DE291499156',
  registerCourt: 'Amtsgericht München',
};

const viesValid: VatValidator = {
  provider: 'vies_fixture',
  validate: async () => ({ valid: true, provider: 'vies_fixture' }),
};

const viesDown: VatValidator = {
  provider: 'vies_fixture',
  validate: async () => {
    throw new Error('vies unavailable');
  },
};

describe('extractRegisterEvidence', () => {
  it('parses DE HR register with court, FR SIREN and GB CRN from legal pages', () => {
    expect(extractRegisterEvidence('de_hrb', [page(DE_IMPRESSUM_MATCH)])?.evidence).toEqual({
      type: 'HRB',
      number: '12345',
      court: expect.stringContaining('München'),
    });
    expect(extractRegisterEvidence('fr_siren', [page(FR_MENTIONS, 'mentions-legales')])?.evidence).toEqual({
      type: 'siren',
      number: '529990001',
      court: null,
    });
    expect(extractRegisterEvidence('gb_crn', [page(GB_LEGAL, 'legal')])?.evidence).toEqual({
      type: 'crn',
      number: '12345678',
      court: null,
    });
    expect(extractRegisterEvidence('lei', [page(DE_IMPRESSUM_MATCH)])).toBeNull();
  });
});

describe('verifyDomainCandidate — scoring table (§3.12.3)', () => {
  it('register + VIES-valid VAT + address + name = VERIFIED with register match type', async () => {
    const result = await verifyDomainCandidate({
      entity: DE_ENTITY,
      candidateDomain: 'muster-pumpen.de',
      pages: [page(DE_IMPRESSUM_MATCH)],
      vatValidator: viesValid,
    });
    expect(result.verdict).toBe('VERIFIED');
    expect(result.score).toBe(100);
    expect(result.matchType).toBe('register_number');
    expect(result.signals).toMatchObject({
      registerNumberExact: true,
      registerMismatch: false,
      vatExactAndViesValid: true,
      postalCodeAndCityMatch: true,
      domainTokenMatchesBrand: true,
    });
    expect(result.signals.nameSimilarity).toBeGreaterThanOrEqual(0.85);
    expect(result.evidenceUrls).toEqual(['https://muster-pumpen.example/impressum']);
  });

  it('register + name only (no VAT/address) = 70 → AMBIGUOUS, never auto-VERIFIED', async () => {
    const result = await verifyDomainCandidate({
      entity: { ...DE_ENTITY, city: null, postalCode: null, vatId: null },
      candidateDomain: 'muster-pumpen.de',
      pages: [page(DE_IMPRESSUM_MATCH)],
    });
    expect(result.verdict).toBe('AMBIGUOUS');
    // 55 注册号 + 15 名称 + 5 域名 token（muster-pumpen.de 含品牌词）。
    expect(result.score).toBe(75);
    expect(result.matchType).toBe('register_number');
    expect(result.signals.vatExactAndViesValid).toBeNull();
  });

  it('no hard evidence caps below 55: address + weak name = REJECTED LOW_SCORE', async () => {
    const result = await verifyDomainCandidate({
      entity: { ...DE_ENTITY, vatId: null },
      candidateDomain: 'beispiel-ventile.example',
      pages: [page(DE_NAME_ADDRESS_ONLY)],
    });
    expect(result.signals.registerNumberExact).toBeNull();
    expect(result.score).toBeLessThanOrEqual(40);
    expect(result.verdict).toBe('REJECTED');
    expect(result.rejectReasons).toContain('LOW_SCORE');
  });

  it('FR SIREN exact + address + name = 90 → VERIFIED', async () => {
    const result = await verifyDomainCandidate({
      entity: {
        scheme: 'fr_siren',
        regNumber: '529990001',
        name: 'POMPES MARTIN SAS',
        country: 'FR',
        city: 'Lyon',
        postalCode: '69003',
      },
      candidateDomain: 'pompes-martin.fr',
      pages: [page(FR_MENTIONS, 'mentions-legales')],
    });
    expect(result.matchType).toBe('register_number');
    // 55 注册号 + 20 地址 + 15 名称 + 5 域名 token。
    expect(result.score).toBe(95);
    expect(result.verdict).toBe('VERIFIED');
  });

  it('GB CRN exact via "Registered in England and Wales No." + address = VERIFIED', async () => {
    const result = await verifyDomainCandidate({
      entity: {
        scheme: 'gb_crn',
        regNumber: '12345678',
        name: 'Beispiel Ventile Limited',
        country: 'GB',
        city: 'Leeds',
        postalCode: 'LS1 2AB',
      },
      candidateDomain: 'beispiel-ventile.co.uk',
      pages: [page(GB_LEGAL, 'legal')],
    });
    expect(result.matchType).toBe('register_number');
    expect(result.signals.registerNumberExact).toBe(true);
    expect(result.verdict).toBe('VERIFIED');
  });

  it('rejects on register mismatch even with matching VAT (negative evidence wins)', async () => {
    const result = await verifyDomainCandidate({
      entity: DE_ENTITY,
      candidateDomain: 'muster-pumpen.de',
      pages: [page(DE_IMPRESSUM_MISMATCH)],
      vatValidator: viesValid,
    });
    expect(result.verdict).toBe('REJECTED');
    expect(result.signals.registerMismatch).toBe(true);
    expect(result.rejectReasons).toContain('REGISTER_MISMATCH');
  });

  it('treats the same number under another court as a mismatch (register numbers are per court)', async () => {
    const result = await verifyDomainCandidate({
      entity: DE_ENTITY,
      candidateDomain: 'muster-pumpen.de',
      pages: [page(DE_IMPRESSUM_WRONG_COURT)],
    });
    expect(result.verdict).toBe('REJECTED');
    expect(result.rejectReasons).toContain('REGISTER_MISMATCH');
  });

  it('keeps VERIFIED achievable when VIES is down but register+address+name reach 90', async () => {
    const result = await verifyDomainCandidate({
      entity: DE_ENTITY,
      candidateDomain: 'muster-pumpen.de',
      pages: [page(DE_IMPRESSUM_MATCH)],
      vatValidator: viesDown,
    });
    expect(result.signals.vatExactAndViesValid).toBeNull();
    // 55 + 20 + 15 + 5（域名 token）＝ 95，即使 VIES 不可用也达 VERIFIED 门槛。
    expect(result.score).toBe(95);
    expect(result.verdict).toBe('VERIFIED');
  });

  it('rejects parked domains and empty candidate evidence', async () => {
    const parked = await verifyDomainCandidate({
      entity: DE_ENTITY,
      candidateDomain: 'muster-pumpen.de',
      pages: [page(PARKED)],
    });
    expect(parked.verdict).toBe('REJECTED');
    expect(parked.rejectReasons).toContain('PARKED_DOMAIN');
    const empty = await verifyDomainCandidate({
      entity: DE_ENTITY,
      candidateDomain: 'muster-pumpen.de',
      pages: [],
    });
    expect(empty.rejectReasons).toContain('NO_LEGAL_PAGE');
  });
});

describe('verifyDomainCandidates — orchestration rules', () => {
  it('selects the only VERIFIED candidate and rejects the conflicting mirror', async () => {
    const result = await verifyDomainCandidates({
      entity: DE_ENTITY,
      candidates: [
        { candidateDomain: 'muster-pumpen.de', pages: [page(DE_IMPRESSUM_MATCH)] },
        { candidateDomain: 'muster-pumpen-kopie.de', pages: [page(DE_IMPRESSUM_MISMATCH)] },
      ],
      vatValidator: viesValid,
    });
    expect(result.nameCollision).toBe(false);
    expect(result.selectedDomain).toBe('muster-pumpen.de');
    expect(result.results.map((item) => item.verdict)).toEqual(['VERIFIED', 'REJECTED']);
  });

  it('marks ≥2 strong candidates as an AMBIGUOUS name collision (never auto-selects)', async () => {
    const result = await verifyDomainCandidates({
      entity: DE_ENTITY,
      candidates: [
        { candidateDomain: 'muster-pumpen.de', pages: [page(DE_IMPRESSUM_MATCH)] },
        { candidateDomain: 'muster-pumpen-gruppe.de', pages: [page(DE_IMPRESSUM_MATCH)] },
      ],
      vatValidator: viesValid,
    });
    expect(result.nameCollision).toBe(true);
    expect(result.selectedDomain).toBeNull();
    for (const item of result.results) expect(item.verdict).toBe('AMBIGUOUS');
  });

  it('maps verdicts to company_domain_resolution drafts with evidence and selection', async () => {
    const verification = await verifyDomainCandidates({
      entity: DE_ENTITY,
      candidates: [{ candidateDomain: 'muster-pumpen.de', pages: [page(DE_IMPRESSUM_MATCH)] }],
      vatValidator: viesValid,
    });
    const [draft] = toDomainResolutionDrafts(verification);
    expect(draft).toMatchObject({
      candidateDomain: 'muster-pumpen.de',
      status: 'VERIFIED',
      matchType: 'register_number',
      selected: true,
      evidenceUrl: 'https://muster-pumpen.example/impressum',
    });
    expect(draft!.confidence).toBe(100);
    expect(draft!.evidenceJson.pageRegister).toMatchObject({ type: 'HRB', number: '12345' });
  });
});

describe('DomainResolver → verifier contract hand-off', () => {
  it('feeds resolver candidates straight into verification (offline fixtures only)', async () => {
    const search: DomainSearchProvider = {
      key: 'brave_fixture',
      async search() {
        return [
          { url: 'https://www.muster-pumpen.de/impressum', rank: 1 },
          { url: 'https://de.linkedin.com/company/muster-pumpen', rank: 2 },
        ];
      },
    };
    const resolver = new MultiRouteDomainResolver({ searchProviders: [search] });
    const resolution = await resolver.resolve({ name: DE_ENTITY.name, country: 'DE', city: 'München' });
    expect(resolution.status).toBe('CANDIDATES');
    const top = resolution.candidates[0]!;
    expect(top.domain).toBe('muster-pumpen.de');

    const verified = await verifyDomainCandidate({
      entity: DE_ENTITY,
      candidateDomain: top.domain,
      pages: [page(DE_IMPRESSUM_MATCH)],
      vatValidator: viesValid,
    });
    expect(verified.verdict).toBe('VERIFIED');
  });
});

// ── §3.12.9 锚点矩阵扩充：IT / ES / NL / BE / CH ──────────────────────────

const IT_NOTE_LEGALI = `Pompe Rossi S.r.l.
Note legali
REA MI-1234567
P.IVA IT12345678901
Via Torino 12, 20121 Milano`;

const ES_AVISO = `Bombas García S.L.
Aviso legal
CIF: B-12345678
Calle Mayor 3, 28001 Madrid`;

const NL_PRIVACY = `Pompen Jansen B.V.
Privacy
KvK: 12345678
BTW: NL123456789B01
Damrak 1, 1012 AB Amsterdam`;

const BE_MENTIONS = `Robinetterie Dubois SA
Mentions légales
KBO-nummer: 0123.456.789
TVA: BE0123456789
Rue X 1, 1000 Bruxelles`;

const CH_IMPRESSUM = `Ventile Meier AG
Impressum
UID: CHE-123.456.789
Bahnhofstrasse 1, 8001 Zürich`;

describe('§3.12.9 country anchor matrix (IT/ES/NL/BE/CH)', () => {
  it('extracts REA+province, NIF/CIF, KVK, KBO and UID evidence', () => {
    const legal = (text: string, kind: LegalPageText['kind'] = 'legal'): LegalPageText => ({
      kind,
      url: 'https://example.test/legal',
      text,
    });
    expect(extractRegisterEvidence('it_rea', [legal(IT_NOTE_LEGALI)])?.evidence).toEqual({
      type: 'rea',
      number: 'MI-1234567',
      court: null,
    });
    expect(extractRegisterEvidence('es_nif', [legal(ES_AVISO)])?.evidence).toEqual({
      type: 'nif',
      number: 'B12345678',
      court: null,
    });
    expect(extractRegisterEvidence('nl_kvk', [legal(NL_PRIVACY, 'privacy')])?.evidence).toEqual({
      type: 'kvk',
      number: '12345678',
      court: null,
    });
    expect(extractRegisterEvidence('be_kbo', [legal(BE_MENTIONS, 'mentions-legales')])?.evidence).toEqual({
      type: 'kbo',
      number: '123456789',
      court: null,
    });
    expect(extractRegisterEvidence('ch_uid', [legal(CH_IMPRESSUM, 'impressum')])?.evidence).toEqual({
      type: 'uid',
      number: '123456789',
      court: null,
    });
  });

  it.each([
    [
      'IT',
      { scheme: 'it_rea', regNumber: 'REA MI-1234567', name: 'Pompe Rossi S.r.l.', country: 'IT', city: 'Milano', postalCode: '20121' },
      IT_NOTE_LEGALI,
      'pompe-rossi.it',
      'legal' as const,
    ],
    [
      'ES',
      { scheme: 'es_nif', regNumber: 'B12345678', name: 'Bombas García S.L.', country: 'ES', city: 'Madrid', postalCode: '28001' },
      ES_AVISO,
      'bombas-garcia.es',
      'legal' as const,
    ],
    [
      'NL',
      { scheme: 'nl_kvk', regNumber: '12345678', name: 'Pompen Jansen B.V.', country: 'NL', city: 'Amsterdam', postalCode: '1012 AB' },
      NL_PRIVACY,
      'pompen-jansen.nl',
      'privacy' as const,
    ],
    [
      'BE',
      { scheme: 'be_kbo', regNumber: '0123.456.789', name: 'Robinetterie Dubois SA', country: 'BE', city: 'Bruxelles', postalCode: '1000' },
      BE_MENTIONS,
      'robinetterie-dubois.be',
      'mentions-legales' as const,
    ],
    [
      'CH',
      { scheme: 'ch_uid', regNumber: 'CHE-123.456.789', name: 'Ventile Meier AG', country: 'CH', city: 'Zürich', postalCode: '8001' },
      CH_IMPRESSUM,
      'ventile-meier.ch',
      'impressum' as const,
    ],
  ])('%s: exact register + address + name reaches VERIFIED', async (_country, entity, text, domain, kind) => {
    const result = await verifyDomainCandidate({
      entity: entity as VerifierEntity,
      candidateDomain: domain,
      pages: [{ kind, url: `https://${domain}/legal`, text }],
    });
    expect(result.signals.registerNumberExact).toBe(true);
    expect(result.matchType).toBe('register_number');
    expect(result.verdict).toBe('VERIFIED');
    expect(result.score).toBeGreaterThanOrEqual(90);
  });

  it('IT: the same REA number under another province is a mismatch (numbers are per province)', async () => {
    const result = await verifyDomainCandidate({
      entity: {
        scheme: 'it_rea',
        regNumber: 'REA MI-1234567',
        name: 'Pompe Rossi S.r.l.',
        country: 'IT',
        city: 'Milano',
        postalCode: '20121',
      },
      candidateDomain: 'pompe-rossi.it',
      pages: [{ kind: 'legal', url: 'https://pompe-rossi.it/legal', text: IT_NOTE_LEGALI.replace('MI-1234567', 'RM-1234567') }],
    });
    expect(result.verdict).toBe('REJECTED');
    expect(result.rejectReasons).toContain('REGISTER_MISMATCH');
  });

  it('BE: a different KBO number is a mismatch', async () => {
    const result = await verifyDomainCandidate({
      entity: {
        scheme: 'be_kbo',
        regNumber: '0123.456.789',
        name: 'Robinetterie Dubois SA',
        country: 'BE',
        city: 'Bruxelles',
        postalCode: '1000',
      },
      candidateDomain: 'robinetterie-dubois.be',
      pages: [{ kind: 'mentions-legales', url: 'https://robinetterie-dubois.be/legal', text: BE_MENTIONS.replace('0123.456.789', '0987.654.321') }],
    });
    expect(result.verdict).toBe('REJECTED');
    expect(result.rejectReasons).toContain('REGISTER_MISMATCH');
  });
});

describe('group portal rule (§3.12.10 multiple registers)', () => {
  it('treats a page listing two HRB entries as AMBIGUOUS even when one matches the entity', async () => {
    const groupText = `Muster Holding GmbH
Handelsregister: Amtsgericht München, HRB 12345
Sitz: Musterstraße 5, 80331 München

Tochtergesellschaft:
Muster Pumpen Service GmbH
Handelsregister: Amtsgericht München, HRB 54321`;
    const result = await verifyDomainCandidate({
      entity: DE_ENTITY,
      candidateDomain: 'muster-gruppe.de',
      pages: [{ kind: 'impressum', url: 'https://muster-gruppe.de/impressum', text: groupText }],
      vatValidator: viesValid,
    });
    expect(result.signals.multipleRegisters).toBe(true);
    expect(result.signals.registerMismatch).toBe(false);
    expect(result.verdict).toBe('AMBIGUOUS');
    expect(result.rejectReasons).toContain('MULTIPLE_REGISTERS');
  });
});
