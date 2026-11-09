import { describe, expect, it } from 'vitest';
import { assembleEvidenceBundle } from '../evidence-bundle';
import { evaluateCorroboration, judgeCorroborationMode } from './corroboration';

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
  it('defaults to shadow and fails safe on invalid values', () => {
    expect(judgeCorroborationMode({})).toBe('shadow');
    expect(judgeCorroborationMode({ JUDGE_CORROBORATION_MODE: 'off' })).toBe('off');
    expect(judgeCorroborationMode({ JUDGE_CORROBORATION_MODE: 'enforce' })).toBe('enforce');
    expect(judgeCorroborationMode({ JUDGE_CORROBORATION_MODE: 'SHADOW ' })).toBe('shadow');
    expect(judgeCorroborationMode({ JUDGE_CORROBORATION_MODE: 'nonsense' })).toBe('shadow');
  });
});

describe('evaluateCorroboration', () => {
  const twoTierBundle = assembleEvidenceBundle({ name: 'Acme' }, [T1, T3]);
  const oneTierBundle = assembleEvidenceBundle({ name: 'Acme' }, [T3]);

  it('passes a FIT verdict when the bundle spans two tiers', () => {
    const record = evaluateCorroboration({ verdict: 'FIT', bundle: twoTierBundle, mode: 'shadow' });
    expect(record).toMatchObject({
      shadow: true,
      mode: 'shadow',
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

  it('flags a FIT verdict backed by one tier as insufficient (still shadow)', () => {
    const record = evaluateCorroboration({ verdict: 'FIT', bundle: oneTierBundle, mode: 'shadow' });
    expect(record).toMatchObject({ reason: 'INSUFFICIENT_TIERS', corroborated: false, evaluated: true });
  });

  it('records NO_BUNDLE without failing the judgment', () => {
    const record = evaluateCorroboration({ verdict: 'NOT_FIT', bundle: null, mode: 'shadow' });
    expect(record).toMatchObject({ reason: 'NO_BUNDLE', evaluated: true, requires_corroboration: true });
  });

  it('does not apply to UNKNOWN verdicts', () => {
    const record = evaluateCorroboration({ verdict: 'UNKNOWN', bundle: twoTierBundle, mode: 'shadow' });
    expect(record).toMatchObject({
      requires_corroboration: false,
      evaluated: false,
      reason: 'NOT_APPLICABLE',
    });
  });

  it('is deterministic (no clock/env dependence when mode is passed)', () => {
    const a = evaluateCorroboration({ verdict: 'FIT', bundle: twoTierBundle, mode: 'shadow' });
    const b = evaluateCorroboration({ verdict: 'FIT', bundle: twoTierBundle, mode: 'shadow' });
    expect(a).toEqual(b);
  });
});
