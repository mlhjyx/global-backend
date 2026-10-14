import { randomInt, randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LeadService } from './lead.service';

// Explicitly opted-in, disposable and migrated PostgreSQL only. The owner connection (a superuser,
// which bypasses RLS) builds and removes the fixtures; every read runs as app_user through the
// production LeadService, whose session must be neither superuser nor BYPASSRLS. It proves what
// the mocked unit tests cannot: the lead.scored_at migration, Prisma's grouped COUNT(total_score),
// the relation-filtered aggregate behind human_reject, and the list's ordering and row shape.
// Synthetic `.example` companies only.
const ownerUrl = process.env.LEAD_QUEUE_BASIS_TEST_DATABASE_URL;
const appUrl = process.env.LEAD_QUEUE_BASIS_TEST_APP_DATABASE_URL;
if (Boolean(ownerUrl) !== Boolean(appUrl)) {
  throw new Error(
    'lead queue basis test needs both LEAD_QUEUE_BASIS_TEST_DATABASE_URL and LEAD_QUEUE_BASIS_TEST_APP_DATABASE_URL',
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
    throw new Error('lead queue basis test requires a loopback test database');
  }
}

/** Lower-case letters only, so no fixture value carries a long digit run. */
function letters(count: number): string {
  return Array.from({ length: count }, () => String.fromCharCode(97 + randomInt(26))).join('');
}

interface LeadFixture {
  id: string;
  company: string;
  status: string;
  queue: string;
  totalScore: number | null;
  scoredAt: Date | null;
  decision: 'accept' | 'reject' | null;
}

describe.runIf(Boolean(ownerUrl && appUrl))('lead queue basis on PostgreSQL', { timeout: 60_000 }, () => {
  // Created only when the suite runs: collecting a skipped suite still executes this body.
  let owner: PrismaClient;
  let app: PrismaClient;
  const suffix = letters(6);
  const workspaceA = randomUUID();
  const workspaceB = randomUUID();
  const icp = randomUUID();
  const otherIcp = randomUUID();
  const scoredAt = new Date('2026-10-14T01:02:03.000Z');
  const fixture = (over: Partial<LeadFixture>): LeadFixture => ({
    id: randomUUID(),
    company: randomUUID(),
    status: 'DISCOVERED',
    queue: 'needs_review',
    totalScore: null,
    scoredAt: null,
    decision: null,
    ...over,
  });
  // One company per lead: (workspace, icp, company) is unique.
  const leads = {
    preset: fixture({}),
    scored: fixture({ status: 'REVIEW', queue: 'recommended', totalScore: 0.7, scoredAt }),
    acceptedUnscored: fixture({ status: 'QUALIFIED', queue: 'recommended', decision: 'accept' }),
    humanRejectedUnscored: fixture({ status: 'REJECTED', queue: 'rejected', decision: 'reject' }),
    scoreRejected: fixture({ status: 'REJECTED', queue: 'rejected', totalScore: 0.1, scoredAt }),
    humanRejectedScored: fixture({ status: 'REJECTED', queue: 'rejected', totalScore: 0.2, scoredAt, decision: 'reject' }),
  };
  // Same ICP id in another workspace, and another ICP in workspace A: neither may be counted.
  const otherWorkspaceLead = fixture({ status: 'REVIEW', queue: 'recommended', totalScore: 0.9, scoredAt });
  const otherIcpLead = fixture({ status: 'REVIEW', queue: 'recommended', totalScore: 0.9, scoredAt });
  const ctx = { workspaceId: workspaceA, userId: 'operator', roles: [] } as never;

  const inWorkspace = <T>(workspace: string, work: (tx: Prisma.TransactionClient) => Promise<T>) =>
    app.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_workspace_id', ${workspace}, true)`;
        return work(tx);
      },
      { timeout: 20_000 },
    );
  const service = () =>
    new LeadService(
      { withWorkspace: <T>(workspace: string, work: (tx: Prisma.TransactionClient) => Promise<T>) => inWorkspace(workspace, work) } as never,
      {} as never,
      {} as never,
    );

  const insertLead = (workspace: string, icpId: string, lead: LeadFixture) => [
    owner.$executeRaw`
      INSERT INTO canonical_company (id, workspace_id, name, domain, status, dedupe_key, updated_at)
      VALUES (${lead.company}::uuid, ${workspace}::uuid, ${`Pumpen ${suffix} ${lead.id.slice(0, 8)} GmbH`},
        ${`pumpen-${suffix}-${lead.id.slice(0, 8)}.example`}, 'NEW',
        ${`domain:pumpen-${suffix}-${lead.id.slice(0, 8)}.example`}, now())`,
    owner.$executeRaw`
      INSERT INTO lead (id, workspace_id, icp_id, canonical_company_id, status, fit_verdict, queue, total_score,
        scored_at, updated_at)
      VALUES (${lead.id}::uuid, ${workspace}::uuid, ${icpId}::uuid, ${lead.company}::uuid,
        ${lead.status}::lead_status, 'match', ${lead.queue}, ${lead.totalScore}, ${lead.scoredAt}, now())`,
    ...(lead.decision
      ? [
          owner.$executeRaw`
            INSERT INTO lead_decision (id, workspace_id, lead_id, action, decided_by)
            VALUES (${randomUUID()}::uuid, ${workspace}::uuid, ${lead.id}::uuid, ${lead.decision}, 'operator')`,
        ]
      : []),
  ];

  beforeAll(async () => {
    owner = new PrismaClient({ datasourceUrl: ownerUrl });
    app = new PrismaClient({ datasourceUrl: appUrl });
    const [identity] = await app.$queryRaw<{ current: string; superuser: string; bypassrls: boolean }[]>`
      SELECT current_user::text AS current, current_setting('is_superuser') AS superuser,
        (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypassrls`;
    // RLS is only proven by a principal it applies to: a superuser or BYPASSRLS session passes silently.
    if (identity?.current !== 'app_user' || identity.superuser !== 'off' || identity.bypassrls !== false) {
      throw new Error('lead queue basis test must connect the app side as app_user without RLS bypass');
    }
    await owner.$transaction([
      ...Object.values(leads).flatMap((lead) => insertLead(workspaceA, icp, lead)),
      ...insertLead(workspaceB, icp, otherWorkspaceLead),
      ...insertLead(workspaceA, otherIcp, otherIcpLead),
    ]);
  });

  afterAll(async () => {
    if (!owner) return;
    try {
      // Deleting the companies removes their leads and decisions through the cascading foreign keys.
      const companies = [...Object.values(leads), otherWorkspaceLead, otherIcpLead].map((lead) => lead.company);
      await owner.$executeRaw`
        DELETE FROM canonical_company WHERE id IN (${Prisma.join(companies.map((id) => Prisma.sql`${id}::uuid`))})`;
    } finally {
      await Promise.all([owner.$disconnect(), app?.$disconnect()]);
    }
  });

  it('queueSummary counts the queues, scored and the four bases as app_user, scoped by RLS and ICP', async () => {
    await expect(service().queueSummary(ctx, icp)).resolves.toEqual({
      recommended: 2,
      needs_review: 1,
      rejected: 3,
      suppressed: 0,
      sanctions_hold: 0,
      scored: false,
      queueBasis: { fit_gate_preset: 1, score: 2, human_accept: 1, human_reject: 2 },
    });
  });

  it('list marks every row scored / queueBasis, orders scored rows first, carries scored_at and no decisions', async () => {
    const page = await service().list(ctx, { icpId: icp, limit: 20 });

    expect(page.hasMore).toBe(false);
    const ids = page.data.map((row) => row.id);
    expect(ids.slice(0, 3)).toEqual([leads.scored.id, leads.humanRejectedScored.id, leads.scoreRejected.id]);
    expect(ids.slice(3)).toEqual(
      [leads.preset.id, leads.acceptedUnscored.id, leads.humanRejectedUnscored.id].sort(),
    );
    expect(ids).not.toContain(otherWorkspaceLead.id);
    expect(ids).not.toContain(otherIcpLead.id);

    const byId = new Map(page.data.map((row) => [row.id, row]));
    const derived = (lead: LeadFixture) => {
      const row = byId.get(lead.id)!;
      return [row.scored, row.queueBasis, row.scoredAt?.toISOString() ?? null, 'decisions' in row];
    };
    expect(derived(leads.preset)).toEqual([false, 'fit_gate_preset', null, false]);
    expect(derived(leads.scored)).toEqual([true, 'score', scoredAt.toISOString(), false]);
    expect(derived(leads.acceptedUnscored)).toEqual([false, 'human_accept', null, false]);
    expect(derived(leads.humanRejectedUnscored)).toEqual([false, 'human_reject', null, false]);
    expect(derived(leads.scoreRejected)).toEqual([true, 'score', scoredAt.toISOString(), false]);
    expect(derived(leads.humanRejectedScored)).toEqual([true, 'human_reject', scoredAt.toISOString(), false]);
  });

  it('get derives the same basis from the full decision history', async () => {
    await expect(service().get(ctx, leads.humanRejectedScored.id)).resolves.toMatchObject({
      scored: true,
      queueBasis: 'human_reject',
      decisions: [{ action: 'reject' }],
    });
    await expect(service().get(ctx, leads.scoreRejected.id)).resolves.toMatchObject({
      scored: true,
      queueBasis: 'score',
      decisions: [],
    });
  });

  it('app_user may stamp the migrated lead.scored_at; scored still follows total_score alone', async () => {
    await inWorkspace(workspaceA, (tx) =>
      tx.lead.update({ where: { id: leads.preset.id }, data: { scoredAt: new Date('2026-10-14T02:00:00.000Z') } }),
    );
    const page = await service().list(ctx, { icpId: icp, queue: 'needs_review', limit: 5 });
    expect(page.data.map((row) => [row.id, row.scored, row.queueBasis, row.scoredAt?.toISOString()])).toEqual([
      [leads.preset.id, false, 'fit_gate_preset', '2026-10-14T02:00:00.000Z'],
    ]);
  });

  // Runs last: it turns the score-written rejection into a human one.
  it('decide(reject) on a score-written REJECTED lead records the decision as app_user and answers human_reject; a retry adds none', async () => {
    const first = await service().decide(ctx, leads.scoreRejected.id, 'reject', 'not a distributor');
    expect(first).toMatchObject({ id: leads.scoreRejected.id, status: 'REJECTED', scored: true, queueBasis: 'human_reject' });

    const retry = await service().decide(ctx, leads.scoreRejected.id, 'reject');
    expect(retry).toMatchObject({ status: 'REJECTED', scored: true, queueBasis: 'human_reject' });

    const decisions = await owner.$queryRaw<{ action: string; reason: string | null }[]>`
      SELECT action, reason FROM lead_decision WHERE lead_id = ${leads.scoreRejected.id}::uuid`;
    expect(decisions).toEqual([{ action: 'reject', reason: 'not a distributor' }]);
    await expect(service().queueSummary(ctx, icp)).resolves.toMatchObject({
      queueBasis: { fit_gate_preset: 1, score: 1, human_accept: 1, human_reject: 3 },
    });
  });
});
