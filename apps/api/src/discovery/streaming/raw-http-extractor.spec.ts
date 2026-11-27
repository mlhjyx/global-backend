import { describe, expect, it, vi } from 'vitest';
import type { ExecutionBroker, ToolContext } from '../../tools/tool-contract';
import {
  buildWwwFallbackUrl,
  extractCompanyWebsiteStreaming,
  extractHtmlChannelsAndLinks,
  extractJsonLdFacts,
  extractVisibleBodyText,
  isPdfBodyContent,
  isWwwRetryableError,
} from './raw-http-extractor';

const WORKSPACE_ID = '10000000-0000-4000-8000-000000000001';
const COMPANY_ID = '20000000-0000-4000-8000-000000000002';
const RUN_ID = '30000000-0000-4000-8000-000000000003';

const RICH_HTML = `<!doctype html>
<html lang="it">
<head>
  <title>Solare Italia Distribuzione S.r.l. - Moduli Fotovoltaici B2B</title>
  <meta name="description" content="Distributore italiano di moduli fotovoltaici, inverter e sistemi di accumulo per installatori e EPC.">
  <style>.nav { color: red; } body { font-family: sans-serif; }</style>
  <script>window.__DATA__ = { secret: "should not appear in visible body text" };</script>
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "Organization",
    "name": "Solare Italia Distribuzione S.r.l.",
    "description": "Wholesale distributor of solar PV modules and inverters across Italy.",
    "email": "commerciale@solare-italia.it",
    "telephone": "+39 02 55501928",
    "sameAs": [
      "https://www.linkedin.com/company/solare-italia-distribuzione",
      "https://x.com/solareitalia"
    ]
  }
  </script>
</head>
<body>
  <header><nav><a href="/home">Home</a><a href="/contatti">Contatti</a></nav></header>
  <main>
    <h1>Solare Italia Distribuzione</h1>
    <p>Siamo un distributore all'ingrosso di pannelli solari fotovoltaici, inverter ibridi e batterie di accumulo per installatori professionisti e aziende EPC in tutta Italia. Oltre 250 MW spediti ogni anno dai nostri magazzini di Milano e Bologna.</p>
    <p>Ordina ora il catalogo rivenditori o contatta il nostro ufficio commerciale: <a href="mailto:sales@solare-italia.it">sales@solare-italia.it</a>, tel <a href="tel:+39-02-55501999">+39 02 55501999</a>.</p>
    <a href="/contatti">Richiedi preventivo</a>
    <a href="/catalogo-2026.pdf">Scarica catalogo PDF</a>
    <a href="/careers">Lavora con noi</a>
  </main>
  <footer>Copyright 2026 Solare Italia</footer>
</body>
</html>`;

const CONTACT_PAGE_HTML = `<!doctype html>
<html>
<head><title>Contatti - Solare Italia</title></head>
<body>
  <main>
    <h1>Contatta il team B2B</h1>
    <p>Scrivici a info@solare-italia.it o compila il modulo per listini grossisti e partnership EPC in tutta Italia.</p>
    <form action="/api/contact" method="post">
      <input type="text" name="name" placeholder="Nome" />
      <input type="email" name="email" placeholder="Email aziendale" />
      <textarea name="message"></textarea>
      <button type="submit">Invia richiesta</button>
    </form>
  </main>
</body>
</html>`;

const THIN_SPA_HTML = `<!doctype html>
<html>
<head><title>SolarGrid GmbH</title><script src="/bundle.js"></script></head>
<body><div id="root"></div><noscript>Please enable JavaScript.</noscript></body>
</html>`;

const RENDERED_SPA_HTML = `<!doctype html>
<html>
<head><title>SolarGrid GmbH - PV Grosshandel</title></head>
<body>
  <main>
    <h1>SolarGrid GmbH</h1>
    <p>Ihr Photovoltaik Grosshandel und Systemlieferant fuer Solarteure und Projektentwickler in Deutschland und Oesterreich. Lagerware ab Muenchen mit direkter Baustellenlieferung.</p>
    <a href="mailto:vertrieb@solargrid.de">vertrieb@solargrid.de</a>
    <a href="https://www.linkedin.com/company/solargrid-gmbh">LinkedIn</a>
  </main>
</body>
</html>`;

function createMockBroker(
  handler: (toolId: string, input: Record<string, unknown>, ctx: ToolContext) => Promise<{ data: unknown }>,
): ExecutionBroker {
  return {
    invoke: vi.fn(async (toolId: string, input: unknown, ctx: ToolContext) => {
      const res = await handler(toolId, (input ?? {}) as Record<string, unknown>, ctx);
      return {
        data: res.data,
        costCents: toolId === 'crawl4ai.render' ? 1 : 0,
        durationMs: 50,
        degraded: false,
      };
    }),
  } as unknown as ExecutionBroker;
}

describe('raw-http-extractor pure helpers (3 empirical laws from #30)', () => {
  it('Law 1: strips script/style/nav/header/footer/noscript and measures visible body text accurately', () => {
    const visible = extractVisibleBodyText(RICH_HTML);
    expect(visible).toContain('Solare Italia Distribuzione');
    expect(visible).toContain('pannelli solari fotovoltaici');
    expect(visible).not.toContain('window.__DATA__');
    expect(visible).not.toContain('font-family');
    expect(visible).not.toContain('Copyright 2026');
    expect(visible.length).toBeGreaterThanOrEqual(200);

    const thin = extractVisibleBodyText(THIN_SPA_HTML);
    expect(thin.length).toBeLessThan(200);
  });

  it('extracts JSON-LD organization facts, emails, phones, and sameAs links safely', () => {
    const facts = extractJsonLdFacts(RICH_HTML);
    expect(facts.organizationNames).toContain('Solare Italia Distribuzione S.r.l.');
    expect(facts.emails).toContain('commerciale@solare-italia.it');
    expect(facts.phones).toContain('+390255501928');
    expect(facts.socialLinks).toContain('https://www.linkedin.com/company/solare-italia-distribuzione');
  });

  it('extracts role emails, phones, socials, inquiry forms, and skips .pdf links for 1-hop contact page', () => {
    const extracted = extractHtmlChannelsAndLinks(
      RICH_HTML,
      'https://solare-italia.it/',
      'solare-italia.it',
    );
    expect(extracted.roleEmails).toEqual(
      expect.arrayContaining(['commerciale@solare-italia.it', 'sales@solare-italia.it']),
    );
    expect(extracted.phones.length).toBeGreaterThanOrEqual(1);
    expect(extracted.socialLinks).toEqual(
      expect.arrayContaining(['https://www.linkedin.com/company/solare-italia-distribuzione']),
    );
    expect(extracted.contactPageUrl).toBe('https://solare-italia.it/contatti');
    expect(extracted.careersPageUrl).toBe('https://solare-italia.it/careers');
    expect(extracted.hasInquiryForm).toBe(false);

    const contactExtracted = extractHtmlChannelsAndLinks(
      CONTACT_PAGE_HTML,
      'https://solare-italia.it/contatti',
      'solare-italia.it',
    );
    expect(contactExtracted.hasInquiryForm).toBe(true);
    expect(contactExtracted.roleEmails).toContain('info@solare-italia.it');
  });

  it('Law 2: detects ERR_TLS_CERT_ALTNAME_INVALID / UND_ERR_SOCKET and builds www. fallback URL', () => {
    const tlsErr = Object.assign(new Error('Hostname/IP does not match certificate altnames'), {
      code: 'ERR_TLS_CERT_ALTNAME_INVALID',
    });
    const socketErr = Object.assign(new Error('fetch failed'), {
      cause: { code: 'UND_ERR_SOCKET' },
    });
    expect(isWwwRetryableError(tlsErr)).toBe(true);
    expect(isWwwRetryableError(socketErr)).toBe(true);
    expect(isWwwRetryableError(new Error('HTTP 404 Not Found'))).toBe(false);

    expect(buildWwwFallbackUrl('https://acme.de/contact')).toBe('https://www.acme.de/contact');
    expect(buildWwwFallbackUrl('https://www.acme.de/contact')).toBeNull();
  });

  it('Law 3: detects PDF binary body prefix', () => {
    expect(isPdfBodyContent('%PDF-1.7\n1 0 obj')).toBe(true);
    expect(isPdfBodyContent('   %PDF-1.4')).toBe(true);
    expect(isPdfBodyContent('<!doctype html><html></html>')).toBe(false);
  });

  it('CodeQL hardening: decodes HTML entities in a single pass and ignores non-http(s) href schemes', () => {
    const html = `<html><body><main>
      <p>A &amp;lt; B &amp; C &#39;quoted&#39;</p>
      <a href="javascript:alert(1)">bad1</a>
      <a href="data:text/html,evil">bad2</a>
      <a href="vbscript:msgbox(1)">bad3</a>
      <a href="/contact">Contact</a>
    </main></body></html>`;
    const visible = extractVisibleBodyText(html);
    expect(visible).toContain("A &lt; B & C 'quoted'");
    const extracted = extractHtmlChannelsAndLinks(html, 'https://acme.de/', 'acme.de');
    expect(extracted.contactPageUrl).toBe('https://acme.de/contact');
    expect(extracted.socialLinks).toEqual([]);
  });
});

describe('extractCompanyWebsiteStreaming single-activity flow', () => {
  it('succeeds via Raw HTTP only on static HTML site and merges 1-hop contact page without calling Crawl4AI', async () => {
    const calls: string[] = [];
    const broker = createMockBroker(async (toolId, input, ctx) => {
      calls.push(`${toolId}:${String(input.url)}`);
      expect(ctx.artifactSubject).toEqual({ subjectType: 'company', subjectId: COMPANY_ID });
      const url = String(input.url);
      if (url.endsWith('/robots.txt')) {
        return { data: { status: 404, ok: false, mediaType: 'text/plain', text: '' } };
      }
      if (url === 'https://solare-italia.it/') {
        return { data: { status: 200, ok: true, mediaType: 'text/plain', text: RICH_HTML, finalUrl: url } };
      }
      if (url === 'https://solare-italia.it/contatti') {
        return { data: { status: 200, ok: true, mediaType: 'text/plain', text: CONTACT_PAGE_HTML, finalUrl: url } };
      }
      throw new Error(`unexpected url ${url}`);
    });

    const result = await extractCompanyWebsiteStreaming({
      broker,
      workspaceId: WORKSPACE_ID,
      companyId: COMPANY_ID,
      runId: RUN_ID,
      domain: 'solare-italia.it',
      inspectPassiveDns: async () => null,
    });

    expect(result.fetchMethod).toBe('raw_http');
    expect(result.usedCrawl4aiFallback).toBe(false);
    expect(result.usedWwwRetry).toBe(false);
    expect(result.pdfSkipped).toBe(false);
    expect(result.channels.roleEmails).toEqual(
      expect.arrayContaining(['commerciale@solare-italia.it', 'sales@solare-italia.it', 'info@solare-italia.it']),
    );
    expect(result.channels.hasInquiryForm).toBe(true);
    expect(result.channels.contactFormUrl).toBe('https://solare-italia.it/contatti');
    expect(result.channels.careersPageUrl).toBe('https://solare-italia.it/careers');
    expect(calls.some((c) => c.startsWith('crawl4ai.render:'))).toBe(false);
  });

  it('Law 1: falls back to crawl4ai.render when DOM-denoised visible body text is < 200 chars', async () => {
    const calls: string[] = [];
    const broker = createMockBroker(async (toolId, input) => {
      calls.push(`${toolId}:${String(input.url)}`);
      const url = String(input.url);
      if (url.endsWith('/robots.txt')) {
        return { data: { status: 404, ok: false, mediaType: 'text/plain', text: '' } };
      }
      if (toolId === 'http.get') {
        return { data: { status: 200, ok: true, mediaType: 'text/plain', text: THIN_SPA_HTML, finalUrl: url } };
      }
      if (toolId === 'crawl4ai.render') {
        return { data: { url, html: RENDERED_SPA_HTML, headers: { 'content-type': 'text/html' } } };
      }
      throw new Error(`unexpected tool ${toolId}`);
    });

    const result = await extractCompanyWebsiteStreaming({
      broker,
      workspaceId: WORKSPACE_ID,
      companyId: COMPANY_ID,
      runId: RUN_ID,
      domain: 'solargrid.de',
      inspectPassiveDns: async () => null,
    });

    expect(result.fetchMethod).toBe('crawl4ai');
    expect(result.usedCrawl4aiFallback).toBe(true);
    expect(result.visibleText).toContain('Photovoltaik Grosshandel');
    expect(result.channels.roleEmails).toContain('vertrieb@solargrid.de');
    expect(calls).toContain('crawl4ai.render:https://solargrid.de/');
  });

  it('Law 2: retries once with www. prefix on ERR_TLS_CERT_ALTNAME_INVALID and succeeds via Raw HTTP', async () => {
    const calls: string[] = [];
    const broker = createMockBroker(async (toolId, input) => {
      const url = String(input.url);
      calls.push(`${toolId}:${url}`);
      if (url.endsWith('/robots.txt')) {
        return { data: { status: 404, ok: false, mediaType: 'text/plain', text: '' } };
      }
      if (url === 'https://solare-italia.it/') {
        throw Object.assign(new Error('ERR_TLS_CERT_ALTNAME_INVALID'), {
          code: 'ERR_TLS_CERT_ALTNAME_INVALID',
        });
      }
      if (url === 'https://www.solare-italia.it/') {
        return { data: { status: 200, ok: true, mediaType: 'text/plain', text: RICH_HTML, finalUrl: url } };
      }
      if (url === 'https://www.solare-italia.it/contatti' || url === 'https://solare-italia.it/contatti') {
        return { data: { status: 200, ok: true, mediaType: 'text/plain', text: CONTACT_PAGE_HTML, finalUrl: url } };
      }
      throw new Error(`unexpected url ${url}`);
    });

    const result = await extractCompanyWebsiteStreaming({
      broker,
      workspaceId: WORKSPACE_ID,
      companyId: COMPANY_ID,
      runId: RUN_ID,
      domain: 'solare-italia.it',
      inspectPassiveDns: async () => null,
    });

    expect(result.fetchMethod).toBe('raw_http');
    expect(result.usedWwwRetry).toBe(true);
    expect(result.homepageUrl).toBe('https://www.solare-italia.it/');
    expect(calls).toContain('http.get:https://www.solare-italia.it/');
    expect(calls.some((c) => c.startsWith('crawl4ai.render:'))).toBe(false);
  });

  it('Law 3: skips .pdf URLs and %PDF- bodies without ever invoking crawl4ai.render', async () => {
    const calls: string[] = [];
    const broker = createMockBroker(async (toolId, input) => {
      const url = String(input.url);
      calls.push(`${toolId}:${url}`);
      if (url.endsWith('/robots.txt')) {
        return { data: { status: 404, ok: false, mediaType: 'text/plain', text: '' } };
      }
      return { data: { status: 200, ok: true, mediaType: 'text/plain', text: '%PDF-1.7 binary', finalUrl: url } };
    });

    const urlSkip = await extractCompanyWebsiteStreaming({
      broker,
      workspaceId: WORKSPACE_ID,
      companyId: COMPANY_ID,
      runId: RUN_ID,
      domain: 'acme.de',
      homepageUrl: 'https://acme.de/brochure.pdf',
    });
    expect(urlSkip.pdfSkipped).toBe(true);
    expect(urlSkip.fetchMethod).toBe('skipped');
    expect(calls).toHaveLength(0);

    const bodySkip = await extractCompanyWebsiteStreaming({
      broker,
      workspaceId: WORKSPACE_ID,
      companyId: COMPANY_ID,
      runId: RUN_ID,
      domain: 'acme.de',
      homepageUrl: 'https://acme.de/download?id=1',
      inspectPassiveDns: async () => null,
    });
    expect(bodySkip.pdfSkipped).toBe(true);
    expect(bodySkip.fetchMethod).toBe('skipped');
    expect(calls.some((c) => c.startsWith('crawl4ai.render:'))).toBe(false);
  });

  it('respects robots.txt Disallow: / and skips fetching without calling Crawl4AI', async () => {
    const calls: string[] = [];
    const broker = createMockBroker(async (toolId, input) => {
      const url = String(input.url);
      calls.push(`${toolId}:${url}`);
      if (url.endsWith('/robots.txt')) {
        return {
          data: {
            status: 200,
            ok: true,
            mediaType: 'text/plain',
            text: 'User-agent: *\nDisallow: /\n',
          },
        };
      }
      throw new Error(`must not fetch ${url}`);
    });

    const result = await extractCompanyWebsiteStreaming({
      broker,
      workspaceId: WORKSPACE_ID,
      companyId: COMPANY_ID,
      runId: RUN_ID,
      domain: 'private-site.de',
      inspectPassiveDns: async () => null,
    });

    expect(result.robotsBlocked).toBe(true);
    expect(result.fetchMethod).toBe('skipped');
    expect(calls).toEqual(['http.get:https://private-site.de/robots.txt']);
  });

  it('does not attribute a legal representative from an off-site redirect to the company', async () => {
    const home = 'https://sunforge.example';
    const broker = createMockBroker(async (_toolId, input) => {
      const url = String(input.url);
      if (url.endsWith('/robots.txt')) {
        return { data: { status: 404, ok: false, mediaType: 'text/plain', text: '' } };
      }
      if (url === `${home}/`) {
        return {
          data: {
            status: 200, ok: true, mediaType: 'text/plain', finalUrl: url,
            text: `<main>${'Industrial pumps. '.repeat(20)}<a href="/impressum">Legal notice</a></main>`,
          },
        };
      }
      if (url === `${home}/impressum`) {
        return {
          data: {
            status: 200, ok: true, mediaType: 'text/plain',
            finalUrl: 'https://other-company.example/impressum',
            text: '<p>Geschäftsführer: Mira Levin</p>',
          },
        };
      }
      throw new Error('unexpected URL');
    });
    const result = await extractCompanyWebsiteStreaming({
      broker, workspaceId: WORKSPACE_ID, companyId: COMPANY_ID, runId: RUN_ID,
      domain: 'sunforge.example', inspectPassiveDns: async () => null,
    });
    expect(result.statutoryDirectors).toEqual([]);
    expect(result.pagesFetched).not.toContain('https://other-company.example/impressum');
  });

  it('F4 & F5: extracts statutory directors from footer & /informativa-privacy hop while running passive DNS in parallel', async () => {
    const homeWithFooterAndPrivacy = `<!doctype html><html><head><title>Novacrest S.r.l.</title></head><body>
      <main><p>${'Distributore fotovoltaico e sistemi di accumulo per installatori e EPC in Italia. '.repeat(4)}</p>
      <a href="/contatti">Contatti</a><a href="/informativa-privacy">Privacy</a></main>
      <footer><p>Amministratore Delegato: Mira Levin</p></footer>
    </body></html>`;
    const privacyHtml = `<html><body><p>Titolare del trattamento: Dott. Marco Verdi</p></body></html>`;
    const broker = createMockBroker(async (_toolId, input) => {
      const url = String(input.url);
      if (url.endsWith('/robots.txt')) {
        return { data: { status: 404, ok: false, mediaType: 'text/plain', text: '' } };
      }
      if (url === 'https://novacrest.example/') {
        return { data: { status: 200, ok: true, mediaType: 'text/plain', text: homeWithFooterAndPrivacy, finalUrl: url } };
      }
      if (url === 'https://novacrest.example/contatti') {
        return { data: { status: 200, ok: true, mediaType: 'text/plain', text: CONTACT_PAGE_HTML, finalUrl: url } };
      }
      if (url === 'https://novacrest.example/informativa-privacy') {
        return { data: { status: 200, ok: true, mediaType: 'text/plain', text: privacyHtml, finalUrl: url } };
      }
      throw new Error(`unexpected url ${url}`);
    });

    const result = await extractCompanyWebsiteStreaming({
      broker,
      workspaceId: WORKSPACE_ID,
      companyId: COMPANY_ID,
      runId: RUN_ID,
      domain: 'novacrest.example',
      inspectPassiveDns: async () => ({
        mxProvider: 'google_workspace',
        mxHosts: ['aspmx.l.google.com'],
        segVendors: [],
        spfIncludes: ['_spf.google.com', 'spf.hubspotemail.net'],
        dmarcPolicy: 'quarantine',
        verificationTokens: ['google'],
        techSignals: ['hubspot'],
      }),
    });

    expect(result.channels.impressumUrl).toBeNull();
    expect(result.channels.statutoryDisclosureUrl).toBe('https://novacrest.example/informativa-privacy');
    expect(result.statutoryDirectors?.map((d) => d.name)).toEqual(['Mira Levin']);
    expect(result.passiveDns?.mxProvider).toBe('google_workspace');
    expect(result.passiveDns?.techSignals).toEqual(['hubspot']);
  });

  it('warms urlContentCache with homepage and contact pages for L2 reuse', async () => {
    const put = vi.fn(async () => undefined);
    const cache = { get: vi.fn(async () => null), put };
    const broker = createMockBroker(async (_toolId, input) => {
      const url = String(input.url);
      if (url.endsWith('/robots.txt')) {
        return { data: { status: 404, ok: false, mediaType: 'text/plain', text: '' } };
      }
      if (url === 'https://solare-italia.it/') {
        return { data: { status: 200, ok: true, mediaType: 'text/html', text: RICH_HTML, finalUrl: 'https://www.solare-italia.it/' } };
      }
      if (url === 'https://www.solare-italia.it/contatti') {
        return { data: { status: 200, ok: true, mediaType: 'text/html', text: CONTACT_PAGE_HTML, finalUrl: url } };
      }
      throw new Error(`unexpected url ${url}`);
    });

    await extractCompanyWebsiteStreaming({
      broker,
      workspaceId: WORKSPACE_ID,
      companyId: COMPANY_ID,
      runId: RUN_ID,
      domain: 'solare-italia.it',
      inspectPassiveDns: async () => null,
      urlContentCache: cache,
    });

    const cachedUrls = put.mock.calls.map((call) => call[1]);
    expect(cachedUrls).toContain('https://www.solare-italia.it/');
    expect(cachedUrls).toContain('https://solare-italia.it/');
    expect(put.mock.calls[0]?.[0]).toBe(WORKSPACE_ID);
    expect(put.mock.calls[0]?.[3]).toBe('company-navigation/v2');
  });
});
