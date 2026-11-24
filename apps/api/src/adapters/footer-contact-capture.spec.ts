import { describe, expect, it } from 'vitest';
import {
  extractFooterContactsFromHtml,
  formatFooterContactsMarkdown,
} from './footer-contact-capture';
import { fetchPageHttpFirst } from './http-first-fetch';
import { captureCompanyContactNavigation } from './company-contact-navigation';
import { extractPublicContacts } from './contact-extractor';
import { collectCompanyChannels } from '../discovery/impressum/collect-company-channels';

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
            <p>P.IVA IT12345678901</p>
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
    expect(captured.vatIds).toEqual(['IT12345678901']);
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
            <p>USt-IdNr: DE987654321</p>
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
    expect(page!.markdown).toContain('DE987654321');

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
});
