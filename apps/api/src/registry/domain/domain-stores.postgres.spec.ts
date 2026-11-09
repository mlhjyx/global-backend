import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DomainResolutionStoreError } from './domain-resolution-store';
import {
  PrismaDomainResolutionStore,
  PrismaDomainReviewTaskStore,
} from './domain-stores.prisma';

// Explicitly opted-in, disposable and migrated PostgreSQL only (CI step "Raw SQL parameter
// types on PostgreSQL" runs it after `prisma migrate deploy`). The owner connection (a
// superuser, which bypasses RLS) builds and removes fixtures; every check of the tenant
// tables runs as app_user within a set_config('app.current_workspace_id') transaction —
// reading outside one yields a silent empty set, which is asserted, not glossed over.
const ownerUrl = process.env.DOMAIN_RESOLUTION_TEST_DATABASE_URL;
const appUrl = process.env.DOMAIN_RESOLUTION_TEST_APP_DATABASE_URL;
if (Boolean(ownerUrl) !== Boolean(appUrl)) {
  throw new Error(
    'domain resolution test needs both DOMAIN_RESOLUTION_TEST_DATABASE_URL and DOMAIN_RESOLUTION_TEST_APP_DATABASE_URL',
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
    throw new Error('domain resolution test requires a loopback test database');
  }
}

/** The SQLSTATE PostgreSQL raised through a Prisma raw query, or null. */
function sqlState(error: unknown): string | null {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2010') return null;
  const code = (error.meta as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' ? code : null;
}

const WS_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const WS_B = 'bbbbbbbb-0000-4000-8000-000000000002';
const NOW = '2026-11-09T12:00:00.000Z';
const LATER = '2026-11-09T13:00:00.000Z';
const PAST = '2026-11-01T12:00:00.000Z';
const FUTURE = '2026-11-20T12:00:00.000Z';

describe.runIf(Boolean(ownerUrl && appUrl))('domain resolution stores on PostgreSQL (ch03 执行面 3a)', { timeout: 60_000 }, () => {
  let owner: PrismaClient;
  let app: PrismaClient;
  const companyA = randomUUID();
  const companyB = randomUUID();
  const companyOther = randomUUID(); // workspace B
  const companyCascade = randomUUID(); // workspace A, deleted mid-suite

  const verifiedInput = (domain: string) => ({
    candidateDomain: domain,
    route: 'source_field' as const,
    routeRank: 0,
    status: 'VERIFIED' as const,
    matchType: 'EXACT',
    confidence: 95,
    evidenceUrl: `https://${domain}/impressum`,
    evidenceHash: 'a'.repeat(64),
    evidenceJson: { register: 'fr_siren', value: '529990001' },
    extractorVersion: 'domain-verifier/v1',
    verifiedAt: '2026-11-09T11:00:00.000Z',
  });

  async function inWorkspace<T>(
    workspace: string | null,
    work: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return app.$transaction(
      async (tx) => {
        if (workspace) {
          await tx.$executeRaw`SELECT set_config('app.current_workspace_id', ${workspace}, true)`;
        }
        return work(tx);
      },
      { timeout: 20_000 },
    );
  }

  /** Runs `work` in a workspace transaction and returns the SQLSTATE it failed with. */
  async function stateOf(
    workspace: string | null,
    work: (tx: Prisma.TransactionClient) => Promise<unknown>,
  ): Promise<string | null> {
    try {
      await inWorkspace(workspace, work);
    } catch (error) {
      return sqlState(error) ?? `other: ${String(error)}`;
    }
    return null;
  }

  const resolutions = (tx: Prisma.TransactionClient) => new PrismaDomainResolutionStore(tx);
  const reviewTasks = (tx: Prisma.TransactionClient) => new PrismaDomainReviewTaskStore(tx);

  beforeAll(async () => {
    owner = new PrismaClient({ datasourceUrl: ownerUrl });
    app = new PrismaClient({ datasourceUrl: appUrl });
    const [identity] = await app.$queryRaw<{ current: string; superuser: string; bypassrls: boolean }[]>`
      SELECT current_user::text AS current, current_setting('is_superuser') AS superuser,
        (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypassrls`;
    // RLS is only proven by a principal it applies to: a superuser or BYPASSRLS session passes silently.
    if (identity?.current !== 'app_user' || identity.superuser !== 'off' || identity.bypassrls !== false) {
      throw new Error('domain resolution test must connect the app side as app_user without RLS bypass');
    }
    const suffix = randomUUID().slice(0, 8);
    await owner.$executeRaw`
      INSERT INTO canonical_company (id, workspace_id, name, domain, status, dedupe_key, updated_at) VALUES
        (${companyA}::uuid, ${WS_A}::uuid, ${`Pumpen ${suffix} GmbH`}, ${`pumpen-${suffix}.example`},
          'NEW', ${`domain:pumpen-${suffix}.example`}, now()),
        (${companyB}::uuid, ${WS_A}::uuid, ${`Ventile ${suffix} GmbH`}, ${`ventile-${suffix}.example`},
          'NEW', ${`domain:ventile-${suffix}.example`}, now()),
        (${companyOther}::uuid, ${WS_B}::uuid, ${`Lager ${suffix} GmbH`}, ${`lager-${suffix}.example`},
          'NEW', ${`domain:lager-${suffix}.example`}, now()),
        (${companyCascade}::uuid, ${WS_A}::uuid, ${`Armaturen ${suffix} GmbH`}, ${`armaturen-${suffix}.example`},
          'NEW', ${`domain:armaturen-${suffix}.example`}, now())`;
  });

  afterAll(async () => {
    if (!owner) return;
    try {
      await owner.$executeRaw`
        DELETE FROM canonical_company WHERE id IN (${companyA}::uuid, ${companyB}::uuid,
          ${companyOther}::uuid, ${companyCascade}::uuid)`;
    } finally {
      await Promise.all([owner.$disconnect(), app?.$disconnect()]);
    }
  });

  it('upserts idempotently, keeps the selected flag out of upserts and selects at most one VERIFIED row', async () => {
    const first = await inWorkspace(WS_A, (tx) => resolutions(tx).upsert(WS_A, companyA, verifiedInput('pumpen-a.example'), NOW));
    expect(first.inserted).toBe(true);
    // 同业务键再写 = 更新而非新行（原子 ON CONFLICT）。
    const again = await inWorkspace(WS_A, (tx) =>
      resolutions(tx).upsert(WS_A, companyA, { ...verifiedInput('pumpen-a.example'), confidence: 88, evidenceJson: { refreshed: true } }, LATER),
    );
    expect(again).toEqual({ id: first.id, inserted: false });

    let rows = await inWorkspace(WS_A, (tx) => resolutions(tx).listForCompany(WS_A, companyA));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ confidence: 88, evidenceJson: { refreshed: true }, selected: false });

    const second = await inWorkspace(WS_A, (tx) =>
      resolutions(tx).upsert(WS_A, companyA, { ...verifiedInput('pumpen-b.example'), route: 'wikidata_p856', routeRank: 2 }, LATER),
    );

    await inWorkspace(WS_A, (tx) => resolutions(tx).selectVerified(WS_A, companyA, first.id, LATER));
    await inWorkspace(WS_A, (tx) => resolutions(tx).selectVerified(WS_A, companyA, second.id, LATER));
    rows = await inWorkspace(WS_A, (tx) => resolutions(tx).listForCompany(WS_A, companyA));
    expect(rows.filter((row) => row.selected).map((row) => row.id)).toEqual([second.id]);
    // 绕过 store 直接置第二行为选中：部分唯一索引拒绝（23505），单选中不靠应用层自觉。
    expect(
      await stateOf(WS_A, (tx) =>
        tx.$executeRaw`UPDATE "company_domain_resolution" SET "selected" = true WHERE "id" = ${first.id}::uuid`,
      ),
    ).toBe('23505');
    // upsert 之后选中位仍在（业务键更新不洗掉选中）。
    await inWorkspace(WS_A, (tx) => resolutions(tx).upsert(WS_A, companyA, verifiedInput('pumpen-a.example'), LATER));
    rows = await inWorkspace(WS_A, (tx) => resolutions(tx).listForCompany(WS_A, companyA));
    expect(rows.filter((row) => row.selected).map((row) => row.id)).toEqual([second.id]);

    // clearSelected 后清一行为零，选中行才能改判为终态（否则 CHECK 23514）。
    expect(await inWorkspace(WS_A, (tx) => resolutions(tx).clearSelected(WS_A, companyA, LATER))).toBe(1);
    expect(await inWorkspace(WS_A, (tx) => resolutions(tx).clearSelected(WS_A, companyA, LATER))).toBe(0);
    await inWorkspace(WS_A, (tx) =>
      resolutions(tx).upsert(WS_A, companyA, { ...verifiedInput('pumpen-a.example'), status: 'REJECTED', verifiedAt: null }, LATER),
    );
    rows = await inWorkspace(WS_A, (tx) => resolutions(tx).listForCompany(WS_A, companyA));
    expect(rows.filter((row) => row.selected)).toEqual([]);
  });

  it('refuses to select a non-VERIFIED row through the store', async () => {
    const pending = await inWorkspace(WS_A, (tx) =>
      resolutions(tx).upsert(WS_A, companyB, { ...verifiedInput('ventile-c.example'), route: 'search', routeRank: 2, status: 'AMBIGUOUS', verifiedAt: null }, NOW),
    );
    await expect(
      inWorkspace(WS_A, (tx) => resolutions(tx).selectVerified(WS_A, companyB, pending.id, LATER)),
    ).rejects.toThrow(DomainResolutionStoreError);
    // 约束层再兜一道：直接 UPDATE 把 AMBIGUOUS 行置 selected 会被 CHECK 拒绝。
    expect(
      await stateOf(WS_A, (tx) =>
        tx.$executeRaw`UPDATE "company_domain_resolution" SET "selected" = true WHERE "id" = ${pending.id}::uuid`,
      ),
    ).toBe('23514');
  });

  it('hides other workspaces and fails closed without a workspace (RLS positive/negative)', async () => {
    // ① 不 set_config：租户表读到静默空集（这正是本仓的经典陷阱）。
    const unseen = await app.$transaction((tx) => resolutions(tx).listForCompany(WS_A, companyA));
    expect(unseen).toEqual([]);
    expect(await app.$transaction((tx) => reviewTasks(tx).listOpen(WS_A))).toEqual([]);

    // ② 不 set_config 直接写：WITH CHECK 拒绝（42501）。
    const insertDenied = await stateOf(
      null,
      (tx) =>
        tx.$executeRaw`INSERT INTO "company_domain_resolution"
          ("id", "workspace_id", "company_id", "candidate_domain", "route", "route_rank", "updated_at")
          VALUES (${randomUUID()}::uuid, ${WS_A}::uuid, ${companyA}::uuid, 'rogue.example', 'manual', 0, now())`,
    );
    expect(insertDenied).toBe('42501');

    // ③ 会话设在别的 workspace：看不见 A 的行，也写不进 A 的行。
    const foreignRead = await inWorkspace(WS_B, (tx) => resolutions(tx).listForCompany(WS_A, companyA));
    expect(foreignRead).toEqual([]);
    const foreignUpdate = await inWorkspace(WS_B, (tx) =>
      tx.companyDomainResolution.updateMany({
        where: { workspaceId: WS_A, companyId: companyA },
        data: { confidence: 1 },
      }),
    );
    expect(foreignUpdate.count).toBe(0);

    // ④ set WS_B 却把行写进 WS_A：WITH CHECK 拒绝。
    expect(
      await stateOf(WS_B, (tx) =>
        tx.$executeRaw`INSERT INTO "company_domain_resolution"
          ("id", "workspace_id", "company_id", "candidate_domain", "route", "route_rank", "updated_at")
          VALUES (${randomUUID()}::uuid, ${WS_A}::uuid, ${companyA}::uuid, 'sneaky.example', 'manual', 0, now())`,
      ),
    ).toBe('42501');

    // ⑤ 复合外键：workspace 与 company 不配套的候选行写不进去（23503）。
    expect(
      await stateOf(WS_A, (tx) =>
        resolutions(tx).upsert(WS_A, companyOther, verifiedInput('cross-workspace.example'), NOW),
      ),
    ).toBe('23503');

    // ⑥ 另一 workspace 的公司可以正常落自己的行（对照，证明前面的拒绝不是全表拒绝）。
    const own = await inWorkspace(WS_B, (tx) => resolutions(tx).upsert(WS_B, companyOther, verifiedInput('lager-own.example'), NOW));
    expect(own.inserted).toBe(true);
  });

  it('runs the review queue store end-to-end: idempotent open, terminal decision, SLA expiry', async () => {
    const [resolution] = await inWorkspace(WS_A, (tx) => resolutions(tx).listForCompany(WS_A, companyA));
    expect(resolution).toBeDefined();

    const first = await inWorkspace(WS_A, (tx) =>
      reviewTasks(tx).openOrGet(WS_A, { resolutionId: resolution!.id, reason: 'low_confidence', priority: 50, dueAt: FUTURE }, NOW),
    );
    expect(first.created).toBe(true);
    const second = await inWorkspace(WS_A, (tx) =>
      reviewTasks(tx).openOrGet(WS_A, { resolutionId: resolution!.id, reason: 'low_confidence', priority: 50, dueAt: FUTURE }, LATER),
    );
    expect(second).toEqual({ task: expect.objectContaining({ id: first.task.id }), created: false });

    const decided = await inWorkspace(WS_A, (tx) =>
      reviewTasks(tx).decide(WS_A, first.task.id, { outcome: 'APPROVED', reviewer: 'ops-alice', note: '确认是官网', nowIso: LATER }),
    );
    expect(decided).toMatchObject({ status: 'APPROVED', decidedAt: LATER, decisionNote: 'ops-alice: 确认是官网' });
    await expect(
      inWorkspace(WS_A, (tx) =>
        reviewTasks(tx).decide(WS_A, first.task.id, { outcome: 'REJECTED', reviewer: 'ops', nowIso: LATER }),
      ),
    ).rejects.toThrow(/不能再裁决/u);

    // 超期工单：OPEN 且 dueAt 已过 → EXPIRED，decided_at 被置上以过迁移 CHECK。
    const late = await inWorkspace(WS_A, (tx) =>
      reviewTasks(tx).openOrGet(WS_A, { resolutionId: resolution!.id, reason: 'audit_sample', priority: 70, dueAt: PAST }, NOW),
    );
    expect(await inWorkspace(WS_A, (tx) => reviewTasks(tx).expireOverdue(WS_A, NOW))).toBe(1);
    const expired = await owner.domainReviewTask.findUniqueOrThrow({ where: { id: late.task.id } });
    expect(expired.status).toBe('EXPIRED');
    expect(expired.decidedAt?.toISOString()).toBe(NOW);
    expect(expired.decisionNote).toBe('SLA_TIMEOUT');
    expect(await inWorkspace(WS_A, (tx) => reviewTasks(tx).expireOverdue(WS_A, NOW))).toBe(0);

    // 非 OPEN 的工单必须有 decided_at（迁移 CHECK 兜底，绕过 store 直写也不行）。
    expect(
      await stateOf(WS_A, (tx) =>
        tx.$executeRaw`INSERT INTO "domain_review_task"
          ("id", "workspace_id", "resolution_id", "reason", "priority", "status", "due_at")
          VALUES (${randomUUID()}::uuid, ${WS_A}::uuid, ${resolution!.id}::uuid, 'name_collision', 50, 'APPROVED', now())`,
      ),
    ).toBe('23514');

    // 工单队列按 workspace 隔离。
    expect(await inWorkspace(WS_B, (tx) => reviewTasks(tx).listOpen(WS_A))).toEqual([]);
  });

  it('cascades resolutions and tasks when the company is deleted', async () => {
    const resolution = await inWorkspace(WS_A, (tx) =>
      resolutions(tx).upsert(WS_A, companyCascade, verifiedInput('cascade.example'), NOW),
    );
    await inWorkspace(WS_A, (tx) =>
      reviewTasks(tx).openOrGet(WS_A, { resolutionId: resolution.id, reason: 'audit_sample', priority: 50, dueAt: FUTURE }, NOW),
    );
    await owner.$executeRaw`DELETE FROM canonical_company WHERE id = ${companyCascade}::uuid`;
    expect(await owner.companyDomainResolution.count({ where: { companyId: companyCascade } })).toBe(0);
    expect(await owner.domainReviewTask.count({ where: { resolutionId: resolution.id } })).toBe(0);
  });
});
