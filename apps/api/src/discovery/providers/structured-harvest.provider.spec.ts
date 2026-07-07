import { describe, expect, it } from 'vitest';
import { parseSitemapXml, pickCareersUrl, tallySections, isBuyingRole, pickJobDetailUrls, slugToTitle } from './structured-harvest.provider';

describe('结构化收割 · 纯解析器', () => {
  it('sitemap XML：普通 sitemap 抽 <loc>', () => {
    const xml = `<urlset><url><loc>https://acme.de/</loc></url><url><loc>https://acme.de/careers</loc></url></urlset>`;
    const r = parseSitemapXml(xml);
    expect(r.isIndex).toBe(false);
    expect(r.locs).toEqual(['https://acme.de/', 'https://acme.de/careers']);
  });

  it('sitemap XML：sitemap index 识别 + 抽子表', () => {
    const xml = `<sitemapindex><sitemap><loc>https://acme.de/sitemap-1.xml</loc></sitemap></sitemapindex>`;
    const r = parseSitemapXml(xml);
    expect(r.isIndex).toBe(true);
    expect(r.locs).toEqual(['https://acme.de/sitemap-1.xml']);
  });

  it('挑 careers 页：命中招聘词，短路径优先', () => {
    const urls = [
      'https://acme.de/products',
      'https://acme.de/en/company/careers-and-jobs',
      'https://acme.de/careers',
      'https://acme.de/about',
    ];
    expect(pickCareersUrl(urls)).toBe('https://acme.de/careers');
    expect(pickCareersUrl(['https://acme.de/karriere'])).toBe('https://acme.de/karriere');
    expect(pickCareersUrl(['https://acme.de/products'])).toBeUndefined();
  });

  it('站点区块盘点：按一级路径段计数', () => {
    const t = tallySections([
      'https://acme.de/products/a',
      'https://acme.de/products/b',
      'https://acme.de/about',
    ]);
    expect(t.products).toBe(2);
    expect(t.about).toBe(1);
  });

  it('职位详情 URL 识别 + slug → 岗位名', () => {
    const urls = [
      'https://acme.de/careers',
      'https://acme.de/careers/jobs/strategic-sourcing-manager',
      'https://acme.de/en/stellenangebote/senior-einkaeufer-12345',
      'https://acme.de/products/laser',
    ];
    const jobs = pickJobDetailUrls(urls);
    expect(jobs).toHaveLength(2);
    expect(slugToTitle('https://acme.de/careers/jobs/strategic-sourcing-manager')).toBe('strategic sourcing manager');
    expect(slugToTitle('https://acme.de/en/stellenangebote/senior-einkaeufer-12345')).toBe('senior einkaeufer');
    expect(isBuyingRole(slugToTitle('https://acme.de/en/stellenangebote/senior-einkaeufer-12345'))).toBe(true);
  });

  it('采购/供应链岗判定（多语）→ 买家团队扩张信号', () => {
    expect(isBuyingRole('Strategic Sourcing Manager')).toBe(true);
    expect(isBuyingRole('Einkäufer (m/w/d)')).toBe(true);
    expect(isBuyingRole('Head of Procurement')).toBe(true);
    expect(isBuyingRole('Frontend Developer')).toBe(false);
  });
});
