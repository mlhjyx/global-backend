import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../model-runtime/structured-task-runtime-bridge', () => ({
  executeStructuredTaskWithRuntime: vi.fn(),
}));

import { executeStructuredTaskWithRuntime } from '../model-runtime/structured-task-runtime-bridge';
import { getTask } from '../ai-tasks/task-registry';
import { BudgetExceededError } from '../tools/budget-store';
import {
  judgeFitCompany,
  persistJudgmentRecordInTransaction,
  type FitJudgment,
} from './fit-judge';
import {
  companyDomainEvidenceUrlPolicy,
  judgeContractMode,
  judgeFitV2,
} from './fit-judge-v2';
import { PROMPT_HASH } from './judgment/judge-prompt';
import type { JudgeCriterionOutput, JudgeOutputV2 } from './judgment/judge-output-v2';

const executeTask = vi.mocked(executeStructuredTaskWithRuntime);

const WS = '10000000-0000-4000-8000-000000000001';
const ICP_ID = '20000000-0000-4000-8000-000000000001';
const NOW = '2026-11-09T12:00:00.000Z';

const ICP_BRIEF = { seller: 'Seller GmbH', seller_summary: 'laser cutting machines' };

const company = {
  id: 'company-1',
  name: 'Acme Pumps',
  domain: 'acme.example',
  country: 'DE',
  industry: 'industrial pumps',
  attributes: {
    products: ['industrial pumps'],
    keywords: ['distributor'],
    // 共享夹具带 T1（GLEIF 法人身份）+ T3（官网画像）：跨源佐证门（默认 enforce）下达标，
    // 使本文件其余用例继续测它们各自的主题；单层/无包的降级行为见专门的 describe。
    gleif: {
      lei: '529900DI47YZJ5P7QQ76',
      legal_name: 'Acme Pumps GmbH',
      registered_country: 'DE',
    },
    website_profile: {
      trade_role: 'distributor',
      carried_brands: ['Brand X'],
      evidence: ['Acme distributes industrial pumps'],
    },
  },
};

/** v1 四门输出（off/shadow 的旧路径）。 */
const v1Output = {
  verdict: 'match',
  material_gate: 'pass：材质匹配',
  role_gate: 'pass：下游买家',
  process_gate: 'pass：核心工艺',
  business_model_gate: 'pass：转售分销',
  reasons: ['匹配'],
};

type Scores = Record<JudgeCriterionOutput['id'], number>;

const SCORES_FIT: Scores = {
  C1_MATERIAL: 9,
  C2_ROLE: 9,
  C3_PROCESS: 8,
  C4_BUSINESS_MODEL: 8,
  C5_SIZE: 8,
};
const SCORES_NOT_FIT: Scores = {
  C1_MATERIAL: 3,
  C2_ROLE: 3,
  C3_PROCESS: 3,
  C4_BUSINESS_MODEL: 3,
  C5_SIZE: 3,
};

function criterion(
  id: JudgeCriterionOutput['id'],
  score: number,
  overrides: Partial<JudgeCriterionOutput> = {},
): JudgeCriterionOutput {
  return {
    id,
    applicable: true,
    score,
    label: score >= 7 ? 'pass' : score <= 3 ? 'fail' : 'weak',
    evidence: [
      {
        kind: 'website',
        url: 'https://acme.example/products',
        span: 'industrial pumps',
        fetched_at: NOW,
      },
    ],
    rationale: `${id} 依据`,
    ...overrides,
  };
}

function v2Output(
  scores: Scores = SCORES_FIT,
  overrides: Partial<JudgeOutputV2> = {},
): JudgeOutputV2 {
  return {
    criteria: (Object.keys(scores) as JudgeCriterionOutput['id'][]).map((id) =>
      criterion(id, scores[id]),
    ),
    evidence_completeness: true,
    verdict_proposed: 'FIT',
    refusal: { is_refusal: false, reason: null },
    ...overrides,
  };
}

/** 让 v2 判定拿到一份「聚合后」的模型结果；runtimeExecution 与 usage 可覆盖。 */
function mockV2(output: unknown, extra: Record<string, unknown> = {}): void {
  executeTask.mockResolvedValue({
    provider: 'mock',
    model: 'deepseek-v4-pro',
    reportedModel: 'deepseek-v4-pro',
    usage: { inputTokens: 120, outputTokens: 80, costUsd: 0.002 },
    data: output,
    ...extra,
  } as never);
}

beforeEach(() => {
  executeTask.mockReset();
});

describe('JUDGE_CONTRACT_MODE parsing', () => {
  it('defaults to off and fails safe on unknown values', () => {
    expect(judgeContractMode({})).toBe('off');
    expect(judgeContractMode({ JUDGE_CONTRACT_MODE: '' })).toBe('off');
    expect(judgeContractMode({ JUDGE_CONTRACT_MODE: 'bogus' })).toBe('off');
  });

  it('accepts the three declared modes (case/space tolerant)', () => {
    expect(judgeContractMode({ JUDGE_CONTRACT_MODE: 'off' })).toBe('off');
    expect(judgeContractMode({ JUDGE_CONTRACT_MODE: ' SHADOW ' })).toBe('shadow');
    expect(judgeContractMode({ JUDGE_CONTRACT_MODE: 'enforce' })).toBe('enforce');
  });
});

describe('companyDomainEvidenceUrlPolicy', () => {
  const policy = companyDomainEvidenceUrlPolicy('www.Acme.Example');

  it('allows the company domain and its subdomains only', () => {
    expect(policy('https://acme.example/products').allowed).toBe(true);
    expect(policy('https://www.acme.example/impressum').allowed).toBe(true);
    expect(policy('https://shop.acme.example/p/1').allowed).toBe(true);
    expect(policy('https://other.example/products').allowed).toBe(false);
    expect(policy('https://acme.example.evil.test/').allowed).toBe(false);
    expect(policy('not a url').allowed).toBe(false);
  });

  it('denies every URL when the company has no domain (fail closed)', () => {
    expect(companyDomainEvidenceUrlPolicy(null)('https://acme.example/').allowed).toBe(false);
  });
});

describe('judgeFitV2 —— judge-output/v2 → 确定性聚合 → FitJudgment + judgment_record', () => {
  it('聚合金标 fit-golden 用例（真实 judge-output）→ FIT/match', async () => {
    // 金标用例（evals/golden-judgments）是 judge-output/v2 的真实样例；把它喂给同一条
    // 生产路径，断言聚合结论与 manifest 的 expectedLabel 一致。
    const golden = JSON.parse(
      readFileSync(
        join(
          import.meta.dirname,
          '../../../../evals/golden-judgments/cases/fit-golden.json',
        ),
        'utf8',
      ),
    ) as {
      input: { icpBrief: string; snapshot: { fetchedAt: string } };
      judge: { now: string; output: JudgeOutputV2 };
      expected: { label: 'FIT' | 'NOT_FIT' | 'UNKNOWN' };
    };
    const goldenCompany = {
      id: 'golden-company-1',
      name: 'Muster Metallbau GmbH',
      domain: 'example.com',
      country: 'DE',
      industry: 'metal fabrication',
      attributes: {
        products: ['Edelstahlbleche und Laserzuschnitte'],
        keywords: ['Großhandel mit Markenwerkzeugen'],
        website_profile: {
          trade_role: 'distributor',
          evidence: [
            'Muster Metallbau GmbH (Beispiel).',
            'Fertigung: Laserschneiden und Kanten.',
            'Handelsunternehmen mit eigenem Lager.',
          ],
        },
      },
    };
    mockV2(golden.judge.output);

    const result = await judgeFitV2(
      {} as never,
      WS,
      { seller: 'Seller', seller_summary: golden.input.icpBrief },
      goldenCompany,
      {
        now: golden.judge.now,
        snapshotFetchedAt: golden.input.snapshot.fetchedAt,
        // golden 用例测聚合映射；跨源佐证门单测另见 corroboration 相关 describe。
        judgeCorroborationMode: 'off',
      },
    );

    expect(result!.judgmentRecord.verdict).toBe(golden.expected.label);
    expect(result!.verdict).toBe('match');
  });

  it('aggregates a FIT and prepares the record the caller must persist', async () => {
    mockV2(v2Output());

    const result = await judgeFitV2({} as never, WS, ICP_BRIEF, company, { now: NOW });

    expect(result).not.toBeNull();
    expect(result!.verdict).toBe('match');
    expect(result!.durableReceipt).toBeUndefined();
    const record = result!.judgmentRecord;
    expect(record.workspaceId).toBe(WS);
    expect(record.companyId).toBe('company-1');
    expect(record.judgeLevel).toBe(2);
    expect(record.verdict).toBe('FIT');
    expect(record.verdictProposed).toBe('FIT');
    expect(record.evidenceCompleteness).toBe(true);
    expect(record.criteria).toHaveLength(5);
    expect(record.rubricVersion).toBe('fit-v2');
    expect(record.promptHash).toBe(PROMPT_HASH);
    expect(record.schemaVersion).toBe('judge-output/v2');
    expect(record.inputDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(record.outputDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(record.model.requested).toBe(getTask('discovery.qualify_fit')!.model);
    expect(record.sampling).toMatchObject({
      temperature: 0.7,
      k: 1,
      // 默认 enforce：共享夹具（T1+T3）达标，采样里带佐证记录。
      corroboration: { reason: 'CORROBORATED', enforced: true },
    });
    expect(record.costMicros).toBe(2000n);
    expect(record.inputTokens).toBe(120);
    expect(record.outputTokens).toBe(80);
    expect(record.failure).toBeUndefined();
    // 记录与 Lead 草稿用同一 verdict 语义：聚合 FIT → Lead match。
    expect(result!.fitReasons.material).toContain('pass');
  });

  it('maps a weighted NOT_FIT to mismatch', async () => {
    mockV2(v2Output(SCORES_NOT_FIT, { verdict_proposed: 'NOT_FIT' }));

    const result = await judgeFitV2({} as never, WS, ICP_BRIEF, company, { now: NOW });

    expect(result!.verdict).toBe('mismatch');
    expect(result!.judgmentRecord.verdict).toBe('NOT_FIT');
  });

  it('denies out-of-domain evidence → evidence gate UNKNOWN → weak', async () => {
    const output = v2Output();
    output.criteria = output.criteria.map((item) => ({
      ...item,
      evidence: [
        {
          kind: 'website' as const,
          url: 'https://third-party.example/acme',
          span: 'industrial pumps',
          fetched_at: NOW,
        },
      ],
    }));
    mockV2(output);

    const result = await judgeFitV2({} as never, WS, ICP_BRIEF, company, { now: NOW });

    expect(result!.verdict).toBe('weak');
    expect(result!.judgmentRecord.verdict).toBe('UNKNOWN');
  });

  it('rejects evidence spans that are not verbatim in the snapshot', async () => {
    const output = v2Output();
    output.criteria = output.criteria.map((item) => ({
      ...item,
      evidence: [
        {
          kind: 'website' as const,
          url: 'https://acme.example/products',
          span: 'a sentence that never appeared',
          fetched_at: NOW,
        },
      ],
    }));
    mockV2(output);

    const result = await judgeFitV2({} as never, WS, ICP_BRIEF, company, { now: NOW });

    expect(result!.verdict).toBe('weak');
    expect(result!.judgmentRecord.verdict).toBe('UNKNOWN');
  });

  it('keeps fail-safe refusal semantics: weak + MODEL_REFUSAL record, never mismatch', async () => {
    mockV2(
      v2Output(SCORES_NOT_FIT, {
        refusal: { is_refusal: true, reason: '本服务不支持该请求' },
      }),
    );

    const result = await judgeFitV2({} as never, WS, ICP_BRIEF, company, { now: NOW });

    expect(result!.verdict).toBe('weak');
    expect(result!.judgmentRecord.verdict).toBe('UNKNOWN');
    expect(result!.judgmentRecord.failure).toEqual({ code: 'MODEL_REFUSAL' });
    expect(result!.fitReasons.reasons[0]).toContain('拒答');
  });

  it('returns null on structurally invalid judge output', async () => {
    mockV2({ criteria: [], verdict_proposed: 'FIT' });

    await expect(
      judgeFitV2({} as never, WS, ICP_BRIEF, company, { now: NOW }),
    ).resolves.toBeNull();
  });

  it('returns null on non-fatal model failures but rethrows budget control errors', async () => {
    executeTask.mockRejectedValue(new Error('upstream down'));
    await expect(
      judgeFitV2({} as never, WS, ICP_BRIEF, company, { now: NOW }),
    ).resolves.toBeNull();

    executeTask.mockRejectedValue(new BudgetExceededError('budget'));
    await expect(
      judgeFitV2({} as never, WS, ICP_BRIEF, company, { now: NOW }),
    ).rejects.toBeInstanceOf(BudgetExceededError);
  });
});

describe('judgeFitCompany 三模式开关', () => {
  it('off（默认）行为完全不变：只跑 v1，不产生 judgment_record', async () => {
    executeTask.mockResolvedValue({ provider: 'mock', model: 'm', data: v1Output } as never);

    const result = await judgeFitCompany({} as never, WS, ICP_BRIEF, company, {
      runId: 'run-off',
      judgeContractMode: 'off',
    });

    expect(result!.verdict).toBe('match');
    expect(result!.judgmentRecord).toBeUndefined();
    expect(executeTask).toHaveBeenCalledTimes(1);
    const input = executeTask.mock.calls[0]![1] as {
      schema: { required?: readonly string[] };
      task: string;
    };
    expect(input.task).toBe('discovery.qualify_fit');
    expect(input.schema.required).toContain('material_gate');
  });

  it('shadow：Lead 仍由 v1 决定，额外跑 v2 并附记录草稿', async () => {
    executeTask
      .mockResolvedValueOnce({ provider: 'mock', model: 'm', data: v1Output } as never)
      .mockResolvedValueOnce({ provider: 'mock', model: 'm', data: v2Output(SCORES_NOT_FIT) } as never);

    const result = await judgeFitCompany({} as never, WS, ICP_BRIEF, company, {
      runId: 'run-shadow-1',
      judgeContractMode: 'shadow',
      now: NOW,
    });

    expect(result!.verdict).toBe('match'); // v1 不变
    expect(result!.judgmentRecord).toBeDefined();
    expect(result!.judgmentRecord!.verdict).toBe('NOT_FIT'); // 记录的是 v2 聚合
    expect(result!.judgmentRecordTolerant).toBe(true);
    expect(executeTask).toHaveBeenCalledTimes(2);
    const v2Input = executeTask.mock.calls[1]![1] as {
      task: string;
      schema: { properties?: Record<string, unknown> };
    };
    expect(v2Input.task).toBe('discovery.qualify_fit');
    expect(Object.keys(v2Input.schema.properties ?? {})).toContain('criteria');
  });

  it('shadow 成本护栏：同一 run 同一公司只跑一次 v2', async () => {
    executeTask.mockImplementation(async () => ({ provider: 'mock', model: 'm', data: v1Output }) as never);
    executeTask
      .mockResolvedValueOnce({ provider: 'mock', model: 'm', data: v1Output } as never)
      .mockResolvedValueOnce({ provider: 'mock', model: 'm', data: v2Output() } as never);

    const first = await judgeFitCompany({} as never, WS, ICP_BRIEF, company, {
      runId: 'run-shadow-guard',
      judgeContractMode: 'shadow',
      now: NOW,
    });
    const second = await judgeFitCompany({} as never, WS, ICP_BRIEF, company, {
      runId: 'run-shadow-guard',
      judgeContractMode: 'shadow',
      now: NOW,
    });

    expect(first!.judgmentRecord).toBeDefined();
    expect(second!.judgmentRecord).toBeUndefined();
    expect(executeTask).toHaveBeenCalledTimes(3); // v1 ×2 + v2 ×1
  });

  it('shadow 的 v2 失败不影响 Lead（不抛错、不写草稿）', async () => {
    executeTask
      .mockResolvedValueOnce({ provider: 'mock', model: 'm', data: v1Output } as never)
      .mockRejectedValueOnce(new Error('v2 upstream down'));

    const result = await judgeFitCompany({} as never, WS, ICP_BRIEF, company, {
      runId: 'run-shadow-fail',
      judgeContractMode: 'shadow',
      now: NOW,
    });

    expect(result!.verdict).toBe('match');
    expect(result!.judgmentRecord).toBeUndefined();
  });

  it('enforce：只用 v2 聚合 verdict 走 Lead 投影', async () => {
    mockV2(v2Output(SCORES_NOT_FIT, { verdict_proposed: 'NOT_FIT' }));

    const result = await judgeFitCompany({} as never, WS, ICP_BRIEF, company, {
      runId: 'run-enforce',
      judgeContractMode: 'enforce',
      now: NOW,
    });

    expect(result!.verdict).toBe('mismatch');
    expect(result!.judgmentRecord!.verdict).toBe('NOT_FIT');
    expect(result!.judgmentRecordTolerant).toBeUndefined();
    expect(executeTask).toHaveBeenCalledTimes(1);
  });
});

describe('persistJudgmentRecordInTransaction —— recordJudgment 唯一写入口', () => {
  function judgmentWithRecord(record: FitJudgment['judgmentRecord'], tolerant = false): FitJudgment {
    return {
      verdict: 'match',
      fitReasons: { material: 'm', role: 'r', process: 'p', business_model: 'b', reasons: [] },
      ...(record ? { judgmentRecord: record } : {}),
      ...(tolerant ? { judgmentRecordTolerant: true } : {}),
    };
  }

  it('writes the draft row with the caller-provided icpId', async () => {
    mockV2(v2Output());
    const judged = await judgeFitV2({} as never, WS, ICP_BRIEF, company, { now: NOW });
    const tx = {
      judgmentRecord: {
        createMany: vi.fn(async () => ({ count: 1 })),
        findUnique: vi.fn(async () => ({ id: 'rec-1', verdict: 'FIT' })),
      },
    };

    await persistJudgmentRecordInTransaction(tx as never, ICP_ID, judgmentWithRecord(judged!.judgmentRecord));

    const data = tx.judgmentRecord.createMany.mock.calls[0]![0] as {
      data: Array<Record<string, unknown>>;
    };
    expect(data.data[0]).toMatchObject({
      workspaceId: WS,
      icpId: ICP_ID,
      canonicalCompanyId: 'company-1',
      judgeLevel: 2,
      verdict: 'FIT',
      rubricVersion: 'fit-v2',
      schemaVersion: 'judge-output/v2',
    });
  });

  it('is a no-op without a draft (off mode)', async () => {
    const tx = { judgmentRecord: { createMany: vi.fn(), findUnique: vi.fn() } };
    await persistJudgmentRecordInTransaction(tx as never, ICP_ID, judgmentWithRecord(undefined));
    expect(tx.judgmentRecord.createMany).not.toHaveBeenCalled();
  });

  it('shadow 的写入失败被吞掉（tolerant），enforce 的写入失败上抛', async () => {
    mockV2(v2Output());
    const judged = await judgeFitV2({} as never, WS, ICP_BRIEF, company, { now: NOW });
    const failingTx = {
      judgmentRecord: {
        createMany: vi.fn(async () => {
          throw new Error('db down');
        }),
        findUnique: vi.fn(),
      },
    };

    await expect(
      persistJudgmentRecordInTransaction(
        failingTx as never,
        ICP_ID,
        judgmentWithRecord(judged!.judgmentRecord, true),
      ),
    ).resolves.toBeUndefined();

    await expect(
      persistJudgmentRecordInTransaction(
        failingTx as never,
        ICP_ID,
        judgmentWithRecord(judged!.judgmentRecord, false),
      ),
    ).rejects.toThrow('db down');
  });
});

describe('跨源佐证门（JUDGE_CORROBORATION_MODE，默认 enforce）', () => {
  it('降级单层证据的 FIT 为 weak，并把 enforce 记录写进采样 JSON', async () => {
    mockV2(v2Output());
    const singleTier = {
      ...company,
      attributes: {
        products: ['industrial pumps'],
        website_profile: { trade_role: 'distributor', evidence: ['Acme distributes pumps'] },
      },
    };
    const result = await judgeFitV2({} as never, WS, ICP_BRIEF, singleTier, {
      now: NOW,
      judgeCorroborationMode: 'enforce',
    });
    expect(result!.verdict).toBe('weak');
    expect(result!.judgmentRecord.verdict).toBe('UNKNOWN');
    expect(result!.fitReasons.reasons[0]).toContain('跨源佐证门');
    const sampling = result!.judgmentRecord.sampling as {
      corroboration: { reason: string; enforced: boolean; downgraded_from: string; tiers_present: string[] };
    };
    expect(sampling.corroboration).toMatchObject({
      reason: 'INSUFFICIENT_TIERS',
      enforced: true,
      downgraded_from: 'FIT',
      tiers_present: ['T3'],
    });
    expect(result!.evidenceBundle?.coverage.tier_list).toEqual(['T3']);
  });

  it('降级 NOT_FIT 为 weak（绝不因证据不足自动拒绝）', async () => {
    mockV2(v2Output(SCORES_NOT_FIT));
    const noEvidence = { ...company, attributes: {} };
    const result = await judgeFitV2({} as never, WS, ICP_BRIEF, noEvidence, {
      now: NOW,
      judgeCorroborationMode: 'enforce',
    });
    expect(result!.verdict).toBe('weak');
    expect(result!.judgmentRecord.verdict).toBe('UNKNOWN');
    const sampling = result!.judgmentRecord.sampling as {
      corroboration: { reason: string; downgraded_from: string };
    };
    expect(sampling.corroboration).toMatchObject({ reason: 'NO_BUNDLE', downgraded_from: 'NOT_FIT' });
  });

  it('跨源达标（T1+T3）的 FIT 原样保留，采样里记 CORROBORATED', async () => {
    mockV2(v2Output());
    const result = await judgeFitV2({} as never, WS, ICP_BRIEF, company, {
      now: NOW,
      judgeCorroborationMode: 'enforce',
    });
    expect(result!.verdict).toBe('match');
    expect(result!.judgmentRecord.verdict).toBe('FIT');
    const sampling = result!.judgmentRecord.sampling as {
      corroboration: { reason: string; enforced: boolean; corroborated: boolean };
    };
    expect(sampling.corroboration).toMatchObject({
      reason: 'CORROBORATED',
      enforced: true,
      corroborated: true,
    });
  });

  it('回滚开关：shadow 只记录不降级；off 完全不评估', async () => {
    mockV2(v2Output());
    const singleTier = {
      ...company,
      attributes: { website_profile: { trade_role: 'distributor' } },
    };
    const shadowed = await judgeFitV2({} as never, WS, ICP_BRIEF, singleTier, {
      now: NOW,
      judgeCorroborationMode: 'shadow',
    });
    expect(shadowed!.verdict).toBe('match');
    const shadowSampling = shadowed!.judgmentRecord.sampling as {
      corroboration: { reason: string; enforced: boolean };
    };
    expect(shadowSampling.corroboration).toMatchObject({ reason: 'INSUFFICIENT_TIERS', enforced: false });

    mockV2(v2Output());
    const off = await judgeFitV2({} as never, WS, ICP_BRIEF, singleTier, {
      now: NOW,
      judgeCorroborationMode: 'off',
    });
    expect(off!.verdict).toBe('match');
    const offSampling = off!.judgmentRecord.sampling as { corroboration?: unknown };
    expect(offSampling.corroboration).toBeUndefined();
    expect(off!.evidenceBundle).toBeUndefined();
  });
});
