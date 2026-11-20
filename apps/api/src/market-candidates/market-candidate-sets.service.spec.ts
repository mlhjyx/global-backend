import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import type { RequestContext } from '../auth/request-context';
import { MarketCandidateSetsService } from './market-candidate-sets.service';

const companyId = '00000000-0000-4000-8000-000000000001';
const setId = '00000000-0000-4000-8000-000000000002';
const actor = '00000000-0000-4000-8000-000000000003';
const ctx: RequestContext = { workspaceId: '00000000-0000-4000-8000-000000000004', userId: actor, roles: [] };
function port(tx: object) {
  const withWorkspace = vi.fn(async (workspace: string, run: (value: object) => unknown) => {
    expect(workspace).toBe(ctx.workspaceId); return run(tx);
  });
  return { withWorkspace };
}

describe('MarketCandidateSetsService boundaries', () => {
  it('bounds initial source-lock retries and returns a controlled conflict after three aborted attempts', async () => {
    const busy = new Prisma.PrismaClientKnownRequestError('SYNTHETIC source lock unavailable', { code: 'P2010', clientVersion: '6.19.3', meta: { code: '55P03' } });
    const withWorkspace = vi.fn().mockRejectedValue(busy);
    const service = new MarketCandidateSetsService({ withWorkspace } as unknown as PrismaService);
    await expect(service.persistInitial(ctx, companyId, { generationOutcome: 'COMPLETED_EMPTY', sources: [], candidates: [] }, actor)).rejects.toMatchObject({ status: 409 });
    expect(withWorkspace).toHaveBeenCalledTimes(3);
  });
  it('does not retry an unrelated storage or validation error as a Claim-lock conflict', async () => {
    const failure = new Prisma.PrismaClientKnownRequestError('SYNTHETIC unexpected constraint', { code: 'P2010', clientVersion: '6.19.3', meta: { code: '23514' } });
    const withWorkspace = vi.fn().mockRejectedValue(failure);
    const service = new MarketCandidateSetsService({ withWorkspace } as unknown as PrismaService);
    await expect(service.persistInitial(ctx, companyId, { generationOutcome: 'COMPLETED_EMPTY', sources: [], candidates: [] }, actor)).rejects.toBe(failure);
    expect(withWorkspace).toHaveBeenCalledTimes(1);
  });

  it('rejects absent or malformed tenant identity before touching the database', async () => {
    const db = port({}); const service = new MarketCandidateSetsService(db as unknown as PrismaService);
    await expect(service.getLatest(undefined as unknown as RequestContext, companyId)).rejects.toMatchObject({ status: 403 });
    await expect(service.getLatest({ ...ctx, workspaceId: '' }, companyId)).rejects.toMatchObject({ status: 403 });
    await expect(service.getLatest({ ...ctx, userId: 'forged' }, companyId)).rejects.toMatchObject({ status: 403 });
    expect(db.withWorkspace).not.toHaveBeenCalled();
  });
  it('returns a real not-found rather than an empty analysis when the company is not visible', async () => {
    const db = port({ $queryRaw: vi.fn(async () => []) });
    const service = new MarketCandidateSetsService(db as unknown as PrismaService);
    await expect(service.getLatest(ctx, companyId)).rejects.toMatchObject({ status: 404 });
  });
  it('returns NOT_ANALYZED without fabricating a set or invoking another capability', async () => {
    const tx = { $queryRaw: vi.fn(async () => [{ id: companyId, version: 1, deletedAt: null }]),
      marketCandidateSet: { findFirst: vi.fn(async () => null) } };
    const service = new MarketCandidateSetsService(port(tx) as unknown as PrismaService);
    expect(await service.getLatest(ctx, companyId)).toEqual({ status: 'NOT_ANALYZED', result: null });
  });
  it('fails closed on a soft-deleted parent instead of reading a remembered set', async () => {
    const tx = { $queryRaw: vi.fn(async () => [{ id: companyId, version: 1, deletedAt: new Date() }]),
      marketCandidateSet: { findFirst: vi.fn(() => { throw new Error('must not read the set'); }) } };
    const service = new MarketCandidateSetsService(port(tx) as unknown as PrismaService);
    await expect(service.getLatest(ctx, companyId)).rejects.toMatchObject({ status: 404 });
  });
  it('validates feedback and the UUID idempotency key before entering a transaction', async () => {
    const db = port({}); const service = new MarketCandidateSetsService(db as unknown as PrismaService);
    await expect(service.recordFeedback(ctx, setId, actor, { expectedRevision: 1, action: 'CONFIRM' }, '')).rejects.toMatchObject({ status: 400 });
    await expect(service.recordFeedback(ctx, setId, actor, { expectedRevision: null, action: 'CONFIRM' }, actor)).rejects.toMatchObject({ status: 400 });
    await expect(service.recordFeedback(ctx, setId, actor, { expectedRevision: 1, action: 'CORRECT', correction: { verified: true } }, actor)).rejects.toMatchObject({ status: 400 });
    expect(db.withWorkspace).not.toHaveBeenCalled();
  });
  it('rejects non-integer or unbounded history cursors without a database read', async () => {
    const db = port({}); const service = new MarketCandidateSetsService(db as unknown as PrismaService);
    for (const page of [{ limit: 101 }, { limit: 0 }, { limit: 1.5 }, { cursor: '0' }, { cursor: '2.1' }, { cursor: 'Infinity' }, { cursor: '1 OR 1=1' }]) {
      await expect(service.listRevisions(ctx, setId, page)).rejects.toMatchObject({ status: 400 });
    }
    expect(db.withWorkspace).not.toHaveBeenCalled();
  });
});
