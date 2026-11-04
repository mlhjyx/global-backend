import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, describe, expect, it } from 'vitest';
import { appendRunEvent } from './run-events';

// Explicitly opted-in, disposable PostgreSQL only (schema from prisma migrate deploy).
const databaseUrl = process.env.RUN_EVENTS_TEST_DATABASE_URL;
if (databaseUrl) {
  const url = new URL(databaseUrl);
  if (
    url.protocol !== 'postgresql:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    !['/global_test', '/run_events_test'].includes(url.pathname)
  ) {
    throw new Error('run-event seq test requires a loopback test database');
  }
}

describe.runIf(Boolean(databaseUrl))('run-event seq allocation on PostgreSQL', () => {
  const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('takes the transaction advisory lock and appends consecutive seqs', async () => {
    // 2026-11-04: pg_advisory_xact_lock returns void; reading it through $queryRaw
    // failed at runtime with "Failed to deserialize column of type 'void'" and
    // aborted every discovery run at quickScan. This exercises the real statement.
    const workspaceId = randomUUID();
    const runId = await prisma.$transaction(async (tx) => {
      await tx.workspace.create({ data: { id: workspaceId, name: 'run-events probe' } });
      const company = await tx.companyProfile.create({
        data: { workspaceId, name: 'Run Events Probe' },
      });
      const icp = await tx.icpDefinition.create({
        data: { workspaceId, companyId: company.id, name: 'probe' },
      });
      const plan = await tx.discoveryQueryPlan.create({
        data: { workspaceId, icpId: icp.id, status: 'CONFIRMED', queries: [] },
      });
      const run = await tx.discoveryRun.create({
        data: {
          workspaceId,
          planId: plan.id,
          icpId: icp.id,
          materializationContractVersion: 'discovery-company-materialization/v1',
        },
      });
      return run.id;
    });

    try {
      await prisma.$transaction(async (tx) => {
        await appendRunEvent(tx as never, {
          workspaceId,
          runId,
          type: 'phase_started',
          payload: { phase: 'quick' },
        });
        await appendRunEvent(tx as never, {
          workspaceId,
          runId,
          type: 'phase_completed',
          payload: { phase: 'quick' },
        });
      });
      const rows = await prisma.runEvent.findMany({
        where: { runId },
        orderBy: { seq: 'asc' },
        select: { seq: true, type: true },
      });
      expect(rows.map((row) => Number(row.seq))).toEqual([1, 2]);
      expect(rows.map((row) => row.type)).toEqual(['phase_started', 'phase_completed']);
    } finally {
      await prisma.runEvent.deleteMany({ where: { runId } });
      await prisma.discoveryRun.deleteMany({ where: { id: runId } });
      await prisma.workspace.deleteMany({ where: { id: workspaceId } });
    }
  }, 60_000);
});
