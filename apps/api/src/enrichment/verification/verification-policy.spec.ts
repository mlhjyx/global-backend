import { describe, expect, it } from 'vitest';
import {
  resolveVerificationVotes,
  scoreEmailPoint,
  scoreTier,
  type VerificationVote,
} from './verification-policy';

/**
 * P1-06（首波）：投票矩阵与评分纯函数——计划 §2.3.5.2 的矩阵行全覆盖，
 * 「单验证器永不判 VALID」与 accept_all 优先是红线。
 */
describe('resolveVerificationVotes：投票矩阵', () => {
  const vote = (
    providerKey: string,
    state: VerificationVote['state'],
    catchAllClass: VerificationVote['catchAllClass'] = 'unknown',
    acceptAll: boolean | null = null,
  ): VerificationVote => ({ providerKey, state, catchAllClass, acceptAll });

  it('双正（两家独立 deliverable）→ VALID', () => {
    expect(
      resolveVerificationVotes([
        vote('millionverifier', 'VALID', 'not_catch_all'),
        vote('emailable', 'VALID', 'not_catch_all'),
      ]),
    ).toMatchObject({ state: 'VALID', reason: 'two_positive_votes' });
  });

  it('单验证器 positive 永不判 VALID（等第二票）；同一 provider 的重复票不算第二票', () => {
    expect(resolveVerificationVotes([vote('millionverifier', 'VALID', 'not_catch_all')])).toMatchObject({
      state: 'UNKNOWN',
      reason: 'single_positive_requires_second_vote',
    });
    expect(
      resolveVerificationVotes([
        vote('millionverifier', 'VALID', 'not_catch_all'),
        vote('millionverifier', 'VALID', 'not_catch_all'),
      ]),
    ).toMatchObject({ state: 'UNKNOWN', reason: 'single_positive_requires_second_vote' });
  });

  it('invalid 无 positive → INVALID；正负冲突（1:1）→ UNKNOWN；负多数 → INVALID', () => {
    expect(resolveVerificationVotes([vote('millionverifier', 'INVALID')])).toMatchObject({
      state: 'INVALID',
      reason: 'verifier_invalid',
    });
    expect(
      resolveVerificationVotes([vote('millionverifier', 'INVALID'), vote('emailable', 'VALID')]),
    ).toMatchObject({ state: 'UNKNOWN', reason: 'verifier_conflict_unresolved' });
    expect(
      resolveVerificationVotes([
        vote('millionverifier', 'INVALID'),
        vote('emailable', 'INVALID'),
        vote('zerobounce', 'VALID'),
      ]),
    ).toMatchObject({ state: 'INVALID', reason: 'verifier_conflict_negative_majority' });
  });

  it('accept_all=true 优先：ok 也不得判 VALID，至多 CATCH_ALL_RISKY', () => {
    expect(
      resolveVerificationVotes([
        vote('millionverifier', 'VALID', 'not_catch_all', true),
        vote('emailable', 'VALID', 'not_catch_all', true),
      ]),
    ).toMatchObject({ state: 'CATCH_ALL_RISKY', catchAllClass: 'true_catch_all', reason: 'accept_all_flag' });
    // 单家 accept_all + 另一家不带标志：同样不得 VALID。
    expect(
      resolveVerificationVotes([
        vote('millionverifier', 'VALID', 'not_catch_all', true),
        vote('emailable', 'VALID', 'not_catch_all', false),
      ]).state,
    ).toBe('CATCH_ALL_RISKY');
  });

  it('catch-all 票 → CATCH_ALL_RISKY，子类取最强（true > unprobeable > inconclusive）', () => {
    expect(
      resolveVerificationVotes([
        vote('millionverifier', 'CATCH_ALL_RISKY', 'inconclusive'),
        vote('smtp_self', 'CATCH_ALL_RISKY', 'true_catch_all'),
      ]),
    ).toMatchObject({ state: 'CATCH_ALL_RISKY', catchAllClass: 'true_catch_all' });
    expect(
      resolveVerificationVotes([vote('smtp_self', 'CATCH_ALL_RISKY', 'unprobeable_provider')]),
    ).toMatchObject({ state: 'CATCH_ALL_RISKY', catchAllClass: 'unprobeable_provider' });
  });

  it('反枚举域 + 单票 positive → 不判 VALID；+ 两家独立 positive → VALID（解析器给出地址级证据）', () => {
    expect(
      resolveVerificationVotes([
        vote('smtp_self', 'CATCH_ALL_RISKY', 'unprobeable_provider'),
        vote('millionverifier', 'VALID', 'not_catch_all'),
      ]).state,
    ).toBe('UNKNOWN');
    expect(
      resolveVerificationVotes([
        vote('smtp_self', 'CATCH_ALL_RISKY', 'unprobeable_provider'),
        vote('millionverifier', 'VALID', 'not_catch_all'),
        vote('emailable', 'VALID', 'not_catch_all'),
      ]).state,
    ).toBe('VALID');
  });

  it('inconclusive-only catch-all 票 → CATCH_ALL_RISKY·inconclusive', () => {
    expect(
      resolveVerificationVotes([vote('truelist', 'CATCH_ALL_RISKY', 'inconclusive')]),
    ).toMatchObject({ state: 'CATCH_ALL_RISKY', catchAllClass: 'inconclusive' });
  });

  it('负票优先于 accept_all：明确 5xx 拒收不能被 accept_all 救回', () => {
    expect(
      resolveVerificationVotes([
        vote('millionverifier', 'INVALID'),
        vote('emailable', 'INVALID'),
        vote('zerobounce', 'VALID', 'not_catch_all', true),
      ]),
    ).toMatchObject({ state: 'INVALID', reason: 'verifier_conflict_negative_majority' });
  });

  it('全 unknown / 空投票 → UNKNOWN', () => {
    expect(resolveVerificationVotes([vote('millionverifier', 'UNKNOWN')])).toMatchObject({
      state: 'UNKNOWN',
      reason: 'inconclusive_votes',
    });
    expect(resolveVerificationVotes([])).toMatchObject({ state: 'UNKNOWN', reason: 'no_votes' });
  });
});

describe('scoreEmailPoint：0–100 评分与分档', () => {
  const now = new Date('2026-11-09T00:00:00.000Z');

  it('基础分：VALID 95 / true_catch_all 60 / unprobeable 55 / UNKNOWN 20 / INVALID 0', () => {
    expect(scoreEmailPoint({ state: 'VALID' })).toBe(95);
    expect(scoreEmailPoint({ state: 'CATCH_ALL_RISKY', catchAllClass: 'true_catch_all' })).toBe(60);
    expect(scoreEmailPoint({ state: 'CATCH_ALL_RISKY', catchAllClass: 'unprobeable_provider' })).toBe(55);
    expect(scoreEmailPoint({ state: 'UNKNOWN' })).toBe(20);
    expect(scoreEmailPoint({ state: 'INVALID' })).toBe(0);
  });

  it('一致性/pattern/供应商信心加成封顶 100', () => {
    expect(scoreEmailPoint({ state: 'VALID', positiveVotes: 2 })).toBe(100);
    expect(scoreEmailPoint({ state: 'VALID', positiveVotes: 3 })).toBe(100);
    expect(scoreEmailPoint({ state: 'UNKNOWN', patternLearned: true })).toBe(25);
    expect(scoreEmailPoint({ state: 'CATCH_ALL_RISKY', catchAllClass: 'true_catch_all', providerConfidence: 90 })).toBe(69);
  });

  it('年龄衰减：每满 90 天 −5，最低到基础分 −15；未满 90 天不衰减', () => {
    const verifiedAt = new Date(now.getTime() - 89 * 86_400_000);
    expect(scoreEmailPoint({ state: 'VALID', verifiedAt, now })).toBe(95);
    const one = new Date(now.getTime() - 90 * 86_400_000);
    expect(scoreEmailPoint({ state: 'VALID', verifiedAt: one, now })).toBe(90);
    const many = new Date(now.getTime() - 400 * 86_400_000);
    expect(scoreEmailPoint({ state: 'VALID', verifiedAt: many, now })).toBe(80);
  });

  it('软退信 3 次 −10；投诉归 0；中间分可为负时钳到 0', () => {
    expect(scoreEmailPoint({ state: 'UNKNOWN', softBounceCount: 3 })).toBe(10);
    expect(scoreEmailPoint({ state: 'VALID', complained: true })).toBe(0);
    const old = new Date(now.getTime() - 400 * 86_400_000);
    expect(scoreEmailPoint({ state: 'UNKNOWN', verifiedAt: old, now, softBounceCount: 3 })).toBe(0);
  });

  it('供应商信心：负数/NaN 不加分也不减分', () => {
    expect(scoreEmailPoint({ state: 'UNKNOWN', providerConfidence: -500 })).toBe(20);
    expect(scoreEmailPoint({ state: 'UNKNOWN', providerConfidence: Number.NaN })).toBe(20);
    expect(scoreEmailPoint({ state: 'UNKNOWN', providerConfidence: 150 })).toBe(30);
  });

  it('分档：A ≥80、B 40–79、C <40', () => {
    expect(scoreTier(95)).toBe('A');
    expect(scoreTier(80)).toBe('A');
    expect(scoreTier(79)).toBe('B');
    expect(scoreTier(40)).toBe('B');
    expect(scoreTier(39)).toBe('C');
  });
});
