import { describe, expect, it } from 'vitest';
import { extractSameSiteLinks, selectKeySubpages } from './site-links';
import { extractPublicContacts } from './contact-extractor';

describe('site-links（多页抓取的确定性选页）', () => {
  const md = `
[Products](https://acme.com/products) [About us](/about) [Contact](https://acme.com/contact)
[Blog](https://acme.com/blog/news-1) [Privacy](https://acme.com/privacy)
[External](https://other.com/products) [PDF](https://acme.com/catalog.pdf)
[Cases](https://acme.com/cases/customer-a) [Certifications](https://acme.com/quality/certifications)
`;

  it('只保留同站链接，相对路径解析', () => {
    const links = extractSameSiteLinks(md, 'https://acme.com/');
    expect(links).toContain('https://acme.com/products');
    expect(links).toContain('https://acme.com/about');
    expect(links.some((l) => l.includes('other.com'))).toBe(false);
  });

  it('关键页优先，排除 blog/privacy/pdf', () => {
    const links = extractSameSiteLinks(md, 'https://acme.com/');
    const picked = selectKeySubpages(links, 6);
    expect(picked).toContain('https://acme.com/products');
    expect(picked).toContain('https://acme.com/contact');
    expect(picked.some((l) => l.includes('/blog') || l.includes('privacy') || l.endsWith('.pdf'))).toBe(false);
  });
});

describe('contact-extractor（确定性，非 LLM —— 命中的必然真实存在于页面）', () => {
  it('抽 email/tel/社媒，带来源页，过滤图片误报', () => {
    const contacts = extractPublicContacts([
      {
        url: 'https://acme.com/contact',
        text: 'Email: sales@acme.com or [call](tel:+49 715 630-30) logo@2x.png https://www.linkedin.com/company/acme',
      },
    ]);
    expect(contacts).toContainEqual({ type: 'email', value: 'sales@acme.com', sourceUrl: 'https://acme.com/contact' });
    expect(contacts.some((c) => c.type === 'phone' && c.value === '+4971563030')).toBe(true);
    expect(contacts.some((c) => c.value.includes('linkedin.com/company/acme'))).toBe(true);
    expect(contacts.some((c) => c.value.includes('2x.png'))).toBe(false);
  });

  it('去重（同值不同页只记一次）', () => {
    const contacts = extractPublicContacts([
      { url: 'https://a.com/1', text: 'x@a.com' },
      { url: 'https://a.com/2', text: 'X@A.com' },
    ]);
    expect(contacts.filter((c) => c.type === 'email')).toHaveLength(1);
  });

  const emailsIn = (text: string) =>
    extractPublicContacts([{ url: 'https://acme.de/impressum', text }])
      .filter((c) => c.type === 'email')
      .map((c) => c.value);

  it('本地部分含变音字母的地址整条不抽，不截成 ller@ / rg.schmidt@；ASCII 地址照旧', () => {
    // 2026-10-09 独立复审：müller@ 曾被抽成 ller@acme.de、Jörg.Schmidt@ 抽成 rg.schmidt@acme.de，错地址挂到公司名下。
    expect(
      emailsIn(
        [
          'Geschäftsführer: Hans Müller, müller@acme.de',
          'Vertrieb: Jörg.Schmidt@acme.de',
          'Kontakt: info@acme.de, max.mueller@acme.de; j.schmidt@acme.de',
        ].join('\n'),
      ),
    ).toEqual(['info@acme.de', 'max.mueller@acme.de', 'j.schmidt@acme.de']);
  });

  it('分解写法的变音（u + U+0308）、撇号姓名与百分号编码的 mailto 也不截成半个地址', () => {
    expect(emailsIn('mu\u0308ller@acme.de')).toEqual([]);
    expect(emailsIn("Irland: o'brien@acme.ie")).toEqual([]);
    expect(emailsIn('[Mail](mailto:m%C3%BCller@acme.de)')).toEqual([]);
    // 引号、Markdown 链接与尖括号不算词的一部分。
    expect(emailsIn("'info@acme.de' [x](mailto:vertrieb@acme.de) <max.mueller@acme.de>")).toEqual([
      'info@acme.de',
      'vertrieb@acme.de',
      'max.mueller@acme.de',
    ]);
  });

  it('中文、俄文等非拉丁文字紧贴地址时不算同一个词，照常抽取', () => {
    expect(emailsIn('联系邮箱sales@acme.cn 电话')).toEqual(['sales@acme.cn']);
    expect(emailsIn('почтаinfo@acme.ru')).toEqual(['info@acme.ru']);
    // 非拉丁字母与 ASCII 混在一个本地部分里时从文字边界切开；以「.」开头的切片不是合法地址，丢弃。
    expect(emailsIn('иван.petrov@acme.ru')).toEqual([]);
  });

  it('隐形格式字符（软连字符、零宽空格）与撇号的各种写法也不让匹配从词中间开始', () => {
    // 复审补充：max.muster\u00ADmann@ 曾被抽成 mann@，O\u00B4Brien@ 被抽成 brien@。
    expect(emailsIn('max.muster\u00ADmann@acme.de')).toEqual([]);
    expect(emailsIn('max.muster\u200Bmann@acme.de')).toEqual([]);
    expect(emailsIn('o\u2019brien@acme.ie O\u00B4Brien@acme.ie o\u02BCbrien@acme.ie')).toEqual([]);
    // 格式字符本身不算词：标签后、中文后的零宽空格不挡住地址。
    expect(emailsIn('E-Mail:\u200Binfo@acme.de 邮箱\u200Bsales@acme.cn')).toEqual(['info@acme.de', 'sales@acme.cn']);
  });

  it('同一地址出现在多页时记先抓到的页（首页在前）', () => {
    expect(
      extractPublicContacts([
        { url: 'https://acme.de/', text: 'max@acme.de' },
        { url: 'https://acme.de/impressum', text: 'Max@acme.de' },
      ]),
    ).toEqual([{ type: 'email', value: 'max@acme.de', sourceUrl: 'https://acme.de/' }]);
  });
});
