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

  it('只有首个联系点带电话', () => {
    const cs = buildPublicContacts('acme.de', [{ value: 'a.b@acme.de' }, { value: 'c.d@acme.de' }], '+1 555');
    expect(cs[0].phone).toBe('+1 555');
    expect(cs[1].phone).toBeUndefined();
  });
});
