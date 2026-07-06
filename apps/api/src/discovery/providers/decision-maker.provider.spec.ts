import { describe, expect, it } from 'vitest';
import { scorePeoplePageUrl } from './decision-maker.provider';

describe('决策人页优先级打分（Impressum 优先）', () => {
  it('Impressum/法律声明最高（德国依法列 Geschäftsführer）', () => {
    expect(scorePeoplePageUrl('https://x.de/impressum')).toBe(100);
    expect(scorePeoplePageUrl('https://x.com/en/imprint')).toBe(100);
    expect(scorePeoplePageUrl('https://x.fr/mentions-legales')).toBe(100);
  });

  it('管理层 > 团队 > 关于 > 联系', () => {
    const mgmt = scorePeoplePageUrl('https://x.de/geschaeftsfuehrung');
    const team = scorePeoplePageUrl('https://x.de/team');
    const about = scorePeoplePageUrl('https://x.de/ueber-uns');
    const contact = scorePeoplePageUrl('https://x.de/kontakt');
    expect(mgmt).toBeGreaterThan(team);
    expect(team).toBeGreaterThan(about);
    expect(about).toBeGreaterThan(contact);
    expect(contact).toBeGreaterThan(0);
  });

  it('英文管理层页也命中', () => {
    expect(scorePeoplePageUrl('https://x.com/company/leadership')).toBeGreaterThanOrEqual(95);
    expect(scorePeoplePageUrl('https://x.com/management-team')).toBeGreaterThanOrEqual(95);
  });

  it('非人物页得 0（不误抓产品/新闻页）', () => {
    expect(scorePeoplePageUrl('https://x.de/produkte/laser')).toBe(0);
    expect(scorePeoplePageUrl('https://x.de/news/2026')).toBe(0);
  });
});
