import { describe, it, expect } from 'vitest';
import {
  classifyPageKind,
  extractPageSignals,
  extractSourcingTerms,
  extractNewsFingerprints,
  extractProductLinks,
  signalHash,
  diffPageSignals,
  textDigest,
  visibleText,
  PageSignals,
} from './page-signals';

const jobPostingLd = (title: string, date = '2026-06-01') =>
  `<script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', title, datePosted: date })}</script>`;
const productLd = (name: string) =>
  `<script type="application/ld+json">${JSON.stringify({ '@type': 'Product', name })}</script>`;
const newsLd = (headline: string, date: string) =>
  `<script type="application/ld+json">${JSON.stringify({ '@type': 'NewsArticle', headline, datePublished: date })}</script>`;

describe('classifyPageKind', () => {
  it('routes sourcing paths (highest priority)', () => {
    expect(classifyPageKind('https://acme.com/suppliers/become-a-supplier')).toBe('sourcing');
    expect(classifyPageKind('https://acme.com/procurement')).toBe('sourcing');
    expect(classifyPageKind('https://acme.com/en/供应商')).toBe('sourcing');
  });
  it('routes careers / news / products', () => {
    expect(classifyPageKind('https://acme.com/careers')).toBe('careers');
    expect(classifyPageKind('https://acme.com/de/karriere')).toBe('careers');
    expect(classifyPageKind('https://acme.com/newsroom/2026')).toBe('news');
    expect(classifyPageKind('https://acme.com/products/lasers')).toBe('products');
  });
  it('falls back to generic', () => {
    expect(classifyPageKind('https://acme.com/about')).toBe('generic');
    expect(classifyPageKind('not a url')).toBe('generic');
  });
  it('does not misclassify impressum/compressor/pressure as news (anchored tokens)', () => {
    expect(classifyPageKind('https://acme.de/impressum')).toBe('generic');
    expect(classifyPageKind('https://acme.com/products/compressor-x1')).toBe('products'); // products before news
    expect(classifyPageKind('https://acme.com/products/pressure-sensors')).toBe('products');
  });
  it('classifies /products/media-players as products, /company/media as news', () => {
    expect(classifyPageKind('https://acme.com/products/media-players')).toBe('products');
    expect(classifyPageKind('https://acme.com/company/media')).toBe('news');
  });
  it('does not misread a footer "suppliers" word in a non-sourcing path as sourcing (path-based)', () => {
    // classification is path-based; /about stays generic even if body mentions suppliers
    expect(classifyPageKind('https://acme.com/about-us')).toBe('generic');
  });
});

describe('extractSourcingTerms', () => {
  it('detects active supplier-recruitment phrases, not the bare word "suppliers"', () => {
    expect(extractSourcingTerms('<p>Our suppliers are great partners.</p>')).toEqual([]);
    expect(extractSourcingTerms('<h1>Become a supplier</h1><p>Register as a vendor today</p>')).toContain('become_a_supplier');
    expect(extractSourcingTerms('<a>Request for Quotation</a>')).toContain('rfq');
    expect(extractSourcingTerms('<div>供应商注册 成为供应商</div>')).toContain('become_a_supplier');
  });
  it('catches real-world phrasing found on scouted sites', () => {
    // Flex: "become suppliers to Flex" (plural), "diverse supplier"
    expect(extractSourcingTerms('<main>opportunities for companies to become suppliers to Flex</main>')).toContain('become_a_supplier');
    expect(extractSourcingTerms('<main>our diverse supplier program</main>')).toContain('seeking_suppliers');
    // TRUMPF: "Supplier portal", "Registration", "Onboarding"
    expect(extractSourcingTerms('<main>Supplier registration and onboarding via our supplier portal</main>')).toContain('supplier_program');
  });
  it('ignores persistent nav/footer "become a supplier" links (stripped before detection)', () => {
    const html = '<main><h1>About us</h1><p>we build machines</p></main><footer><a>Become a supplier</a></footer>';
    expect(extractSourcingTerms(html)).toEqual([]);
  });
  it('dedupes and sorts', () => {
    const t = extractSourcingTerms('<p>become a supplier. Become a Supplier. RFQ. request for quote.</p>');
    expect(t).toEqual([...t].sort());
    expect(new Set(t).size).toBe(t.length);
  });
});

describe('extractNewsFingerprints — hashes only, no headline text (compliance)', () => {
  it('returns opaque fingerprint hashes, never the headline text', () => {
    const html = newsLd('CEO Jane Smith opens new plant in Poland', '2026-05-20') + newsLd('Acme raises Series C', '2026-04-01');
    const items = extractNewsFingerprints(html);
    expect(items).toHaveLength(2);
    for (const it of items) expect(it).toMatch(/^[0-9a-f]{16}$/); // 16-hex fingerprint
    expect(items.join(' ')).not.toMatch(/jane|smith|poland|series/i); // no leaked person/text
  });
  it('a new article yields a new fingerprint in the set', () => {
    const a = extractNewsFingerprints(newsLd('Old news', '2026-01-01'));
    const b = extractNewsFingerprints(newsLd('Old news', '2026-01-01') + newsLd('Brand new plant', '2026-06-01'));
    expect(b.length).toBe(a.length + 1);
    expect(a.every((x) => b.includes(x))).toBe(true);
  });
  it('extracts news detail links (same-origin) as fingerprints when no JSON-LD', () => {
    const html = '<a href="/newsroom/release/acme-opens-plant-10087/">x</a><a href="https://other.com/news/foo/">ext</a>';
    const items = extractNewsFingerprints(html, 'https://acme.com/newsroom/');
    expect(items).toHaveLength(1); // only same-registrable-domain link
  });
});

describe('extractProductLinks — real sites lack Product JSON-LD, names live in anchor URLs', () => {
  it('extracts same-origin product/solution detail paths, ignoring external + listing links', () => {
    const html =
      '<a href="/products/machines-systems/2d-laser-cutting-machines/">A</a>' +
      '<a href="/en_INT/products/lasers/beam-sources/">B</a>' +
      '<a href="/products">listing</a>' + // no slug after segment → excluded
      '<a href="https://competitor.com/products/foo/">ext</a>'; // external → excluded
    const links = extractProductLinks(html, 'https://trumpf.com/en_INT/products/');
    expect(links).toContain('/products/machines-systems/2d-laser-cutting-machines');
    expect(links.some((l) => l.includes('competitor'))).toBe(false);
    expect(links).not.toContain('/products');
  });
  it('rejects foreign links on multi-label TLDs (.co.uk) — same-site filter must not fail open', () => {
    const html =
      '<a href="/products/machines/widget-a/">own</a>' +
      '<a href="https://partner.co.uk/products/widget-b/">ext</a>'; // different company, same public suffix
    const links = extractProductLinks(html, 'https://www.example.co.uk/products/');
    expect(links).toContain('/products/machines/widget-a');
    expect(links.some((l) => l.includes('widget-b'))).toBe(false);
  });
  it('accepts apex + subdomain of the watched host', () => {
    const html =
      '<a href="https://example.co.uk/products/widget-alpha/">apex</a>' +
      '<a href="https://shop.example.co.uk/products/gadget-beta/">sub</a>';
    const links = extractProductLinks(html, 'https://www.example.co.uk/products/');
    expect(links).toEqual(['/products/gadget-beta', '/products/widget-alpha']); // sorted
  });
});

describe('extractPageSignals', () => {
  it('extracts hiring with buying-role flag', () => {
    const html = jobPostingLd('Procurement Manager') + jobPostingLd('Frontend Engineer');
    const s = extractPageSignals(html, 'careers');
    expect(s.hiring?.open_roles).toBe(2);
    expect(s.hiring?.has_buying_role).toBe(true);
    expect(s.hiring?.titles).toContain('Procurement Manager');
  });
  it('extracts products and sourcing and news together', () => {
    const html =
      productLd('Fiber Laser X1') + productLd('Press Brake B2') +
      '<h1>Become a supplier</h1>' +
      newsLd('New factory announced', '2026-06-10') +
      '<p>' + 'lorem ipsum dolor sit amet consectetur adipiscing elit '.repeat(3) + '</p>';
    const s = extractPageSignals(html, 'products');
    expect(s.products).toEqual(['Fiber Laser X1', 'Press Brake B2']);
    expect(s.sourcing?.terms).toContain('become_a_supplier');
    expect(s.news?.items.length).toBe(1);
    expect(s.textDigest).toBeTypeOf('string');
  });
});

describe('signalHash — stable under cosmetic churn', () => {
  const body =
    productLd('Fiber Laser X1') + '<h1>Become a supplier</h1>' +
    '<p>' + 'we manufacture industrial cutting systems for global markets '.repeat(4) + '</p>';

  it('is unchanged when only volatile/cosmetic bits differ', () => {
    const a = body + '<span>© 2026 Acme • 14:32:07 • csrf=deadbeefdeadbeefcafe</span>';
    const b = body + '<span>© 2025 Acme • 09:11:55 • csrf=0011223344556677aabb</span><!-- build 9931 -->';
    expect(signalHash(extractPageSignals(a))).toBe(signalHash(extractPageSignals(b)));
  });
  it('changes when a real signal changes (new product)', () => {
    const a = body;
    const b = body + productLd('Tube Laser T3');
    expect(signalHash(extractPageSignals(a))).not.toBe(signalHash(extractPageSignals(b)));
  });
});

describe('diffPageSignals', () => {
  const empty: PageSignals = { kind: 'generic' };

  it('emits SOURCING_OPENED with the newly opened terms', () => {
    const prev: PageSignals = { kind: 'sourcing' };
    const next: PageSignals = { kind: 'sourcing', sourcing: { terms: ['become_a_supplier', 'rfq'] } };
    const d = diffPageSignals(prev, next);
    const opened = d.find((x) => x.changeType === 'SOURCING_OPENED');
    expect(opened).toBeTruthy();
    expect(opened!.strength).toBe(1);
    expect(opened!.evidence.opened_terms).toEqual(['become_a_supplier', 'rfq']);
  });

  it('emits HIRING_UP and marks buying-role stronger', () => {
    const prev: PageSignals = { kind: 'careers', hiring: { open_roles: 2, titles: ['QA Engineer'], has_buying_role: false } };
    const next: PageSignals = { kind: 'careers', hiring: { open_roles: 4, titles: ['QA Engineer', 'Sourcing Manager'], has_buying_role: true } };
    const d = diffPageSignals(prev, next);
    const up = d.find((x) => x.changeType === 'HIRING_UP');
    expect(up).toBeTruthy();
    expect(up!.evidence).toMatchObject({ from: 2, to: 4, has_buying_role: true });
    expect(up!.strength).toBe(0.9);
  });

  it('emits HIRING_DOWN weakly', () => {
    const prev: PageSignals = { kind: 'careers', hiring: { open_roles: 5, titles: [], has_buying_role: false } };
    const next: PageSignals = { kind: 'careers', hiring: { open_roles: 1, titles: [], has_buying_role: false } };
    expect(diffPageSignals(prev, next).map((x) => x.changeType)).toContain('HIRING_DOWN');
  });

  it('emits NEW_PRODUCTS with only the newly added names', () => {
    const prev: PageSignals = { kind: 'products', products: ['A', 'B'] };
    const next: PageSignals = { kind: 'products', products: ['A', 'B', 'C'] };
    const d = diffPageSignals(prev, next);
    expect(d.find((x) => x.changeType === 'NEW_PRODUCTS')!.evidence.new_products).toEqual(['C']);
  });

  it('emits NEWS_POSTED reporting only the COUNT of new items (no headline text — compliance)', () => {
    const prev: PageSignals = { kind: 'news', news: { items: ['aaaa1111bbbb2222'] } };
    const next: PageSignals = { kind: 'news', news: { items: ['aaaa1111bbbb2222', 'cccc3333dddd4444', 'eeee5555ffff6666'] } };
    const ev = diffPageSignals(prev, next).find((x) => x.changeType === 'NEWS_POSTED')!;
    expect(ev.evidence).toEqual({ new_count: 2 });
    expect(JSON.stringify(ev.evidence)).not.toMatch(/\|/); // no "headline|date" leakage
  });

  it('emits a single weak PAGE_CHANGED when only textDigest differs', () => {
    const prev: PageSignals = { kind: 'generic', textDigest: 'aaa' };
    const next: PageSignals = { kind: 'generic', textDigest: 'bbb' };
    const d = diffPageSignals(prev, next);
    expect(d).toHaveLength(1);
    expect(d[0].changeType).toBe('PAGE_CHANGED');
  });

  it('emits nothing when nothing meaningful changed', () => {
    const same: PageSignals = { kind: 'generic', textDigest: 'aaa', products: ['A'] };
    expect(diffPageSignals(same, same)).toEqual([]);
    expect(diffPageSignals(empty, empty)).toEqual([]);
  });

  it('can emit multiple deltas from one diff', () => {
    const prev: PageSignals = { kind: 'generic', products: ['A'], hiring: { open_roles: 1, titles: [], has_buying_role: false } };
    const next: PageSignals = { kind: 'generic', products: ['A', 'B'], hiring: { open_roles: 3, titles: [], has_buying_role: false }, sourcing: { terms: ['rfq'] } };
    const types = diffPageSignals(prev, next).map((x) => x.changeType).sort();
    expect(types).toEqual(['HIRING_UP', 'NEW_PRODUCTS', 'SOURCING_OPENED']);
  });
});

describe('textDigest / visibleText', () => {
  it('strips scripts/styles and tags', () => {
    const t = visibleText('<style>.x{}</style><script>var a=1</script><h1>Hello</h1><p>World</p>');
    expect(t).toContain('hello');
    expect(t).toContain('world');
    expect(t).not.toContain('var a');
  });
  it('returns undefined for near-empty content', () => {
    expect(textDigest('<html><body> </body></html>')).toBeUndefined();
  });
  it('is stable when only relative timestamps change (2 days ago → 3 days ago)', () => {
    const body = 'the annual industrial machinery conference recap is now available for all attendees ';
    const a = textDigest(`<main><article>${body} posted 2 days ago</article></main>`);
    const b = textDigest(`<main><article>${body} posted 3 days ago</article></main>`);
    expect(a).toBe(b);
  });
  it('still changes when the actual content changes', () => {
    const a = textDigest('<main>' + 'we manufacture precision cutting systems for export '.repeat(2) + 'posted 2 hours ago</main>');
    const b = textDigest('<main>' + 'we now also manufacture welding robots for export '.repeat(2) + 'posted 2 hours ago</main>');
    expect(a).not.toBe(b);
  });
});
