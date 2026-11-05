import { describe, expect, it } from 'vitest';
import { decodeHtmlEntities, parseHtml, selectAll, selectAttr, selectText } from './html-select';

const PAGE = `<!doctype html><html><head><title>t</title><style>.x{}</style></head>
<body>
  <div class="cards">
    <div class="card"><a class="site" href="/exhibitor/acme">Acme Pumpen GmbH</a><span class="country">Germany</span></div>
    <div class="card featured"><a class="site" href="https://beta.example/">Beta Werke</a><span class="country">Austria</span></div>
  </div>
  <ul id="products"><li>Pumpen</li><li>Ventile</li></ul>
</body></html>`;

describe('M1 极简 HTML 选择器', () => {
  it('parses a page into a tree and extracts text', () => {
    const root = parseHtml(PAGE);
    expect(root.children.length).toBeGreaterThan(0);
    expect(selectText(PAGE, 'title')).toBe('t');
  });

  it('selects by class, tag and id', () => {
    expect(selectAll(PAGE, '.card')).toHaveLength(2);
    expect(selectAll(PAGE, 'div.card')).toHaveLength(2);
    expect(selectAll(PAGE, '#products li')).toHaveLength(2);
    expect(selectAll(PAGE, 'a.site')).toHaveLength(2);
  });

  it('matches descendant combinators against real ancestors', () => {
    expect(selectAll(PAGE, 'div.cards .card .country')).toHaveLength(2);
    expect(selectText(PAGE, 'div.card .country')).toBe('Germany');
  });

  it('extracts attributes and handles ::text / ::attr() suffixes', () => {
    expect(selectAttr(PAGE, 'a.site', 'href')).toBe('/exhibitor/acme');
    expect(selectText(PAGE, 'a.site::text')).toBe('Acme Pumpen GmbH');
    expect(selectText(PAGE, 'a.site::attr(href)')).toBe('/exhibitor/acme');
  });

  it('tolerates broken markup and never matches script/style text', () => {
    const broken = '<div class="card"><span class="name">A<div><span class="name">B</span>';
    expect(selectAll(broken, '.name')).toHaveLength(2);
    const withScript = '<div class="card">x<script>var s = "<div class=\\"card\\">";</script></div>';
    expect(selectAll(withScript, '.card')).toHaveLength(1);
  });

  it('returns empty results for unsupported selectors instead of throwing', () => {
    expect(selectAll(PAGE, 'div > .card')).toEqual([]);
    expect(selectText(PAGE, 'nope')).toBeNull();
  });

  it('decodes named and numeric HTML entities in extracted text', () => {
    const html =
      '<div class="c"><p>A&amp;D &#40;THAILAND&#41; &#x26; CO.</p><p>&nbsp;Ges.m.b.H.</p><p>&unknown; stays</p></div>';
    expect(selectText(html, '.c')).toBe('A&D (THAILAND) & CO. Ges.m.b.H. &unknown; stays');
    // Invalid references stay literal instead of turning into control characters.
    expect(decodeHtmlEntities('A&amp;D &#x41;&#66; &bogus; &#0; &lt;x&gt;')).toBe(
      'A&D AB &bogus; &#0; <x>',
    );
  });
});
