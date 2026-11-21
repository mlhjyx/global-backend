import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureCompanyContactNavigation } from './company-contact-navigation';
import { httpFirstParserVersion, fetchPageHttpFirst } from './http-first-fetch';
import { createPrismaUrlContentCache } from './url-content-cache';
import { createCrawl4aiFetchTool } from '../tools/builtin-tools';
import { findContactPaths } from '../discovery/website-profile/contact-paths';
import { companyContactObservation, persistCompanyContactPoints } from '../discovery/company-contact-points';

const URL = 'https://acme.example/';
const WS = '11111111-1111-4111-8111-111111111111';
const COMPANY = '22222222-2222-4222-8222-222222222222';
const BODY = 'Industrial pumps and equipment are distributed for manufacturing customers. '.repeat(1000);
const HTML = `<html><head><title>Acme Pumps GmbH</title></head><body><nav><a href="kontakt/">Kontakt</a></nav><article><h1>Acme Pumps</h1><p>${BODY}</p></article><footer><a href="/impressum/">Impressum</a></footer></body></html>`;
afterEach(() => vi.unstubAllEnvs());
async function throughTool(html = HTML, exactHtml?: true) {
  vi.stubEnv('HTTP_FIRST_FETCH', 'on');
  const fetchHtml = vi.fn(async () => ({ status: 200, contentType: 'text/html', body: Buffer.from(html) }));
  const renderer = vi.fn(async () => { throw new Error('renderer must not be used'); });
  const tool = createCrawl4aiFetchTool({ isAllowedByRobots: async () => true, crawlUrl: renderer,
    fetchHttpFirst: (url, settings) => fetchPageHttpFirst(url, { ...settings, fetchHtml }) });
  const result = await tool.execute({ url: URL, maxChars: 4000, ...(exactHtml ? { exactHtml } : {}) }, { workspaceId: WS });
  expect(fetchHtml).toHaveBeenCalledTimes(1); expect(renderer).not.toHaveBeenCalled();
  return result.data;
}

describe('same-response company navigation through the real tool', () => {
  it('retains long-page nav/footer URLs inside the final maxChars and persists only real unverified company points', async () => {
    const data = await throughTool();
    expect(data.text.length).toBeLessThanOrEqual(4000);
    const paths = findContactPaths(data.text, 'acme.example');
    expect(paths).toMatchObject({ contactPage: 'https://acme.example/kontakt', impressumPage: 'https://acme.example/impressum' });
    const tx = {
      $queryRaw: vi.fn(async (strings: TemplateStringsArray) => strings.join('').includes('FROM canonical_company')
        ? [{ status: 'NEW', name: 'Acme Pumps GmbH', domain: 'acme.example' }] : []),
      suppressionRecord: { findMany: vi.fn(async () => []) },
      companyContactPoint: { findMany: vi.fn(async () => []), createMany: vi.fn(async () => ({ count: 2 })),
        updateMany: vi.fn(async () => ({ count: 0 })) },
    };
    await persistCompanyContactPoints(tx as never, { workspaceId: WS, companyId: COMPANY,
      observation: companyContactObservation({ ...paths, linksChecked: false, contactForm: null, contactFormChecked: false }),
      seenAt: new Date('2026-11-21T00:00:00Z') });
    const written = tx.companyContactPoint.createMany.mock.calls[0]![0] as unknown as { data: Array<Record<string, unknown>> };
    expect(written.data.map(point => point.value).sort()).toEqual(['https://acme.example/impressum', 'https://acme.example/kontakt']);
    expect(written.data.every(point => point.status === 'UNVERIFIED' && point.dataClass === 'green')).toBe(true);
  });
  it('retains existing social company links instead of marking them absent after article projection', async () => {
    const html = HTML.replace(BODY, BODY.slice(0, 1200)).replace('</footer>',
      '<a href="https://www.linkedin.com/company/acme/">Company LinkedIn</a><a href="https://x.com/acme_pumps">Company X</a></footer>');
    const paths = findContactPaths((await throughTool(html)).text, 'acme.example');
    expect(paths).toMatchObject({ linkedinCompanyPage: 'https://www.linkedin.com/company/acme', xCompanyAccount: 'https://x.com/acme_pumps' });
    const existing = [
      { id: 'old-linkedin', kind: 'linkedin_company_page', value: 'https://www.linkedin.com/company/acme' },
      { id: 'old-x', kind: 'x_company_account', value: 'https://x.com/acme_pumps' },
    ].map(point => ({ ...point, status: 'UNVERIFIED', statusReason: null, providerKey: 'company_contact', updatedBy: null }));
    const updateMany = vi.fn(async (_args: { data: Record<string, unknown> }) => ({ count: 1 }));
    const tx = { $queryRaw: vi.fn(async (sql: TemplateStringsArray) => sql.join('').includes('FROM canonical_company')
      ? [{ status: 'NEW', name: 'Acme Pumps GmbH', domain: 'acme.example' }] : []),
      suppressionRecord: { findMany: vi.fn(async () => []) }, companyContactPoint: { findMany: vi.fn(async () => existing),
        createMany: vi.fn(async () => ({ count: 2 })), updateMany } };
    await persistCompanyContactPoints(tx as never, { workspaceId: WS, companyId: COMPANY,
      observation: companyContactObservation({ ...paths, linksChecked: true, contactForm: null, contactFormChecked: false }),
      seenAt: new Date('2026-11-21T00:00:00Z') });
    expect(updateMany.mock.calls.every(([args]) => args.data.statusReason !== 'REMOVED_FROM_SITE')).toBe(true);
  });

  it('does not let Tool input or context install a producer or choose the internal recipe', async () => {
    vi.stubEnv('HTTP_FIRST_FETCH', 'on');
    const hijack = vi.fn(() => '[Contact](https://acme.example/forged)');
    const tool = createCrawl4aiFetchTool({ isAllowedByRobots: async () => true,
      fetchHttpFirst: (url, settings) => fetchPageHttpFirst(url, { ...settings,
        fetchHtml: async () => ({ status: 200, contentType: 'text/html', body: Buffer.from(HTML) }) }) });
    const input = { url: URL, maxChars: 4000, captureNavigation: hijack, recipe: 'legacy' };
    const key = tool.idempotencyKey({ url: URL, maxChars: 4000 });
    expect(tool.idempotencyKey(input)).toBe(key);
    const data = (await tool.execute(input, { workspaceId: WS, captureNavigation: hijack, recipe: 'legacy' } as never)).data;
    expect(hijack).not.toHaveBeenCalled();
    expect(findContactPaths(data.text, 'acme.example').contactPage).toBe('https://acme.example/kontakt');
    expect(data.text).not.toContain('/forged');
  });

  it('does not alter legacy exactHtml without a manufacturer revision', async () => {
    const legacy = await throughTool(HTML, true);
    expect(legacy.text).not.toContain('https://acme.example/kontakt');
    expect(legacy.text).not.toContain('https://acme.example/impressum');
  });
  it('never reuses an old-format conditional304 row from the normal cache', async () => {
    const oldKey = createHash('sha256').update(URL).digest('hex');
    const legacy = { markdown: 'Old text without navigation', content_hash: 'b'.repeat(64), etag: 'old-etag', last_modified: null };
    const tx = { $queryRaw: vi.fn(async (_sql: TemplateStringsArray, ...values: unknown[]) => values[1] === oldKey ? [legacy] : []),
      $executeRaw: vi.fn(async () => 1) };
    const port = createPrismaUrlContentCache({ withWorkspace: async (_ws, fn) => fn(tx) });
    const fetchHtml = vi.fn(async () => ({ status: 304, contentType: null, body: Buffer.alloc(0) }));
    expect(await fetchPageHttpFirst(URL, { cache: { workspaceId: WS, port }, fetchHtml, captureNavigation: captureCompanyContactNavigation })).toBeNull();
    expect(fetchHtml).toHaveBeenCalledWith(URL, undefined);
  });
});

describe('navigation projection boundaries and cache recipe', () => {
  async function capture(links: string, head = '', finalUrl = URL, minChars = 200, article = BODY.slice(0, 1200)) {
    return fetchPageHttpFirst(URL, { minChars, captureNavigation: captureCompanyContactNavigation,
      fetchHtml: async () => ({ status: 200, finalUrl, contentType: 'text/html', body: Buffer.from(
        `<html><head><title>Original title</title>${head}</head><body><nav>${links}</nav><article><p>${article}</p></article></body></html>`) }) });
  }
  it('keeps only bounded real strict URLs, with invalid and duplicate anchors unable to starve a footer', async () => {
    const invalid = '<a href="mailto:person@acme.example">Mail</a><a href="/people/john-smith/contact">Contact John Smith</a>'.repeat(700);
    const duplicate = '<a href="/kontakt/">Contact John Smith</a>'.repeat(700);
    const page = await capture(invalid + duplicate + '<a href="/impressum?track=private">Impressum</a><a href="/lieferanten">Supplier</a>');
    const paths = findContactPaths(page!.markdown.slice(0, 4000), 'acme.example');
    expect(paths).toMatchObject({ contactPage: 'https://acme.example/kontakt', impressumPage: 'https://acme.example/impressum',
      supplierPage: 'https://acme.example/lieferanten' });
    const prefix = page!.markdown.split('\n\n')[0]!;
    expect(prefix.match(/\]\(/gu)).toHaveLength(3);
    expect(prefix).not.toMatch(/John|person@|track=|private/u);
  });
  it('honors same-site base and guarded final URL, while external bases/redirects cannot relabel relative URLs', async () => {
    expect(findContactPaths((await capture('<a href="kontakt">Kontakt</a>', '<base href="/de/">'))!.markdown, 'acme.example').contactPage)
      .toBe('https://acme.example/de/kontakt');
    for (const [head, finalUrl] of [['<base href="https://other.example/">', URL], ['', 'https://other.example/']]) {
      const page = await capture('<a href="/kontakt">Kontakt</a><a href="https://acme.example/impressum">Impressum</a>', head, finalUrl);
      expect(findContactPaths(page!.markdown, 'acme.example')).toMatchObject({ contactPage: null, impressumPage: 'https://acme.example/impressum' });
    }
    expect(findContactPaths((await capture('<a href="kontakt">Kontakt</a>', '', 'https://www.acme.example/de/'))!.markdown, 'acme.example').contactPage)
      .toBe('https://www.acme.example/de/kontakt');
  });
  it('keeps article links in the actual guarded redirect/base context too', async () => {
    const body = `${BODY.slice(0, 1200)}<a href="kontakt">Kontakt</a>`;
    const external = await capture('', '', 'https://other.example/', 200, body);
    expect(findContactPaths(external!.markdown, 'acme.example').contactPage).toBeNull();
    const same = await capture('', '', 'https://www.acme.example/de/', 200, body);
    expect(findContactPaths(same!.markdown, 'acme.example').contactPage).toBe('https://www.acme.example/de/kontakt');
  });

  it('preserves LinkedIn ambiguity and rejects personal/foreign/script-derived navigation', async () => {
    const page = await capture('<a href="https://www.linkedin.com/company/partner-one">One</a><a href="https://www.linkedin.com/company/partner-two">Two</a>' +
      '<a href="https://www.linkedin.com/in/person">Person</a><a href="https://other.example/contact">Contact</a>' +
      '<a href="/service"><script>Contact</script></a><template><a href="/kontakt">Contact</a></template>');
    expect(findContactPaths(page!.markdown, 'acme.example')).toMatchObject({ linkedinCompanyPage: null, contactPage: null });
    expect(page!.markdown).not.toContain('/in/person');
  });
  it('cannot turn navigation into a readable article or alter legacy body/hash/title without eligible links', async () => {
    expect(await capture('<a href="/kontakt">Contact</a>', '', URL, 10000, 'short')).toBeNull();
    const html = `<html><head><title>Original title</title></head><body><article><p>${BODY.slice(0, 1200)}</p></article><footer><a href="/people/john-smith">Contact John Smith</a></footer></body></html>`;
    const fetchHtml = async () => ({ status: 200, contentType: 'text/html', body: Buffer.from(html) });
    const legacy = await fetchPageHttpFirst(URL, { fetchHtml });
    const current = await fetchPageHttpFirst(URL, { fetchHtml, captureNavigation: captureCompanyContactNavigation });
    expect(current).toMatchObject({ markdown: legacy!.markdown, title: legacy!.title, contentHash: legacy!.contentHash });
    expect(httpFirstParserVersion(legacy!, false)).toBe('http-first/1');
    expect(httpFirstParserVersion(current!, false)).toBe('http-first/2');
  });
  it('handles malformed/oversized/inert anchors without retaining labels or claiming guessed response context', async () => {
    const page = await capture('<a href="">Contact</a><a href="http://%invalid">Contact</a>' +
      `<a href="${'x'.repeat(2050)}">Contact</a><a href="/service">${'x'.repeat(121)}</a>` +
      '<a href="/kontakt">Visible contact<script>person@acme.example</script></a>', '<base href="http://%invalid">');
    expect(findContactPaths(page!.markdown, 'acme.example').contactPage).toBe('https://acme.example/kontakt');
    expect(page!.markdown.split('\n\n')[0]).not.toContain('person@');
    const html = `<html><body><article><p>${BODY.slice(0, 1200)}</p></article></body></html>`;
    expect(await fetchPageHttpFirst(URL, { captureNavigation: captureCompanyContactNavigation,
      fetchHtml: async () => ({ status: 200, finalUrl: 'not-a-url', contentType: 'text/html', body: Buffer.from(html) }) })).toBeNull();
  });

  it('round-trips the current recipe on304 with real origin validators and unchanged content hash', async () => {
    const rows = new Map<unknown, Record<string, unknown>>();
    const tx = {
      $queryRaw: async (_sql: TemplateStringsArray, ...values: unknown[]) => rows.has(values[1]) ? [rows.get(values[1])] : [],
      $executeRaw: async (sql: TemplateStringsArray, ...values: unknown[]) => {
        if (sql.join('').includes('INSERT')) rows.set(values[1], { markdown: values[6], content_hash: values[5], etag: values[3], last_modified: values[4] });
        return 1;
      },
    };
    const port = createPrismaUrlContentCache({ withWorkspace: async (_ws, fn) => fn(tx) });
    const fetchHtml = vi.fn().mockResolvedValueOnce({ status: 200, contentType: 'text/html', body: Buffer.from(HTML), etag: 'origin-version' })
      .mockResolvedValueOnce({ status: 304, contentType: null, body: Buffer.alloc(0) });
    const options = { fetchHtml, cache: { workspaceId: WS, port }, captureNavigation: captureCompanyContactNavigation };
    const first = await fetchPageHttpFirst(URL, options), second = await fetchPageHttpFirst(URL, options);
    expect(second).toMatchObject({ markdown: first!.markdown, contentHash: first!.contentHash, parserVersion: 'http-first/2', fromCache: 'conditional-304' });
    expect(fetchHtml.mock.calls[1]![1]).toEqual({ ifNoneMatch: 'origin-version', ifModifiedSince: null });
    expect(findContactPaths(second!.markdown, 'acme.example').contactPage).toBe('https://acme.example/kontakt');
  });
});
