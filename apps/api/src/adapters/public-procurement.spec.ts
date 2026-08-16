import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PublicHttpDependencies, PublicHttpRequestOptions, PublicHttpResponse } from './guarded-http';

const { requestPublicHttpMock } = vi.hoisted(() => ({ requestPublicHttpMock: vi.fn() }));

vi.mock('./guarded-http', () => ({ requestPublicHttp: requestPublicHttpMock }));
import {
  GEBIZ_DATASET_ID,
  searchBrazilPncp,
  searchContractsFinder,
  searchSingaporeGebiz,
  searchUsaSpendingAwards,
  searchUkFindATender,
  searchWorldBankProcurement,
} from './public-procurement';

beforeEach(() => {
  requestPublicHttpMock.mockReset();
  requestPublicHttpMock.mockImplementation(async (
    raw: string,
    options: PublicHttpRequestOptions,
    dependencies: PublicHttpDependencies,
  ): Promise<PublicHttpResponse> => {
    await dependencies.beforeRequest?.();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    try {
      const response = await fetch(new URL(raw), {
        method: options.method,
        headers: options.headers,
        body: options.body,
        redirect: 'manual',
        signal: controller.signal,
      });
      const declaredLength = Number(response.headers.get('content-length'));
      if (Number.isFinite(declaredLength) && declaredLength > (options.maxBytes ?? 0)) {
        throw new Error(`public procurement response exceeds ${options.maxBytes} bytes`);
      }
      const body = Buffer.from(await response.arrayBuffer());
      if (body.length > (options.maxBytes ?? 0)) {
        throw new Error(`public procurement response exceeds ${options.maxBytes} bytes`);
      }
      return {
        status: response.status,
        ok: response.ok,
        headers: Object.fromEntries(response.headers.entries()),
        body,
        text: body.toString('utf8'),
        finalUrl: raw,
      };
    } finally {
      clearTimeout(timer);
    }
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function json(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    ...init,
  });
}

describe('World Bank procurement wire client', () => {
  it('keeps the procurement organization role explicit, excludes contacts, and hashes the exact body', async () => {
    const body = {
      total: '2',
      procnotices: [
        {
          id: 'OP-1',
          contact_organization: 'Water Project Implementation Unit',
          project_name: 'Clean Water Programme',
          project_id: 'P100',
          contact_ctry_name: 'Ghana',
          project_ctry_name: 'Kenya',
          bid_description: 'Industrial pump package',
          procurement_method_name: 'Request for Bids',
          submission_deadline_date: '2026-09-01T00:00:00Z',
          contact_name: 'Named Person',
          contact_email: 'named@example.test',
          contact_phone_no: '+1 555',
        },
        {
          id: 'OP-2',
          project_name: 'Project name is not a company',
          bid_description: 'Pump package',
        },
      ],
    };
    const rawBody = JSON.stringify(body);
    const fetchMock = vi.fn(async () => new Response(rawBody, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const beforeRequest = vi.fn(async () => undefined);

    const page = await searchWorldBankProcurement({ keywords: ['pump'], country: 'Kenya', limit: 2 }, beforeRequest);

    expect(beforeRequest).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.hostname).toBe('search.worldbank.org');
    expect(url.searchParams.get('qterm')).toBe('pump Kenya');
    expect(init).toMatchObject({ redirect: 'manual' });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(page.records).toEqual([
      expect.objectContaining({
        organizationName: 'Water Project Implementation Unit',
        organizationRole: 'procurement_buyer_or_implementing_agency',
        signalStage: 'published_notice',
        country: 'Ghana',
        projectCountry: 'Kenya',
      }),
    ]);
    expect(JSON.stringify(page.records)).not.toContain('named@example.test');
    expect(JSON.stringify(page.records)).not.toContain('Named Person');
    expect(page.provenance.contentHash).toBe(createHash('sha256').update(rawBody).digest('hex'));
    expect(page.provenance.sourceUrl).toContain('/api/v2/procnotices');
  });

  it('hashes the exact response bytes before strict UTF-8 decoding', async () => {
    const jsonBody = JSON.stringify({ total: 0, procnotices: [] });
    const rawBytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(jsonBody, 'utf8')]);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(rawBytes, { status: 200 })));

    const page = await searchWorldBankProcurement({ keywords: ['pump'] });

    expect(page.records).toEqual([]);
    expect(page.provenance.contentHash).toBe(createHash('sha256').update(rawBytes).digest('hex'));
    expect(page.provenance.contentHash).not.toBe(createHash('sha256').update(jsonBody).digest('hex'));
  });

  it('fails closed when a procurement response contains malformed UTF-8', async () => {
    const rawBytes = Buffer.concat([
      Buffer.from('{"total":0,"procnotices":[],"invalid":"', 'utf8'),
      Buffer.from([0xc3, 0x28]),
      Buffer.from('"}', 'utf8'),
    ]);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(rawBytes, { status: 200 })));

    await expect(searchWorldBankProcurement({ keywords: ['pump'] }))
      .rejects.toThrow(/invalid UTF-8/u);
  });

  it('does not promote a project title or contact-shaped text into an organization and drops unsafe free text', async () => {
    const body = {
      total: '3',
      procnotices: [
        {
          id: 'OP-PROJECT-AS-ORG',
          contact_organization: 'Clean Water Programme',
          project_name: 'Clean Water Programme',
          project_ctry_name: 'Kenya',
          bid_description: 'Industrial pump package',
        },
        {
          id: 'OP-CONTACT-AS-ORG',
          contact_organization: 'private@example.test',
          project_name: 'Safe Water Programme',
          project_ctry_name: 'Kenya',
          bid_description: 'Industrial pump package',
        },
        {
          id: 'OP-SAFE-ORG',
          contact_organization: 'Water Services Board',
          project_name: 'Safe Water Programme',
          project_ctry_name: 'Kenya',
          bid_description: 'Contact Jane Doe at private@example.test or +1 202-555-0100',
        },
      ],
    };
    vi.stubGlobal('fetch', vi.fn(async () => json(body)));

    const page = await searchWorldBankProcurement({ keywords: ['water'], country: 'Kenya' });

    expect(page.records).toEqual([
      expect.objectContaining({
        id: 'OP-SAFE-ORG',
        organizationName: 'Water Services Board',
        country: undefined,
        projectCountry: 'Kenya',
        title: 'Safe Water Programme',
      }),
    ]);
    expect(JSON.stringify(page.records)).not.toContain('Jane Doe');
    expect(JSON.stringify(page.records)).not.toContain('private@example.test');
    expect(JSON.stringify(page.records)).not.toContain('202-555-0100');
  });

  it('fails closed when the response exceeds the byte cap before reading it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({}, { headers: { 'content-length': String(8 * 1024 * 1024 + 1) } })),
    );
    await expect(searchWorldBankProcurement({ keywords: ['pump'] })).rejects.toThrow(/exceeds/u);
  });

  it('fails closed when a streamed body crosses the byte cap without a Content-Length header', async () => {
    const oversizedBody = `{"payload":"${'x'.repeat(8 * 1024 * 1024)}"}`;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(oversizedBody, { status: 200 })));
    await expect(searchWorldBankProcurement({ keywords: ['pump'] })).rejects.toThrow(/exceeds/u);
  });

  it('retries a stalled request twice, then aborts without hanging past the bounded total window', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(
        async (_url: URL, init: RequestInit) =>
          await new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
          }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const pending = searchWorldBankProcurement({ keywords: ['pump'] });
    const assertion = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(65_000);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe('USAspending awards wire client', () => {
  it('keeps the federal buyer and awarded supplier separate and preserves exact provenance', async () => {
    const payload = {
      page_metadata: { page: 1, hasNext: true },
      results: [{
        'Award ID': 'CONT_AWD_123',
        'Recipient Name': 'Acme Pump Systems Inc.',
        'Award Amount': 125000,
        Description: 'Industrial pump maintenance',
        'Start Date': '2026-01-15',
        'End Date': '2027-01-14',
        'Awarding Agency': 'Department of the Interior',
        'Awarding Sub Agency': 'Bureau of Reclamation',
        generated_internal_id: 'CONT_AWD_123_1400',
        recipient_email: 'person@example.test',
      }],
    };
    const rawBody = JSON.stringify(payload);
    const fetchMock = vi.fn(async () => new Response(rawBody, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const beforeRequest = vi.fn(async () => undefined);

    const page = await searchUsaSpendingAwards({
      keywords: ['industrial pump'],
      startDate: '2025-08-13',
      endDate: '2026-08-13',
      page: 1,
      limit: 5,
    }, beforeRequest);

    expect(beforeRequest).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.toString()).toBe('https://api.usaspending.gov/api/v2/search/spending_by_award/');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toMatchObject({
      filters: { award_type_codes: ['A', 'B', 'C', 'D'], keywords: ['industrial pump'] },
      page: 1,
      limit: 5,
      subawards: false,
    });
    expect(requestPublicHttpMock).toHaveBeenCalledWith(
      'https://api.usaspending.gov/api/v2/search/spending_by_award/',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"keywords":["industrial pump"]'),
        redirect: 'manual',
        maxRedirects: 0,
      }),
      expect.objectContaining({ beforeRequest }),
    );
    expect(page.records).toEqual([expect.objectContaining({
      awardId: 'CONT_AWD_123',
      awardingAgency: 'Department of the Interior',
      awardingSubAgency: 'Bureau of Reclamation',
      recipientName: 'Acme Pump Systems Inc.',
      amount: 125000,
    })]);
    expect(JSON.stringify(page.records)).not.toContain('person@example.test');
    expect(page.nextCursor).toBe('2');
    expect(page.provenance).toMatchObject({
      sourceUrl: 'https://api.usaspending.gov/api/v2/search/spending_by_award/',
      contentHash: createHash('sha256').update(rawBody).digest('hex'),
      parserVersion: 'usaspending-awards/v1',
    });
  });

  it.each([302, 303])('converts USAspending POST to GET after an allowed HTTP %s redirect', async (status) => {
    const redirectedUrl = 'https://api.usaspending.gov/api/v2/search/spending_by_award/?redirected=1';
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status, headers: { location: redirectedUrl } }))
      .mockResolvedValueOnce(json({ page_metadata: { page: 1, hasNext: false }, results: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const beforeRequest = vi.fn(async () => undefined);

    await searchUsaSpendingAwards({
      keywords: ['pump'], startDate: '2025-08-13', endDate: '2026-08-13', page: 1, limit: 5,
    }, beforeRequest);

    const first = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const second = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect(first.method).toBe('POST');
    expect(first.body).toBeTruthy();
    expect(second.method).toBe('GET');
    expect(second.body).toBeUndefined();
    expect(new Headers(second.headers).has('content-type')).toBe(false);
    expect(requestPublicHttpMock).toHaveBeenCalledTimes(2);
    expect(beforeRequest).toHaveBeenCalledTimes(2);
  });

  it('preserves USAspending POST body after an allowed HTTP 307 redirect', async () => {
    const redirectedUrl = 'https://api.usaspending.gov/api/v2/search/spending_by_award/?redirected=1';
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 307, headers: { location: redirectedUrl } }))
      .mockResolvedValueOnce(json({ page_metadata: { page: 1, hasNext: false }, results: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const beforeRequest = vi.fn(async () => undefined);

    await searchUsaSpendingAwards({
      keywords: ['pump'], startDate: '2025-08-13', endDate: '2026-08-13', page: 1, limit: 5,
    }, beforeRequest);

    const first = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const second = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect(second.method).toBe('POST');
    expect(second.body).toBe(first.body);
    expect(new Headers(second.headers).get('content-type')).toBe('application/json');
    expect(requestPublicHttpMock).toHaveBeenCalledTimes(2);
    expect(beforeRequest).toHaveBeenCalledTimes(2);
  });

  it('honors Retry-After for a bounded 429 retry and returns only the successful response', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('{"detail":"rate limited"}', {
        status: 429,
        headers: { 'retry-after': '2' },
      }))
      .mockResolvedValueOnce(json({ page_metadata: { page: 1, hasNext: false }, results: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const beforeRequest = vi.fn(async () => undefined);

    const pending = searchUsaSpendingAwards({
      keywords: ['pump'], startDate: '2025-08-13', endDate: '2026-08-13', page: 1, limit: 5,
    }, beforeRequest);
    const assertion = expect(pending).resolves.toMatchObject({ records: [] });
    await vi.advanceTimersByTimeAsync(2_001);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requestPublicHttpMock).toHaveBeenCalledTimes(2);
    expect(beforeRequest).toHaveBeenCalledTimes(2);
  });

  it('retries transient 503 responses twice, then surfaces the final failure with Retry-After evidence', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => new Response('{"detail":"unavailable"}', {
      status: 503,
      headers: { 'retry-after': '1' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const pending = searchUsaSpendingAwards({
      keywords: ['pump'], startDate: '2025-08-13', endDate: '2026-08-13', page: 1, limit: 5,
    });
    const assertion = expect(pending).rejects.toThrow(/HTTP 503.*retry-after=1/u);
    await vi.advanceTimersByTimeAsync(2_001);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does not retry a non-transient client failure', async () => {
    const fetchMock = vi.fn(async () => new Response('{"detail":"bad request"}', { status: 400 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(searchUsaSpendingAwards({
      keywords: ['pump'], startDate: '2025-08-13', endDate: '2026-08-13', page: 1, limit: 5,
    })).rejects.toThrow(/HTTP 400/u);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('fails closed when role-defining fields, dates or response metadata are invalid', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({
      page_metadata: { page: 1, hasNext: false },
      results: [{ 'Award ID': 'A-1', 'Recipient Name': 'Supplier without an agency' }],
    })));
    await expect(searchUsaSpendingAwards({
      keywords: ['pump'], startDate: '2025-08-13', endDate: '2026-08-13', page: 1,
    })).resolves.toMatchObject({ records: [] });
    await expect(searchUsaSpendingAwards({
      keywords: ['pump'], startDate: '2026-02-30', endDate: '2026-08-13', page: 1,
    })).rejects.toThrow(/valid YYYY-MM-DD/u);

    vi.stubGlobal('fetch', vi.fn(async () => json({ page_metadata: { page: 2, hasNext: false }, results: [] })));
    await expect(searchUsaSpendingAwards({
      keywords: ['pump'], startDate: '2025-08-13', endDate: '2026-08-13', page: 1,
    })).rejects.toThrow(/schema changed/u);
  });
});

describe('UK OCDS clients', () => {
  const release = {
    ocid: 'ocds-h6vhtk-abc123',
    id: '000001-2026',
    date: '2026-08-12T10:00:00Z',
    tag: ['award'],
    buyer: { id: 'buyer-1', name: 'City Council' },
    tender: {
      title: 'Pump maintenance',
      description: 'Maintain pumps',
      status: 'complete',
      tenderPeriod: { endDate: '2026-09-01T12:00:00Z' },
      value: { amount: 125000, currency: 'GBP' },
      classification: { scheme: 'CPV', id: '42122000', description: 'Pumps' },
      additionalClassifications: [{ scheme: 'CPV', id: '42122130', description: 'Water pumps' }],
    },
    parties: [
      {
        id: 'buyer-1',
        name: 'City Council',
        roles: ['buyer'],
        address: { countryName: 'United Kingdom' },
        details: { url: 'https://declared-buyer.example/path' },
        contactPoint: { name: 'Private Person', email: 'private@example.test' },
      },
      { id: 'supplier-1', name: 'Acme Pumps Ltd', roles: ['supplier'] },
    ],
    awards: [{ suppliers: [{ id: 'supplier-1', name: 'Acme Pumps Ltd' }] }],
  };

  it('Find a Tender splits buyer demand and awarded supplier without promoting a declared URL to identity', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        json({
          releases: [release],
          links: {
            next: 'https://www.find-tender.service.gov.uk/api/1.0/ocdsReleasePackages?cursor=YWJjZA%3D%3D&updatedTo=2026-08-12T23%3A59%3A59Z',
          },
        }),
      ),
    );
    const page = await searchUkFindATender({ updatedFrom: '2026-08-01T00:00:00', stage: 'award', limit: 1 });
    const [url] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as unknown as [URL];
    expect(url.searchParams.get('stages')).toBe('award');
    expect(page.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ organizationName: 'City Council', organizationRole: 'buyer', signalStage: 'awarded' }),
        expect.objectContaining({ organizationName: 'Acme Pumps Ltd', organizationRole: 'supplier', signalStage: 'awarded' }),
      ]),
    );
    expect(page.records.find((item) => item.organizationRole === 'buyer')?.declaredUrl).toBe(
      'https://declared-buyer.example/path',
    );
    expect(page.records.find((item) => item.organizationRole === 'buyer')).toMatchObject({
      noticeUrl: 'https://www.find-tender.service.gov.uk/Notice/000001-2026',
      deadline: '2026-09-01T12:00:00Z',
      estimatedValue: 125000,
      currency: 'GBP',
      classificationIds: ['42122000', '42122130'],
    });
    expect(page.records.every((item) => !('domain' in item))).toBe(true);
    expect(JSON.stringify(page.records)).not.toContain('private@example.test');
    expect(page.nextCursor).toBe(
      '{"cursor":"YWJjZA==","updatedFrom":"2026-08-01T00:00:00","updatedTo":"2026-08-12T23:59:59Z"}',
    );
    expect(page.provenance.parserVersion).toBe('uk-find-a-tender-ocds/v4');
  });

  it('reuses the official upper bound with an opaque cursor so later pages stay in one snapshot', async () => {
    const fetchMock = vi.fn(async () => json({ releases: [] }));
    vi.stubGlobal('fetch', fetchMock);

    await searchUkFindATender({
      updatedFrom: '2026-08-13T00:00:00Z',
      stage: 'tender',
      cursor: '{"cursor":"YWJjZA==","updatedFrom":"2026-08-01T00:00:00Z","updatedTo":"2026-08-12T23:59:59Z"}',
    });

    const [url] = fetchMock.mock.calls[0] as unknown as [URL];
    expect(url.searchParams.get('cursor')).toBe('YWJjZA==');
    expect(url.searchParams.get('updatedFrom')).toBe('2026-08-01T00:00:00Z');
    expect(url.searchParams.get('updatedTo')).toBe('2026-08-12T23:59:59Z');
    expect(url.searchParams.get('stages')).toBe('tender');
  });

  it('rejects a raw or malformed continuation cursor instead of mixing result snapshots', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ releases: [] })));
    await expect(searchUkFindATender({
      updatedFrom: '2026-08-01T00:00:00Z',
      stage: 'tender',
      cursor: 'YWJjZA==',
    })).rejects.toThrow(/opaque cursor/u);
  });

  it('rejects a next link that escapes the official host', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ releases: [], links: { next: 'https://attacker.example/steal?cursor=YWJjZA==' } })),
    );
    await expect(searchUkFindATender({ updatedFrom: '2026-08-01T00:00:00', stage: 'tender' })).rejects.toThrow(/escaped/u);
  });

  it('Contracts Finder uses the documented OCDS GET endpoint and preserves the same role split', async () => {
    const fetchMock = vi.fn(async () => json({ releases: [release] }));
    vi.stubGlobal('fetch', fetchMock);
    const page = await searchContractsFinder({
      publishedFrom: '2026-08-01T00:00:00Z',
      publishedTo: '2026-08-12T23:59:59Z',
      limit: 10,
      stage: 'tender',
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.pathname).toBe('/Published/Notices/OCDS/Search');
    expect(url.searchParams.get('stages')).toBe('tender');
    expect(init.method).not.toBe('POST');
    expect(page.records.some((item) => item.organizationRole === 'supplier')).toBe(true);
    expect(page.records.every((item) => item.noticeUrl === undefined)).toBe(true);
    expect(page.provenance.parserVersion).toBe('uk-contracts-finder-ocds/v4');
  });

  it('corrects contradictory UK constituent countries from structured address evidence without guessing from names', async () => {
    const makeRelease = (id: string, name: string, address: Record<string, unknown>) => ({
      ...release,
      ocid: `ocds-b5fd17-${id}`,
      id,
      tag: ['tender'],
      buyer: { id: `buyer-${id}`, name },
      parties: [{ id: `buyer-${id}`, name, roles: ['buyer'], address }],
      awards: [],
      tender: { ...release.tender, status: 'active' },
    });
    vi.stubGlobal('fetch', vi.fn(async () => json({
      releases: [
        makeRelease('newry', 'Newry, Mourne and Down District Council', {
          locality: 'Newry', postalCode: 'BT34 2QU', countryName: 'England',
        }),
        makeRelease('scotland', 'Scottish Buyer', { countryName: 'SCOTLAND' }),
        makeRelease('wales', 'Welsh Buyer', { region: 'wales' }),
        makeRelease('wales-postcode', 'Welsh Health Board', { postalCode: 'LL17 0JL', countryName: 'England' }),
        makeRelease('scotland-postcode', 'Scottish Health Board', { postalCode: 'EH1 1YZ', countryName: 'England' }),
        makeRelease('border-postcode', 'Border Buyer', { postalCode: 'SY10 1AA', countryName: 'England' }),
        makeRelease('invalid-postcode', 'Invalid Postcode Buyer', { postalCode: 'LL-private' }),
        makeRelease('consistent-evidence', 'Northern Irish Buyer', {
          region: 'UKN', postalCode: 'BT34 2QU', countryName: 'England',
        }),
        makeRelease('gbr', 'GBR Buyer', { countryName: 'GBR' }),
        makeRelease('official-name', 'Official Name Buyer', {
          countryName: 'United Kingdom of Great Britain and Northern Ireland',
        }),
        makeRelease('invalid-region-code', 'Invalid Region Buyer', { region: 'UKNOTREAL' }),
        makeRelease('no-guess', 'Northern Ireland in the organization name only', {}),
      ],
    })));

    const page = await searchContractsFinder({
      publishedFrom: '2026-08-01T00:00:00Z',
      limit: 100,
      stage: 'tender',
    });

    expect(page.records.map((item) => [item.releaseId, item.country, item.region])).toEqual([
      ['newry', 'United Kingdom', 'Northern Ireland'],
      ['scotland', 'United Kingdom', 'Scotland'],
      ['wales', 'United Kingdom', 'Wales'],
      ['wales-postcode', 'United Kingdom', 'Wales'],
      ['scotland-postcode', 'United Kingdom', 'Scotland'],
      ['border-postcode', 'United Kingdom', 'England'],
      ['invalid-postcode', undefined, undefined],
      ['consistent-evidence', 'United Kingdom', 'Northern Ireland'],
      ['gbr', 'United Kingdom', undefined],
      ['official-name', 'United Kingdom', undefined],
      ['invalid-region-code', undefined, undefined],
      ['no-guess', undefined, undefined],
    ]);
  });

  it('preserves an explicit foreign supplier country and does not guess for an addressless supplier', async () => {
    const foreignRelease = {
      ...release,
      parties: [
        release.parties[0],
        { ...release.parties[1], address: { countryName: 'France' } },
        { id: 'supplier-2', name: 'Addressless Supplier', roles: ['supplier'] },
      ],
      awards: [{ suppliers: [
        { id: 'supplier-1', name: 'Acme Pumps Ltd' },
        { id: 'supplier-2', name: 'Addressless Supplier' },
      ] }],
    };
    vi.stubGlobal('fetch', vi.fn(async () => json({ releases: [foreignRelease] })));

    const page = await searchUkFindATender({ updatedFrom: '2026-08-01T00:00:00', stage: 'award' });
    expect(page.records.find((item) => item.sourcePartyId === 'supplier-1')?.country).toBe('France');
    expect(page.records.find((item) => item.sourcePartyId === 'supplier-2')?.country).toBeUndefined();
  });

  it('accepts the official Contracts Finder next-link upper bound with a numeric timezone offset', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({
        releases: [],
        links: {
          // The live service leaves the plus unescaped in links.next.
          next: 'https://www.contractsfinder.service.gov.uk/Published/Notices/OCDS/Search?cursor=YWJjZA%3D%3D&publishedTo=2026-08-12T20:17:54+01:00',
        },
      })),
    );

    const page = await searchContractsFinder({ publishedFrom: '2026-08-01T00:00:00', limit: 1, stage: 'tender' });
    expect(page.nextCursor).toBe(
      '{"cursor":"YWJjZA==","publishedFrom":"2026-08-01T00:00:00","publishedTo":"2026-08-12T20:17:54+01:00"}',
    );
  });

  it('rejects an impossible numeric timezone offset', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({
        releases: [],
        links: {
          next: 'https://www.contractsfinder.service.gov.uk/Published/Notices/OCDS/Search?cursor=YWJjZA%3D%3D&publishedTo=2026-08-12T20%3A17%3A54%2B24%3A00',
        },
      })),
    );

    await expect(searchContractsFinder({ publishedFrom: '2026-08-01T00:00:00', limit: 1, stage: 'tender' }))
      .rejects.toThrow(/publishedTo must be an ISO date-time/u);
  });
});

describe('Brazil PNCP', () => {
  it('returns an explicitly scoped public buyer demand signal and respects the API minimum page size', async () => {
    const fetchMock = vi.fn(async () =>
      json({
        data: [
          {
            numeroControlePNCP: '11222333000181-1-000001/2026',
            objetoCompra: '<b>Industrial pumps</b> private@example.test 11 99999-8888 123.456.789-00',
            dataEncerramentoProposta: '2026-09-01T12:00:00',
            valorTotalEstimado: 120000,
            orgaoEntidade: { razaoSocial: 'Municipio de Exemplo', cnpj: '11222333000181' },
            unidadeOrgao: { municipioNome: 'Recife', ufSigla: 'PE', codigoIbge: '2611606' },
          },
        ],
        totalRegistros: 21,
        totalPaginas: 3,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const page = await searchBrazilPncp({ dateFinal: '20260812', page: 1, pageSize: 1, uf: ' pe ' });
    const [url] = fetchMock.mock.calls[0] as unknown as [URL];
    expect(url.searchParams.get('tamanhoPagina')).toBe('10');
    expect(url.searchParams.get('uf')).toBe('PE');
    expect(page.records[0]).toMatchObject({
      organizationName: 'Municipio de Exemplo',
      organizationRole: 'buyer',
      signalStage: 'open_for_proposals',
      buyerCnpjClaim: '11222333000181',
      unitMunicipality: 'Recife',
      unitState: 'PE',
      unitIbgeCode: '2611606',
    });
    expect(page.records[0].title).not.toMatch(/private@example|99999-8888|123\.456/u);
    expect(page.provenance.parserVersion).toBe('brazil-pncp-proposals/v3');
    expect(page.nextCursor).toBe('2');
  });

  it('admits a CNPJ claim only when it is numeric, checksum-valid, and matches the control prefix', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({
        data: [
          {
            numeroControlePNCP: '11222333000181-1-000001/2026',
            objetoCompra: 'Valid pump procurement',
            orgaoEntidade: { razaoSocial: 'Valid Buyer', cnpj: '11222333000181' },
          },
          {
            numeroControlePNCP: '11222333000182-1-000002/2026',
            objetoCompra: 'Invalid checksum pump procurement',
            orgaoEntidade: { razaoSocial: 'Invalid Checksum Buyer', cnpj: '11222333000182' },
          },
          {
            numeroControlePNCP: '12345678000190-1-000003/2026',
            objetoCompra: 'Mismatched pump procurement',
            orgaoEntidade: { razaoSocial: 'Mismatched Buyer', cnpj: '11222333000181' },
          },
          {
            numeroControlePNCP: 'ABCDEFGHIJKLMN-1-000004/2026',
            objetoCompra: 'Alphanumeric pump procurement',
            orgaoEntidade: { razaoSocial: 'Alphanumeric Buyer', cnpj: 'ABCDEFGHIJKLMN' },
          },
          {
            numeroControlePNCP: '11222333000181-1-000005/2026',
            objetoCompra: 'Formatted CNPJ pump procurement',
            orgaoEntidade: { razaoSocial: 'Formatted CNPJ Buyer', cnpj: '11.222.333/0001-81' },
          },
        ],
        totalRegistros: 5,
        totalPaginas: 1,
      })),
    );

    const page = await searchBrazilPncp({ dateFinal: '20260812' });

    expect(page.records.map((record) => record.buyerCnpjClaim)).toEqual([
      '11222333000181',
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });

  it('treats official 204 as an empty terminal page', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));
    const page = await searchBrazilPncp({ dateFinal: '20260812' });
    expect(page.records).toEqual([]);
    expect(page.nextCursor).toBeUndefined();
    expect(page.provenance.contentHash).toBe(createHash('sha256').update('').digest('hex'));
  });

  it('rejects an invalid PNCP state before the request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(searchBrazilPncp({ dateFinal: '20260812', uf: 'Brazil' }))
      .rejects.toThrow(/two-letter state code/u);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('Singapore GeBIZ', () => {
  it('emits awarded suppliers only and keeps the agency as buyer evidence', async () => {
    const fetchMock = vi.fn(async () =>
      json({
        success: true,
        result: {
          total: 2,
          records: [
            {
              _id: 1,
              tender_no: 'ABC001',
              tender_description: 'Industrial pump maintenance',
              agency: 'Public Utilities Board',
              supplier_name: 'Acme Singapore Pte Ltd',
              tender_detail_status: 'Awarded to Suppliers',
              award_date: '12/8/2026',
              awarded_amt: '12345.50',
            },
            {
              _id: 2,
              tender_no: 'ABC002',
              tender_description: 'No supplier award',
              agency: 'Public Utilities Board',
              supplier_name: 'Unknown',
              tender_detail_status: 'Awarded to No Suppliers',
            },
          ],
        },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const page = await searchSingaporeGebiz({ keywords: ['pump'], limit: 2 });
    const [url] = fetchMock.mock.calls[0] as unknown as [URL];
    expect(url.searchParams.get('resource_id')).toBe(GEBIZ_DATASET_ID);
    expect(page.records).toEqual([
      expect.objectContaining({
        organizationName: 'Acme Singapore Pte Ltd',
        organizationRole: 'supplier',
        signalStage: 'awarded_historical',
        buyerAgency: 'Public Utilities Board',
        amount: 12345.5,
      }),
    ]);
  });

  it('drops placeholder and non-awarded supplier rows before they reach company discovery', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({
      success: true,
      result: {
        total: 3,
        records: [
          { _id: 1, tender_no: 'A', tender_description: 'Pump', agency: 'PUB', supplier_name: 'Unknown', tender_detail_status: 'Awarded to No Suppliers' },
          { _id: 2, tender_no: 'B', tender_description: 'Pump', agency: 'PUB', supplier_name: 'N/A', tender_detail_status: 'Awarded to Suppliers' },
          { _id: 3, tender_no: 'C', tender_description: 'Pump', agency: 'PUB', supplier_name: 'Acme Pte Ltd', tender_detail_status: 'Cancelled' },
        ],
      },
    })));
    await expect(searchSingaporeGebiz({ keywords: ['pump'], limit: 3 })).resolves.toMatchObject({ records: [] });
  });

  it.each(['Awarded to Suppliers', 'Awarded by Items', 'Award by interface record'])(
    'accepts the official successful award status %s',
    async (status) => {
      vi.stubGlobal('fetch', vi.fn(async () => json({
        success: true,
        result: { total: 1, records: [{
          _id: 1, tender_no: 'A', tender_description: 'Pump', agency: 'PUB',
          supplier_name: 'Acme Pte Ltd', tender_detail_status: status,
        }] },
      })));
      await expect(searchSingaporeGebiz({ keywords: ['pump'], limit: 1 }))
        .resolves.toMatchObject({ records: [expect.objectContaining({ organizationName: 'Acme Pte Ltd' })] });
    },
  );
});

describe('shared public procurement safety boundary', () => {
  it('fails closed on schema drift', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ success: true, result: { rows: [] } })));
    await expect(searchSingaporeGebiz({ keywords: ['pump'] })).rejects.toThrow(/schema changed/u);
  });

  it('rejects redirects away from the registered official host before the second request', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(null, { status: 302, headers: { location: 'https://attacker.example/payload' } }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await expect(searchSingaporeGebiz({ keywords: ['pump'] })).rejects.toThrow(/not allowed/u);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('re-runs the external request gate on every allowed redirect hop and records the final URL', async () => {
    const finalUrl = `https://data.gov.sg/api/action/datastore_search?resource_id=${GEBIZ_DATASET_ID}&limit=1`;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: finalUrl } }))
      .mockResolvedValueOnce(json({ success: true, result: { total: 0, records: [] } }));
    vi.stubGlobal('fetch', fetchMock);
    const beforeRequest = vi.fn(async () => undefined);

    const page = await searchSingaporeGebiz({ keywords: ['pump'], limit: 1 }, beforeRequest);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requestPublicHttpMock).toHaveBeenCalledTimes(2);
    expect(beforeRequest).toHaveBeenCalledTimes(2);
    expect(page.provenance.sourceUrl).toBe(finalUrl);
  });

  it('rejects redirects to an unregistered path on an otherwise official host', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(null, { status: 302, headers: { location: 'https://data.gov.sg/private/export' } }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await expect(searchSingaporeGebiz({ keywords: ['pump'] })).rejects.toThrow(/not allowed/u);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('rejects a lookalike path that merely starts with the registered endpoint text', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(null, {
        status: 302,
        headers: { location: 'https://data.gov.sg/api/action/datastore_searchevil' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await expect(searchSingaporeGebiz({ keywords: ['pump'] })).rejects.toThrow(/not allowed/u);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('rejects calendar dates that JavaScript would otherwise normalize silently', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ data: [] })));
    await expect(searchBrazilPncp({ dateFinal: '20260230' })).rejects.toThrow(/valid calendar date/u);
    await expect(searchUkFindATender({ updatedFrom: '2026-02-30T00:00:00Z', stage: 'tender' })).rejects.toThrow(/ISO date-time/u);
  });
});
