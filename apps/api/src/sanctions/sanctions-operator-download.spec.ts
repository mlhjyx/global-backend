import { describe, expect, it, vi } from 'vitest';
import { EgressBlockedError, type PublicHttpResponse } from '../adapters/guarded-http';
import { DEFAULT_SANCTIONS_UA, MAX_SANCTIONS_DOWNLOAD_ARTIFACT_BYTES } from '../tools/source-tools';
import type { ExecutionBroker } from '../tools/tool-contract';
import {
  OperatorSanctionsDownloads,
  SanctionsOperatorRefreshError,
  assertOfficialSanctionsSource,
  censusSanctionsList,
  officialSanctionsEndpoints,
  type PublicHttpRequester,
} from './sanctions-operator-download';

/*
 * Operator (B0) download path for the three official sanctions lists. Every name in the fixtures
 * is invented; the fixtures only reproduce the published XML shapes, individuals included, so the
 * tests can show that people are counted and dropped, never kept.
 */

const SDN_URL = 'https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.XML';
const CONSOLIDATED_URL =
  'https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/CONSOLIDATED.XML';
const EU_URL =
  'https://webgate.ec.europa.eu/fsd/fsf/public/files/xmlFullSanctionsList_1_1/content?token=dG9rZW4tMjAxNw';
const OFAC_HOST = 'sanctionslistservice.ofac.treas.gov';
const EU_HOST = 'webgate.ec.europa.eu';
const S3_FINAL_URL =
  'https://wc2h-sls-prod-public-published.s3.us-gov-west-1.amazonaws.com/Published/SDN.XML?X-Amz-Security-Token=temporary-token&X-Amz-Signature=temporary-signature';

const OFAC_XML = `<?xml version="1.0" standalone="yes"?>
<sdnList xmlns="https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/XML">
  <publshInformation><Publish_Date>10/09/2026</Publish_Date><Record_Count>7</Record_Count></publshInformation>
  <sdnEntry><uid>81001</uid><lastName>PRETEND METALS GROUP</lastName><sdnType>Entity</sdnType>
    <programList><program>RUSSIA-EO14024</program></programList></sdnEntry>
  <sdnEntry><uid>81002</uid><firstName>Notreal</firstName><lastName>PERSONA GAMMA</lastName><sdnType>Individual</sdnType>
    <programList><program>SDGT</program></programList>
    <dateOfBirthList><dateOfBirthItem><uid>9</uid><dateOfBirth>12 Jan 1961</dateOfBirth></dateOfBirthItem></dateOfBirthList></sdnEntry>
  <sdnEntry><uid>81003</uid><lastName>DREAMT FREIGHTER</lastName><sdnType>Vessel</sdnType>
    <programList><program>IRAN</program></programList></sdnEntry>
  <sdnEntry><uid>81004</uid><lastName>VAPOR AIR CARGO</lastName><sdnType>Entity</sdnType>
    <programList><program>IRAN</program></programList>
    <addressList><address><uid>10</uid><country>Iran</country></address></addressList></sdnEntry>
  <sdnEntry><uid>81005</uid><firstName>Fabled</firstName><lastName>PERSONA DELTA</lastName><sdnType>Individual</sdnType>
    <programList><program>CYBER2</program></programList></sdnEntry>
  <sdnEntry><uid>81006</uid><lastName>EP-NOTAPLANE</lastName><sdnType>Aircraft</sdnType>
    <programList><program>IRAN</program></programList></sdnEntry>
  <sdnEntry><uid>81007</uid><sdnType>Entity</sdnType><programList><program>IRAN</program></programList></sdnEntry>
</sdnList>`;

const EU_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<export xmlns="http://eu.europa.ec/fpi/fsd/export" generationDate="2026-09-22T20:01:34.799+02:00" globalFileId="900002">
  <sanctionEntity euReferenceNumber="EU.9002.01" logicalId="900201">
    <subjectType code="enterprise" classificationCode="E"/>
    <nameAlias wholeName="IMAGINED RAIL SUPPLY OOO" strong="true"/>
  </sanctionEntity>
  <sanctionEntity euReferenceNumber="EU.9002.02" logicalId="900202">
    <subjectType code="person" classificationCode="P"/>
    <nameAlias wholeName="Ficta Inventova" strong="true"/>
  </sanctionEntity>
</export>`;

const OFAC_PERSONAL = ['persona gamma', 'notreal', 'persona delta', 'fabled', '1961'];

function response(
  over: Partial<Omit<PublicHttpResponse, 'body' | 'text'>> & { body?: string | Buffer } = {},
): PublicHttpResponse {
  const body = Buffer.isBuffer(over.body) ? over.body : Buffer.from(over.body ?? OFAC_XML, 'utf8');
  return {
    status: over.status ?? 200,
    ok: over.ok ?? (over.status ?? 200) < 300,
    headers: over.headers ?? { 'content-type': 'text/xml', 'last-modified': 'Fri, 09 Oct 2026 21:00:00 GMT' },
    body,
    text: body.toString('utf8'),
    finalUrl: over.finalUrl ?? S3_FINAL_URL,
  };
}

const allowAll = (): Pick<ExecutionBroker, 'checkSourcePolicy'> & { checkSourcePolicy: ReturnType<typeof vi.fn> } => ({
  checkSourcePolicy: vi.fn(async () => ({ allowed: true })),
});

function downloadsWith(
  request: PublicHttpRequester,
  sourcePolicy: Pick<ExecutionBroker, 'checkSourcePolicy'> = allowAll(),
  keys: readonly string[] = ['eu_fsf', 'ofac_consolidated', 'ofac_sdn'],
) {
  return new OperatorSanctionsDownloads({
    endpoints: officialSanctionsEndpoints().filter((endpoint) => keys.includes(endpoint.key)),
    sourcePolicy,
    request,
    timeoutMs: 600_000,
    sleep: async () => undefined,
  });
}

describe('official sanctions endpoints', () => {
  it('binds each seeded source to its U.S. Treasury OFAC or EU Financial Sanctions Files URL', () => {
    expect(officialSanctionsEndpoints()).toEqual([
      { key: 'eu_fsf', url: EU_URL, format: 'eu_fsf_xml', host: EU_HOST },
      { key: 'ofac_consolidated', url: CONSOLIDATED_URL, format: 'ofac_sdn_xml', host: OFAC_HOST },
      { key: 'ofac_sdn', url: SDN_URL, format: 'ofac_sdn_xml', host: OFAC_HOST },
    ]);
  });

  it('accepts a source row only when its key, URL and format are exactly the official ones', () => {
    expect(assertOfficialSanctionsSource({ key: 'ofac_sdn', url: SDN_URL, format: 'ofac_sdn_xml' })).toEqual({
      key: 'ofac_sdn', url: SDN_URL, format: 'ofac_sdn_xml', host: OFAC_HOST,
    });
    expect(assertOfficialSanctionsSource({ key: 'eu_fsf', url: EU_URL, format: 'eu_fsf_xml' }).host).toBe(EU_HOST);
  });

  it.each([
    ['another host', { key: 'ofac_sdn', url: 'https://sanctions.example.org/SDN.XML', format: 'ofac_sdn_xml' }],
    ['a look-alike host', { key: 'ofac_sdn', url: SDN_URL.replace(OFAC_HOST, `${OFAC_HOST}.attacker.example`), format: 'ofac_sdn_xml' }],
    ['plain http', { key: 'ofac_sdn', url: SDN_URL.replace('https:', 'http:'), format: 'ofac_sdn_xml' }],
    ['embedded credentials', { key: 'ofac_sdn', url: SDN_URL.replace('https://', 'https://user:secret@'), format: 'ofac_sdn_xml' }],
    ['another path on the official host', { key: 'ofac_sdn', url: SDN_URL.replace('SDN.XML', 'SDN_ENHANCED.XML'), format: 'ofac_sdn_xml' }],
    ['an extra query', { key: 'ofac_sdn', url: `${SDN_URL}?redirect=1`, format: 'ofac_sdn_xml' }],
    ["another source's URL", { key: 'ofac_sdn', url: CONSOLIDATED_URL, format: 'ofac_sdn_xml' }],
    ['a format the key does not publish', { key: 'ofac_sdn', url: SDN_URL, format: 'eu_fsf_xml' }],
    ['an unknown source key', { key: 'un_consolidated', url: SDN_URL, format: 'ofac_sdn_xml' }],
    ['a prototype key', { key: '__proto__', url: SDN_URL, format: 'ofac_sdn_xml' }],
  ])('refuses %s', (_case, row) => {
    expect(() => assertOfficialSanctionsSource(row)).toThrow(SanctionsOperatorRefreshError);
    expect(() => assertOfficialSanctionsSource(row)).toThrow(/SANCTIONS_OPERATOR_SOURCE_NOT_OFFICIAL/);
  });
});

describe('censusSanctionsList', () => {
  it('counts kept entities and dropped individuals, vessels and aircraft in an OFAC list', () => {
    const census = censusSanctionsList('ofac_sdn_xml', OFAC_XML);

    expect(census).toEqual({
      publishDate: '2026-10-09',
      entries: 7,
      kept: 2,
      invalidEntities: 1,
      subjectTypes: { Entity: 3, Individual: 2, Vessel: 1, Aircraft: 1 },
      dropped: { Individual: 2, Vessel: 1, Aircraft: 1 },
    });
    const blob = JSON.stringify(census).toLowerCase();
    for (const personal of OFAC_PERSONAL) expect(blob).not.toContain(personal);
  });

  it('counts kept enterprises and dropped persons in an EU list', () => {
    expect(censusSanctionsList('eu_fsf_xml', EU_XML)).toEqual({
      publishDate: '2026-09-22',
      entries: 2,
      kept: 1,
      invalidEntities: 0,
      subjectTypes: { enterprise: 1, person: 1 },
      dropped: { person: 1 },
    });
  });

  it('refuses a format it has no parser for', () => {
    expect(() => censusSanctionsList('un_xml', OFAC_XML)).toThrow(/SANCTIONS_OPERATOR_FORMAT_UNSUPPORTED/);
  });
});

describe('OperatorSanctionsDownloads.download', () => {
  it('fetches through the guarded requester with the list UA, operator deadline, size cap and redirect cap', async () => {
    const request = vi.fn<PublicHttpRequester>(async () => response());
    const sourcePolicy = allowAll();

    const download = await downloadsWith(request, sourcePolicy).download('ofac_sdn');

    expect(sourcePolicy.checkSourcePolicy).toHaveBeenCalledWith('sanctions.download', OFAC_HOST, 'sanctions_screening');
    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith(SDN_URL, {
      headers: { 'user-agent': DEFAULT_SANCTIONS_UA },
      operatorTimeoutMs: 600_000,
      maxBytes: MAX_SANCTIONS_DOWNLOAD_ARTIFACT_BYTES,
      maxRedirects: 3,
    });
    expect(download).toMatchObject({
      key: 'ofac_sdn',
      format: 'ofac_sdn_xml',
      host: OFAC_HOST,
      finalHost: 'wc2h-sls-prod-public-published.s3.us-gov-west-1.amazonaws.com',
      bytes: Buffer.byteLength(OFAC_XML),
      contentType: 'text/xml',
      lastModified: 'Fri, 09 Oct 2026 21:00:00 GMT',
      body: OFAC_XML,
    });
    expect(JSON.stringify({ ...download, body: undefined })).not.toMatch(/X-Amz|temporary-(token|signature)/);
  });

  it('passes a user agent recorded in the source config', async () => {
    const request = vi.fn<PublicHttpRequester>(async () => response());
    await downloadsWith(request).download('ofac_sdn', 'OperatorProbe/2.0 (+ops)');
    expect(request.mock.calls[0]![1]).toMatchObject({ headers: { 'user-agent': 'OperatorProbe/2.0 (+ops)' } });
  });

  it.each([
    ['suspended', 'SANCTIONS_OPERATOR_SOURCE_POLICY_SUSPENDED'],
    ['unregistered', 'SANCTIONS_OPERATOR_SOURCE_POLICY_UNREGISTERED'],
    ['purpose_not_allowed', 'SANCTIONS_OPERATOR_SOURCE_POLICY_PURPOSE_NOT_ALLOWED'],
  ] as const)('refuses before any network call when the source policy is %s', async (reason, code) => {
    const request = vi.fn<PublicHttpRequester>(async () => response());
    const sourcePolicy = { checkSourcePolicy: vi.fn(async () => ({ allowed: false, reason })) };

    await expect(downloadsWith(request, sourcePolicy).download('ofac_sdn')).rejects.toThrow(code);
    expect(request).not.toHaveBeenCalled();
  });

  it('refuses a source that was not selected for this run', async () => {
    const request = vi.fn<PublicHttpRequester>(async () => response());
    await expect(downloadsWith(request, allowAll(), ['eu_fsf']).download('ofac_sdn'))
      .rejects.toThrow(/SANCTIONS_OPERATOR_SOURCE_NOT_SELECTED/);
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    ['a non-2xx answer', response({ status: 503 }), /SANCTIONS_OPERATOR_DOWNLOAD_HTTP_503/],
    ['a download that ended on plain http', response({ finalUrl: 'http://mirror.example/SDN.XML' }), /SANCTIONS_OPERATOR_DOWNLOAD_NOT_HTTPS/],
    ['a non-XML media type', response({ headers: { 'content-type': 'text/html; charset=utf-8' } }), /SANCTIONS_OPERATOR_DOWNLOAD_MEDIA_TYPE_INVALID/],
    ['a missing media type', response({ headers: {} }), /SANCTIONS_OPERATOR_DOWNLOAD_MEDIA_TYPE_INVALID/],
    ['bytes that are not UTF-8', response({ body: Buffer.from([0x3c, 0x61, 0xff, 0xfe, 0x3e]) }), /SANCTIONS_OPERATOR_DOWNLOAD_UTF8_INVALID/],
    ['a DOCTYPE with an entity declaration', response({ body: `<?xml version="1.0"?><!DOCTYPE sdnList [<!ENTITY boom "x">]>${OFAC_XML.slice(OFAC_XML.indexOf('<sdnList'))}` }), /SANCTIONS_OPERATOR_DOWNLOAD_XML_INVALID/],
    ['XML that is not well formed', response({ body: '<sdnList><sdnEntry></sdnList>' }), /SANCTIONS_OPERATOR_DOWNLOAD_XML_INVALID/],
  ])('refuses %s', async (_case, answer, error) => {
    const request = vi.fn<PublicHttpRequester>(async () => answer);
    await expect(downloadsWith(request).download('ofac_sdn')).rejects.toThrow(error);
  });

  it('reports an oversized list as too large instead of a generic block', async () => {
    const request = vi.fn<PublicHttpRequester>(async () => {
      throw new EgressBlockedError('response_too_large');
    });
    await expect(downloadsWith(request).download('ofac_sdn')).rejects.toThrow(/SANCTIONS_OPERATOR_DOWNLOAD_TOO_LARGE/);
  });

  it('keeps a network guard refusal visible by its code', async () => {
    const request = vi.fn<PublicHttpRequester>(async () => {
      throw new EgressBlockedError('non_global_address');
    });
    await expect(downloadsWith(request).download('ofac_sdn')).rejects.toThrow(
      'SANCTIONS_OPERATOR_DOWNLOAD_BLOCKED: non_global_address',
    );
  });

  it('turns any other transport failure into one plain, bounded operator error', async () => {
    const reset = Object.assign(new Error('read ECONNRESET'), { errno: -104, code: 'ECONNRESET', syscall: 'read' });
    const failure = await downloadsWith(vi.fn<PublicHttpRequester>(async () => {
      throw reset;
    })).download('ofac_sdn').catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(SanctionsOperatorRefreshError);
    expect(failure).toMatchObject({ code: 'SANCTIONS_OPERATOR_DOWNLOAD_FAILED', message: 'SANCTIONS_OPERATOR_DOWNLOAD_FAILED: ECONNRESET' });
    expect(Object.keys(failure as object).sort()).toEqual(['code', 'name']);

    const long = await downloadsWith(vi.fn<PublicHttpRequester>(async () => {
      throw new Error('x'.repeat(5_000));
    })).download('ofac_sdn').catch((error: unknown) => error as Error);
    expect(long.message.length).toBeLessThan(250);
  });
});

describe('OperatorSanctionsDownloads.download retries', () => {
  function retrying(request: PublicHttpRequester) {
    const sleep = vi.fn(async (_ms: number) => undefined);
    const log = vi.fn();
    const downloads = new OperatorSanctionsDownloads({
      endpoints: officialSanctionsEndpoints(),
      sourcePolicy: allowAll(),
      request,
      timeoutMs: 600_000,
      sleep,
      log,
    });
    return { downloads, sleep, log };
  }

  it('retries a socket reset and a failed DNS answer, then returns the list', async () => {
    const reset = Object.assign(new Error('read ECONNRESET'), { errno: -104, code: 'ECONNRESET', syscall: 'read' });
    const request = vi.fn<PublicHttpRequester>()
      .mockRejectedValueOnce(reset)
      .mockRejectedValueOnce(new EgressBlockedError('dns_lookup_failed'))
      .mockResolvedValueOnce(response());
    const { downloads, sleep, log } = retrying(request);

    await expect(downloads.download('ofac_sdn')).resolves.toMatchObject({ key: 'ofac_sdn', bytes: Buffer.byteLength(OFAC_XML) });

    expect(request).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([5_000, 15_000]);
    expect(log).toHaveBeenCalledWith('ofac_sdn: attempt 1 of 4 failed (SANCTIONS_OPERATOR_DOWNLOAD_FAILED: ECONNRESET); retrying in 5 s');
    expect(log).toHaveBeenCalledWith('ofac_sdn: attempt 2 of 4 failed (SANCTIONS_OPERATOR_DOWNLOAD_BLOCKED: dns_lookup_failed); retrying in 15 s');
  });

  it.each([429, 500, 502, 503, 504])('retries an HTTP %i answer', async (status) => {
    const request = vi.fn<PublicHttpRequester>()
      .mockResolvedValueOnce(response({ status }))
      .mockResolvedValueOnce(response());
    const { downloads } = retrying(request);

    await expect(downloads.download('ofac_sdn')).resolves.toMatchObject({ key: 'ofac_sdn' });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('gives up after four attempts with the last failure', async () => {
    const request = vi.fn<PublicHttpRequester>(async () => {
      throw new Error('public_http_timeout');
    });
    const { downloads, sleep } = retrying(request);

    await expect(downloads.download('ofac_sdn')).rejects.toThrow('SANCTIONS_OPERATOR_DOWNLOAD_FAILED: public_http_timeout');
    expect(request).toHaveBeenCalledTimes(4);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([5_000, 15_000, 45_000]);
  });

  it.each([
    ['a non-public address', async () => { throw new EgressBlockedError('non_global_address'); }],
    ['an oversized list', async () => { throw new EgressBlockedError('response_too_large'); }],
    ['an HTTP 404', async () => response({ status: 404 })],
    ['a non-XML media type', async () => response({ headers: { 'content-type': 'text/html' } })],
    ['XML that fails the safety gate', async () => response({ body: '<!DOCTYPE x [<!ENTITY y "z">]><sdnList/>' })],
  ] as const)('does not retry %s', async (_case, answer) => {
    const request = vi.fn<PublicHttpRequester>(answer);
    const { downloads, sleep } = retrying(request);

    await expect(downloads.download('ofac_sdn')).rejects.toThrow(SanctionsOperatorRefreshError);
    expect(request).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe('OperatorSanctionsDownloads as the refresh service broker', () => {
  const ctx = { workspaceId: 'platform', purpose: 'sanctions_screening' };

  it('serves an official list without a durable receipt and records what it served', async () => {
    const request = vi.fn<PublicHttpRequester>(async () => response());
    const downloads = downloadsWith(request);

    const result = await downloads.invoke('sanctions.download', { url: SDN_URL }, ctx);

    expect(result).toEqual({
      data: { body: OFAC_XML, contentType: 'text/xml', lastModified: 'Fri, 09 Oct 2026 21:00:00 GMT' },
      costCents: 0,
    });
    expect(result).not.toHaveProperty('durableReceipt');
    expect(downloads.served('ofac_sdn')).toMatchObject({
      download: { key: 'ofac_sdn', finalHost: 'wc2h-sls-prod-public-published.s3.us-gov-west-1.amazonaws.com', bytes: Buffer.byteLength(OFAC_XML) },
      census: { kept: 2, dropped: { Individual: 2, Vessel: 1, Aircraft: 1 } },
    });
    expect(downloads.served('ofac_sdn')!.download).not.toHaveProperty('body');
  });

  it('refuses every other tool and every URL that is not a selected official endpoint', async () => {
    const request = vi.fn<PublicHttpRequester>(async () => response());
    const downloads = downloadsWith(request, allowAll(), ['ofac_sdn']);

    await expect(downloads.invoke('http.get', { url: SDN_URL }, ctx)).rejects.toThrow(/SANCTIONS_OPERATOR_TOOL_UNSUPPORTED/);
    await expect(downloads.invoke('sanctions.download', { url: 'https://attacker.example/SDN.XML' }, ctx))
      .rejects.toThrow(/SANCTIONS_OPERATOR_SOURCE_NOT_SELECTED/);
    await expect(downloads.invoke('sanctions.download', { url: EU_URL }, ctx))
      .rejects.toThrow(/SANCTIONS_OPERATOR_SOURCE_NOT_SELECTED/);
    expect(request).not.toHaveBeenCalled();
  });

  it('answers source policy questions through the injected ToolBroker decision', async () => {
    const sourcePolicy = { checkSourcePolicy: vi.fn(async () => ({ allowed: false, reason: 'suspended' as const })) };
    const downloads = downloadsWith(vi.fn<PublicHttpRequester>(), sourcePolicy);

    await expect(downloads.checkSourcePolicy('sanctions.download', OFAC_HOST, 'sanctions_screening'))
      .resolves.toEqual({ allowed: false, reason: 'suspended' });
  });
});
