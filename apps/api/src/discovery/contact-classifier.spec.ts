import { describe, expect, it } from 'vitest';

import { classifyContactEmail } from './contact-classifier';

/**
 * A4：联系方式分类器 v2——把邮箱按「这是什么邮箱」分类（role/generic_sales/procurement/…/personal），
 * 并按数据分级口径给 dataClass（personal=red，其余 amber）。国家语言词表是产品口径
 * （info/sales/kontakt/vertrieb/einkauf/anfrage…），用矩阵钉住。
 */
describe('classifyContactEmail（A4 分类器 v2）', () => {
  it.each([
    // 德语区核心词
    ['info@mueller-pumpen.de', 'role'],
    ['kontakt@mueller-pumpen.de', 'role'],
    ['anfrage@mueller-pumpen.de', 'role'],
    ['vertrieb@mueller-pumpen.de', 'generic_sales'],
    ['sales@mueller-pumpen.de', 'generic_sales'],
    ['einkauf@mueller-pumpen.de', 'procurement'],
    ['purchasing@mueller-pumpen.de', 'procurement'],
    ['geschaeftsfuehrung@mueller-pumpen.de', 'management'],
    ['buchhaltung@mueller-pumpen.de', 'finance'],
    ['service@mueller-pumpen.de', 'support'],
    // 英语与其他国家语言
    ['contact@example.com', 'role'],
    ['office@example.com', 'role'],
    ['hello@example.com', 'role'],
    ['commercial@example.fr', 'generic_sales'],
    ['ventas@example.es', 'generic_sales'],
    ['vendite@example.it', 'generic_sales'],
    ['achat@example.fr', 'procurement'],
    ['compras@example.es', 'procurement'],
    ['acquisti@example.it', 'procurement'],
    ['accounting@example.com', 'finance'],
    // 变体：大小写、+tag、连字符
    ['Info@Example.DE', 'role'],
    ['kontakt+web@example.de', 'role'],
    ['einkauf-2@example.de', 'procurement'],
  ])('%s → %s', (email, expected) => {
    expect(classifyContactEmail(email).emailType).toBe(expected);
  });

  it.each([
    ['max.mustermann@example.de'],
    ['m.mustermann@example.de'],
    ['anna-maria.schmidt@example.de'],
  ])('%s 是人名/个性化形态 → personal（red）', (email) => {
    const result = classifyContactEmail(email);
    expect(result.emailType).toBe('personal');
    expect(result.dataClass).toBe('red');
  });

  it('词表与形态都判不出的 → other（amber，绝不冒认人名：jdoe/webmaster 这类单段词不冒认）', () => {
    expect(classifyContactEmail('jdoe@example.de').emailType).toBe('other');
    const result = classifyContactEmail('x7@example.com');
    expect(result.emailType).toBe('other');
    expect(result.dataClass).toBe('amber');
  });

  it('非邮箱输入不崩溃、按 other 处理', () => {
    expect(classifyContactEmail('not-an-email').emailType).toBe('other');
  });

  it('role 类邮箱 dataClass 一律 amber（职能邮箱=ePrivacy，非个人数据）', () => {
    for (const email of ['info@a.de', 'vertrieb@a.de', 'einkauf@a.de', 'service@a.de']) {
      expect(classifyContactEmail(email).dataClass).toBe('amber');
    }
  });
});
