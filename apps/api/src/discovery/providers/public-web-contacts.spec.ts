import { describe, expect, it } from 'vitest';
import { buildPublicContacts } from './public-web.provider';
import { GENERIC_CONTACT_TITLE } from '../provider-contract';
import { inferEmailPattern } from '../email-format-learning';

/**
 * public_web 联系人构造单测。只有职能邮箱白名单（`cleanEmail`）里的地址是公司联系点，不是个人数据、不标；
 * 其余一律是个人数据（GDPR Art.4），必须标 personalData=true → persistDiscoveredContacts 才写
 * person.profile 侧写证据（Codex P2 on #58 曾漏标 first.last@；2026-10-08 又发现 max@ 这类单名被当公开联系点）。
 * 只有 first.last@ 反推姓名，其余个人邮箱给占位名，不能成为邮箱格式学习样本。
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
    expect(contacts.map((c) => c.fullName)).toEqual([
      '个人邮箱 (max@)',
      '个人邮箱 (mueller@)',
      '个人邮箱 (mm@)',
    ]);
  });

  it('单名个人邮箱不当姓名样本：邮箱格式学习只从 first.last@ 学', () => {
    // 复审 HIGH：从 mueller@ 反推出 "Mueller" 会给 `first` 投票，datenschutz@、technik@ 一多就压过真实样本。
    const samples = (domainEmails: string[]) =>
      buildPublicContacts('acme.de', domainEmails.map((value) => ({ value })), undefined).map((c) => ({
        fullName: c.fullName,
        email: c.email!,
      }));

    expect(inferEmailPattern(samples(['info@acme.de', 'mueller@acme.de']))).toBeNull();
    expect(
      inferEmailPattern(
        samples(['info@acme.de', 'datenschutz@acme.de', 'technik@acme.de', 'j.schmidt@acme.de']),
      ),
    ).toMatchObject({ pattern: 'first.last', support: 1, samples: 1 });
  });

  it('大小写、加号地址与白名单外的职能词：按白名单判，未知的一律个人', () => {
    const contacts = buildPublicContacts(
      'acme.de',
      [
        { value: 'INFO@ACME.DE' },
        { value: 'info-eu@acme.de' },
        { value: 'Max@Acme.de' },
        { value: 'max+news@acme.de' },
        { value: 'datenschutz@acme.de' },
      ],
      undefined,
    );

    expect(contacts.map((c) => [c.fullName, c.personalData ?? false])).toEqual([
      ['公开联系点 (INFO@)', false],
      ['公开联系点 (info-eu@)', false],
      ['个人邮箱 (Max@)', true],
      ['个人邮箱 (max+news@)', true],
      ['个人邮箱 (datenschutz@)', true],
    ]);
  });

  it('只有恰好一个分隔符的 first.last@ 反推姓名，max__x@ 这类给占位名', () => {
    const [c] = buildPublicContacts('acme.de', [{ value: 'max__x@acme.de' }], undefined);
    expect(c.fullName).toBe('个人邮箱 (max__x@)');
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
