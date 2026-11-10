import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  QUICK_JUDGE_BATCH_SIZE,
  QUICK_SCAN_POOL_LIMIT,
  QUICK_SCAN_POOL_LIMIT_CAPPED,
  QUICK_SCAN_POOL_LIMIT_MAX,
  UNCAPPED_QUICK_SCAN_POOL_LIMIT,
  buildQuickJudgePrompt,
  parseQuickJudgeBatch,
  prefilterAttributes,
  prefilterCompany,
  resolveQuickScanPoolLimit,
} from './quick-scan';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

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

describe('QUICK_SCAN_POOL_LIMIT —— 产品帽 vs 防爆安全界', () => {
  it('off：产品帽 500，忽略 env 覆盖（行为与今天一致）', () => {
    expect(resolveQuickScanPoolLimit({} as NodeJS.ProcessEnv)).toBe(
      QUICK_SCAN_POOL_LIMIT_CAPPED,
    );
    expect(
      resolveQuickScanPoolLimit({
        DISCOVERY_QUICK_SCAN_POOL_LIMIT: '9000',
      } as NodeJS.ProcessEnv),
    ).toBe(QUICK_SCAN_POOL_LIMIT_CAPPED);
    expect(QUICK_SCAN_POOL_LIMIT).toBe(500);
  });

  it('on：默认防爆界 5 万；env 可调，畸形/越界回退默认', () => {
    const on = (raw?: string): number =>
      resolveQuickScanPoolLimit({
        DISCOVERY_UNCAPPED: 'on',
        ...(raw === undefined ? {} : { DISCOVERY_QUICK_SCAN_POOL_LIMIT: raw }),
      } as NodeJS.ProcessEnv);

    expect(on()).toBe(UNCAPPED_QUICK_SCAN_POOL_LIMIT);
    expect(on('9000')).toBe(9_000);
    expect(on(`${QUICK_SCAN_POOL_LIMIT_MAX}`)).toBe(QUICK_SCAN_POOL_LIMIT_MAX);
    for (const raw of ['0', '-1', '1e3', '100abc', '10.5', '', `${QUICK_SCAN_POOL_LIMIT_MAX + 1}`]) {
      expect(on(raw)).toBe(UNCAPPED_QUICK_SCAN_POOL_LIMIT);
    }
  });

  it('进程 env DISCOVERY_UNCAPPED=on：模块常量切到防爆界', async () => {
    vi.resetModules();
    vi.stubEnv('DISCOVERY_UNCAPPED', 'on');
    const mod = await import('./quick-scan');
    expect(mod.QUICK_SCAN_POOL_LIMIT).toBe(UNCAPPED_QUICK_SCAN_POOL_LIMIT);
  });
});
