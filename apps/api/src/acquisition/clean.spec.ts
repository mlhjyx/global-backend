import { describe, expect, it } from 'vitest';
import { cleanEmail, cleanPhone, cleanName, cleanStringList, contentHashOf, cleanEntity } from './clean';

describe('采集清洗（源无关）', () => {
  it('邮箱分级：职能 vs 人名（GDPR 关键区分）', () => {
    expect(cleanEmail('info@acme.de')).toEqual({ value: 'info@acme.de', kind: 'role' });
    expect(cleanEmail('SALES@Acme.com')).toEqual({ value: 'sales@acme.com', kind: 'role' });
    expect(cleanEmail('john.smith@acme.com')).toEqual({ value: 'john.smith@acme.com', kind: 'personal' });
    expect(cleanEmail('m.mueller@acme.de')?.kind).toBe('personal');
    expect(cleanEmail('vertrieb@acme.de')?.kind).toBe('role'); // 德语职能词
    // 保守分级（GDPR）：未在白名单的单词名判 personal，防个人邮箱绕过隔离门
    expect(cleanEmail('max@vendor.com')?.kind).toBe('personal');
    expect(cleanEmail('jane@vendor.com')?.kind).toBe('personal');
    expect(cleanEmail('orders@acme.com')?.kind).toBe('role'); // 扩充职能词
    expect(cleanEmail('sales2@acme.com')?.kind).toBe('role'); // 去尾数后仍职能
    expect(cleanEmail('not-an-email')).toBeNull();
    expect(cleanEmail(null)).toBeNull();
  });

  it('电话规整：保留 +数字，过短/过长判无效', () => {
    expect(cleanPhone('+49 (0) 322 210 929 60')).toBe('+49032221092960'); // 保留 + 与全部数字
    expect(cleanPhone('123')).toBeNull();
    expect(cleanPhone(undefined)).toBeNull();
  });

  it('名称规整：折叠空白', () => {
    expect(cleanName('  ACME   Manufacturing\tAG ')).toBe('ACME Manufacturing AG');
  });

  it('字符串列表：去重 + 取 object.name + 上限', () => {
    expect(cleanStringList(['Laser', 'laser ', { name: 'Bending' }, 'Laser'])).toEqual(['Laser', 'Bending']);
    expect(cleanStringList('not-array')).toEqual([]);
  });

  it('contentHash 稳定：同值同 hash，键序无关', () => {
    expect(contentHashOf({ a: 1, b: [2, 3] })).toBe(contentHashOf({ b: [2, 3], a: 1 }));
    expect(contentHashOf({ a: 1 })).not.toBe(contentHashOf({ a: 2 }));
  });

  it('cleanEntity：域名归一 + 个人数据标记 + 命名空间字段', () => {
    const c = cleanEntity({
      externalId: 'x1',
      name: '  TRUMPF  GmbH ',
      website: 'https://www.trumpf.com/de/',
      country: 'Germany',
      fields: { email: 'max.mustermann@trumpf.com', phone: '+49 7156 303-0', products: ['Laser', 'Laser'], hiring: true },
    })!;
    expect(c.name).toBe('TRUMPF GmbH');
    expect(c.domain).toBe('trumpf.com'); // 去 www/协议/路径
    expect(c.cleaned.email_kind).toBe('personal');
    expect(c.personalData).toBe(true); // 人名邮箱 → 触发合规门
    expect(c.cleaned.products).toEqual(['Laser']);
    expect(c.contentHash).toHaveLength(64);
  });

  it('cleanEntity：职能邮箱不标个人数据', () => {
    const c = cleanEntity({ externalId: 'x2', name: 'ACME', website: 'acme.de', fields: { email: 'info@acme.de' } })!;
    expect(c.personalData).toBe(false);
    expect(c.cleaned.email_kind).toBe('role');
  });

  it('无名称 → null', () => {
    expect(cleanEntity({ externalId: 'x', name: '   ' })).toBeNull();
  });
});
