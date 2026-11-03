import { describe, expect, it } from 'vitest';
import {
  QUICK_JUDGE_BATCH_SIZE,
  buildQuickJudgePrompt,
  parseQuickJudgeBatch,
  prefilterAttributes,
  prefilterCompany,
} from './quick-scan';

const company = {
  id: 'c1',
  name: 'Acme Pumpen GmbH',
  domain: 'acme-pumpen.de',
  country: 'DE',
  industry: 'industrial pumps',
  employeeCount: 45,
  attributes: { keywords: ['pumpen', 'vertrieb'], country: 'DE' },
};

describe('M0③ 快扫：规则预筛', () => {
  it('keeps every company when the ICP has no rules', () => {
    expect(prefilterCompany([], company)).toEqual({
      decision: 'candidate',
      verdict: 'match',
      score: null,
    });
  });

  it('prefilters a company hit by an exclusion rule before any model call', () => {
    const decision = prefilterCompany(
      [{ kind: 'EXCLUSION', field: 'country', operator: 'in', value: ['CN'] }],
      { ...company, country: 'CN' },
    );
    expect(decision.decision).toBe('prefiltered_out');
    expect(decision.verdict).toBe('exclude');
  });

  it('prefilters a company failing a MUST_HAVE rule', () => {
    const decision = prefilterCompany(
      [{ kind: 'MUST_HAVE', field: 'industry', operator: 'contains', value: ['pumps'] }],
      { ...company, industry: 'textiles' },
    );
    expect(decision.decision).toBe('prefiltered_out');
    expect(decision.verdict).toBe('no_match');
  });

  it('keeps a company whose attributes are unknown (review goes to the quick judge)', () => {
    const decision = prefilterCompany(
      [{ kind: 'MUST_HAVE', field: 'certifications', operator: 'contains', value: ['ISO 9001'] }],
      company,
    );
    expect(decision.decision).toBe('candidate');
    expect(decision.verdict).toBe('review');
  });

  it('treats mirrored MUST_HAVE exclusions as advisory so distributors are not pre-killed', () => {
    // ICP generators mirror `keywords contains 泵` into `keywords not_contains 泵`; the mirror
    // passes on English attribute vocabularies and must not exclude the company.
    const decision = prefilterCompany(
      [
        { kind: 'MUST_HAVE', field: 'keywords', operator: 'contains', value: ['pumpen'] },
        { kind: 'EXCLUSION', field: 'keywords', operator: 'not_contains', value: ['pumpen'] },
      ],
      company,
    );
    expect(decision.decision).toBe('candidate');
  });

  it('merges canonical columns into the rule attribute record', () => {
    expect(prefilterAttributes(company)).toMatchObject({
      name: 'Acme Pumpen GmbH',
      domain: 'acme-pumpen.de',
      country: 'DE',
      industry: 'industrial pumps',
      employee_count: 45,
      employeeCount: 45,
      keywords: ['pumpen', 'vertrieb'],
    });
  });
});

describe('M0③ 快扫：批量粗判解析', () => {
  it('batches eight companies per call', () => {
    expect(QUICK_JUDGE_BATCH_SIZE).toBe(8);
  });

  it('parses a well-formed batch into per-index verdicts', () => {
    expect(
      parseQuickJudgeBatch(
        {
          judgments: [
            { index: 0, verdict: 'match', reason: 'distributor' },
            { index: 1, verdict: 'mismatch', reason: 'competitor' },
            { index: 2, verdict: 'weak', reason: 'unclear' },
          ],
        },
        4,
      ),
    ).toEqual(['match', 'mismatch', 'weak', null]);
  });

  it('returns all-null when the batch output is unparseable (caller degrades per company)', () => {
    expect(parseQuickJudgeBatch({ nope: true }, 2)).toEqual([null, null]);
    expect(parseQuickJudgeBatch(undefined, 2)).toEqual([null, null]);
  });

  it('ignores out-of-range, duplicate and invalid entries', () => {
    expect(
      parseQuickJudgeBatch(
        {
          judgments: [
            { index: 9, verdict: 'match' },
            { index: 0, verdict: 'maybe' },
            { index: 1, verdict: 'match' },
            { index: 1, verdict: 'mismatch' },
          ],
        },
        2,
      ),
    ).toEqual([null, 'match']);
  });

  it('labels each company with its index in the prompt', () => {
    const prompt = buildQuickJudgePrompt({ icp_name: 'DE pump distributors' }, [company, { ...company, id: 'c2', name: 'Beta' }]);
    expect(prompt).toContain('0');
    expect(prompt).toContain('Beta');
    expect(prompt).toContain('DE pump distributors');
  });
});
