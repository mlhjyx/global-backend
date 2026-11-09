import { afterEach, describe, expect, it, vi } from 'vitest';
import { persistJudgmentRecordInTransaction, type FitJudgment } from './fit-judge';
import { assembleEvidenceBundle } from './evidence-bundle';
import type { JudgmentRecordDraft } from './judgment/judgment-record';
import { CRITERION_IDS } from './judgment/fit-rubric';

/**
 * 跨源佐证 shadow 接线（2026-11-10）：persistJudgmentRecordInTransaction 给判定主记录
 * 附 sampling.corroboration；任何异常都不影响判定写入（shadow 语义）。
 */
const WS = '10000000-0000-4000-8000-000000000001';

const PASS_CRITERIA = CRITERION_IDS.map((id) => ({
  id,
  applicable: true,
  score: 9,
  label: 'pass' as const,
  evidence: [],
  rationale: 'ok',
}));

function draft(verdict: 'FIT' | 'NOT_FIT' | 'UNKNOWN'): JudgmentRecordDraft {
  return {
    workspaceId: WS,
    companyId: 'company-1',
    judgeLevel: 1,
    verdict,
    criteria: PASS_CRITERIA,
    evidenceCompleteness: true,
    rubricVersion: 'fit-v2',
    promptHash: 'a'.repeat(64),
    schemaVersion: 'judge-output/v2',
    inputDigest: 'b'.repeat(64),
    outputDigest: 'c'.repeat(64),
    model: { requested: 'test-model' },
    sampling: { temperature: 0.7, k: 1 },
  };
}

function judgmentWith(record: JudgmentRecordDraft): FitJudgment {
  return {
    verdict: 'match',
    fitReasons: { material: 'm', role: 'r', process: 'p', business_model: 'b', reasons: [] },
    judgmentRecord: record,
  };
}

function fakeTx(attributes: unknown | undefined) {
  // recordJudgment 写入后按 replay key 回读并比对 verdict——mock 必须回显最后写入的 verdict。
  let lastVerdict = 'FIT';
  return {
    judgmentRecord: {
      createMany: vi.fn(async (args: { data: Array<{ verdict: string }> }) => {
        lastVerdict = args.data[0]!.verdict;
        return { count: 1 };
      }),
      findUnique: vi.fn(async () => ({ id: 'rec-1', verdict: lastVerdict })),
    },
    canonicalCompany: {
      findUnique: vi.fn(async () => (attributes === undefined ? null : { attributes })),
    },
  };
}

function writtenSampling(tx: ReturnType<typeof fakeTx>): Record<string, unknown> {
  const data = tx.judgmentRecord.createMany.mock.calls[0]![0] as {
    data: Array<Record<string, unknown>>;
  };
  return data.data[0]!.sampling as Record<string, unknown>;
}

const twoTierBundle = assembleEvidenceBundle({ name: 'Acme' }, [
  {
    tier: 'T1',
    source_key: 'gleif',
    evidence_kind: 'legal_identity',
    facts: { registry_lei: '529900DI47YZJ5P7QQ76' },
  },
  {
    tier: 'T3',
    source_key: 'website_profile',
    evidence_kind: 'website',
    facts: { trade_role: 'manufacturer' },
  },
]);

afterEach(() => {
  delete process.env.JUDGE_CORROBORATION_MODE;
});

describe('persistJudgmentRecordInTransaction · corroboration shadow', () => {
  it('attaches a CORROBORATED record to the primary FIT record when the bundle spans two tiers', async () => {
    const tx = fakeTx({ evidence_bundle: twoTierBundle });
    await persistJudgmentRecordInTransaction(tx as never, 'icp-1', judgmentWith(draft('FIT')));
    const sampling = writtenSampling(tx);
    expect(sampling.temperature).toBe(0.7);
    expect(sampling.corroboration).toMatchObject({
      shadow: true,
      mode: 'shadow',
      verdict: 'FIT',
      reason: 'CORROBORATED',
      corroborated: true,
      tiers_present: ['T1', 'T3'],
    });
  });

  it('records NO_BUNDLE for a company without an evidence bundle (no block)', async () => {
    const tx = fakeTx({});
    await persistJudgmentRecordInTransaction(tx as never, 'icp-1', judgmentWith(draft('NOT_FIT')));
    expect(writtenSampling(tx).corroboration).toMatchObject({ reason: 'NO_BUNDLE', shadow: true });
  });

  it('keeps the judgment write intact when the company read throws', async () => {
    const tx = fakeTx(undefined);
    tx.canonicalCompany.findUnique.mockRejectedValueOnce(new Error('boom'));
    await persistJudgmentRecordInTransaction(tx as never, 'icp-1', judgmentWith(draft('FIT')));
    expect(tx.judgmentRecord.createMany).toHaveBeenCalledTimes(1);
    const sampling = writtenSampling(tx);
    expect(sampling.corroboration).toBeUndefined();
    expect(sampling).toEqual({ temperature: 0.7, k: 1 });
  });

  it('does not evaluate UNKNOWN verdicts', async () => {
    const tx = fakeTx({ evidence_bundle: twoTierBundle });
    await persistJudgmentRecordInTransaction(tx as never, 'icp-1', judgmentWith(draft('UNKNOWN')));
    expect(writtenSampling(tx).corroboration).toBeUndefined();
  });

  it('stays inert when JUDGE_CORROBORATION_MODE=off', async () => {
    process.env.JUDGE_CORROBORATION_MODE = 'off';
    const tx = fakeTx({ evidence_bundle: twoTierBundle });
    await persistJudgmentRecordInTransaction(tx as never, 'icp-1', judgmentWith(draft('FIT')));
    expect(tx.canonicalCompany.findUnique).not.toHaveBeenCalled();
    expect(writtenSampling(tx).corroboration).toBeUndefined();
  });
});
