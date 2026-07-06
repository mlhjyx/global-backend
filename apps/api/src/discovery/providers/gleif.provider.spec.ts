import { describe, expect, it } from 'vitest';
import { pickBest } from './gleif.provider';
import { GleifRecord } from '../../adapters/gleif';

function rec(lei: string, legalName: string, extra: Partial<GleifRecord> = {}): GleifRecord {
  return { lei, legalName, ...extra };
}

// 真实 GLEIF "TRUMPF" contains 检索会返回的一组噪声候选（含非目标同 token 公司）
const TRUMPF_CANDIDATES = [
  rec('5299007DQPD2QYB17B54', 'Trumpf Vermögensverwaltung GbR'),
  rec('875500QIWPHRUM3LQ468', 'Brandt & Trumpf GmbH'),
  rec('529900WJ5PTEQ4V00I90', 'TRUMPF Laser SE'),
  rec('EXACTMATCHLEI00000001', 'TRUMPF GmbH + Co. KG'),
];

describe('GLEIF 最佳匹配 + 置信度 + 歧义护栏（绝不贴错身份）', () => {
  it('精确规范化名 → 满分命中且甩开次佳', () => {
    const best = pickBest('TRUMPF GmbH + Co. KG', TRUMPF_CANDIDATES);
    expect(best?.record.lei).toBe('EXACTMATCHLEI00000001');
    expect(best?.score).toBe(1);
    expect(best?.margin).toBeGreaterThanOrEqual(0.1);
  });

  it('查询完全被候选包含 → 强分选中更具体的那条（而非同 token 的泛名/异公司）', () => {
    const best = pickBest('TRUMPF Laser', TRUMPF_CANDIDATES);
    expect(best?.record.legalName).toBe('TRUMPF Laser SE');
    expect(best?.score).toBeGreaterThanOrEqual(0.72);
    expect(best?.margin).toBeGreaterThanOrEqual(0.1); // 甩开 "TRUMPF"/"Brandt & Trumpf"
  });

  it('拼写全称法人形式与缩写归一等价："Siemens AG" ≡ "Siemens Aktiengesellschaft"', () => {
    // 模拟真实 GLEIF 对 "Siemens" 的 123 条 contains 命中（真身埋在基金/基金会里）
    const siemens = [
      rec('F1', 'Siemens-Fonds Siemens-Rente'),
      rec('F2', 'Siemens Auszahlungsfonds'),
      rec('S1', 'Siemens Stiftung'),
      rec('AG', 'Siemens Aktiengesellschaft'),
      rec('F3', 'Siemens EuroCash'),
    ];
    const best = pickBest('Siemens AG', siemens);
    expect(best?.record.lei).toBe('AG'); // 精确命中真身 Siemens Aktiengesellschaft
    expect(best?.score).toBe(1);
    expect(best?.margin).toBeGreaterThanOrEqual(0.1);
  });

  it('多个同前缀实体并列、无突出者 → margin 低于护栏（调用方据此 miss，不乱贴）', () => {
    const ambiguous = [
      rec('A', 'Müller Präzision GmbH'),
      rec('B', 'Müller Technik GmbH'),
      rec('C', 'Müller Bau GmbH'),
    ];
    const best = pickBest('Müller', ambiguous);
    expect(best!.score).toBeGreaterThanOrEqual(0.72); // 单看分数够高
    expect(best!.margin).toBeLessThan(0.1); // 但没有突出者 → 歧义 → 不贴
  });

  it('只共享零核心 token 的公司分数低于门槛（被拒绝）', () => {
    const noise = [rec('X', 'Schmidt Präzision GmbH'), rec('Y', 'Weber Automotive AG')];
    const best = pickBest('Bayerische Motoren Werke', noise);
    expect(best!.score).toBeLessThan(0.72);
  });

  it('空/无核心 token 名不误命中', () => {
    expect(pickBest('GmbH', TRUMPF_CANDIDATES)).toBeNull(); // 全是法人后缀 → 无 token
  });

  it('候选为空返回 null', () => {
    expect(pickBest('TRUMPF', [])).toBeNull();
  });
});
