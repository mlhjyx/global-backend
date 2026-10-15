import { randomInt, randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  COMPANY_CONTACT_PARSER_VERSION,
  contactPathAttempt,
  contactPathBackfillCandidates,
  nextContactPathAttempt,
  recordContactPathAttempt,
} from './company-contact-points';

// W5-f: the contact-path backfill query (contactPathBackfillCandidates) and its attempt watermark,
// run for real. Explicitly opted-in, disposable and migrated PostgreSQL only. The owner connection
// (a superuser, which bypasses RLS) builds and removes the fixtures; the query and the stamp writer
// run as app_user, whose session must be neither superuser nor BYPASSRLS. Synthetic `.example`
// companies only. Not in ci.yml: run by hand, see the PR (W9 moves the real-database specs out of it).
const ownerUrl = process.env.CONTACT_PATH_BACKFILL_TEST_DATABASE_URL;
const appUrl = process.env.CONTACT_PATH_BACKFILL_TEST_APP_DATABASE_URL;
if (Boolean(ownerUrl) !== Boolean(appUrl)) {
  throw new Error(
    'contact-path backfill test needs both CONTACT_PATH_BACKFILL_TEST_DATABASE_URL and CONTACT_PATH_BACKFILL_TEST_APP_DATABASE_URL',
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
    throw new Error('contact-path backfill test requires a loopback test database');
  }
}

/** Lower-case letters only, so no fixture value carries a long digit run. */
function letters(count: number): string {
  return Array.from({ length: count }, () => String.fromCharCode(97 + randomInt(26))).join('');
}

const DAY = 24 * 60 * 60 * 1000;
const at = (base: Date, offsetMs: number) => new Date(base.getTime() + offsetMs);

describe.runIf(Boolean(ownerUrl && appUrl))('contact-path backfill candidates on PostgreSQL (W5-f)', { timeout: 60_000 }, () => {
  // Created only when the suite runs: collecting a skipped suite still executes this body.
  let owner: PrismaClient;
  let app: PrismaClient;
  const suffix = letters(6);
  const workspaceA = randomUUID();
  const workspaceB = randomUUID();
  // The first run of the scenario was created at RUN_1.
  const RUN_1 = new Date('2026-10-14T00:00:00.000Z');
  const CREATED = new Date('2026-09-01T00:00:00.000Z');

  // Workspace A. `created` orders them oldest first; the comments give each one's watermark at RUN_1.
  const ids = {
    neverOld: randomUUID(), // never tried, oldest
    triedLongAgo: randomUUID(), // tried 30 days before RUN_1, created before neverNew
    neverNew: randomUUID(), // never tried
    triedTenDays: randomUUID(), // tried 10 days before RUN_1, created first of all the tried ones
    oldRules: randomUUID(), // read under an older contact-path rules version, never tried under the watermark
    cooling: randomUUID(), // tried 2 days before RUN_1: inside the 7-day cooldown
    read: randomUUID(), // read under the current rules
    ownRun: randomUUID(), // one of the run's own companies (excluded by id)
    suppressed: randomUUID(),
    noDomain: randomUUID(),
    later: randomUUID(), // created between the runs
  };
  const otherWorkspace = randomUUID();
  const names = Object.fromEntries(Object.keys(ids).map((key) => [key, key])) as Record<keyof typeof ids, string>;

  const inWorkspace = <T>(workspace: string, work: (tx: Prisma.TransactionClient) => Promise<T>) =>
    app.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_workspace_id', ${workspace}, true)`;
        return work(tx);
      },
      { timeout: 20_000 },
    );

  const idName = new Map<string, string>();
  const candidates = async (runSince: Date, options: { workspace?: string; asWorkspace?: string } = {}) => {
    const rows = await inWorkspace(options.asWorkspace ?? workspaceA, (tx) =>
      contactPathBackfillCandidates(tx, {
        workspaceId: options.workspace ?? workspaceA,
        runSince,
        excludeCompanyIds: [ids.ownRun],
        limit: 50,
      }),
    );
    return rows.map((row) => idName.get(row.id) ?? row.id);
  };

  /** What the profile loop does after one attempt: read the stored watermark, stamp the next one. */
  const attempt = (companyId: string, when: Date, runSince: Date) =>
    inWorkspace(workspaceA, async (tx) => {
      const row = await tx.canonicalCompany.findUnique({ where: { id: companyId }, select: { attributes: true } });
      return recordContactPathAttempt(tx, {
        workspaceId: workspaceA,
        companyId,
        attempt: nextContactPathAttempt(contactPathAttempt(row?.attributes), when, runSince),
      });
    });

  const stored = (companyId: string) =>
    inWorkspace(workspaceA, async (tx) =>
      contactPathAttempt(
        (await tx.canonicalCompany.findUnique({ where: { id: companyId }, select: { attributes: true } }))?.attributes,
      ),
    );

  const insertCompany = (
    id: string,
    workspace: string,
    name: string,
    options: { created: Date; domain?: string | null; status?: string; profile?: Record<string, unknown> },
  ) => {
    const domain = options.domain === undefined ? `${name.toLowerCase()}-${suffix}.example` : options.domain;
    const attributes = options.profile ? JSON.stringify({ website_profile: options.profile }) : null;
    return owner.$executeRaw`
      INSERT INTO canonical_company (id, workspace_id, name, domain, status, dedupe_key, attributes, created_at, updated_at)
      VALUES (${id}::uuid, ${workspace}::uuid, ${`${name} ${suffix} GmbH`}, ${domain}, ${options.status ?? 'NEW'},
        ${`name:${name}-${suffix}`}, ${attributes}::jsonb, ${options.created}, now())`;
  };

  beforeAll(async () => {
    owner = new PrismaClient({ datasourceUrl: ownerUrl });
    app = new PrismaClient({ datasourceUrl: appUrl });
    const [identity] = await app.$queryRaw<{ current: string; superuser: string; bypassrls: boolean }[]>`
      SELECT current_user::text AS current, current_setting('is_superuser') AS superuser,
        (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypassrls`;
    // RLS is only proven by a principal it applies to: a superuser or BYPASSRLS session passes silently.
    if (identity?.current !== 'app_user' || identity.superuser !== 'off' || identity.bypassrls !== false) {
      throw new Error('contact-path backfill test must connect the app side as app_user without RLS bypass');
    }
    for (const [key, id] of Object.entries(ids)) idName.set(id, key);
    idName.set(otherWorkspace, 'otherWorkspace');
    const iso = (offsetMs: number) => at(RUN_1, offsetMs).toISOString();
    await owner.$transaction([
      insertCompany(ids.neverOld, workspaceA, names.neverOld, { created: at(CREATED, 0) }),
      insertCompany(ids.triedLongAgo, workspaceA, names.triedLongAgo, {
        created: at(CREATED, 1 * DAY),
        profile: { _contact_attempt_at: iso(-30 * DAY) },
      }),
      insertCompany(ids.neverNew, workspaceA, names.neverNew, { created: at(CREATED, 2 * DAY) }),
      insertCompany(ids.triedTenDays, workspaceA, names.triedTenDays, {
        created: at(CREATED, -1 * DAY),
        profile: { _contact_attempt_at: iso(-10 * DAY) },
      }),
      insertCompany(ids.oldRules, workspaceA, names.oldRules, {
        created: at(CREATED, 3 * DAY),
        profile: { trade_role: 'distributor', _ts: iso(-40 * DAY), _contact_parser: 'company_contact/v0' },
      }),
      insertCompany(ids.cooling, workspaceA, names.cooling, {
        created: at(CREATED, -2 * DAY),
        profile: { _contact_attempt_at: iso(-2 * DAY) },
      }),
      insertCompany(ids.read, workspaceA, names.read, {
        created: at(CREATED, -3 * DAY),
        profile: { trade_role: 'distributor', _ts: iso(-20 * DAY), _contact_parser: COMPANY_CONTACT_PARSER_VERSION, _contact_attempt_at: iso(-20 * DAY) },
      }),
      insertCompany(ids.ownRun, workspaceA, names.ownRun, { created: at(CREATED, -4 * DAY) }),
      insertCompany(ids.suppressed, workspaceA, names.suppressed, { created: at(CREATED, -5 * DAY), status: 'SUPPRESSED' }),
      insertCompany(ids.noDomain, workspaceA, names.noDomain, { created: at(CREATED, -6 * DAY), domain: null }),
      insertCompany(otherWorkspace, workspaceB, 'otherWorkspace', { created: at(CREATED, -7 * DAY) }),
    ]);
  });

  afterAll(async () => {
    if (!owner) return;
    try {
      await owner.$executeRaw`DELETE FROM canonical_company WHERE workspace_id IN (${workspaceA}::uuid, ${workspaceB}::uuid)`;
    } finally {
      await Promise.all([owner.$disconnect(), app?.$disconnect()]);
    }
  });

  it('lists never-tried companies first (oldest first), then the longest-untried, leaving out cooling, read, own, suppressed and domain-less ones', async () => {
    expect(await candidates(RUN_1)).toEqual(['neverOld', 'neverNew', 'oldRules', 'triedLongAgo', 'triedTenDays']);
  });

  it('applies RLS: the query asked for another workspace from this workspace sees nothing, and never another workspace’s rows', async () => {
    expect(await candidates(RUN_1, { workspace: workspaceB })).toEqual([]);
    expect(await candidates(RUN_1, { workspace: workspaceB, asWorkspace: workspaceB })).toEqual(['otherWorkspace']);
  });

  it('keeps the same list while the run stamps what it tries, so continuation indexes still point at the same companies', async () => {
    const before = await candidates(RUN_1);
    // The run tries neverOld (empty page), reads neverNew (marker + stamp) and tries triedLongAgo again.
    await expect(attempt(ids.neverOld, at(RUN_1, 1 * 60 * 60 * 1000), RUN_1)).resolves.toBe(true);
    await inWorkspace(workspaceA, (tx) => tx.$executeRaw`
      UPDATE canonical_company
      SET attributes = jsonb_set(COALESCE(attributes, '{}'::jsonb), '{website_profile}',
        COALESCE(attributes -> 'website_profile', '{}'::jsonb) || jsonb_build_object('_contact_parser', ${COMPANY_CONTACT_PARSER_VERSION}::text))
      WHERE id = ${ids.neverNew}::uuid`);
    await attempt(ids.neverNew, at(RUN_1, 2 * 60 * 60 * 1000), RUN_1);
    await attempt(ids.triedLongAgo, at(RUN_1, 3 * 60 * 60 * 1000), RUN_1);
    // A retried activity tries triedLongAgo once more: `previous` still holds the attempt before the run.
    await attempt(ids.triedLongAgo, at(RUN_1, 4 * 60 * 60 * 1000), RUN_1);

    expect(await stored(ids.neverOld)).toEqual({ at: at(RUN_1, 1 * 60 * 60 * 1000).toISOString(), previous: null });
    expect(await stored(ids.triedLongAgo)).toEqual({
      at: at(RUN_1, 4 * 60 * 60 * 1000).toISOString(),
      previous: at(RUN_1, -30 * DAY).toISOString(),
    });
    expect(await candidates(RUN_1)).toEqual(before);
  });

  it('a later run skips what was tried within 7 days of its creation; a new company queues before every company tried before', async () => {
    await insertCompany(ids.later, workspaceA, names.later, { created: at(RUN_1, 12 * 60 * 60 * 1000) });
    const RUN_2 = at(RUN_1, 1 * DAY);
    // neverOld (failed at RUN_1+1h) and triedLongAgo (RUN_1+4h) are cooling; neverNew was read.
    expect(await candidates(RUN_2)).toEqual(['oldRules', 'later', 'triedTenDays']);
  });

  it('after the cooldown a company that keeps failing comes back, behind the never-tried and the longer-untried', async () => {
    const RUN_3 = at(RUN_1, 8 * DAY);
    // cooling (tried RUN_1−2d) has rested its week too; neverOld and triedLongAgo were tried at RUN_1+1h / +4h.
    expect(await candidates(RUN_3)).toEqual(['oldRules', 'later', 'triedTenDays', 'cooling', 'neverOld', 'triedLongAgo']);
  });
});
