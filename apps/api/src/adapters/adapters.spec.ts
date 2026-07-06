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
});
