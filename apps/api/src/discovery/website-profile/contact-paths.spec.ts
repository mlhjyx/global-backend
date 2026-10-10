import { describe, expect, it } from 'vitest';
import {
  COMPANY_CONTACT_LINK_KINDS,
  COMPANY_CONTACT_POINT_KINDS,
  findContactPaths,
  hasContactForm,
  isCompanyContactPointValue,
} from './contact-paths';

// Synthetic pages only: `.example` hosts, made-up slugs and handles, no addresses, numbers or names.
const DOMAIN = 'pumpen-handel.example';
const NONE = {
  contactPage: null,
  impressumPage: null,
  supplierPage: null,
  linkedinCompanyPage: null,
  xCompanyAccount: null,
};

const links = (...lines: string[]) => lines.join('\n');

describe('company contact point kinds (BI-14)', () => {
  it('are links and a contact-form marker only', () => {
    expect(COMPANY_CONTACT_POINT_KINDS).toEqual([
      'contact_page',
      'impressum_page',
      'contact_form',
      'supplier_page',
      'linkedin_company_page',
      'x_company_account',
    ]);
    expect(COMPANY_CONTACT_LINK_KINDS).toEqual(
      COMPANY_CONTACT_POINT_KINDS.filter((kind) => kind !== 'contact_form'),
    );
  });
});

describe('findContactPaths (BI-14)', () => {
  it('finds the contact, Impressum and supplier pages by path, as https without query or fragment', () => {
    const home = links(
      '[Start](https://pumpen-handel.example/)',
      '[Produkte](https://pumpen-handel.example/produkte)',
      '[Kontakt](https://pumpen-handel.example/kontakt/)',
      '[Impressum](http://pumpen-handel.example/impressum.html#top)',
      '[Lieferant werden](https://www.pumpen-handel.example/de/lieferant-werden?ref=nav)',
    );

    expect(findContactPaths(home, DOMAIN)).toEqual({
      ...NONE,
      contactPage: 'https://pumpen-handel.example/kontakt',
      impressumPage: 'https://pumpen-handel.example/impressum.html',
      supplierPage: 'https://www.pumpen-handel.example/de/lieferant-werden',
    });
  });

  it('resolves relative links against the homepage and reads the link label', () => {
    const home = links(
      '[Kontakt](/seite/12)',
      '[Impressum](node/7)',
      '[Lieferantenportal](/portal)',
    );

    expect(findContactPaths(home, DOMAIN)).toEqual({
      ...NONE,
      contactPage: 'https://pumpen-handel.example/seite/12',
      impressumPage: 'https://pumpen-handel.example/node/7',
      supplierPage: 'https://pumpen-handel.example/portal',
    });
  });

  it('does not let a query string name the page of a label-only match', () => {
    expect(findContactPaths('[Kontakt](/index.php?id=12)', DOMAIN)).toEqual(NONE);
    // A path that names the page itself keeps working without its query.
    expect(findContactPaths('[Kontakt](/kontakt?lang=de)', DOMAIN).contactPage).toBe(
      'https://pumpen-handel.example/kontakt',
    );
  });

  it('keeps only links on the company domain or its subdomains', () => {
    const home = links(
      '[Kontakt](https://pumpen-handel.example.other.example/kontakt)',
      '[Kontakt](https://notpumpen-handel.example/kontakt)',
      '[Impressum](https://agentur.example/impressum)',
      '[Kontakt](javascript:void(0))',
      '[Kontakt](#kontakt)',
      '[Kontakt](https://pumpen-handel.example/)',
      '[Kontakt](https://pumpen-handel.example:8443/kontakt)',
      '[Kontakt](https://user:pw@pumpen-handel.example/kontakt)',
      '[Kontakt](ftp://pumpen-handel.example/kontakt)',
    );
    expect(findContactPaths(home, DOMAIN)).toEqual(NONE);

    expect(
      findContactPaths('[Kontakt](https://service.pumpen-handel.example/kontakt)', DOMAIN).contactPage,
    ).toBe('https://service.pumpen-handel.example/kontakt');
  });

  it('stores only paths made of known words, so no free page text reaches the stored link', () => {
    const rejected = [
      '/kontakt-qwx',
      '/abteilung-zz9/kontakt',
      '/de/service/info/kontakt',
      '/kontakt-1234567',
      '/kontakt.pdf',
      '/%E0%A4%A/kontakt',
    ];
    for (const path of rejected) {
      expect(findContactPaths(`[Kontakt](${path})`, DOMAIN).contactPage, path).toBeNull();
    }
    expect(findContactPaths('[Kontakt & Anfahrt](/kontakt-und-anfahrt)', DOMAIN).contactPage).toBe(
      'https://pumpen-handel.example/kontakt-und-anfahrt',
    );
    expect(findContactPaths('[Schreiben Sie uns](/de/unternehmen/kontakt.php)', DOMAIN).contactPage).toBe(
      'https://pumpen-handel.example/de/unternehmen/kontakt.php',
    );
    expect(findContactPaths('[Contact us](/en/contact-us)', DOMAIN).contactPage).toBe(
      'https://pumpen-handel.example/en/contact-us',
    );
  });

  it('keeps at most one link per kind: a path match first, then the shallower path, then the first one', () => {
    expect(
      findContactPaths(links('[Kontakt](/seite/3)', '[Schreiben](/kontaktformular)'), DOMAIN).contactPage,
    ).toBe('https://pumpen-handel.example/kontaktformular');
    expect(
      findContactPaths(links('[Kontakt](/service/kontakt)', '[Contact](/kontakt)'), DOMAIN).contactPage,
    ).toBe('https://pumpen-handel.example/kontakt');
    expect(
      findContactPaths(links('[Kontakt](/kontakt)', '[Contact](/contact)'), DOMAIN).contactPage,
    ).toBe('https://pumpen-handel.example/kontakt');
  });

  it('lets one page be both the contact page and the Impressum', () => {
    expect(findContactPaths('[Kontakt & Impressum](/kontakt-impressum)', DOMAIN)).toEqual({
      ...NONE,
      contactPage: 'https://pumpen-handel.example/kontakt-impressum',
      impressumPage: 'https://pumpen-handel.example/kontakt-impressum',
    });
  });

  it('recognises the German and English supplier and partner invitations', () => {
    const supplierLinks: Array<[string, string]> = [
      ['[Lieferanten](/lieferanten)', '/lieferanten'],
      ['[Für Lieferanten](/seite/4)', '/seite/4'],
      ['[Portal](/lieferantenportal)', '/lieferantenportal'],
      ['[Partner werden](/partner-werden)', '/partner-werden'],
      ['[Händler werden](/haendler-werden)', '/haendler-werden'],
      ['[Hersteller werden](/hersteller/hersteller-werden)', '/hersteller/hersteller-werden'],
      ['[Become a supplier](/en/become-a-supplier)', '/en/become-a-supplier'],
      ['[Supplier portal](/en/supplier-portal)', '/en/supplier-portal'],
      ['[Partner program](/en/partner-program)', '/en/partner-program'],
      ['[Partnerprogramm](/partnerprogramm)', '/partnerprogramm'],
    ];
    for (const [link, path] of supplierLinks) {
      expect(findContactPaths(link, DOMAIN).supplierPage, link).toBe(
        `https://pumpen-handel.example${path}`,
      );
    }
    for (const link of ['[Unsere Partner](/partner)', '[Händlersuche](/haendler)', '[Hersteller](/hersteller)']) {
      expect(findContactPaths(link, DOMAIN).supplierPage, link).toBeNull();
    }
  });

  it('keeps the company LinkedIn page and drops every other LinkedIn path', () => {
    expect(
      findContactPaths(
        '[LinkedIn](https://de.linkedin.com/company/pumpen-handel-example/?trk=footer)',
        DOMAIN,
      ).linkedinCompanyPage,
    ).toBe('https://www.linkedin.com/company/pumpen-handel-example');
    expect(
      findContactPaths('[](https://linkedin.com/showcase/pumpen-handel-service)', DOMAIN).linkedinCompanyPage,
    ).toBe('https://www.linkedin.com/showcase/pumpen-handel-service');

    const dropped = [
      'https://www.linkedin.com/in/zz-sample-slug',
      'https://www.linkedin.com/pub/zz-sample-slug',
      'https://www.linkedin.com/profile/view',
      'https://www.linkedin.com/feed/',
      'https://www.linkedin.com/posts/zz-sample-slug',
      'https://www.linkedin.com/company/pumpen-handel-example/people/',
      'https://www.linkedin.com/company/12345678',
      'https://www.linkedin.com/company/',
      'https://lnkd.in/zzsample',
      'https://www.linkedin.com.other.example/company/pumpen-handel-example',
    ];
    for (const url of dropped) {
      expect(findContactPaths(`[LinkedIn](${url})`, DOMAIN).linkedinCompanyPage, url).toBeNull();
    }
  });

  it('keeps an X account only when its handle carries the company domain name', () => {
    expect(
      findContactPaths('[X](https://twitter.com/PumpenHandelDE)', DOMAIN).xCompanyAccount,
    ).toBe('https://x.com/pumpenhandelde');
    expect(findContactPaths('[](https://x.com/pumpen_handel/)', DOMAIN).xCompanyAccount).toBe(
      'https://x.com/pumpen_handel',
    );

    const dropped = [
      'https://x.com/pumpenhandel/status/1',
      'https://twitter.com/intent/tweet',
      'https://twitter.com/share',
      'https://x.com/hashtag/pumpen',
      'https://x.com/search',
      'https://x.com/i/flow',
      'https://x.com/pumpenhandel_offiziell_de',
      'https://x.com/zz_unrelated_9',
      'https://x.com/',
      'https://x.com.other.example/pumpenhandel',
    ];
    for (const url of dropped) {
      expect(findContactPaths(`[X](${url})`, DOMAIN).xCompanyAccount, url).toBeNull();
    }
  });

  it('returns nothing for empty input or an unusable company domain', () => {
    expect(findContactPaths('', DOMAIN)).toEqual(NONE);
    expect(findContactPaths('[Kontakt](/kontakt)', 'not a domain')).toEqual(NONE);
    expect(findContactPaths('no links at all', DOMAIN)).toEqual(NONE);
  });
});

describe('isCompanyContactPointValue (BI-14)', () => {
  it('admits exactly the links the finder stores for each kind', () => {
    expect(isCompanyContactPointValue('contact_page', 'https://pumpen-handel.example/kontakt', DOMAIN)).toBe(true);
    expect(isCompanyContactPointValue('contact_form', 'https://www.pumpen-handel.example/kontakt', DOMAIN)).toBe(true);
    expect(
      isCompanyContactPointValue('linkedin_company_page', 'https://www.linkedin.com/company/pumpen-handel-example', DOMAIN),
    ).toBe(true);
    expect(isCompanyContactPointValue('x_company_account', 'https://x.com/pumpenhandel', DOMAIN)).toBe(true);

    for (const [kind, value] of [
      ['contact_page', 'https://agentur.example/kontakt'],
      ['contact_page', 'https://pumpen-handel.example/kontakt?x=1'],
      ['contact_page', 'https://pumpen-handel.example/kontakt#form'],
      ['contact_page', 'http://pumpen-handel.example/kontakt'],
      ['contact_page', 'https://pumpen-handel.example/'],
      ['impressum_page', 'https://www.linkedin.com/company/pumpen-handel-example'],
      ['linkedin_company_page', 'https://www.linkedin.com/in/zz-sample-slug'],
      ['x_company_account', 'https://twitter.com/pumpenhandel'],
      ['x_company_account', 'https://x.com/zz_unrelated_9'],
      ['phone', 'https://pumpen-handel.example/kontakt'],
    ] as const) {
      expect(isCompanyContactPointValue(kind, value, DOMAIN), `${kind} ${value}`).toBe(false);
    }
  });
});

describe('hasContactForm (BI-14)', () => {
  const form = (inner: string, attributes = '') => `<html><body><form${attributes}>${inner}</form></body></html>`;

  it('finds a contact form with a submit control, consent text and required fields', () => {
    expect(hasContactForm(form(
      '<label>Firma *</label><input name="firma" required>' +
        '<label>Nachricht</label><textarea name="nachricht"></textarea>' +
        '<label><input type="checkbox" required> Ich bin mit der Datenschutzerklärung einverstanden.</label>' +
        '<button type="submit">Absenden</button>',
      ' method="post" action="/kontakt"',
    ))).toBe(true);
  });

  it('needs two of the three signals: submit control, consent text, required-field markers', () => {
    expect(hasContactForm(form('<textarea></textarea><input type="submit" value="Senden"><span>Pflichtfeld</span>'))).toBe(true);
    expect(hasContactForm(form('<textarea></textarea><span role="button">Abschicken</span><p>Firma *</p>'))).toBe(true);
    expect(hasContactForm(form('<textarea></textarea><p>Mit dem Absenden stimmen Sie der Datenschutzerklärung zu.</p><a>Submit</a>'))).toBe(true);
    expect(hasContactForm(form('<textarea></textarea><button>Senden</button>'))).toBe(false);
    expect(hasContactForm(form('<textarea></textarea><p>Datenschutz</p>'))).toBe(false);
    expect(hasContactForm(form('<textarea aria-required="true"></textarea>'))).toBe(false);
  });

  it('ignores search, login, newsletter and shop forms', () => {
    const signals = '<button type="submit">Senden</button><input required><p>Datenschutz</p>';
    expect(hasContactForm(form(`<input type="search" name="q">${signals}`))).toBe(false);
    expect(hasContactForm(form(signals, ' role="search"'))).toBe(false);
    expect(hasContactForm(form(`<input type="password" name="pw">${signals}`))).toBe(false);
    expect(hasContactForm(form(`<p>Newsletter abonnieren</p>${signals}`))).toBe(false);
    expect(hasContactForm(form(signals, ' action="/warenkorb/add"'))).toBe(false);
    // A newsletter opt-in inside a real contact form does not disqualify it.
    expect(hasContactForm(form(`<textarea></textarea><label>Newsletter erhalten</label>${signals}`))).toBe(true);
  });

  it('reads only form markup, without scripts, styles or comments, and finds a later qualifying form', () => {
    expect(hasContactForm('<div>Absenden Datenschutz Pflichtfeld</div><formula></formula>')).toBe(false);
    expect(hasContactForm(form(
      '<textarea></textarea><script>var label = "Datenschutz Pflichtfeld";</script>' +
        '<style>.required{}</style><!-- Absenden --><button>OK</button>',
    ))).toBe(false);
    expect(hasContactForm(
      '<form role="search"><input type="search" required><button>Suchen</button></form>' +
        form('<textarea></textarea><button>Absenden</button><p>Datenschutz</p>'),
    )).toBe(true);
    expect(hasContactForm('')).toBe(false);
  });
});
