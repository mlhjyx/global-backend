import { describe, expect, it, vi } from 'vitest';

vi.mock('../../adapters/robots', () => ({
  isAllowedByRobots: vi.fn(async () => true),
}));

import { buildPublicContacts, PublicWebDiscoveryProvider } from './public-web.provider';
import { GENERIC_CONTACT_TITLE } from '../provider-contract';
import { inferEmailPattern } from '../email-format-learning';
import type { ExecutionBroker, ToolResult } from '../../tools/tool-contract';

const HOME = 'https://acme.de/';
/** 抽取结果的形状：每个邮箱都带它被抓到的页。 */
const at = (values: string[], sourceUrl = HOME) => values.map((value) => ({ value, sourceUrl }));

/**
 * public_web 联系人构造单测。只有职能邮箱白名单（`cleanEmail`）里的地址是公司联系点，不是个人数据、不标；
 * 其余一律是个人数据（GDPR Art.4），必须标 personalData=true → persistDiscoveredContacts 才写
 * person.profile 侧写证据（Codex P2 on #58 曾漏标 first.last@；2026-10-08 又发现 max@ 这类单名被当公开联系点）。
 * 只有 first.last@ 反推姓名，其余个人邮箱给占位名，不能成为邮箱格式学习样本。
 * 2026-10-09：只留公司域名（含子域）上的邮箱；个人邮箱的 sourcePage 记它实际所在的页。
 */
describe('buildPublicContacts', () => {
  it('first.last@ 反推姓名 → personalData=true + sourcePage，无 switchboard title', () => {
    const [c] = buildPublicContacts('acme.de', at(['john.smith@acme.de']), undefined);
    expect(c.fullName).toBe('John Smith');
    expect(c.personalData).toBe(true);
    expect(c.sourcePage).toBe('https://acme.de/');
    expect(c.title).toBeUndefined();
  });

  it('职能/总机邮箱 → 非个人数据（personalData 不设）+ 通用占位 title', () => {
    const [c] = buildPublicContacts('acme.de', at(['info@acme.de']), '+49 30 123');
    expect(c.fullName).toContain('公开联系点');
    expect(c.personalData).toBeUndefined();
    expect(c.title).toBe(GENERIC_CONTACT_TITLE);
    expect(c.phone).toBe('+49 30 123'); // 仅首个联系点带电话
  });

  it('单名与缩写邮箱（max@、mueller@、mm@）也是个人数据：标 personalData，不当公开联系点', () => {
    // 2026-10-08 BI-14 设计调研：此前只认 first.last 形，max@ 被存成「公开联系点 (max@)」且不标个人数据。
    const contacts = buildPublicContacts(
      'acme.de',
      at(['max@acme.de', 'mueller@acme.de', 'mm@acme.de']),
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
      buildPublicContacts('acme.de', at(domainEmails), undefined).map((c) => ({
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
      at(['INFO@ACME.DE', 'info-eu@acme.de', 'Max@Acme.de', 'max+news@acme.de', 'datenschutz@acme.de']),
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
    const [c] = buildPublicContacts('acme.de', at(['max__x@acme.de']), undefined);
    expect(c.fullName).toBe('个人邮箱 (max__x@)');
    expect(c.personalData).toBe(true);
  });

  it('白名单里的职能邮箱（含带数字的 sales2@）仍是公司联系点', () => {
    const contacts = buildPublicContacts(
      'acme.de',
      at(['info@acme.de', 'vertrieb@acme.de', 'einkauf@acme.de', 'sales2@acme.de']),
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
    const cs = buildPublicContacts('acme.de', at(['a.b@acme.de', 'c.d@acme.de']), '+1 555');
    expect(cs[0].phone).toBe('+1 555');
    expect(cs[1].phone).toBeUndefined();
  });

  it('个人邮箱的 sourcePage 记它实际所在的页（如 Impressum），不再一律记首页', () => {
    // 2026-10-09 独立复审：GDPR Art.14 的来源说明要指向真实页面。
    const contacts = buildPublicContacts(
      'acme.de',
      [
        { value: 'info@acme.de', sourceUrl: HOME },
        { value: 'max.mustermann@acme.de', sourceUrl: 'https://acme.de/impressum' },
        { value: 'mm@acme.de', sourceUrl: 'https://www.acme.de/kontakt' },
      ],
      undefined,
    );

    expect(contacts.map((c) => [c.email, c.sourcePage])).toEqual([
      ['info@acme.de', undefined],
      ['max.mustermann@acme.de', 'https://acme.de/impressum'],
      ['mm@acme.de', 'https://www.acme.de/kontakt'],
    ]);
  });

  it('来源页不带账号口令、查询串与片段', () => {
    const [c] = buildPublicContacts(
      'acme.de',
      [{ value: 'max@acme.de', sourceUrl: 'https://user:secret@acme.de/kontakt?session=abc#team' }],
      undefined,
    );
    expect(c.sourcePage).toBe('https://acme.de/kontakt');
  });

  it('只留公司域名及其子域上的邮箱：建站公司、外部数据保护官、gmail 等其他域名的地址不存', () => {
    // 2026-10-09 独立复审：这些地址曾作为公司联系人挂到这家公司名下。排在前面也不占 5 个名额。
    const contacts = buildPublicContacts(
      'acme.de',
      at([
        'info@webagentur.de',
        'dsb@extern-datenschutz.de',
        'acme.gmbh@gmail.com',
        'info@notacme.de',
        'info@acme.de.evil.com',
        'info@acme.detelefon',
        '@acme.de',
        'acme.de',
        'info@acme.de',
        'vertrieb@shop.acme.de',
        'Max@WWW.ACME.DE',
      ]),
      '+49 30 123',
    );

    expect(contacts.map((c) => c.email)).toEqual(['info@acme.de', 'vertrieb@shop.acme.de', 'Max@WWW.ACME.DE']);
    expect(contacts[0].phone).toBe('+49 30 123'); // 电话给第一个留下的联系点
  });

  it('公司域名按同一规则规范化（大小写、www.、国际化域名转 ASCII）后再比较', () => {
    const contacts = buildPublicContacts(
      'www.Müller-Pumpen.de',
      at(['info@xn--mller-pumpen-dlb.de', 'info@mueller-pumpen.de']),
      undefined,
    );
    expect(contacts.map((c) => c.email)).toEqual(['info@xn--mller-pumpen-dlb.de']);
  });

  it('说不出来源页的个人邮箱不存，也不占名额；电话给第一个留下的联系点', () => {
    const contacts = buildPublicContacts(
      'acme.de',
      [
        { value: 'max@acme.de', sourceUrl: 'ftp://acme.de/kontakt' },
        { value: 'info@acme.de', sourceUrl: 'ftp://acme.de/kontakt' },
      ],
      '+49 30 123',
    );
    // 职能邮箱不是个人数据，本来就不记来源页，照常保留。
    expect(contacts.map((c) => [c.email, c.phone, c.sourcePage])).toEqual([
      ['info@acme.de', '+49 30 123', undefined],
    ]);
  });

  it('公司域名无法规范化时一个都不留', () => {
    expect(buildPublicContacts('', at(['info@acme.de']), undefined)).toEqual([]);
    expect(buildPublicContacts('localhost', at(['info@localhost.de']), undefined)).toEqual([]);
  });
});

describe('PublicWebDiscoveryProvider.discoverContacts：抽取 → 构造的接线', () => {
  function brokerServing(pages: Record<string, string>): ExecutionBroker {
    return {
      checkSourcePolicy: async () => ({ allowed: true }),
      invoke: vi.fn(async (_toolId: string, input: { url: string }): Promise<ToolResult<unknown>> => {
        const text = pages[input.url];
        if (text === undefined) throw new Error(`unexpected crawl ${input.url}`);
        return { data: { url: input.url, text, contentHash: 'hash' }, costCents: 0 };
      }) as unknown as ExecutionBroker['invoke'],
    };
  }

  it('个人邮箱记 Impressum 页为来源；变音地址与其他域名的地址都不出现', async () => {
    const provider = new PublicWebDiscoveryProvider({
      gateway: {} as never,
      broker: brokerServing({
        'https://acme.de/': 'Willkommen bei Acme. [Impressum](/impressum) Kontakt: info@acme.de',
        'https://acme.de/impressum': [
          'Geschäftsführer: Max Mustermann, max.mustermann@acme.de',
          'Prokurist: Hans Müller, müller@acme.de',
          'Webdesign: Agentur XY, info@webagentur.de',
          'Datenschutzbeauftragter: dsb@extern-datenschutz.de',
          'Alternativ: acme.gmbh@gmail.com',
        ].join('\n'),
      }),
    });

    const result = await provider.discoverContacts(
      { name: 'Acme GmbH', domain: 'acme.de' },
      { workspaceId: 'ws-1', runId: 'run-1' },
    );

    expect(result.contacts.map((c) => [c.email, c.personalData ?? false, c.sourcePage])).toEqual([
      ['info@acme.de', false, undefined],
      ['max.mustermann@acme.de', true, 'https://acme.de/impressum'],
    ]);
  });
});
