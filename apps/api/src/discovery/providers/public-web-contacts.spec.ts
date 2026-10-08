import { describe, expect, it } from 'vitest';
import { buildPublicContacts } from './public-web.provider';
import { GENERIC_CONTACT_TITLE } from '../provider-contract';

/**
 * public_web 联系人构造单测（Codex P2 on #58 discovery.service.ts:127）：first.last@ 反推的**具名个人**
 * 邮箱 = 个人数据（GDPR Art.4），必须标 personalData=true → persistDiscoveredContacts 才写 person.profile
 * 侧写证据（GDPR 标记）。此前漏标 → 具名个人邮箱入库却无标记/证据。总机/职能邮箱不是个人数据、不标。
 */
describe('buildPublicContacts', () => {
  it('first.last@ 反推姓名 → personalData=true + sourcePage，无 switchboard title', () => {
    const [c] = buildPublicContacts('acme.de', [{ value: 'john.smith@acme.de' }], undefined);
    expect(c.fullName).toBe('John Smith');
    expect(c.personalData).toBe(true);
    expect(c.sourcePage).toBe('https://acme.de/');
    expect(c.title).toBeUndefined();
  });

  it('职能/总机邮箱 → 非个人数据（personalData 不设）+ 通用占位 title', () => {
    const [c] = buildPublicContacts('acme.de', [{ value: 'info@acme.de' }], '+49 30 123');
    expect(c.fullName).toContain('公开联系点');
    expect(c.personalData).toBeUndefined();
    expect(c.title).toBe(GENERIC_CONTACT_TITLE);
    expect(c.phone).toBe('+49 30 123'); // 仅首个联系点带电话
  });

  it('单名与缩写邮箱（max@、mueller@、mm@）也是个人数据：标 personalData，不当公开联系点', () => {
    // 2026-10-08 BI-14 设计调研：此前只认 first.last 形，max@ 被存成「公开联系点 (max@)」且不标个人数据。
    const contacts = buildPublicContacts(
      'acme.de',
      [{ value: 'max@acme.de' }, { value: 'mueller@acme.de' }, { value: 'mm@acme.de' }],
      undefined,
    );

    for (const c of contacts) {
      expect(c.personalData).toBe(true);
      expect(c.sourcePage).toBe('https://acme.de/');
      expect(c.title).toBeUndefined();
      expect(c.department).toBeUndefined();
      expect(c.fullName).not.toContain('公开联系点');
    }
  });

  it('任意形状的个人本地部分都能推出显示名，连续分隔符不报错', () => {
    const [c] = buildPublicContacts('acme.de', [{ value: 'max__x@acme.de' }], undefined);
    expect(c.fullName).toBe('Max X');
    expect(c.personalData).toBe(true);
  });

  it('白名单里的职能邮箱（含带数字的 sales2@）仍是公司联系点', () => {
    const contacts = buildPublicContacts(
      'acme.de',
      [
        { value: 'info@acme.de' },
        { value: 'vertrieb@acme.de' },
        { value: 'einkauf@acme.de' },
        { value: 'sales2@acme.de' },
      ],
      undefined,
    );

    expect(contacts.map((c) => c.fullName)).toEqual([
      '公开联系点 (info@)',
      '公开联系点 (vertrieb@)',
      '公开联系点 (einkauf@)',
      '公开联系点 (sales2@)',
    ]);
    for (const c of contacts) {
      expect(c.personalData).toBeUndefined();
      expect(c.title).toBe(GENERIC_CONTACT_TITLE);
      expect(c.department).toBe('general');
    }
  });

  it('只有首个联系点带电话', () => {
    const cs = buildPublicContacts('acme.de', [{ value: 'a.b@acme.de' }, { value: 'c.d@acme.de' }], '+1 555');
    expect(cs[0].phone).toBe('+1 555');
    expect(cs[1].phone).toBeUndefined();
  });
});
