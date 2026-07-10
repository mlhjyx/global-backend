import { describe, expect, it } from 'vitest';
import {
  KNOWN_PATTERNS,
  buildLocalPart,
  generateEmailCandidates,
  parseName,
  transliterateVariants,
} from './email-permutation';

describe('email-permutation · 音译变体', () => {
  it('德语标准 + 去音标两套变体', () => {
    expect(transliterateVariants('Jörg')).toEqual(['joerg', 'jorg']);
    expect(transliterateVariants('Müller')).toEqual(['mueller', 'muller']);
    expect(transliterateVariants('Weiß')).toEqual(['weiss']); // ß→ss 两套一致 → 去重后一个
  });

  it('法/西音标去组合记号', () => {
    expect(transliterateVariants('José')).toEqual(['jose']);
    expect(transliterateVariants('François')).toEqual(['francois']);
  });

  it('纯 ASCII 名单一变体', () => {
    expect(transliterateVariants('Herold')).toEqual(['herold']);
  });

  it('空/空白返回空数组', () => {
    expect(transliterateVariants('  ')).toEqual([]);
  });
});

describe('email-permutation · 姓名解析', () => {
  it('去称谓/学位前缀', () => {
    expect(parseName('Dr. Max Müller')).toMatchObject({ given: 'Max', surname: 'Müller' });
    expect(parseName('Dipl.-Ing. Klaus Weber')).toMatchObject({ given: 'Klaus', surname: 'Weber' });
  });

  it('贵族前缀归入姓，core 取末段', () => {
    expect(parseName('Anna von der Berg')).toMatchObject({
      given: 'Anna',
      surname: 'von der Berg',
      surnameCore: 'Berg',
    });
  });

  it('连字符姓保留', () => {
    expect(parseName('Klaus Müller-Lüdenscheidt')).toMatchObject({
      given: 'Klaus',
      surname: 'Müller-Lüdenscheidt',
    });
  });

  it('单 token = 只有名', () => {
    expect(parseName('Cher')).toMatchObject({ given: 'Cher', surname: '' });
  });

  it('空 → null', () => {
    expect(parseName('   ')).toBeNull();
    expect(parseName('Dr.')).toBeNull(); // 全是称谓 → 无有效 token
  });
});

describe('email-permutation · 候选生成', () => {
  it('first.last 与 f.last 在最前（先验最高）', () => {
    const c = generateEmailCandidates('Hans Herold', 'acme.de');
    expect(c[0]).toMatchObject({ email: 'hans.herold@acme.de', pattern: 'first.last' });
    expect(c[1]).toMatchObject({ email: 'h.herold@acme.de', pattern: 'f.last' });
  });

  it('先验降序', () => {
    const c = generateEmailCandidates('Hans Herold', 'acme.de');
    for (let i = 1; i < c.length; i += 1) expect(c[i - 1].prior).toBeGreaterThanOrEqual(c[i].prior);
  });

  it('umlaut 名同时产德语标准与去音标两套', () => {
    const emails = generateEmailCandidates('Jörg Müller', 'acme.de').map((c) => c.email);
    expect(emails).toContain('joerg.mueller@acme.de');
    expect(emails).toContain('jorg.muller@acme.de');
  });

  it('贵族前缀姓：整段压平与 core 段都在候选里', () => {
    const emails = generateEmailCandidates('Anna von der Berg', 'acme.de').map((c) => c.email);
    expect(emails).toContain('anna.vonderberg@acme.de');
    expect(emails).toContain('anna.berg@acme.de');
  });

  it('候选去重且有界', () => {
    const c = generateEmailCandidates('Hans Herold', 'acme.de', { maxCandidates: 3 });
    expect(c).toHaveLength(3);
    expect(new Set(c.map((x) => x.email)).size).toBe(3);
  });

  it('单名（无姓）只出 first 类', () => {
    const c = generateEmailCandidates('Cher', 'acme.de');
    expect(c.every((x) => x.pattern === 'first')).toBe(true);
    expect(c[0].email).toBe('cher@acme.de');
  });

  it('无效域/空名 → 空', () => {
    expect(generateEmailCandidates('Hans Herold', 'not-a-domain')).toEqual([]);
    expect(generateEmailCandidates('', 'acme.de')).toEqual([]);
  });

  it('域名去 www./前导 @', () => {
    const c = generateEmailCandidates('Hans Herold', 'www.acme.de');
    expect(c[0].email).toBe('hans.herold@acme.de');
  });
});

describe('email-permutation · buildLocalPart / KNOWN_PATTERNS', () => {
  it('KNOWN_PATTERNS 暴露标签+先验', () => {
    expect(KNOWN_PATTERNS.find((p) => p.label === 'first.last')?.prior).toBe(0.9);
  });

  it('buildLocalPart 复用同一套定义', () => {
    expect(buildLocalPart('f.last', { first: 'hans', fi: 'h', last: 'herold', li: 'h' })).toBe('h.herold');
    expect(buildLocalPart('first.last', { first: 'hans', fi: 'h', last: 'herold', li: 'h' })).toBe('hans.herold');
    expect(buildLocalPart('unknown', { first: 'hans', fi: 'h', last: 'herold', li: 'h' })).toBeNull();
  });
});
