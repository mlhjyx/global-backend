import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../prisma/prisma.service';
import { seedAgentCatalog } from './agent-catalog.seed';
import { AGENT_KEYS } from './agent-catalog';
import { PrismaAgentDecisionTraceStore } from './agent-decision-trace.store';
import { PrismaAgentRegistryStore } from './agent-registry.store';
import { createDbAgentResolver } from './agent-resolver';
import { AgentsService } from './agents.service';

// Explicitly opted-in, disposable and migrated PostgreSQL only（同 lead-queue-basis 模式）。
// owner 连接（superuser，绕过 RLS）建/清夹具；执行侧一律走 app_user + withWorkspace，
// 证明迁移的 RLS、append-only 授权与幂等唯一键在真库上成立：
//   * seed 幂等：重复播种不新增行、不覆盖 ops 启停；
//   * 解析器在真库上按注册行工作（负向 1/2 的库侧对照）；
//   * trace 同一 (run, step, discriminator) 重放不翻行（负向 6）；
//   * trace 跨租户不可见（9b-4 的 404 语义靠它）；app_user 无 UPDATE/DELETE（负向 4）；
//   * trace 随 run 级联删除。
const ownerUrl = process.env.AGENT_ORCHESTRATION_TEST_DATABASE_URL;
const appUrl = process.env.AGENT_ORCHESTRATION_TEST_APP_DATABASE_URL;
if (Boolean(ownerUrl) !== Boolean(appUrl)) {
  throw new Error(
    'agent orchestration test needs both AGENT_ORCHESTRATION_TEST_DATABASE_URL and AGENT_ORCHESTRATION_TEST_APP_DATABASE_URL',
  );
}
for (const value of [ownerUrl, appUrl]) {
  if (!value) continue;
  const url = new URL(value);
  if (
    url.protocol !== 'postgresql:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    url.pathname !== '/global_test' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new Error('agent orchestration test requires a loopback test database');
  }
}

async function rejectsWithPermission(operation: () => Promise<unknown>): Promise<void> {
  await expect(operation()).rejects.toThrow(/permission denied/u);
}

async function rejectsWithRls(operation: () => Promise<unknown>): Promise<void> {
  await expect(operation()).rejects.toThrow(/row-level security/u);
}

describe.runIf(Boolean(ownerUrl && appUrl))(
  'agent orchestration v0 on PostgreSQL',
  { timeout: 60_000 },
  () => {
    let owner: PrismaClient;
    let prisma: PrismaService;
    const workspaceA = randomUUID();
    const workspaceB = randomUUID();
    const runId = randomUUID();
    const otherRunId = randomUUID();
    let previousAppUrl: string | undefined;

    beforeAll(async () => {
      owner = new PrismaClient({ datasourceUrl: ownerUrl });
      previousAppUrl = process.env.APP_DATABASE_URL;
      process.env.APP_DATABASE_URL = appUrl;
      prisma = new PrismaService();
      await prisma.$connect();
      // discovery_run 无 plan/icp 外键，可直接造行；trace 的 (workspace, run) 外键指向它。
      for (const [workspaceId, id] of [
        [workspaceA, runId],
        [workspaceB, otherRunId],
      ] as const) {
        await owner.$executeRaw`
          INSERT INTO "discovery_run"
            ("id", "workspace_id", "plan_id", "icp_id", "materialization_contract_version")
          VALUES
            (${id}::uuid, ${workspaceId}::uuid, ${randomUUID()}::uuid, ${randomUUID()}::uuid,
             'discovery-company-materialization/v1')
        `;
      }
    });

    afterAll(async () => {
      await owner.$executeRaw`DELETE FROM "discovery_run" WHERE "id" IN (${runId}::uuid, ${otherRunId}::uuid)`;
      await owner.$executeRaw`DELETE FROM "agent_profile" WHERE "agent_key" LIKE 'spec.agent.%'`;
      await Promise.allSettled([owner.$disconnect(), prisma.$disconnect()]);
      if (previousAppUrl === undefined) delete process.env.APP_DATABASE_URL;
      else process.env.APP_DATABASE_URL = previousAppUrl;
    });

    it('seeds the builtin agents idempotently and never overrides the ops kill switch', async () => {
      const first = await seedAgentCatalog(owner);
      const second = await seedAgentCatalog(owner);
      expect(first.profiles).toBeGreaterThanOrEqual(2);
      expect(first.inserted + first.updated).toBe(first.profiles);
      expect(second.inserted).toBe(0);
      expect(second.updated).toBe(second.profiles);

      const agents = new AgentsService(prisma);
      await agents.setStatus(workspaceA, undefined, AGENT_KEYS.qualifier, 'DISABLED', 'spec');
      const third = await seedAgentCatalog(owner);
      expect(third.updated).toBe(third.profiles);
      const [row] = await owner.$queryRaw<{ status: string }[]>`
        SELECT "status" FROM "agent_profile" WHERE "agent_key" = ${AGENT_KEYS.qualifier}
      `;
      expect(row?.status).toBe('DISABLED');
      await agents.setStatus(workspaceA, undefined, AGENT_KEYS.qualifier, 'ACTIVE', 'spec restore');
    });

    it('resolves registered agents through the app_user RLS context', async () => {
      const resolver = createDbAgentResolver(new PrismaAgentRegistryStore(prisma), { ttlMs: 0 });
      const scout = await resolver.resolve(AGENT_KEYS.sourceScout, workspaceA);
      expect(scout.name).toBe('源侦察员');
      expect(scout.loopPolicy.maxRounds).toBe(1);
      const qualifier = await resolver.resolve(AGENT_KEYS.qualifier, workspaceA);
      expect(qualifier.skillKeys).toEqual(['discovery.qualify_fit']);
    });

    it('replays the same round without a second trace row and hides it from other tenants', async () => {
      const store = new PrismaAgentDecisionTraceStore(prisma);
      const trace = {
        workspaceId: workspaceA,
        runId,
        stepType: 'discovery.query' as const,
        agentKey: AGENT_KEYS.sourceScout,
        decisionType: 'source.route',
        discriminator: 'spec-query-key',
        chosenOption: { sources: ['wikidata'] },
        rejectedCandidates: [{ candidateRef: 'public_web', rejectReason: 'SOURCE_HINT_EXCLUDED' }],
      };
      await store.record(trace);
      await store.record({ ...trace, attempt: 2 });
      const rows = await owner.$queryRaw<{ id: string; attempt: number }[]>`
        SELECT "id"::text AS "id", "attempt" FROM "agent_decision_trace"
        WHERE "workspace_id" = ${workspaceA}::uuid AND "run_id" = ${runId}::uuid
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.attempt).toBe(1);

      const visibleToA = await prisma.withWorkspace(workspaceA, (tx) =>
        tx.$queryRaw<{ id: string }[]>`SELECT "id"::text AS "id" FROM "agent_decision_trace"`,
      );
      expect(visibleToA.length).toBeGreaterThanOrEqual(1);
      const visibleToB = await prisma.withWorkspace(workspaceB, (tx) =>
        tx.$queryRaw<{ id: string }[]>`SELECT "id"::text AS "id" FROM "agent_decision_trace"`,
      );
      expect(visibleToB).toHaveLength(0);
    });

    it('keeps traces append-only for the application role and cascades them with the run', async () => {
      await rejectsWithPermission(() =>
        prisma.withWorkspace(workspaceA, (tx) =>
          tx.$executeRaw`UPDATE "agent_decision_trace" SET "reason_code" = 'tampered' WHERE "run_id" = ${runId}::uuid`,
        ),
      );
      await rejectsWithPermission(() =>
        prisma.withWorkspace(workspaceA, (tx) =>
          tx.$executeRaw`DELETE FROM "agent_decision_trace" WHERE "run_id" = ${runId}::uuid`,
        ),
      );
      // 会话在 A，写入 B 的空间 → RLS WITH CHECK 拒绝（跨租户写不进去）。
      await rejectsWithRls(() =>
        prisma.withWorkspace(workspaceA, (tx) =>
          tx.$executeRaw`
            INSERT INTO "agent_decision_trace"
              ("workspace_id", "run_id", "step_type", "agent_key", "decision_type", "discriminator")
            VALUES
              (${workspaceB}::uuid, ${otherRunId}::uuid, 'discovery.query',
               ${AGENT_KEYS.sourceScout}, 'source.route', 'cross-tenant')
          `,
        ),
      );
      // A 的空间 + B 的 run → (workspace_id, run_id) 外键拒绝（轨迹只能挂本空间的 run）。
      await expect(
        prisma.withWorkspace(workspaceA, (tx) =>
          tx.$executeRaw`
            INSERT INTO "agent_decision_trace"
              ("workspace_id", "run_id", "step_type", "agent_key", "decision_type", "discriminator")
            VALUES
              (${workspaceA}::uuid, ${otherRunId}::uuid, 'discovery.query',
               ${AGENT_KEYS.sourceScout}, 'source.route', 'foreign-run')
          `,
        ),
      ).rejects.toThrow(/foreign key/u);

      await owner.$executeRaw`DELETE FROM "discovery_run" WHERE "id" = ${runId}::uuid`;
      const remaining = await owner.$queryRaw<{ count: bigint }[]>`
        SELECT count(*) AS "count" FROM "agent_decision_trace" WHERE "workspace_id" = ${workspaceA}::uuid
      `;
      expect(Number(remaining[0]?.count ?? -1)).toBe(0);
      await owner.$executeRaw`
        INSERT INTO "discovery_run"
          ("id", "workspace_id", "plan_id", "icp_id", "materialization_contract_version")
        VALUES
          (${runId}::uuid, ${workspaceA}::uuid, ${randomUUID()}::uuid, ${randomUUID()}::uuid,
           'discovery-company-materialization/v1')
      `;
    });
  },
);
