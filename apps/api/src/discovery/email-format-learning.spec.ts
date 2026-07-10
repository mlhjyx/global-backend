import { describe, expect, it } from 'vitest';
import { applyLearnedPattern, inferEmailPattern } from './email-format-learning';

describe('email-format-learning · 反推命名法', () => {
  it('单样本 s.vogt → f.last，基线置信 0.6', () => {
    const learned = inferEmailPattern([{ fullName: 'Sabine Vogt', email: 's.vogt@acme.de' }]);
    expect(learned).toMatchObject({ pattern: 'f.last', support: 1, samples: 1 });
    expect(learned?.confidence).toBeCloseTo(0.6);
  });

  it('多一致样本抬升置信', () => {
    const learned = inferEmailPattern([
      { fullName: 'Sabine Vogt', email: 's.vogt@acme.de' },
      { fullName: 'Klaus Weber', email: 'k.weber@acme.de' },
    ]);
    expect(learned?.pattern).toBe('f.last');
    expect(learned?.support).toBe(2);
    expect(learned?.confidence).toBeCloseTo(0.75);
  });

  it('first.last 命名法', () => {
    const learned = inferEmailPattern([{ fullName: 'Hans Herold', email: 'hans.herold@acme.de' }]);
    expect(learned?.pattern).toBe('first.last');
  });

  it('umlaut 样本经音译匹配', () => {
    const learned = inferEmailPattern([{ fullName: 'Jörg Müller', email: 'j.mueller@acme.de' }]);
    expect(learned?.pattern).toBe('f.last');
  });

  it('无法解析/不吻合 → null', () => {
    expect(inferEmailPattern([{ fullName: 'Hans Herold', email: 'xyz123@acme.de' }])).toBeNull();
    expect(inferEmailPattern([])).toBeNull();
  });
});

describe('email-format-learning · 套用到新姓名', () => {
  it('学到 f.last 套到 Hans Herold', () => {
    const learned = inferEmailPattern([{ fullName: 'Sabine Vogt', email: 's.vogt@acme.de' }])!;
    const out = applyLearnedPattern(learned, 'Hans Herold', 'acme.de');
    expect(out[0]).toMatchObject({ email: 'h.herold@acme.de', pattern: 'learned:f.last' });
    expect(out[0].prior).toBeCloseTo(0.6); // 用学习置信度
  });

  it('umlaut 目标名产两套变体', () => {
    const learned = inferEmailPattern([{ fullName: 'Sabine Vogt', email: 's.vogt@acme.de' }])!;
    const emails = applyLearnedPattern(learned, 'Jörg Müller', 'acme.de').map((c) => c.email);
    expect(emails).toContain('j.mueller@acme.de');
    expect(emails).toContain('j.muller@acme.de');
  });

  it('缺姓无法套 last 类 → 空', () => {
    const learned = inferEmailPattern([{ fullName: 'Sabine Vogt', email: 's.vogt@acme.de' }])!;
    expect(applyLearnedPattern(learned, 'Cher', 'acme.de')).toEqual([]);
  });

  it('无效域 → 空', () => {
    const learned = inferEmailPattern([{ fullName: 'Sabine Vogt', email: 's.vogt@acme.de' }])!;
    expect(applyLearnedPattern(learned, 'Hans Herold', 'bad')).toEqual([]);
  });
});
