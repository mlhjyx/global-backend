import { describe, expect, it, vi } from 'vitest';
import { blindContactKey, encryptPii } from '../../compliance/pii-crypto';
import {
  parseArgs,
  runBackfill,
} from '../../../scripts/backfill-contact-domain-blind-key.mts';

/**
 * P1-01：domain_blind_key 回填脚本的纯逻辑——幂等分批、dry-run、失败行留 NULL。
 * fake Prisma（零数据库）；值全部是合成 `.example` 数据。
 */
function fakePrisma(pages: Array<Array<{ id: string; value: string }>>) {
  const updates: Array<{ id: string; domainBlindKey: string }> = [];
  let call = 0;
  const prisma = {
    contactPoint: {
      findMany: vi.fn(async () => pages[call++] ?? []),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: { domainBlindKey: string } }) => {
        updates.push({ id: where.id, domainBlindKey: data.domainBlindKey });
        return {};
      }),
    },
  };
  return { prisma, updates };
}

describe('parseArgs', () => {
  it('默认 dryRun=false、batchSize=500；--dry-run 与 --batch-size 生效；非法值拒绝', () => {
    expect(parseArgs([])).toEqual({ dryRun: false, batchSize: 500 });
    expect(parseArgs(['--dry-run', '--batch-size', '100'])).toEqual({ dryRun: true, batchSize: 100 });
    expect(() => parseArgs(['--batch-size', '0'])).toThrow(/batch-size/u);
    expect(() => parseArgs(['--batch-size', '5001'])).toThrow(/batch-size/u);
  });
});

describe('runBackfill', () => {
  it('解密→域盲索引并写库；分批直到取空', async () => {
    const { prisma, updates } = fakePrisma([
      [{ id: 'p1', value: encryptPii('Info@Acme.example') }],
      [{ id: 'p2', value: encryptPii('max@sub.acme.example') }],
    ]);
    const counts = await runBackfill(prisma as never, { dryRun: false, batchSize: 1 });
    expect(counts).toEqual({ scanned: 2, updated: 2, failed: 0 });
    expect(updates).toEqual([
      { id: 'p1', domainBlindKey: blindContactKey('domain:acme.example') },
      { id: 'p2', domainBlindKey: blindContactKey('domain:sub.acme.example') },
    ]);
  });

  it('dry-run：只统计不回写', async () => {
    const { prisma, updates } = fakePrisma([[{ id: 'p1', value: encryptPii('a@acme.example') }]]);
    const counts = await runBackfill(prisma as never, { dryRun: true, batchSize: 10 });
    expect(counts).toMatchObject({ scanned: 1, updated: 1, failed: 0 });
    expect(updates).toHaveLength(0);
  });

  it('解密失败/无法解析域：该行记 failed 并留 NULL，不中断整批', async () => {
    const { prisma, updates } = fakePrisma([
      [
        { id: 'bad-cipher', value: 'enc:v1:not-a-valid-payload' },
        { id: 'no-domain', value: encryptPii('not-an-email') },
        { id: 'ok', value: encryptPii('info@acme.example') },
      ],
    ]);
    const counts = await runBackfill(prisma as never, { dryRun: false, batchSize: 10 });
    expect(counts).toEqual({ scanned: 3, updated: 1, failed: 2 });
    expect(updates).toHaveLength(1);
    expect(updates[0]?.id).toBe('ok');
  });
});
