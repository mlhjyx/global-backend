import { describe, expect, it } from 'vitest';
import { assembleEvidenceBundle } from '../evidence-bundle';
import {
  enforceCorroboration,
  evaluateCorroboration,
  judgeCorroborationMode,
} from './corroboration';

const T1 = {
  tier: 'T1' as const,
  source_key: 'gleif',
  evidence_kind: 'legal_identity',
  facts: { registry_lei: '529900DI47YZJ5P7QQ76' },
};
const T3 = {
  tier: 'T3' as const,
  source_key: 'website_profile',
  evidence_kind: 'website',
  facts: { trade_role: 'manufacturer' },
};

describe('judgeCorroborationMode', () => {
  it('defaults to enforce (影子期已取消) and fails closed on invalid values', () => {
    expect(judgeCorroborationMode({})).toBe('enforce');
    expect(judgeCorroborationMode({ JUDGE_CORROBORATION_MODE: 'off' })).toBe('off');
    expect(judgeCorroborationMode({ JUDGE_CORROBORATION_MODE: 'shadow' })).toBe('shadow');
    expect(judgeCorroborationMode({ JUDGE_CORROBORATION_MODE: 'ENFORCE ' })).toBe('enforce');
    // 拼写错误不得静默关闭门 → fail-closed 到 enforce
    expect(judgeCorroborationMode({ JUDGE_CORROBORATION_MODE: 'nonsense' })).toBe('enforce');
  });
});

describe('evaluateCorroboration', () => {
  const twoTierBundle = assembleEvidenceBundle({ name: 'Acme' }, [T1, T3]);
  const oneTierBundle = assembleEvidenceBundle({ name: 'Acme' }, [T3]);

  it('passes a FIT verdict when the bundle spans two tiers', () => {
    const record = evaluateCorroboration({ verdict: 'FIT', bundle: twoTierBundle, mode: 'enforce' });
    expect(record).toMatchObject({
      mode: 'enforce',
      enforced: true,
      requires_corroboration: true,
      evaluated: true,
      reason: 'CORROBORATED',
      corroborated: true,
      tiers_present: ['T1', 'T3'],
      distinct_sources: 2,
      required_min_tiers: 2,
    });
    expect(record.bundle_built_at).toBe(twoTierBundle.built_at);
  });

  it('flags a FIT verdict backed by one tier as insufficient', () => {
    const record = evaluateCorroboration({ verdict: 'FIT', bundle: oneTierBundle, mode: 'enforce' });
    expect(record).toMatchObject({ reason: 'INSUFFICIENT_TIERS', corroborated: false, evaluated: true });
  });

  it('records NO_BUNDLE', () => {
    const record = evaluateCorroboration({ verdict: 'NOT_FIT', bundle: null, mode: 'enforce' });
    expect(record).toMatchObject({ reason: 'NO_BUNDLE', evaluated: true, requires_corroboration: true });
  });

  it('does not apply to UNKNOWN verdicts', () => {
    const record = evaluateCorroboration({ verdict: 'UNKNOWN', bundle: twoTierBundle, mode: 'enforce' });
    expect(record).toMatchObject({
      requires_corroboration: false,
      enforced: false,
      evaluated: false,
      reason: 'NOT_APPLICABLE',
    });
  });
});

describe('enforceCorroboration', () => {
  const twoTierBundle = assembleEvidenceBundle({ name: 'Acme' }, [T1, T3]);
  const oneTierBundle = assembleEvidenceBundle({ name: 'Acme' }, [T3]);

  it('keeps a corroborated FIT unchanged and records the evaluation', () => {
    const result = enforceCorroboration({ verdict: 'match', bundle: twoTierBundle, mode: 'enforce' });
    expect(result).toMatchObject({ verdict: 'match', proposed: 'match', downgraded: false, reasonLine: null });
    expect(result.record).toMatchObject({ reason: 'CORROBORATED', enforced: true });
  });

  it('downgrades an insufficient FIT to weak (fail-closed) with a reason line', () => {
    const result = enforceCorroboration({ verdict: 'match', bundle: oneTierBundle, mode: 'enforce' });
    expect(result.verdict).toBe('weak');
    expect(result.proposed).toBe('match');
    expect(result.downgraded).toBe(true);
    expect(result.record).toMatchObject({
      reason: 'INSUFFICIENT_TIERS',
      enforced: true,
      downgraded_from: 'FIT',
    });
    expect(result.reasonLine).toContain('跨源佐证门');
    expect(result.reasonLine).toContain('降级');
  });

  it('downgrades a NOT_FIT without any bundle to weak (never auto-reject on no evidence)', () => {
    const result = enforceCorroboration({ verdict: 'mismatch', bundle: null, mode: 'enforce' });
    expect(result.verdict).toBe('weak');
    expect(result.record).toMatchObject({ reason: 'NO_BUNDLE', downgraded_from: 'NOT_FIT' });
  });

  it('shadow mode records but never downgrades (rollback switch)', () => {
    const result = enforceCorroboration({ verdict: 'match', bundle: oneTierBundle, mode: 'shadow' });
    expect(result).toMatchObject({ verdict: 'match', downgraded: false, reasonLine: null });
    expect(result.record).toMatchObject({ reason: 'INSUFFICIENT_TIERS', enforced: false });
  });

  it('off mode neither records nor downgrades', () => {
    const result = enforceCorroboration({ verdict: 'match', bundle: oneTierBundle, mode: 'off' });
    expect(result).toMatchObject({ verdict: 'match', downgraded: false });
    expect(result.record.enforced).toBe(false);
  });

  it('leaves weak verdicts untouched', () => {
    const result = enforceCorroboration({ verdict: 'weak', bundle: oneTierBundle, mode: 'enforce' });
    expect(result).toMatchObject({ verdict: 'weak', downgraded: false });
    expect(result.record.reason).toBe('NOT_APPLICABLE');
  });
});
