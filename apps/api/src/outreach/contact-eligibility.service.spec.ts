import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { encryptPii } from '../compliance/pii-crypto';
import { ContactEligibilityService } from './contact-eligibility.service';

/**
 * P1-16 引擎侧：批量可触达性查询的口径——密文等值匹配、最强状态、未找到 fail-closed、
 * catch-all 策略 OFF、批量上限与规范化。
 */
const WORKSPACE = '00000000-0000-4000-8000-0000000000aa';

interface Row {
  value: string;
  verification_state: string;
  confidence: number | null;
}

function fakePrisma(rows: Row[]) {
  const queryRaw = vi.fn(async () => rows);
  const prisma = {
    withWorkspace: vi.fn(async (_workspaceId: string, fn: (tx: unknown) => Promise<unknown>) =>
      fn({ $queryRaw: queryRaw }),
    ),
  };
  return { prisma, queryRaw };
}

const hash = (email: string) => createHash('sha256').update(email).digest('hex');

function rowFor(email: string, state: string, confidence: number | null): Row {
  return { value: encryptPii(email), verification_state: state, confidence };
}

function errorCode(error: unknown): string {
  return (error as { response?: { error?: { code?: string } } }).response?.error?.code ?? '';
}

describe('ContactEligibilityService.check', () => {
  it('VALID 命中：state/score/allowedActions(outreach)/emailHash 与 DNC 同口径', async () => {
    const { prisma } = fakePrisma([rowFor('info@acme.example', 'VALID', 95)]);
    const service = new ContactEligibilityService(prisma as never);
    const [result] = await service.check(WORKSPACE, ['Info@Acme.example']);
    expect(result).toMatchObject({
      emailHash: hash('info@acme.example'),
      found: true,
      state: 'VALID',
      score: 95,
      allowedActions: ['display', 'match', 'outreach'],
      catchAllPolicy: null,
    });
  });

  it('CATCH_ALL_RISKY：策略恒为 OFF/allowed=false（灰度表未落地=拒发），tier 按分数', async () => {
    const { prisma } = fakePrisma([rowFor('sales@acme.example', 'CATCH_ALL_RISKY', 84)]);
    const service = new ContactEligibilityService(prisma as never);
    const [result] = await service.check(WORKSPACE, ['sales@acme.example']);
    expect(result).toMatchObject({
      state: 'CATCH_ALL_RISKY',
      allowedActions: ['display', 'match'],
      catchAllPolicy: { mode: 'OFF', allowed: false, tier: 'normal', minScore: 40 },
    });
  });

  it('同一邮箱多条点取最强状态（VALID 胜过 INVALID/UNKNOWN）', async () => {
    const { prisma } = fakePrisma([
      rowFor('dup@acme.example', 'INVALID', 0),
      rowFor('dup@acme.example', 'UNKNOWN', 20),
      rowFor('dup@acme.example', 'VALID', 95),
    ]);
    const service = new ContactEligibilityService(prisma as never);
    const [result] = await service.check(WORKSPACE, ['dup@acme.example']);
    expect(result).toMatchObject({ found: true, state: 'VALID' });
  });

  it('未找到 → found=false / UNKNOWN / 空 allowedActions（调用方 fail closed）', async () => {
    const { prisma } = fakePrisma([]);
    const service = new ContactEligibilityService(prisma as never);
    const [result] = await service.check(WORKSPACE, ['ghost@acme.example']);
    expect(result).toMatchObject({
      emailHash: hash('ghost@acme.example'),
      found: false,
      state: 'UNKNOWN',
      score: null,
      allowedActions: [],
      catchAllPolicy: null,
    });
  });

  it('规范化 + 去重：大小写/空白归一后按规范形匹配与哈希', async () => {
    const { prisma } = fakePrisma([rowFor('info@acme.example', 'VALID', 95)]);
    const service = new ContactEligibilityService(prisma as never);
    const results = await service.check(WORKSPACE, [
      '  Info@Acme.Example ',
      'info@acme.example',
    ]);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ emailHash: hash('info@acme.example') });
  });

  it('非法批量/邮箱/超限 → 400 词表错误码', async () => {
    const { prisma } = fakePrisma([]);
    const service = new ContactEligibilityService(prisma as never);
    const codes: string[] = [];
    for (const bad of ['not-an-array' as never, [''] as string[], ['   '] as string[]]) {
      try {
        await service.check(WORKSPACE, bad as never);
      } catch (error) {
        codes.push(errorCode(error));
      }
    }
    expect(codes).toEqual([
      'OUTREACH_ELIGIBILITY_INVALID_BATCH',
      'OUTREACH_ELIGIBILITY_INVALID_EMAIL',
      'OUTREACH_ELIGIBILITY_INVALID_EMAIL',
    ]);
    const tooMany = Array.from({ length: 51 }, (_, index) => `u${index}@acme.example`);
    try {
      await service.check(WORKSPACE, tooMany);
      throw new Error('should have thrown');
    } catch (error) {
      expect(errorCode(error)).toBe('OUTREACH_ELIGIBILITY_BATCH_TOO_LARGE');
    }
  });
});
