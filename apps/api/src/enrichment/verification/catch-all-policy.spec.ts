import { describe, expect, it } from 'vitest';
import {
  CATCH_ALL_GRAY_COUNTRIES,
  DEFAULT_CATCH_ALL_SEND_POLICY,
  catchAllSendTier,
  evaluateCatchAllEligibility,
  resolveCatchAllSendPolicyFromEnv,
} from './catch-all-policy';

/**
 * P1：catch-all 发送分层——阈值（≥70 正常、40–69 灰度、<40 抑制）与灰度白名单（仅 US/FR）。
 * 德国永不进入灰度（UWG §7(2) Nr.2）；UNKNOWN/INVALID 永不发送。
 */
describe('catch-all 阈值分层', () => {
  it('默认常量：70/40，白名单 US/FR', () => {
    expect(DEFAULT_CATCH_ALL_SEND_POLICY).toEqual({
      normalMinScore: 70,
      grayMinScore: 40,
      grayCountries: ['US', 'FR'],
    });
    expect(CATCH_ALL_GRAY_COUNTRIES).toEqual(['US', 'FR']);
  });

  it('≥70 正常、40–69 灰度、<40 抑制（边界值逐字）', () => {
    expect(catchAllSendTier(100)).toBe('normal');
    expect(catchAllSendTier(70)).toBe('normal');
    expect(catchAllSendTier(69)).toBe('gray');
    expect(catchAllSendTier(40)).toBe('gray');
    expect(catchAllSendTier(39)).toBe('suppressed');
    expect(catchAllSendTier(0)).toBe('suppressed');
  });

  it('env 覆盖：阈值可调、国家大小写归一，非法值回退默认', () => {
    expect(
      resolveCatchAllSendPolicyFromEnv({
        CATCH_ALL_NORMAL_MIN_SCORE: '80',
        CATCH_ALL_GRAY_MIN_SCORE: '50',
        CATCH_ALL_GRAY_COUNTRIES: 'us, fr',
      }),
    ).toEqual({ normalMinScore: 80, grayMinScore: 50, grayCountries: ['US', 'FR'] });
    expect(
      resolveCatchAllSendPolicyFromEnv({
        CATCH_ALL_NORMAL_MIN_SCORE: 'abc',
        CATCH_ALL_GRAY_MIN_SCORE: '200',
        CATCH_ALL_GRAY_COUNTRIES: ',,',
      }),
    ).toEqual(DEFAULT_CATCH_ALL_SEND_POLICY);
    // 灰阈值高于正常阈值时被压到正常阈值（区间必须单调）。
    expect(
      resolveCatchAllSendPolicyFromEnv({ CATCH_ALL_NORMAL_MIN_SCORE: '60', CATCH_ALL_GRAY_MIN_SCORE: '90' })
        .grayMinScore,
    ).toBe(60);
  });
});

describe('evaluateCatchAllEligibility：分层 + 白名单 + 状态门', () => {
  it('VALID 地址不受 catch-all 策略约束', () => {
    expect(evaluateCatchAllEligibility({ state: 'VALID', score: 95, country: 'DE' })).toMatchObject({
      tier: 'normal',
      eligible: true,
      reason: 'valid_not_catch_all',
    });
  });

  it('UNKNOWN / INVALID 永不发送（先验证/终态）', () => {
    expect(evaluateCatchAllEligibility({ state: 'UNKNOWN', score: 90, country: 'US' })).toMatchObject({
      eligible: false,
      reason: 'state_not_eligible',
    });
    expect(evaluateCatchAllEligibility({ state: 'INVALID', score: 0, country: 'US' })).toMatchObject({
      eligible: false,
      reason: 'state_not_eligible',
    });
  });

  it('CATCH_ALL_RISKY：≥70 且白名单国家 → 正常分层；40–69 → 灰度；<40 → 抑制', () => {
    expect(
      evaluateCatchAllEligibility({ state: 'CATCH_ALL_RISKY', score: 75, country: 'US' }),
    ).toMatchObject({ tier: 'normal', eligible: true, reason: 'eligible_normal' });
    expect(
      evaluateCatchAllEligibility({ state: 'CATCH_ALL_RISKY', score: 55, country: 'fr' }),
    ).toMatchObject({ tier: 'gray', eligible: true, reason: 'eligible_gray' });
    expect(
      evaluateCatchAllEligibility({ state: 'CATCH_ALL_RISKY', score: 39, country: 'US' }),
    ).toMatchObject({ tier: 'suppressed', eligible: false, reason: 'score_suppressed' });
  });

  it('德国/其他非白名单国家一律不进入（无论分数多高）', () => {
    expect(
      evaluateCatchAllEligibility({ state: 'CATCH_ALL_RISKY', score: 95, country: 'DE' }),
    ).toMatchObject({ eligible: false, reason: 'country_not_whitelisted' });
    expect(
      evaluateCatchAllEligibility({ state: 'CATCH_ALL_RISKY', score: 55, country: null }),
    ).toMatchObject({ eligible: false, reason: 'country_not_whitelisted' });
  });
});
