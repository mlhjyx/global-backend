import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { mapPublicWebCompanyToRecord, type ExtractedCompany } from './public-web.provider';
import { validateRawSourceProviderPayload } from '../raw-source-provider-schema';

const DOMAIN = 'pumpen-mueller.de';
const FETCHED_AT = '2026-10-09T08:00:00.000Z';
const SEARCH_TEXT =
  '- 标题：Pumpen Müller GmbH – Großhandel für Pumpen\n  URL：https://www.pumpen-mueller.de/';

/**
 * The database writer's URL check (`raw_source_safe_https_url_v2`) without its contact rules, which the
 * TypeScript boundary applies as well: lower-case host, optional :443, no query, fragment or percent-escape.
 * The writer raises on any other URL, quarantined rows included, and that aborts the query's transaction.
 */
const DATABASE_STORABLE_URL =
  /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+(?::443)?(?:\/[^?#%]*)?$/u;

function mapped(
  extracted: Partial<ExtractedCompany>,
  hitUrls: readonly string[],
  domain = DOMAIN,
) {
  return mapPublicWebCompanyToRecord({
    domain,
    hitUrls,
    sourceText: SEARCH_TEXT,
    extracted: { is_company_site: true, name: 'Pumpen Müller GmbH', ...extracted },
    sourceClass: 'public_intelligence',
    fetchedAt: FETCHED_AT,
  });
}

/** Raw ingestion validates the record as the provider returns it; a JSON round trip must not change that. */
function governedPayload(record: unknown): Record<string, unknown> {
  const direct = validateRawSourceProviderPayload('public_web', record);
  const roundTripped = validateRawSourceProviderPayload(
    'public_web',
    JSON.parse(JSON.stringify(record)),
  );
  expect(direct).toEqual(roundTripped);
  if (!direct.ok) throw new Error(`Raw governance rejected the record: ${direct.reason}`);
  return direct.value;
}

type Case = Readonly<{
  title: string;
  extracted: Partial<ExtractedCompany>;
  hitUrls: readonly string[];
  domain?: string;
  name?: string;
  products?: readonly string[];
  keywords?: readonly string[];
  country: string | undefined;
  sourceUrl: string;
}>;

const CASES: readonly Case[] = [
  {
    title: 'German product names mixed with controlled terms, "Germany", hit on www.<domain>',
    extracted: {
      country: 'Germany',
      products: ['Kreiselpumpen', 'centrifugal pumps', 'Tauchpumpen', 'Industrial Pumps'],
      keywords: ['Pumpen Großhandel', 'industrial', 'submersible', 'hydraulic systems'],
      evidence: 'Pumpen Müller GmbH – Großhandel für Pumpen',
      confidence: 0.9,
    },
    hitUrls: ['https://www.pumpen-mueller.de/produkte/kreiselpumpen'],
    products: ['centrifugal pumps', 'Industrial Pumps'],
    keywords: ['industrial', 'hydraulic systems'],
    country: 'DE',
    sourceUrl: 'https://pumpen-mueller.de/',
  },
  {
    title: 'only German terms, "Deutschland", hit on the exact host, no confidence',
    extracted: {
      country: 'Deutschland',
      products: ['Pumpen', 'Armaturen', 'Kreiselpumpen'],
      keywords: ['Großhandel', 'Vertrieb'],
    },
    hitUrls: ['https://pumpen-mueller.de/'],
    country: 'DE',
    sourceUrl: 'https://pumpen-mueller.de/',
  },
  {
    title: '"德国", confidence null, a page on the exact host',
    extracted: { country: '德国', confidence: null as unknown as number, products: ['valves', 'Ventile'] },
    hitUrls: ['https://pumpen-mueller.de/kontakt'],
    products: ['valves'],
    country: 'DE',
    sourceUrl: 'https://pumpen-mueller.de/kontakt',
  },
  {
    title: '"DACH" is no country, plain-http hit',
    extracted: { country: 'DACH', products: ['pumps'], confidence: 0.9 },
    hitUrls: ['http://www.pumpen-mueller.de/'],
    products: ['pumps'],
    country: undefined,
    sourceUrl: 'https://pumpen-mueller.de/',
  },
  {
    title: '"Österreich" is not in the vocabulary, hit on a subdomain',
    extracted: { country: 'Österreich' },
    hitUrls: ['https://shop.pumpen-mueller.de/pumpen'],
    country: undefined,
    sourceUrl: 'https://pumpen-mueller.de/',
  },
  {
    title: 'unknown country, umlaut path first, then a page with query and fragment',
    extracted: { country: 'Atlantis', confidence: 0.4 },
    hitUrls: ['https://pumpen-mueller.de/über-uns', 'https://pumpen-mueller.de/produkte?seite=2#liste'],
    country: undefined,
    sourceUrl: 'https://pumpen-mueller.de/produkte',
  },
  {
    title: 'a path the database reads as a password reference, a non-default port, then a usable page',
    extracted: { country: 'Germany' },
    hitUrls: [
      'https://pumpen-mueller.de/kunden/forgot_password',
      'https://pumpen-mueller.de:8443/shop',
      'https://pumpen-mueller.de/sortiment',
    ],
    country: 'DE',
    sourceUrl: 'https://pumpen-mueller.de/sortiment',
  },
  {
    title: 'ISO code answer, www hit first, then the exact host',
    extracted: { country: 'de' },
    hitUrls: ['https://www.pumpen-mueller.de/', 'https://pumpen-mueller.de/impressum'],
    country: 'DE',
    sourceUrl: 'https://pumpen-mueller.de/impressum',
  },
  {
    title: 'a subdomain that is itself the record domain',
    extracted: { country: 'Germany' },
    domain: 'shop.pumpen-mueller.de',
    hitUrls: ['https://shop.pumpen-mueller.de/pumpen'],
    country: 'DE',
    sourceUrl: 'https://shop.pumpen-mueller.de/pumpen',
  },
  {
    title: '"GmbH & Co. KG" name kept as written',
    extracted: { name: 'Pumpen Müller GmbH & Co. KG', country: 'Germany' },
    hitUrls: ['https://www.pumpen-mueller.de/'],
    name: 'Pumpen Müller GmbH & Co. KG',
    country: 'DE',
    sourceUrl: 'https://pumpen-mueller.de/',
  },
  {
    title: 'typographic quotes, dash and trademark sign in the name',
    extracted: { name: '„Pumpen Müller“ GmbH & Co. KG – Großhandel®', country: 'Germany' },
    hitUrls: ['https://www.pumpen-mueller.de/'],
    name: 'Pumpen Müller GmbH & Co. KG - Großhandel',
    country: 'DE',
    sourceUrl: 'https://pumpen-mueller.de/',
  },
  {
    title: 'typographic apostrophe, no-break space and TM sign in the name',
    extracted: { name: ' Müller’s Pumpen GmbH™ ', country: 'Germany' },
    hitUrls: ['https://www.pumpen-mueller.de/'],
    name: "Müller's Pumpen GmbH",
    country: 'DE',
    sourceUrl: 'https://pumpen-mueller.de/',
  },
  {
    title: 'full-width letters in the name',
    extracted: { name: 'ＫＳＢ SE & Co. KGaA', country: 'Germany' },
    hitUrls: ['https://www.pumpen-mueller.de/'],
    name: 'KSB SE & Co. KGaA',
    country: 'DE',
    sourceUrl: 'https://pumpen-mueller.de/',
  },
  {
    title: 'line break, tab and double space in the name',
    extracted: { name: 'Pumpen  Müller\tGmbH\n& Co. KG', country: 'Germany' },
    hitUrls: ['https://www.pumpen-mueller.de/'],
    name: 'Pumpen Müller GmbH & Co. KG',
    country: 'DE',
    sourceUrl: 'https://pumpen-mueller.de/',
  },
  {
    title: 'the same controlled term with other separators, case or a trailing hyphen (first spelling wins)',
    extracted: {
      products: ['centrifugal-pumps', 'centrifugal_pumps', 'Centrifugal Pumps', 'pump-'],
      country: 'Germany',
    },
    hitUrls: ['https://pumpen-mueller.de/'],
    products: ['centrifugal pumps', 'pump'],
    country: 'DE',
    sourceUrl: 'https://pumpen-mueller.de/',
  },
  {
    title: 'internationalized domain from a Unicode search hit',
    extracted: { country: 'Germany' },
    domain: 'müller-pumpen.de',
    hitUrls: ['https://www.müller-pumpen.de/'],
    country: 'DE',
    sourceUrl: 'https://xn--mller-pumpen-dlb.de/',
  },
];

describe('public_web records pass the Raw governance (discovery run 733fbf03)', () => {
  it.each(CASES)('$title', (c) => {
    const record = mapped(c.extracted, c.hitUrls, c.domain);
    const payload = governedPayload(record);
    const attributes = payload.attributes as Record<string, unknown>;
    const provenance = payload.provenance as Record<string, unknown>;

    expect(record.attributes).toMatchObject({
      products: c.products ?? [],
      keywords: c.keywords ?? [],
    });
    expect(attributes).toMatchObject({
      products: c.products ?? [],
      keywords: c.keywords ?? [],
      extraction_confidence:
        typeof c.extracted.confidence === 'number' ? c.extracted.confidence : 0,
      source_class: 'public_intelligence',
    });
    expect(payload.country).toBe(c.country);
    if (c.name) expect(payload.name).toBe(c.name);
    expect(payload.externalId).toBe(payload.domain);
    expect(new URL(String(provenance.sourceUrl)).hostname).toBe(payload.domain);
    expect(provenance).toEqual({
      sourceUrl: c.sourceUrl,
      fetchedAt: FETCHED_AT,
      contentHash: createHash('sha256').update(SEARCH_TEXT).digest('hex'),
      parserVersion: 'public_web/v2-search',
    });
    expect(c.sourceUrl).toMatch(DATABASE_STORABLE_URL);
  });

  it('drops every uncontrolled term from the record, not only from the stored payload', () => {
    const record = mapped(
      {
        products: ['Kreiselpumpen', 'centrifugal pumps', 'submersible'],
        keywords: ['Tauchpumpen', 'industrial'],
      },
      ['https://www.pumpen-mueller.de/'],
    );
    const serialized = JSON.stringify(governedPayload(record));
    for (const dropped of ['Kreiselpumpen', 'submersible', 'Tauchpumpen']) {
      expect(JSON.stringify(record)).not.toContain(dropped);
      expect(serialized).not.toContain(dropped);
    }
  });

  it('keeps at most 20 controlled terms, as the Raw boundary and the database writer allow', () => {
    const vocabulary = [
      'aerospace', 'automation', 'brake', 'centrifugal', 'compressor', 'defense', 'device',
      'electric', 'electronics', 'energy', 'engineering', 'equipment', 'fabrication', 'hydraulic',
      'imaging', 'industrial', 'machine', 'machinery', 'manufacturing', 'medical', 'metal',
      'motor', 'press', 'pump', 'valve',
    ];
    const record = mapped({ products: vocabulary, keywords: vocabulary }, ['https://pumpen-mueller.de/']);
    expect(record.attributes?.products).toEqual(vocabulary.slice(0, 20));
    expect(record.attributes?.keywords).toEqual(vocabulary.slice(0, 20));
    governedPayload(record);
  });

  it.each([
    [120, 120],
    [0, 0],
    [12.5, undefined],
    [-3, undefined],
    [null, undefined],
  ])('maps employee_count %s to employeeCount %s', (employeeCount, expected) => {
    const record = mapped({ employee_count: employeeCount }, ['https://pumpen-mueller.de/']);
    expect(record.employeeCount).toBe(expected);
    expect(governedPayload(record).employeeCount).toBe(expected);
  });

  it('leaves a name carrying a phone number to the boundary, which rejects it', () => {
    const record = mapped(
      { name: 'Pumpen Müller GmbH, Tel. 0711 1234567' },
      ['https://pumpen-mueller.de/'],
    );
    expect(validateRawSourceProviderPayload('public_web', record)).toEqual({
      ok: false,
      reason: 'PROVIDER_PAYLOAD_SCHEMA_INVALID',
    });
  });
});
