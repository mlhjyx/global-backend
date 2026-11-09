import { describe, expect, it, vi } from 'vitest';
import { persistJudgmentRecordInTransaction, type FitJudgment } from './fit-judge';
import { assembleEvidenceBundle } from './evidence-bundle';
import type { JudgmentRecordDraft } from './judgment/judgment-record';
import { CRITERION_IDS } from './judgment/fit-rubric';

/**
 * 跨源佐证 enforce 接线（2026-11-10）：判定链现场装配证据包并在同事务写回
 * canonical_company.attributes.evidence_bundle；写失败只告警不回滚判定。
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

function judgmentWith(record: JudgmentRecordDraft, bundle?: typeof twoTierBundle): FitJudgment {
  return {
    verdict: 'match',
    fitReasons: { material: 'm', role: 'r', process: 'p', business_model: 'b', reasons: [] },
    judgmentRecord: record,
    ...(bundle ? { evidenceBundle: bundle } : {}),
  };
}

function fakeTx(existingAttributes: Record<string, unknown> | null) {
  // recordJudgment 写入后按 replay key 回读并比对 verdict——mock 必须回显最后写入的 verdict。
  let lastVerdict = 'FIT';
  const companyRow =
    existingAttributes === null
      ? null
      : {
          id: 'company-1',
          name: 'Acme',
          domain: 'acme.de',
          status: 'NEW',
          attributes: existingAttributes,
          version: 7,
        };
  return {
    // suppression-policy 锁（pg_advisory_xact_lock）与 suppression 读取
    $queryRaw: vi.fn(async () => []),
    suppressionRecord: { findMany: vi.fn(async () => []) },
    judgmentRecord: {
      createMany: vi.fn(async (args: { data: Array<{ verdict: string }> }) => {
        lastVerdict = args.data[0]!.verdict;
        return { count: 1 };
      }),
      findUnique: vi.fn(async () => ({ id: 'rec-1', verdict: lastVerdict })),
    },
    canonicalCompany: {
      findUnique: vi.fn(async () => companyRow),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
  };
}

describe('persistJudgmentRecordInTransaction · 证据包写回', () => {
  it('merges evidence_bundle into attributes in the same transaction and still writes the record', async () => {
    const tx = fakeTx({ keywords: ['pumps'], website_profile: { trade_role: 'manufacturer' } });
    await persistJudgmentRecordInTransaction(tx as never, 'icp-1', judgmentWith(draft('FIT'), twoTierBundle));
    expect(tx.canonicalCompany.updateMany).toHaveBeenCalledTimes(1);
    const data = tx.canonicalCompany.updateMany.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(data.data.version).toEqual({ increment: 1 });
    const update = tx.canonicalCompany.updateMany.mock.calls[0]![0] as {
      where: Record<string, unknown>;
      data: { attributes: Record<string, unknown> };
    };
    expect(update.where).toMatchObject({
      id: 'company-1',
      workspaceId: WS,
      status: { not: 'SUPPRESSED' },
      version: 7,
    });
    // 其余属性原样保留，包写入 evidence_bundle 键
    expect(update.data.attributes.keywords).toEqual(['pumps']);
    expect(update.data.attributes.website_profile).toEqual({ trade_role: 'manufacturer' });
    expect((update.data.attributes.evidence_bundle as { coverage: { corroborated: boolean } }).coverage.corroborated).toBe(true);
    expect(tx.judgmentRecord.createMany).toHaveBeenCalledTimes(1);
  });

  it('fails the transaction when the bundle write throws (fail-closed, retryable)', async () => {
    // 同事务内语句级错误会中止 Postgres 事务，吞掉只会制造半截状态；判定按失败上抛、可重试。
    const tx = fakeTx({ keywords: ['pumps'] });
    tx.canonicalCompany.updateMany.mockRejectedValueOnce(new Error('lock timeout'));
    await expect(
      persistJudgmentRecordInTransaction(tx as never, 'icp-1', judgmentWith(draft('FIT'), twoTierBundle)),
    ).rejects.toThrow('lock timeout');
    expect(tx.judgmentRecord.createMany).not.toHaveBeenCalled();
  });

  it('skips the bundle write when the company row is gone/suppressed, but still writes the record', async () => {
    const tx = fakeTx(null);
    await persistJudgmentRecordInTransaction(tx as never, 'icp-1', judgmentWith(draft('NOT_FIT'), twoTierBundle));
    expect(tx.canonicalCompany.updateMany).not.toHaveBeenCalled();
    expect(tx.judgmentRecord.createMany).toHaveBeenCalledTimes(1);
  });

  it('does not touch attributes when no bundle was produced (mode off)', async () => {
    const tx = fakeTx({ keywords: ['pumps'] });
    await persistJudgmentRecordInTransaction(tx as never, 'icp-1', judgmentWith(draft('FIT')));
    expect(tx.canonicalCompany.updateMany).not.toHaveBeenCalled();
    expect(tx.judgmentRecord.createMany).toHaveBeenCalledTimes(1);
  });
});
