import { describe, expect, it } from 'vitest';
import {
  decodeCfEmail,
  decodeHtmlEntities,
  decodeObfuscatedEmails,
  extractJsonLdContacts,
  normalizePhone,
  stripHtml,
} from './impressum-extract';

/**
 * A1：Impressum 挖掘器的确定性抽取原语（无 LLM、无幻觉）。每种形态都来自真实德语区
 * Impressum/kontakt 页的公开样本；纯函数可钉死。
 */
describe('decodeCfEmail（Cloudflare 邮箱混淆）', () => {
  it('XOR 解码 cfemail（首字节为 key）', () => {
    // 'info@mueller-pumpen.de' 的 cfemail 编码（key=0x2a）
    const encoded = '2a43444c456a475f4f46464f58075a5f475a4f44044e4f';
    expect(decodeCfEmail(encoded)).toBe('info@mueller-pumpen.de');
  });

  it('非法输入返回 null 而不抛错', () => {
    expect(decodeCfEmail('')).toBeNull();
    expect(decodeCfEmail('zz')).toBeNull();
    expect(decodeCfEmail('1')).toBeNull();
    expect(decodeCfEmail('xy')).toBeNull();
  });

  it('解码结果不像邮箱也返回 null（防脏数据）', () => {
    expect(decodeCfEmail('2a00010203')).toBeNull();
  });
});

describe('extractJsonLdContacts（schema.org contactPoint）', () => {
  it('抽组织级 email/telephone（contactPoint 数组 + @graph 包装）', () => {
    const html = `
      <html><head>
      <script type="application/ld+json">
      {"@context":"https://schema.org","@graph":[
        {"@type":"Organization","name":"Müller Pumpen GmbH",
         "email":"info@mueller-pumpen.de","telephone":"+49 89 1234567",
         "contactPoint":[{"@type":"ContactPoint","email":"vertrieb@mueller-pumpen.de","telephone":"+49 89 1234568","contactType":"sales"}]}
      ]}
      </script></head><body></body></html>`;
    const out = extractJsonLdContacts(html);
    expect(out.emails).toEqual(expect.arrayContaining(['info@mueller-pumpen.de', 'vertrieb@mueller-pumpen.de']));
    expect(out.phones).toEqual(expect.arrayContaining(['+49 89 1234567', '+49 89 1234568']));
  });

  it('Person 型条目的 email 不进公司级结果（个人数据只走联系人层）', () => {
    const html = `
      <script type="application/ld+json">
      {"@type":"Organization","name":"Acme","email":"info@acme.de",
       "employee":[{"@type":"Person","name":"Max Mustermann","email":"max@acme.de"}]}
      </script>`;
    const out = extractJsonLdContacts(html);
    expect(out.emails).toContain('info@acme.de');
    expect(out.emails).not.toContain('max@acme.de');
  });

  it('坏 JSON / 非 ld+json script 不抛错', () => {
    expect(extractJsonLdContacts('<script type="application/ld+json">{oops</script>')).toEqual({ emails: [], phones: [] });
    expect(extractJsonLdContacts('<script>var a=1</script>')).toEqual({ emails: [], phones: [] });
  });
});

describe('decodeObfuscatedEmails（文本混淆形态）', () => {
  it.each([
    ['Kontakt: info [at] mueller-pumpen [dot] de', 'info@mueller-pumpen.de'],
    ['vertrieb(at)mueller-pumpen(dot)de', 'vertrieb@mueller-pumpen.de'],
    ['sales {at} mueller-pumpen {dot} de', 'sales@mueller-pumpen.de'],
    ['einkauf AT mueller-pumpen DOT de', 'einkauf@mueller-pumpen.de'],
    ['vertrieb (ät) mueller-pumpen (punkt) de', 'vertrieb@mueller-pumpen.de'],
  ])('%s → %s', (text, expected) => {
    expect(decodeObfuscatedEmails(text)).toContain(expected);
  });

  it('不把普通文本误认成邮箱', () => {
    expect(decodeObfuscatedEmails('Öffnungszeiten: Mo-Fr 8-17 Uhr')).toEqual([]);
  });
});

describe('normalizePhone（总机归一，供幂等唯一键）', () => {
  it.each([
    ['+49 (0)89 1234567', '+49891234567'],
    ['+49 89 1234567', '+49891234567'],
    ['089/1234567', '+49891234567'],
    ['089 1234567', '+49891234567'],
    ['+49-89-1234567', '+49891234567'],
    ['tel: +49 89 123 45 67', '+49891234567'],
  ])('%s → %s', (raw, expected) => {
    expect(normalizePhone(raw, 'DE')).toBe(expected);
  });

  it('拒绝过短/无数字的输入', () => {
    expect(normalizePhone('123')).toBeNull();
    expect(normalizePhone('kein Telefon')).toBeNull();
  });
});

describe('decodeHtmlEntities / stripHtml', () => {
  it('数字与命名实体解码；剥离标签与脚本', () => {
    expect(decodeHtmlEntities('info&#64;acme.de')).toBe('info@acme.de');
    expect(decodeHtmlEntities('&#105;nfo@acme.de')).toBe('info@acme.de');
    expect(decodeHtmlEntities('a &amp; b')).toBe('a & b');
    expect(stripHtml('<p>info&#64;acme.de</p><script>var x=1;</script>').trim()).toBe('info@acme.de');
  });

  it('非法实体保持原样，不抛错', () => {
    expect(decodeHtmlEntities('&#x110000;')).toBe('&#x110000;');
    expect(decodeHtmlEntities('&#0;')).toBe('&#0;');
  });
});
