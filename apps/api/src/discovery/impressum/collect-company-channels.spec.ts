import { describe, expect, it } from 'vitest';
import { collectCompanyChannels } from './collect-company-channels';

/**
 * A1：从已抓取的 Impressum/联系页装配**公司级**联系方式（A4 的 company_contact_channel 输入）。
 * 纪律：只收本站域邮箱；personal 邮箱不进公司层；电话归一；每条带来源页与来源类型。
 */
describe('collectCompanyChannels', () => {
  const domain = 'mueller-pumpen.de';

  it('Impressum 文本里的 role 邮箱与 tel: 总机 → email(amber)+phone(green)，来源=impressum', () => {
    const channels = collectCompanyChannels({
      domain,
      country: 'DE',
      pages: [{
        url: 'https://mueller-pumpen.de/impressum',
        kind: 'impressum',
        text: 'Angaben gemäß § 5 TMG: Müller Pumpen GmbH\nE-Mail: info@mueller-pumpen.de\nTelefon: [+49 89 1234567](tel:+49891234567)',
      }],
    });
    expect(channels).toEqual(expect.arrayContaining([
      expect.objectContaining({
        channel: 'email', value: 'info@mueller-pumpen.de', emailType: 'role', sourceType: 'impressum',
        sourceUrl: 'https://mueller-pumpen.de/impressum', legalBasis: 'legitimate_interest',
      }),
      expect.objectContaining({
        channel: 'phone', value: '+49891234567', sourceType: 'impressum',
        sourceUrl: 'https://mueller-pumpen.de/impressum',
      }),
    ]));
    // A4 写入器口径：email 必带 emailType；phone 必须不带。
    for (const channel of channels) {
      if (channel.channel === 'email') expect(channel.emailType).toBeTruthy();
      else expect(channel.emailType).toBeUndefined();
    }
  });

  it('HTML 面：cfemail 解码 + JSON-LD contactPoint + mailto 链接都进渠道且去重', () => {
    const channels = collectCompanyChannels({
      domain,
      country: 'DE',
      pages: [{
        url: 'https://mueller-pumpen.de/kontakt',
        kind: 'contact',
        html: `
          <a href="mailto:vertrieb@mueller-pumpen.de">Vertrieb</a>
          <a class="__cf_email__" data-cfemail="2a43444c456a475f4f46464f58075a5f475a4f44044e4f">E-Mail</a>
          <script type="application/ld+json">
            {"@type":"Organization","contactPoint":[{"@type":"ContactPoint","email":"vertrieb@mueller-pumpen.de","telephone":"+49 (0)89 1234567"}]}
          </script>`,
        text: 'Kontakt',
      }],
    });
    const emails = channels.filter((c) => c.channel === 'email').map((c) => c.value);
    expect(emails).toEqual(expect.arrayContaining(['vertrieb@mueller-pumpen.de', 'info@mueller-pumpen.de']));
    expect(new Set(emails).size).toBe(emails.length); // JSON-LD 与 mailto 重复的值只留一条
    expect(channels.find((c) => c.channel === 'phone')).toMatchObject({ value: '+49891234567' });
    for (const c of channels) expect(c.sourceType).toBe('contact_page');
  });

  it('personal 邮箱不进公司层（只属联系人层）；站外邮箱（gmail）被丢弃', () => {
    const channels = collectCompanyChannels({
      domain,
      pages: [{
        url: 'https://mueller-pumpen.de/impressum',
        kind: 'impressum',
        text: 'Max Mustermann: max.mustermann@mueller-pumpen.de — privat: m.mueller@gmail.com — Firma: info@mueller-pumpen.de',
      }],
    });
    const emails = channels.filter((c) => c.channel === 'email').map((c) => c.value);
    expect(emails).toEqual(['info@mueller-pumpen.de']);
  });

  it('子域邮箱认可（mail.mueller-pumpen.de），联系表单页产出 form_url(green)', () => {
    const channels = collectCompanyChannels({
      domain,
      pages: [{
        url: 'https://mueller-pumpen.de/kontakt',
        kind: 'contact',
        html: '<form action="/kontakt/send"><input name="email"/></form>',
        text: 'E-Mail: anfrage@mail.mueller-pumpen.de',
      }],
    });
    expect(channels).toEqual(expect.arrayContaining([
      expect.objectContaining({ channel: 'email', value: 'anfrage@mail.mueller-pumpen.de' }),
      expect.objectContaining({ channel: 'form_url', value: 'https://mueller-pumpen.de/kontakt' }),
    ]));
    const form = channels.find((c) => c.channel === 'form_url');
    expect(form?.emailType).toBeUndefined();
  });

  it('同一邮箱出现在两页 → 只留一条（先出现的页），cap 生效', () => {
    const channels = collectCompanyChannels({
      domain,
      cap: 3,
      pages: [
        { url: 'https://mueller-pumpen.de/kontakt', kind: 'contact', text: 'info@mueller-pumpen.de vertrieb@mueller-pumpen.de einkauf@mueller-pumpen.de' },
        { url: 'https://mueller-pumpen.de/impressum', kind: 'impressum', text: 'info@mueller-pumpen.de service@mueller-pumpen.de' },
      ],
    });
    expect(channels).toHaveLength(3);
    const info = channels.find((c) => c.value === 'info@mueller-pumpen.de');
    expect(info?.sourceType).toBe('contact_page');
  });

  it('同组织域邮箱认可（sanotact-group.de 的 Impressum 发布 info@sanotact.de），第三方建站域仍拒绝', () => {
    const channels = collectCompanyChannels({
      domain: 'sanotact-group.de',
      country: 'DE',
      pages: [{
        url: 'https://www.sanotact-group.de/impressum/',
        kind: 'impressum',
        html: '<a href="mailto:info@sanotact.de">Kontakt</a> <a href="mailto:service@webagentur-xy.de">Webdesign</a>',
        text: 'Impressum',
      }],
    });
    const emails = channels.filter((c) => c.channel === 'email').map((c) => c.value);
    expect(emails).toEqual(['info@sanotact.de']);
  });

  it('HTML 实体编码的邮箱（info&#64;acme.de / &#105;nfo@acme.de）被解出', () => {
    const channels = collectCompanyChannels({
      domain: 'acme.de',
      pages: [{
        url: 'https://acme.de/impressum',
        kind: 'impressum',
        html: '<a href="mailto:info&#64;acme.de">Kontakt</a><p>&#105;nfo@acme.de</p>',
        text: 'Impressum',
      }],
    });
    const emails = channels.filter((c) => c.channel === 'email').map((c) => c.value);
    expect(emails).toEqual(['info@acme.de']);
  });

  it('第三方词根前缀/冒充中间段域不被误收（peters-webdesign vs peter.de、peter.de.evil.com）', () => {
    const channels = collectCompanyChannels({
      domain: 'peter.de',
      pages: [{
        url: 'https://peter.de/impressum',
        kind: 'impressum',
        html: '<a href="mailto:kontakt@peters-webdesign.de">a</a> <a href="mailto:info@hansapark.de">b</a> ' +
          '<a href="mailto:info@peter.de.evil.com">c</a> <a href="mailto:info@peter.de">ok</a>',
        text: '',
      }],
    });
    expect(channels.filter((c) => c.channel === 'email').map((c) => c.value)).toEqual(['info@peter.de']);
  });

  it('单段缩写邮箱（ds@/mm@）不冒认公司渠道，词形态（impressum@）保留为 other', () => {
    const channels = collectCompanyChannels({
      domain: 'acme.de',
      pages: [{ url: 'https://acme.de/impressum', kind: 'impressum', text: 'ds@acme.de mm@acme.de impressum@acme.de' }],
    });
    const emails = channels.filter((c) => c.channel === 'email');
    expect(emails.map((c) => c.value)).toEqual(['impressum@acme.de']);
    expect(emails[0]!.emailType).toBe('other');
  });

  it('网页可控的 http 页面 URL 被 fail-safe 降级（sourceUrl 省略、form_url 放弃），绝不抛错', () => {
    const channels = collectCompanyChannels({
      domain: 'legacy.de',
      pages: [
        { url: 'http://legacy.de/impressum', kind: 'impressum', text: 'info@legacy.de' },
        { url: 'http://legacy.de/kontakt', kind: 'contact', html: '<form></form>', text: '' },
      ],
    });
    const email = channels.find((c) => c.channel === 'email');
    expect(email).toBeTruthy();
    expect(email!.sourceUrl).toBeUndefined();
    expect(channels.some((c) => c.channel === 'form_url')).toBe(false);
  });

  it('非 DE/AT/CH 国家不做电话国别猜测（只收带 + 的号码）', () => {
    const channels = collectCompanyChannels({
      domain: 'acme.fr',
      country: 'FR',
      pages: [{ url: 'https://acme.fr/mentions-legales', kind: 'impressum', text: 'Tél: 01 23 45 67 89 — international: +33 1 23 45 67 89' }],
    });
    const phones = channels.filter((c) => c.channel === 'phone').map((c) => c.value);
    expect(phones).toEqual(['+33123456789']);
  });
});
