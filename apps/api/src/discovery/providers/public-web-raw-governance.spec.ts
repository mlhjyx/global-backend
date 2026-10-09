import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { mapPublicWebCompanyToRecord, type ExtractedCompany } from './public-web.provider';
import { prepareRawSourceBatch } from '../raw-source-ingestion';
import { isStableSafeHttpsUrl } from '../raw-source-provider-normalizer';
import { validateRawSourceProviderPayload } from '../raw-source-provider-schema';
import { PUBLIC_WEB_COMPANY_SITE_POLICY_DOMAIN } from '../source-policy-scope';

const DOMAIN = 'pumpen-mueller.de';
const FETCHED_AT = '2026-10-09T08:00:00.000Z';
const SEARCH_TEXT =
  '- 标题：Pumpen Müller GmbH – Großhandel für Pumpen\n  URL：https://www.pumpen-mueller.de/';

/*
 * ASCII reading of the database writer's source-URL predicate `raw_source_safe_https_url_v2` and the
 * contact rules it applies (`raw_source_text_secret_safe_v2`, `raw_source_text_contact_safe_v2`;
 * migration 20260826130000). The writer raises on any other URL, quarantined rows included, and the
 * raise aborts the query's transaction. The mapping only emits ASCII URLs, so POSIX [[:alnum:]],
 * [[:alpha:]] and [[:cntrl:]] read as their ASCII classes.
 */
const SQL_HTTPS_HOST =
  /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+(?::443)?(?:\/|$)/u;
const SQL_EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/iu;
const SQL_SECRET =
  /(?:^|[^A-Za-z0-9])(?:bearer|basic auth|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|secret|password|passwd|private[_ -]?key|first[_ -]?name|last[_ -]?name|full[_ -]?name|contact[_ -]?name|personal data|jane doe|john doe|john smith|alice van smith)(?:$|[^A-Za-z0-9])/iu;
const SQL_KEY_TOKEN = /(?:^|[^A-Za-z0-9])sk-[a-z0-9_-]{6,}/iu;
const SQL_PHONE = /(?:^|[^A-Za-z0-9])(?:[+]?[0-9][ ().-]*){7,}(?:$|[^A-Za-z0-9])/u;

/** POSIX [[:cntrl:]] in ASCII: U+0000–U+001F and U+007F. */
function hasControlCharacter(text: string): boolean {
  return [...text].some((character) => {
    const code = character.charCodeAt(0);
    return code < 0x20 || code === 0x7f;
  });
}

function databaseStoresSourceUrl(url: string): boolean {
  const spaced = url.replace(/%20/giu, ' ');
  const bytes = Buffer.byteLength(url, 'utf8');
  return (
    bytes >= 1 &&
    bytes <= 2_048 &&
    SQL_HTTPS_HOST.test(url) &&
    !/[?#]/u.test(url) &&
    !/^https:\/\/[^/]*@/u.test(url) &&
    !/%25/iu.test(url) &&
    !url.replace(/%20/giu, '').includes('%') &&
    !hasControlCharacter(spaced) &&
    ![SQL_EMAIL, SQL_SECRET, SQL_KEY_TOKEN, SQL_PHONE].some((rule) => rule.test(spaced))
  );
}

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
    title: 'paths the database reads as a key token or a password reference, a non-default port, then a usable page',
    extracted: { country: 'Germany' },
    hitUrls: [
      'https://pumpen-mueller.de/Kreiselpumpe_SK-40_160',
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
    title: 'internationalized domain from a Unicode search hit',
    extracted: { country: 'Germany' },
    domain: 'müller-pumpen.de',
    hitUrls: ['https://www.müller-pumpen.de/'],
    country: 'DE',
    sourceUrl: 'https://xn--mller-pumpen-dlb.de/',
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
];

/** Model answers whose names need normalizing; country and hit as in the run 733fbf03 shape. */
const NAMES: ReadonlyArray<readonly [title: string, raw: string, stored: string]> = [
  ['"GmbH & Co. KG" kept as written', 'Pumpen Müller GmbH & Co. KG', 'Pumpen Müller GmbH & Co. KG'],
  ['typographic double quotes, dash and trademark sign', '„Pumpen Müller“ GmbH & Co. KG – Großhandel®', 'Pumpen Müller GmbH & Co. KG - Großhandel'],
  ['typographic apostrophe, no-break space and TM sign', ' Müller’s Pumpen\u{a0}GmbH™ ', "Müller's Pumpen GmbH"],
  ['acute accent used as an apostrophe', 'O´Brien Pumps Ltd', "O'Brien Pumps Ltd"],
  ['soft hyphen inside a word', 'Pumpen\u{ad}handel Müller GmbH', 'Pumpenhandel Müller GmbH'],
  ['full-width letters', 'ＫＳＢ SE & Co. KGaA', 'KSB SE & Co. KGaA'],
  ['line break, tab and double space', 'Pumpen  Müller\tGmbH\n& Co. KG', 'Pumpen Müller GmbH & Co. KG'],
  ['a search title separator', 'Pumpen Müller GmbH | Großhandel', 'Pumpen Müller GmbH - Großhandel'],
  ['a middle-dot separator', 'ACME · Pumps', 'ACME - Pumps'],
  ['single quotation marks around a word', '‘Pumpen’ GmbH', 'Pumpen GmbH'],
  ['German low and high single quotation marks', '‚Pumpenhaus‘ Müller GmbH', 'Pumpenhaus Müller GmbH'],
  ['a genitive apostrophe stays', "Hans' Pumpen GmbH", "Hans' Pumpen GmbH"],
  ['an underscore', 'Pumpen_Müller GmbH', 'Pumpen Müller GmbH'],
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
    expect(payload.externalId).toBe(payload.domain);
    expect(new URL(String(provenance.sourceUrl)).hostname).toBe(payload.domain);
    expect(provenance).toEqual({
      sourceUrl: c.sourceUrl,
      fetchedAt: FETCHED_AT,
      contentHash: createHash('sha256').update(SEARCH_TEXT).digest('hex'),
      parserVersion: 'public_web/v2-search',
    });
    expect(databaseStoresSourceUrl(c.sourceUrl)).toBe(true);
  });

  it('is ACCEPTED by Raw ingestion under the company-site source policy alone', () => {
    const record = mapped({ country: 'Germany', products: ['pumps'] }, [
      'https://www.pumpen-mueller.de/produkte',
    ]);
    const companySite = {
      id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      domain: PUBLIC_WEB_COMPANY_SITE_POLICY_DOMAIN,
      retentionDays: 365,
      reviewStatus: 'APPROVED',
      allowedPurpose: ['discovery', 'enrichment'],
      updatedAt: new Date('2026-10-09T00:00:00.000Z'),
    };

    const [row] = prepareRawSourceBatch({
      providerKey: 'public_web',
      records: [record],
      policies: [companySite],
      now: new Date(FETCHED_AT),
    }).rows;

    expect(row).toMatchObject({
      ingestStatus: 'ACCEPTED',
      dispositionCode: null,
      externalId: DOMAIN,
      sourceUrl: 'https://pumpen-mueller.de/',
      retentionDays: 365,
    });
    expect(row!.sourcePolicySnapshot).toMatchObject({
      kind: 'source_policy',
      id: companySite.id,
      domain: PUBLIC_WEB_COMPANY_SITE_POLICY_DOMAIN,
      allowedPurpose: ['discovery'],
    });
  });

  it.each(NAMES)('stores a name with %s', (_title, raw, stored) => {
    const record = mapped({ name: raw, country: 'Germany' }, ['https://www.pumpen-mueller.de/']);
    expect(record.name).toBe(stored);
    expect(governedPayload(record).name).toBe(stored);
  });

  it('keeps, from any exact-host hit, only a source URL that both boundaries store', () => {
    const paths = [
      '/produkte/kreiselpumpen',
      '/Kreiselpumpe_SK-40_160',
      '/katalog_sk-10_200',
      '/sk-pumpen-katalog',
      '/kunden/forgot_password',
      '/my_secret_garden',
      '/api_key',
      '/über-uns',
      '/produkte/pumpe%20xl',
      '/service/0711-1234567',
      '/kontakt/max.mustermann@pumpen-mueller.de',
      '/a_b/c-d.html',
    ];
    const chosen = paths.map((path) => {
      const record = mapped({}, [`https://${DOMAIN}${path}`]);
      expect(validateRawSourceProviderPayload('public_web', record).ok, path).toBe(true);
      const sourceUrl = record.provenance?.sourceUrl ?? '';
      expect(databaseStoresSourceUrl(sourceUrl), `${path} -> ${sourceUrl}`).toBe(true);
      return sourceUrl;
    });
    expect(chosen[0]).toBe('https://pumpen-mueller.de/produkte/kreiselpumpen');
    expect(chosen.slice(1).every((url) => url === 'https://pumpen-mueller.de/')).toBe(true);
    // Why "_" is refused: TypeScript reads no key token here, the database does.
    const keyTokenPath = 'https://pumpen-mueller.de/Kreiselpumpe_SK-40_160';
    expect(isStableSafeHttpsUrl(keyTokenPath)).toBe(true);
    expect(databaseStoresSourceUrl(keyTokenPath)).toBe(false);
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

  it.each([
    ['a phone number', 'Pumpen Müller GmbH, Tel. 0711 1234567'],
    ['a word the database reads as a secret marker once "_" is a word break', 'Pumpen_Secret GmbH'],
  ])('leaves a name carrying %s to the boundary, which rejects it', (_title, name) => {
    const hitUrls = ['https://pumpen-mueller.de/'];
    // Control: the same record with a clean name passes, so the name alone decides.
    expect(validateRawSourceProviderPayload('public_web', mapped({}, hitUrls)).ok).toBe(true);
    expect(validateRawSourceProviderPayload('public_web', mapped({ name }, hitUrls))).toEqual({
      ok: false,
      reason: 'PROVIDER_PAYLOAD_SCHEMA_INVALID',
    });
  });
});
