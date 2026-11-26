import { describe, expect, it } from 'vitest';
import {
  extractFooterContactsFromHtml,
  formatFooterContactsMarkdown,
} from './footer-contact-capture';
import { fetchPageHttpFirst } from './http-first-fetch';
import { captureCompanyContactNavigation } from './company-contact-navigation';
import { extractPublicContacts } from './contact-extractor';
import { collectCompanyChannels } from '../discovery/impressum/collect-company-channels';
import { parseImpressum } from '../discovery/website-profile/impressum';

const LONG_BODY = 'Commercial solar EPC installer delivering 600W-720W HJT utility and industrial rooftop projects. '.repeat(20);

describe('pre-Readability footer & business channel capture', () => {
  it('captures role mailto, tel, explicit public WhatsApp, VAT ID, address, and vendor portal while rejecting personal emails', () => {
    const html = `
      <html>
        <head><title>Sole EPC S.r.l.</title></head>
        <body>
          <article><h1>Sole EPC</h1><p>${LONG_BODY}</p></article>
          <footer>
            <address>Via Roma 12, 20121 Milano, Italy</address>
            <p>P.IVA IT12345678903</p>
            <a href="mailto:sales@sole-epc.it">Sales</a>
            <a href="mailto:mario.rossi@sole-epc.it">Mario Rossi</a>
            <a href="mailto:sales@other-agency.it">Agency</a>
            <a href="tel:+39 02 1234567">Call</a>
            <a href="https://api.whatsapp.com/send?phone=39021234567&text=Hello">WhatsApp Business</a>
            <a href="/fornitori">Fornitori</a>
          </footer>
        </body>
      </html>
    `;

    const captured = extractFooterContactsFromHtml(html, 'https://sole-epc.it/');
    expect(captured.roleEmails).toEqual(['sales@sole-epc.it']);
    expect(captured.phones).toEqual(['+39021234567']);
    expect(captured.whatsappUrls).toEqual(['https://wa.me/39021234567']);
    expect(captured.vatIds).toEqual(['IT12345678903']);
    expect(captured.addresses).toEqual(['Via Roma 12, 20121 Milano, Italy']);
    expect(captured.vendorPortalUrls).toEqual(['https://sole-epc.it/fornitori']);
    expect(formatFooterContactsMarkdown(captured)).not.toContain('mario.rossi');
  });

  it('preserves footer signals inside fetchPageHttpFirst markdown before Readability strips <footer>', async () => {
    const html = `
      <html>
        <head><title>NordSolar GmbH</title></head>
        <body>
          <article><h1>NordSolar</h1><p>${LONG_BODY}</p></article>
          <footer>
            <a href="mailto:export@nordsolar.de">Export</a>
            <a href="tel:+49309876543">Phone</a>
            <a href="https://wa.me/49309876543">WhatsApp</a>
            <p>USt-IdNr: DE136695976</p>
          </footer>
        </body>
      </html>
    `;
    const page = await fetchPageHttpFirst('https://nordsolar.de/', {
      captureNavigation: captureCompanyContactNavigation,
      fetchHtml: async () => ({
        status: 200,
        contentType: 'text/html',
        body: Buffer.from(html),
      }),
    });
    expect(page).not.toBeNull();
    expect(page!.markdown).toContain('export@nordsolar.de');
    expect(page!.markdown).toContain('https://wa.me/49309876543');
    expect(page!.markdown).toContain('DE136695976');

    const extracted = extractPublicContacts([{ url: 'https://nordsolar.de/', text: page!.markdown }]);
    expect(extracted.some((c) => c.type === 'email' && c.value === 'export@nordsolar.de')).toBe(true);
    expect(extracted.some((c) => c.type === 'phone' && c.value === '+49309876543')).toBe(true);
    expect(extracted.some((c) => c.type === 'social' && c.value === 'https://wa.me/49309876543')).toBe(true);
  });

  it('feeds footer role emails and phones into collectCompanyChannels on rendered HTML', () => {
    const channels = collectCompanyChannels({
      domain: 'sole-epc.it',
      country: 'IT',
      pages: [
        {
          url: 'https://sole-epc.it/contatti',
          kind: 'contact',
          text: 'Contatti Sole EPC',
          html: '<html><body><footer><p>Write to sales@sole-epc.it or +39 02 99887766</p></footer></body></html>',
        },
      ],
    });
    expect(channels.some((c) => c.channel === 'email' && c.value === 'sales@sole-epc.it')).toBe(true);
    expect(channels.some((c) => c.channel === 'phone' && c.value === '+390299887766')).toBe(true);
  });

  it('prevents <br /><a> and adjacent tag gluing from breaking VAT word boundaries (aegmarket.com regression)', async () => {
    const html = `
      <html>
        <head><title>AEG Market</title></head>
        <body>
          <article><h1>AEG Market</h1><p>${LONG_BODY}</p></article>
          <footer>
            <p>P.IVA IT02390660039<br /><a href="/termini">Termini e condizioni</a></p>
          </footer>
        </body>
      </html>
    `;
    const captured = extractFooterContactsFromHtml(html, 'https://aegmarket.com/');
    expect(captured.vatIds).toEqual(['IT02390660039']);

    // Adjacent <span> elements without whitespace also separate cleanly without breaking punctuation.
    const spanHtml = `
      <html><body><footer>
        <address><span>Via Roma 12</span>, <span>20121 Milano</span></address>
        <div><span>P.IVA IT02390660039</span><span>Termini</span></div>
      </footer></body></html>
    `;
    const spanCaptured = extractFooterContactsFromHtml(spanHtml, 'https://aegmarket.com/');
    expect(spanCaptured.vatIds).toEqual(['IT02390660039']);
    expect(spanCaptured.addresses).toEqual(['Via Roma 12, 20121 Milano']);

    const page = await fetchPageHttpFirst('https://aegmarket.com/', {
      captureNavigation: captureCompanyContactNavigation,
      fetchHtml: async () => ({
        status: 200,
        contentType: 'text/html',
        body: Buffer.from(html),
      }),
    });
    expect(page?.markdown).toContain('- VAT: IT02390660039');
    expect(parseImpressum(page!.markdown, { domain: 'aegmarket.com', countryHint: 'IT' }).vatId).toBe(
      'IT02390660039',
    );
  });

  it('extracts prefix-less 11-digit Italian P.IVA via eu-vat.ts on .it, S.r.l., and lang=it-IT contexts while rejecting bad checksums and unanchored domains', async () => {
    const italsolHtml = `
      <html><body>
        <article><h1>Italsol</h1><p>${LONG_BODY}</p></article>
        <footer><p>P. Iva e C.F. 02053810517</p></footer>
      </body></html>
    `;
    expect(extractFooterContactsFromHtml(italsolHtml, 'https://italsolsrl.it/').vatIds).toEqual([
      'IT02053810517',
    ]);

    const solarplaceHtml = `
      <html><body>
        <article><h1>Solarplace</h1><p>${LONG_BODY}</p></article>
        <footer><p>Solarplace S.r.l. - Partita IVA: 03899910925</p></footer>
      </body></html>
    `;
    expect(extractFooterContactsFromHtml(solarplaceHtml, 'https://solarplace.net/').vatIds).toEqual([
      'IT03899910925',
    ]);

    // Non-.it domain with <html lang="it-IT"> and bare P.IVA without S.r.l. in footer
    const langItHtml = `
      <html lang="it-IT"><body>
        <article><h1>Solarplace</h1><p>${LONG_BODY}</p></article>
        <footer><p>P.IVA 03899910925</p></footer>
      </body></html>
    `;
    expect(extractFooterContactsFromHtml(langItHtml, 'https://solarplace.net/').vatIds).toEqual([
      'IT03899910925',
    ]);

    // End-to-end through fetchPageHttpFirst -> parseImpressum
    const page = await fetchPageHttpFirst('https://italsolsrl.it/', {
      captureNavigation: captureCompanyContactNavigation,
      fetchHtml: async () => ({
        status: 200,
        contentType: 'text/html',
        body: Buffer.from(italsolHtml),
      }),
    });
    expect(page?.markdown).toContain('- VAT: IT02053810517');
    expect(parseImpressum(page!.markdown, { domain: 'italsolsrl.it', countryHint: 'IT' }).vatId).toBe(
      'IT02053810517',
    );

    // Rejects invalid checksums and unanchored non-Italian sites
    const invalidChecksumHtml = `
      <html><body><footer>
        <p>P.IVA IT12345678901 | USt-IdNr: DE987654321 | P.IVA 02875940163</p>
      </footer></body></html>
    `;
    expect(extractFooterContactsFromHtml(invalidChecksumHtml, 'https://italsolsrl.it/').vatIds).toEqual([]);

    const unanchoredHtml = `<html><body><footer><p>P.IVA 04553650989</p></footer></body></html>`;
    expect(extractFooterContactsFromHtml(unanchoredHtml, 'https://global-site.com/').vatIds).toEqual([]);
  });

  it('extracts JSON-LD vatID/taxID before script stripping even without <footer>, skips Person PII, and handles malformed/oversized/deep payloads safely', async () => {
    // gruppohvc.it regression: JSON-LD vatID in <head>, no <footer> tag at all
    const jsonLdOnlyHtml = `
      <html>
        <head>
          <title>Gruppo HVC</title>
          <script type="application/ld+json">{broken json</script>
          <script type="application/ld+json">
            {
              "@context": "https://schema.org",
              "@graph": [
                {
                  "@type": "Person",
                  "name": "Mario Rossi",
                  "email": "mario.rossi@gruppohvc.it",
                  "vatID": "IT02390660039",
                  "taxID": "IT04553650989"
                },
                {
                  "@type": "Organization",
                  "name": "Gruppo HVC S.r.l.",
                  "vatID": "IT05503370289"
                }
              ]
            }
          </script>
        </head>
        <body><article><h1>Gruppo HVC</h1><p>${LONG_BODY}</p></article></body>
      </html>
    `;

    const captured = extractFooterContactsFromHtml(jsonLdOnlyHtml, 'https://gruppohvc.it/');
    expect(captured.vatIds).toEqual(['IT05503370289']);
    expect(captured.roleEmails).toEqual([]);
    const md = formatFooterContactsMarkdown(captured);
    expect(md).toContain('- VAT: IT05503370289');
    expect(md).not.toContain('Mario Rossi');
    expect(md).not.toContain('IT02390660039');

    // Survives Readability inside fetchPageHttpFirst
    const page = await fetchPageHttpFirst('https://gruppohvc.it/', {
      captureNavigation: captureCompanyContactNavigation,
      fetchHtml: async () => ({
        status: 200,
        contentType: 'text/html',
        body: Buffer.from(jsonLdOnlyHtml),
      }),
    });
    expect(page?.markdown).toContain('- VAT: IT05503370289');
    expect(parseImpressum(page!.markdown, { domain: 'gruppohvc.it', countryHint: 'IT' }).vatId).toBe(
      'IT05503370289',
    );

    // JSON-LD taxID without IT prefix on .it domain
    const taxIdHtml = `
      <html><head>
        <script type="application/ld+json; charset=utf-8">
          {"@type":"Organization","taxID":"02053810517"}
        </script>
      </head><body></body></html>
    `;
    expect(extractFooterContactsFromHtml(taxIdHtml, 'https://italsolsrl.it/').vatIds).toEqual([
      'IT02053810517',
    ]);

    // Oversized JSON-LD (> 128 KB) and deeply nested JSON-LD (> depth 10) are safely skipped
    const hugePadding = 'a'.repeat(130_000);
    const oversizedHtml = `
      <html><head>
        <script type="application/ld+json">{"@type":"Organization","description":"${hugePadding}","vatID":"IT05503370289"}</script>
      </head><body></body></html>
    `;
    expect(extractFooterContactsFromHtml(oversizedHtml, 'https://gruppohvc.it/').vatIds).toEqual([]);

    let deepObj: Record<string, unknown> = { '@type': 'Organization', vatID: 'IT05503370289' };
    for (let i = 0; i < 12; i += 1) deepObj = { nested: deepObj };
    const deepHtml = `
      <html><head>
        <script type="application/ld+json">${JSON.stringify(deepObj)}</script>
      </head><body></body></html>
    `;
    expect(extractFooterContactsFromHtml(deepHtml, 'https://gruppohvc.it/').vatIds).toEqual([]);
  });
});
