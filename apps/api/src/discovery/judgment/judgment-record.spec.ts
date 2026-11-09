import { describe, expect, it, vi } from 'vitest';

import type { JudgeCriterionOutput } from './judge-output-v2';
import {
  JudgmentRecordReplayConflictError,
  JudgmentRecordValidationError,
  buildRecordedCriteria,
  collectEvidenceRefs,
  judgmentInputDigest,
  judgmentOutputDigest,
  recordJudgment,
} from './judgment-record';

const HEX_A = 'a'.repeat(64);
const HEX_B = 'b'.repeat(64);
const HEX_C = 'c'.repeat(64);

function criteria(): JudgeCriterionOutput[] {
  return [
    {
      id: 'C1_MATERIAL',
      applicable: true,
      score: 8,
      label: 'pass',
      evidence: [
        { kind: 'website', url: 'https://example.com/a', span: 'span-a' },
        { kind: 'website', url: 'https://example.com/a', span: 'span-a' },
      ],
      rationale: 'ok',
    },
    {
      id: 'C2_ROLE',
      applicable: true,
      score: 9,
      label: 'pass',
      evidence: [{ kind: 'impressum', url: 'https://example.com/b', span: 'span-b' }],
      rationale: 'ok',
    },
    { id: 'C3_PROCESS', applicable: true, score: 7, label: 'pass', evidence: [], rationale: 'ok' },
    { id: 'C4_BUSINESS_MODEL', applicable: true, score: 8, label: 'pass', evidence: [], rationale: 'ok' },
    {
      id: 'C5_SIZE',
      applicable: false,
      score: null,
      label: 'not_applicable',
      evidence: [],
      rationale: 'ICP 未声明规模',
    },
  ];
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    workspaceId: '11111111-1111-4111-8111-111111111111',
    companyId: '22222222-2222-4222-8222-222222222222',
    icpId: '33333333-3333-4333-8333-333333333333',
    judgeLevel: 2 as const,
    verdict: 'FIT' as const,
    criteria: criteria(),
    evidenceCompleteness: true,
    inputDigest: HEX_A,
    outputDigest: HEX_B,
    promptHash: HEX_C,
    model: { requested: 'deepseek-v4-pro' },
    ...overrides,
  };
}

function fakeTx(row: { id: string; verdict: string } | null, insertedCount = 1) {
  const createMany = vi.fn(async () => ({ count: insertedCount }));
  const findUnique = vi.fn(async () => row);
  return { judgmentRecord: { createMany, findUnique } } as unknown as {
    judgmentRecord: {
      createMany: ReturnType<typeof vi.fn>;
      findUnique: ReturnType<typeof vi.fn>;
    };
  };
}

describe('judgment-record 写入器（P3 J06）', () => {
  it('新写入：落库一次、replayed=false，失败字段由 failure code 派生', async () => {
    const tx = fakeTx({ id: 'record-1', verdict: 'FIT' });
    const result = await recordJudgment(tx as never, input({
      failure: { code: 'PROVIDER_HTTP_429' },
    }));
    expect(result).toEqual({ recordId: 'record-1', replayed: false });
    const data = tx.judgmentRecord.createMany.mock.calls[0][0].data[0];
    expect(data.stage).toBe('provider');
    expect(data.cause).toBe('PROVIDER_HTTP_429');
    expect(data.outcome).toBe('retry');
    expect(data.retryable).toBe(true);
    expect(data.failureCode).toBe('PROVIDER_HTTP_429');
  });

  it('无失败时 failure 相关列全为 null', async () => {
    const tx = fakeTx({ id: 'record-1', verdict: 'FIT' });
    await recordJudgment(tx as never, input());
    const data = tx.judgmentRecord.createMany.mock.calls[0][0].data[0];
    expect(data.stage).toBeNull();
    expect(data.cause).toBeNull();
    expect(data.retryable).toBeNull();
    expect(data.failureCode).toBeNull();
  });

  it('replay：同输入同 verdict 命中已有行 → replayed=true，不报错', async () => {
    const tx = fakeTx({ id: 'record-1', verdict: 'FIT' }, 0);
    const result = await recordJudgment(tx as never, input());
    expect(result).toEqual({ recordId: 'record-1', replayed: true });
  });

  it('replay 冲突：同输入不同 verdict → 抛错（绝不静默覆盖）', async () => {
    const tx = fakeTx({ id: 'record-1', verdict: 'NOT_FIT' }, 0);
    await expect(recordJudgment(tx as never, input())).rejects.toBeInstanceOf(
      JudgmentRecordReplayConflictError,
    );
  });

  it('校验：非法 verdict/judgeLevel/digest/criteria/失败码被拒', async () => {
    const tx = fakeTx({ id: 'x', verdict: 'FIT' });
    await expect(
      recordJudgment(tx as never, input({ verdict: 'MAYBE' })),
    ).rejects.toThrow(/unknown verdict/);
    await expect(
      recordJudgment(tx as never, input({ judgeLevel: 4 })),
    ).rejects.toThrow(/judgeLevel/);
    await expect(
      recordJudgment(tx as never, input({ inputDigest: 'xyz' })),
    ).rejects.toThrow(/inputDigest/);
    await expect(
      recordJudgment(tx as never, input({ criteria: criteria().slice(1) })),
    ).rejects.toThrow(/criteria must contain/);
    const dup = criteria();
    dup[1] = { ...dup[0]! };
    await expect(
      recordJudgment(tx as never, input({ criteria: dup })),
    ).rejects.toThrow(/duplicate criterion/);
    await expect(
      recordJudgment(tx as never, input({ failure: { code: 'NOT_A_CODE' } })),
    ).rejects.toThrow(/unknown failure code/);
  });

  it('证据去重与摘要确定性', () => {
    const refs = collectEvidenceRefs(criteria());
    expect(refs).toHaveLength(2);
    expect(refs.map((ref) => ref.span)).toEqual(['span-a', 'span-b']);
    expect(judgmentOutputDigest(criteria())).toMatch(/^[0-9a-f]{64}$/);
    expect(judgmentOutputDigest(criteria())).toBe(judgmentOutputDigest(criteria()));
    expect(judgmentInputDigest({ a: 1 })).not.toBe(judgmentInputDigest({ a: 2 }));
  });

  it('buildRecordedCriteria 只保留写库字段', () => {
    const recorded = buildRecordedCriteria({
      criteria: criteria(),
      evidence_completeness: true,
      verdict_proposed: 'FIT',
      refusal: { is_refusal: false, reason: null },
    });
    expect(recorded).toHaveLength(5);
    expect(Object.keys(recorded[0]!).sort()).toEqual([
      'applicable',
      'evidence',
      'id',
      'label',
      'rationale',
      'score',
    ]);
  });

  it('校验错误类型可区分（供上层映射 HTTP/失败码）', () => {
    expect(new JudgmentRecordValidationError('x').code).toBe(
      'JUDGMENT_RECORD_INVALID',
    );
    expect(new JudgmentRecordReplayConflictError('x').code).toBe(
      'JUDGMENT_RECORD_REPLAY_CONFLICT',
    );
  });
});
