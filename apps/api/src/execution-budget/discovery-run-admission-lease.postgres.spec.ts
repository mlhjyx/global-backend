import { randomBytes, randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../prisma/prisma.service';
import { BudgetExceededError, PostgresBudgetStore } from '../tools/budget-store';
import {
  ExecutionBudgetAuthorityRepository,
  isTrustedExecutionBudgetDatabaseMarker,
  mapExecutionBudgetPersistenceError,
} from './execution-budget-authority.repository';
import { ExecutionBudgetAuthorityService } from './execution-budget-authority.service';
import type { VerifiedExecutionBudgetAuthority } from './execution-budget-authority.types';
import type { ExecutionBudgetBinding } from './execution-budget-binding';
import type { ExecutionBudgetGrantVerifier } from './execution-budget-grant.verifier';
import {
  workspaceExecutionBudgetRequestScope,
  type WorkspaceExecutionBudgetRequest,
} from './execution-budget-request-scope';

const OWNER_DATABASE_URL = process.env.DATABASE_URL?.trim();
const APP_DATABASE_URL = process.env.APP_DATABASE_URL?.trim();
const REQUESTED = process.env.EXECUTION_BUDGET_ADMISSION_LEASE_DATABASE_TEST === '1';

/** Fixtures are written for real, so only an explicitly named *_test database qualifies. */
function isDisposableTestDatabase(url: string | undefined): boolean {
  if (!url) return false;
  try {
    return new URL(url).pathname.replace(/^\//, '').endsWith('_test');
  } catch {
    return false;
  }
}

if (
  REQUESTED &&
  !(isDisposableTestDatabase(OWNER_DATABASE_URL) && isDisposableTestDatabase(APP_DATABASE_URL))
) {
  throw new Error(
    'EXECUTION_BUDGET_ADMISSION_LEASE_DATABASE_TEST needs DATABASE_URL and APP_DATABASE_URL on a database named *_test',
  );
}

/*
 * The admission lease on every workspace authority that has one: discovery runs, 3 hours
 * (20261009170000), and ICP design and ICP query planning, 30 minutes (20261010110000).
 * Every other admission keeps the bare Grant window.
 */
const liveDatabaseIt = REQUESTED ? it : it.skip;
const TIMEOUT = 60_000;
const ISSUER = 'https://control.example.test';
const CAP_MICROUSD = 2_000_000n;
const LEASE_SECONDS = 3 * 60 * 60;
const ICP_LEASE_SECONDS = 30 * 60;
const PAST_GRANT_WINDOW = 10 * 60;
const LEASE_CHECK = 'execution_budget_authority_admission_lease_check';
const ATTEST_MARKERS = [
  'EXECUTION_BUDGET_GRANT_EXPIRED',
  'EXECUTION_BUDGET_GRANT_INVALID',
  'EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH',
  'EXECUTION_BUDGET_AUTHORITY_REVOKED',
  'EXECUTION_BUDGET_AUTHORITY_EXHAUSTED',
  'EXECUTION_BUDGET_AUTHORITY_LIFECYCLE_UNAVAILABLE',
] as const;

const discoveryRun = (): WorkspaceExecutionBudgetRequest => ({
  operation: 'POST /query-plans/:planId/execute',
  planId: randomUUID(),
});

const understandingRun = (): WorkspaceExecutionBudgetRequest => ({
  operation: 'POST /companies',
  body: { website: `https://${randomUUID()}.example.test/` },
});

const discoverContacts = (): WorkspaceExecutionBudgetRequest => ({
  operation: 'POST /canonical-companies/:id/discover-contacts',
  companyId: randomUUID(),
});

/** ICP design and ICP query planning get a 30-minute lease (product owner, 2026-10-10). */
const ICP_OPERATIONS: ReadonlyArray<readonly [string, () => WorkspaceExecutionBudgetRequest]> = [
  ['icp.design', () => ({ operation: 'POST /companies/:companyId/icps', companyId: randomUUID() })],
  ['icp.query_plan', () => ({ operation: 'POST /icps/:icpId/query-plans', icpId: randomUUID() })],
];

/** Every other workspace operation keeps the bare Grant window. */
const OTHER_OPERATIONS: ReadonlyArray<readonly [string, () => WorkspaceExecutionBudgetRequest]> = [
  ['understanding.run', understandingRun],
  ['discovery.run + company (discover-contacts)', discoverContacts],
  [
    'discovery.run + company (guess-emails)',
    () => ({ operation: 'POST /canonical-companies/:id/guess-emails', companyId: randomUUID() }),
  ],
  ['contact.verify', () => ({ operation: 'POST /contact-points/:pointId/verify', pointId: randomUUID() })],
];

/** A historical-shape Platform row; the CHECK must refuse it any lease. */
function platformAuthorityInsert(lease: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`
    INSERT INTO "execution_budget_authority" (
      "scope_key", "authority_kind", "workspace_id", "issuer", "audience", "jti",
      "token_sha256", "schema_version", "purpose", "subject_type", "subject_id",
      "schedule_id", "currency", "unit", "cap_per_run_microusd",
      "campaign_cap_microusd", "max_runs", "runs_consumed", "issued_at",
      "not_before", "expires_at", "consumed_at", "admission_lease_expires_at"
    ) VALUES (
      'platform', 'PLATFORM_GRANT', NULL, ${ISSUER}, 'global-backend:execution-budget',
      ${randomUUID()}::uuid, ${randomBytes(32).toString('hex')}, 'execution-budget-grant/v1',
      'platform.acquisition', 'schedule', 'acq-sweep', 'acq-sweep', 'USD', 'microusd',
      1000, 1000, 1, 1, now() - INTERVAL '5 seconds', now() - INTERVAL '5 seconds',
      now() + INTERVAL '4 minutes', now(), ${lease}
    )`;
}

function grantClaims(
  workspaceId: string,
  request: WorkspaceExecutionBudgetRequest,
  window: { issuedOffset: number; expiresOffset: number } = { issuedOffset: -5, expiresOffset: 240 },
): VerifiedExecutionBudgetAuthority {
  const scope = workspaceExecutionBudgetRequestScope(request);
  const now = Math.floor(Date.now() / 1000);
  return {
    schemaVersion: 'execution-budget-grant/v1',
    authorityKind: 'WORKSPACE_GRANT',
    issuer: ISSUER,
    audience: 'global-backend:execution-budget',
    jti: randomUUID(),
    purpose: scope.purpose,
    workspaceId,
    subjectType: scope.subjectType,
    subjectId: scope.subjectId,
    requestSha256: scope.requestSha256,
    scheduleId: null,
    currency: 'USD',
    unit: 'microusd',
    capMicrousd: CAP_MICROUSD,
    capPerRunMicrousd: null,
    campaignCapMicrousd: null,
    maxRuns: null,
    tokenSha256: randomBytes(32).toString('hex'),
    issuedAt: now + window.issuedOffset,
    notBefore: now + window.issuedOffset,
    expiresAt: now + window.expiresOffset,
  };
}

function singleConnection(url: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set('connection_limit', '1');
  return parsed.href;
}

type AuthorityTimes = {
  lease: Date | null;
  consumed_at: Date;
  expires_at: Date;
  lease_is_admission_plus_three_hours: boolean | null;
  lease_is_admission_plus_thirty_minutes: boolean | null;
};

describe('workspace admission lease on PostgreSQL as the RLS-bound app principal', () => {
  let owner: PrismaClient;
  let app: PrismaService;
  let service: ExecutionBudgetAuthorityService;
  let repository: ExecutionBudgetAuthorityRepository;
  let store: PostgresBudgetStore;
  let timeColumns: string[] = [];

  beforeAll(async () => {
    if (!REQUESTED) return;
    owner = new PrismaClient({ datasourceUrl: OWNER_DATABASE_URL });
    app = new PrismaService();
    const [principal] = await app.$queryRaw<Array<{ session: string; superuser: string; bypass: boolean }>>`
      SELECT session_user::text AS session, current_setting('is_superuser') AS superuser,
             (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypass`;
    if (principal?.session !== 'app_user' || principal.superuser !== 'off' || principal.bypass !== false) {
      throw new Error('APP_DATABASE_URL must log in as app_user, which RLS binds');
    }
    repository = new ExecutionBudgetAuthorityRepository(app);
    // Admission takes claims that were already verified; the verifier is never consulted.
    service = new ExecutionBudgetAuthorityService({} as ExecutionBudgetGrantVerifier, repository);
    store = new PostgresBudgetStore(app);
    timeColumns = (
      await owner.$queryRaw<Array<{ column_name: string }>>`
        SELECT column_name::text AS column_name
          FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'execution_budget_authority'
           AND data_type = 'timestamp with time zone'
         ORDER BY ordinal_position`
    ).map((row) => row.column_name);
  }, TIMEOUT);

  afterAll(async () => {
    await app?.$disconnect();
    await owner?.$disconnect();
  });

  async function seedWorkspace(): Promise<string> {
    const workspaceId = randomUUID();
    await owner.workspace.create({ data: { id: workspaceId, name: 'Admission lease integration' } });
    return workspaceId;
  }

  /** The product admission path: consume the verified Grant and open its account in one transaction. */
  function admitClaims(claims: VerifiedExecutionBudgetAuthority): Promise<ExecutionBudgetBinding> {
    return app.withWorkspace(claims.workspaceId!, (tx) =>
      service.consumeVerifiedWorkspaceGrantInTransaction(claims, tx),
    );
  }

  function admit(workspaceId: string, request: WorkspaceExecutionBudgetRequest): Promise<ExecutionBudgetBinding> {
    return admitClaims(grantClaims(workspaceId, request));
  }

  async function authorityTimes(authorityId: string): Promise<AuthorityTimes> {
    const [row] = await owner.$queryRaw<AuthorityTimes[]>`
      SELECT "admission_lease_expires_at" AS lease, "consumed_at", "expires_at",
             "admission_lease_expires_at" = "consumed_at" + INTERVAL '3 hours'
               AS lease_is_admission_plus_three_hours,
             "admission_lease_expires_at" = "consumed_at" + INTERVAL '30 minutes'
               AS lease_is_admission_plus_thirty_minutes
        FROM "execution_budget_authority"
       WHERE "id" = ${authorityId}::uuid`;
    return row!;
  }

  /** Replays consume directly and commits, which the product path never does. */
  function replayConsume(
    claims: VerifiedExecutionBudgetAuthority,
  ): Promise<Array<{ authority_id: string; replay: boolean }>> {
    return app.withWorkspace(claims.workspaceId!, (tx) =>
      tx.$queryRaw<Array<{ authority_id: string; replay: boolean }>>`
        SELECT * FROM consume_workspace_execution_authority(
          ${claims.issuer}, ${claims.audience}, ${claims.jti}::uuid,
          ${claims.tokenSha256}, ${claims.schemaVersion},
          ${claims.purpose}::"execution_budget_purpose",
          ${claims.workspaceId}::uuid, ${claims.subjectType}, ${claims.subjectId},
          ${claims.requestSha256}, ${claims.currency}, ${claims.unit},
          ${claims.capMicrousd}, ${new Date(claims.issuedAt * 1000)},
          ${new Date(claims.notBefore * 1000)}, ${new Date(claims.expiresAt * 1000)})`,
    );
  }

  /** Writes a lease as the owner; the CHECK is the only thing that can refuse it. */
  function setLease(authorityId: string, expression: Prisma.Sql): Promise<number> {
    return owner.$executeRaw`UPDATE "execution_budget_authority"
       SET "admission_lease_expires_at" = ${expression}
     WHERE "id" = ${authorityId}::uuid`;
  }

  function shiftAssignments(sign: '+' | '-'): string {
    return timeColumns
      .map((column) => `"${column}" = "${column}" ${sign} make_interval(secs => $1::double precision)`)
      .join(', ');
  }

  /** Moves every timestamp on the authority row back together, as if the clock moved forward. */
  async function age(authorityId: string, seconds: number): Promise<void> {
    const updated = await owner.$executeRawUnsafe(
      `UPDATE "execution_budget_authority" SET ${shiftAssignments('-')} WHERE "id" = $2::uuid`,
      seconds,
      authorityId,
    );
    expect(updated).toBe(1);
  }

  function markerOf(error: unknown): string {
    const marker = ATTEST_MARKERS.find((candidate) =>
      isTrustedExecutionBudgetDatabaseMarker(error, candidate),
    );
    if (!marker) throw error;
    return marker;
  }

  /** Runs attest as app_user and names the database marker it raised, or ACTIVE. */
  async function attestOutcome(binding: ExecutionBudgetBinding, scopeKey = binding.scopeKey): Promise<string> {
    return app
      .withWorkspace(scopeKey, (tx) =>
        tx.$queryRaw`SELECT * FROM attest_authorized_tool_budget_v1(
          ${scopeKey}, ${binding.authorityId}::uuid, ${binding.accountKey})`,
      )
      .then(
        () => 'ACTIVE',
        (error: unknown) => markerOf(error),
      );
  }

  async function errorOf(promise: Promise<unknown>): Promise<unknown> {
    return promise.then(
      () => {
        throw new Error('expected the database to refuse');
      },
      (error: unknown) => error,
    );
  }

  async function expectLeaseCheckViolation(write: Promise<unknown>): Promise<void> {
    const error = await errorOf(write);
    expect(error).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect(String((error as Error).message)).toContain(LEASE_CHECK);
  }

  liveDatabaseIt(
    'stamps a lease of exactly admission + 3 hours on discovery runs and none on the operations without one',
    async () => {
      const workspaceId = await seedWorkspace();
      const claims = grantClaims(workspaceId, discoveryRun());
      const binding = await admitClaims(claims);
      const times = await authorityTimes(binding.authorityId);

      expect(binding).toMatchObject({ purpose: 'discovery.run', subjectType: 'discovery_run', replay: false });
      expect(times.lease).toBeInstanceOf(Date);
      expect(times.lease_is_admission_plus_three_hours).toBe(true);
      expect(times.lease!.getTime() - times.consumed_at.getTime()).toBe(LEASE_SECONDS * 1000);
      expect(times.lease!.getTime()).toBeGreaterThan(times.expires_at.getTime());

      // The product refuses a replayed Grant (and rolls its transaction back) ...
      await expect(admitClaims(claims)).rejects.toMatchObject({ code: 'EXECUTION_BUDGET_GRANT_REUSED' });
      // ... so replay consume directly and commit: the replay branch returns the stored
      // row and never rewrites the lease.
      await expect(replayConsume(claims)).resolves.toEqual([
        { authority_id: binding.authorityId, replay: true },
      ]);
      await expect(authorityTimes(binding.authorityId)).resolves.toEqual(times);

      for (const [name, request] of OTHER_OPERATIONS) {
        const other = await admit(workspaceId, request());
        expect((await authorityTimes(other.authorityId)).lease, name).toBeNull();
      }
    },
    TIMEOUT,
  );

  liveDatabaseIt(
    'keeps a discovery run spendable ten minutes after admission, past its Grant window',
    async () => {
      const workspaceId = await seedWorkspace();
      const binding = await admit(workspaceId, discoveryRun());
      await age(binding.authorityId, PAST_GRANT_WINDOW);

      await expect(
        store.attestAuthorized({
          authorityId: binding.authorityId,
          scopeKey: binding.scopeKey,
          accountKey: binding.accountKey,
        }),
      ).resolves.toMatchObject({ authorityId: binding.authorityId });
      const reservation = await store.reserve({
        workspaceId,
        accountKey: binding.accountKey,
        operationKey: `lease-op-${randomUUID()}`,
        estimatedMicrousd: 0n,
      });
      expect(reservation).toMatchObject({ replay: false, estimatedMicrousd: 0n });
      await expect(store.release(reservation)).resolves.toMatchObject({ chargedMicrousd: 0n, replay: false });
    },
    TIMEOUT,
  );

  liveDatabaseIt(
    'keeps every workspace authority without a lease on its Grant window',
    async () => {
      const workspaceId = await seedWorkspace();
      for (const [name, request] of OTHER_OPERATIONS) {
        const binding = await admit(workspaceId, request());
        expect(await attestOutcome(binding), name).toBe('ACTIVE');

        await age(binding.authorityId, PAST_GRANT_WINDOW);
        expect(await attestOutcome(binding), name).toBe('EXECUTION_BUDGET_GRANT_EXPIRED');
      }
    },
    TIMEOUT,
  );

  liveDatabaseIt(
    'ends the lease after 3 hours with the same 60-second tolerance and the same error',
    async () => {
      const workspaceId = await seedWorkspace();
      const binding = await admit(workspaceId, discoveryRun());

      await age(binding.authorityId, LEASE_SECONDS + 30);
      expect(await attestOutcome(binding)).toBe('ACTIVE');

      await age(binding.authorityId, 90);
      expect(await attestOutcome(binding)).toBe('EXECUTION_BUDGET_GRANT_EXPIRED');
      await expect(
        store.attestAuthorized({
          authorityId: binding.authorityId,
          scopeKey: binding.scopeKey,
          accountKey: binding.accountKey,
        }),
      ).rejects.toMatchObject({ name: 'ExecutionBudgetGrantError', code: 'EXECUTION_BUDGET_GRANT_EXPIRED' });
      const reserveError = await errorOf(
        store.reserve({
          workspaceId,
          accountKey: binding.accountKey,
          operationKey: `lease-op-${randomUUID()}`,
          estimatedMicrousd: 0n,
        }),
      );
      expect(isTrustedExecutionBudgetDatabaseMarker(reserveError, 'EXECUTION_BUDGET_GRANT_EXPIRED')).toBe(true);
      expect(mapExecutionBudgetPersistenceError(reserveError)).toMatchObject({
        code: 'EXECUTION_BUDGET_GRANT_EXPIRED',
      });
    },
    TIMEOUT,
  );

  liveDatabaseIt(
    'still stops a run inside the lease on revocation, exhaustion, another workspace and a closed account',
    async () => {
      const workspaceId = await seedWorkspace();
      const otherWorkspaceId = await seedWorkspace();
      const [revoked, exhausted, foreign, closed] = await Promise.all(
        [1, 2, 3, 4].map(async () => {
          const binding = await admit(workspaceId, discoveryRun());
          await age(binding.authorityId, PAST_GRANT_WINDOW);
          expect(await attestOutcome(binding)).toBe('ACTIVE');
          return binding;
        }),
      );

      await repository.revoke({ scopeKey: workspaceId, authorityId: revoked!.authorityId, reason: 'operator stop' });
      expect(await attestOutcome(revoked!)).toBe('EXECUTION_BUDGET_AUTHORITY_REVOKED');

      await expect(
        store.reserve({
          workspaceId,
          accountKey: exhausted!.accountKey,
          operationKey: `lease-op-${randomUUID()}`,
          estimatedMicrousd: CAP_MICROUSD + 1n,
        }),
      ).rejects.toBeInstanceOf(BudgetExceededError);
      expect(await attestOutcome(exhausted!)).toBe('EXECUTION_BUDGET_AUTHORITY_EXHAUSTED');

      expect(await attestOutcome(foreign!, otherWorkspaceId)).toBe('EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH');

      await store.close({ workspaceId, accountKey: closed!.accountKey });
      expect(await attestOutcome(closed!)).toBe('EXECUTION_BUDGET_AUTHORITY_LIFECYCLE_UNAVAILABLE');
    },
    TIMEOUT,
  );

  liveDatabaseIt(
    'still admits and opens only inside the Grant window',
    async () => {
      const workspaceId = await seedWorkspace();
      const expired = grantClaims(workspaceId, discoveryRun(), { issuedOffset: -400, expiresOffset: -100 });
      await expect(admitClaims(expired)).rejects.toMatchObject({ code: 'EXECUTION_BUDGET_GRANT_EXPIRED' });
      const [{ rows }] = await owner.$queryRaw<Array<{ rows: number }>>`
        SELECT count(*)::int AS rows FROM "execution_budget_authority" WHERE "jti" = ${expired.jti}::uuid`;
      expect(rows).toBe(0);

      const binding = await admit(workspaceId, discoveryRun());
      await age(binding.authorityId, PAST_GRANT_WINDOW);
      expect(await attestOutcome(binding)).toBe('ACTIVE');
      await expect(
        store.open({
          authorityId: binding.authorityId,
          scopeKey: binding.scopeKey,
          accountKey: binding.accountKey,
        }),
      ).rejects.toMatchObject({ code: 'EXECUTION_BUDGET_GRANT_EXPIRED' });
    },
    TIMEOUT,
  );

  liveDatabaseIt(
    'refuses a lease on any other authority, beyond 3 hours, or not after the Grant window',
    async () => {
      const workspaceId = await seedWorkspace();
      const run = await admit(workspaceId, discoveryRun());
      const [understanding, contacts] = await Promise.all([
        admit(workspaceId, understandingRun()),
        admit(workspaceId, discoverContacts()),
      ]);

      await expectLeaseCheckViolation(
        setLease(understanding.authorityId, Prisma.sql`"consumed_at" + INTERVAL '1 hour'`),
      );
      await expectLeaseCheckViolation(setLease(contacts.authorityId, Prisma.sql`"consumed_at" + INTERVAL '1 hour'`));
      await expectLeaseCheckViolation(
        setLease(run.authorityId, Prisma.sql`"consumed_at" + INTERVAL '3 hours 0.001 seconds'`),
      );
      await expectLeaseCheckViolation(setLease(run.authorityId, Prisma.sql`"expires_at"`));
      await expect(setLease(run.authorityId, Prisma.sql`"consumed_at" + INTERVAL '1 hour'`)).resolves.toBe(1);
      await expect(setLease(run.authorityId, Prisma.sql`NULL`)).resolves.toBe(1);

      await expectLeaseCheckViolation(
        owner.$executeRaw(platformAuthorityInsert(Prisma.sql`now() + INTERVAL '1 hour'`)),
      );
      // Control: the same Platform row without a lease is valid; roll it back.
      const rollback = new Error('rollback the control Platform row');
      await expect(
        owner.$transaction(async (tx) => {
          await expect(tx.$executeRaw(platformAuthorityInsert(Prisma.sql`NULL`))).resolves.toBe(1);
          throw rollback;
        }),
      ).rejects.toBe(rollback);
    },
    TIMEOUT,
  );

  liveDatabaseIt(
    'judges a discovery run without a lease by its Grant window, as before the migration',
    async () => {
      const workspaceId = await seedWorkspace();
      const binding = await admit(workspaceId, discoveryRun());
      await owner.$executeRaw`UPDATE "execution_budget_authority"
        SET "admission_lease_expires_at" = NULL WHERE "id" = ${binding.authorityId}::uuid`;

      expect(await attestOutcome(binding)).toBe('ACTIVE');
      await age(binding.authorityId, PAST_GRANT_WINDOW);
      expect(await attestOutcome(binding)).toBe('EXECUTION_BUDGET_GRANT_EXPIRED');
    },
    TIMEOUT,
  );

  liveDatabaseIt(
    'stamps a lease of exactly admission + 30 minutes on ICP design and ICP query planning',
    async () => {
      const workspaceId = await seedWorkspace();
      for (const [name, request] of ICP_OPERATIONS) {
        const claims = grantClaims(workspaceId, request());
        const binding = await admitClaims(claims);
        const times = await authorityTimes(binding.authorityId);

        expect(binding.purpose, name).toBe(name);
        expect(times.lease, name).toBeInstanceOf(Date);
        expect(times.lease_is_admission_plus_thirty_minutes, name).toBe(true);
        expect(times.lease!.getTime() - times.consumed_at.getTime(), name).toBe(ICP_LEASE_SECONDS * 1000);
        expect(times.lease!.getTime(), name).toBeGreaterThan(times.expires_at.getTime());

        await expect(admitClaims(claims), name).rejects.toMatchObject({ code: 'EXECUTION_BUDGET_GRANT_REUSED' });
        await expect(replayConsume(claims), name).resolves.toEqual([
          { authority_id: binding.authorityId, replay: true },
        ]);
        await expect(authorityTimes(binding.authorityId), name).resolves.toEqual(times);
      }
    },
    TIMEOUT,
  );

  liveDatabaseIt(
    'keeps ICP design and ICP query planning spendable past their Grant window, inside the lease',
    async () => {
      const workspaceId = await seedWorkspace();
      for (const [name, request] of ICP_OPERATIONS) {
        const binding = await admit(workspaceId, request());
        // 2026-10-10: a query plan's reservation was refused about 6 minutes after admission.
        await age(binding.authorityId, PAST_GRANT_WINDOW);

        await expect(
          store.attestAuthorized({
            authorityId: binding.authorityId,
            scopeKey: binding.scopeKey,
            accountKey: binding.accountKey,
          }),
          name,
        ).resolves.toMatchObject({ authorityId: binding.authorityId });
        const reservation = await store.reserve({
          workspaceId,
          accountKey: binding.accountKey,
          operationKey: `lease-op-${randomUUID()}`,
          estimatedMicrousd: 0n,
        });
        expect(reservation, name).toMatchObject({ replay: false, estimatedMicrousd: 0n });
        await expect(store.release(reservation), name).resolves.toMatchObject({ chargedMicrousd: 0n, replay: false });
      }
    },
    TIMEOUT,
  );

  liveDatabaseIt(
    'ends the ICP lease after 30 minutes with the same 60-second tolerance and the same error',
    async () => {
      const workspaceId = await seedWorkspace();
      for (const [name, request] of ICP_OPERATIONS) {
        const binding = await admit(workspaceId, request());

        await age(binding.authorityId, ICP_LEASE_SECONDS + 30);
        expect(await attestOutcome(binding), name).toBe('ACTIVE');

        await age(binding.authorityId, 90);
        expect(await attestOutcome(binding), name).toBe('EXECUTION_BUDGET_GRANT_EXPIRED');
        await expect(
          store.attestAuthorized({
            authorityId: binding.authorityId,
            scopeKey: binding.scopeKey,
            accountKey: binding.accountKey,
          }),
          name,
        ).rejects.toMatchObject({ name: 'ExecutionBudgetGrantError', code: 'EXECUTION_BUDGET_GRANT_EXPIRED' });
        const reserveError = await errorOf(
          store.reserve({
            workspaceId,
            accountKey: binding.accountKey,
            operationKey: `lease-op-${randomUUID()}`,
            estimatedMicrousd: 0n,
          }),
        );
        expect(isTrustedExecutionBudgetDatabaseMarker(reserveError, 'EXECUTION_BUDGET_GRANT_EXPIRED'), name).toBe(
          true,
        );
        expect(mapExecutionBudgetPersistenceError(reserveError), name).toMatchObject({
          code: 'EXECUTION_BUDGET_GRANT_EXPIRED',
        });
      }
    },
    TIMEOUT,
  );

  liveDatabaseIt(
    'still stops an ICP request inside the lease on revocation, exhaustion, another workspace and a closed account',
    async () => {
      const workspaceId = await seedWorkspace();
      const otherWorkspaceId = await seedWorkspace();
      const [revoked, exhausted, foreign, closed] = await Promise.all(
        [0, 1, 2, 3].map(async (index) => {
          const [, request] = ICP_OPERATIONS[index % ICP_OPERATIONS.length]!;
          const binding = await admit(workspaceId, request());
          await age(binding.authorityId, PAST_GRANT_WINDOW);
          expect(await attestOutcome(binding)).toBe('ACTIVE');
          return binding;
        }),
      );

      await repository.revoke({ scopeKey: workspaceId, authorityId: revoked!.authorityId, reason: 'operator stop' });
      expect(await attestOutcome(revoked!)).toBe('EXECUTION_BUDGET_AUTHORITY_REVOKED');

      await expect(
        store.reserve({
          workspaceId,
          accountKey: exhausted!.accountKey,
          operationKey: `lease-op-${randomUUID()}`,
          estimatedMicrousd: CAP_MICROUSD + 1n,
        }),
      ).rejects.toBeInstanceOf(BudgetExceededError);
      expect(await attestOutcome(exhausted!)).toBe('EXECUTION_BUDGET_AUTHORITY_EXHAUSTED');

      expect(await attestOutcome(foreign!, otherWorkspaceId)).toBe('EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH');

      await store.close({ workspaceId, accountKey: closed!.accountKey });
      expect(await attestOutcome(closed!)).toBe('EXECUTION_BUDGET_AUTHORITY_LIFECYCLE_UNAVAILABLE');
    },
    TIMEOUT,
  );

  liveDatabaseIt(
    'still admits and opens ICP requests only inside the Grant window',
    async () => {
      const workspaceId = await seedWorkspace();
      for (const [name, request] of ICP_OPERATIONS) {
        const expired = grantClaims(workspaceId, request(), { issuedOffset: -400, expiresOffset: -100 });
        await expect(admitClaims(expired), name).rejects.toMatchObject({ code: 'EXECUTION_BUDGET_GRANT_EXPIRED' });
        const [{ rows }] = await owner.$queryRaw<Array<{ rows: number }>>`
          SELECT count(*)::int AS rows FROM "execution_budget_authority" WHERE "jti" = ${expired.jti}::uuid`;
        expect(rows, name).toBe(0);

        const binding = await admit(workspaceId, request());
        await age(binding.authorityId, PAST_GRANT_WINDOW);
        expect(await attestOutcome(binding), name).toBe('ACTIVE');
        await expect(
          store.open({
            authorityId: binding.authorityId,
            scopeKey: binding.scopeKey,
            accountKey: binding.accountKey,
          }),
          name,
        ).rejects.toMatchObject({ code: 'EXECUTION_BUDGET_GRANT_EXPIRED' });
      }
    },
    TIMEOUT,
  );

  liveDatabaseIt(
    'caps an ICP lease at 30 minutes, keeps the discovery cap at 3 hours and refuses any other lease',
    async () => {
      const workspaceId = await seedWorkspace();
      for (const [name, request] of ICP_OPERATIONS) {
        const { authorityId } = await admit(workspaceId, request());
        await expectLeaseCheckViolation(
          setLease(authorityId, Prisma.sql`"consumed_at" + INTERVAL '30 minutes 0.001 seconds'`),
        );
        // Within the discovery cap, but not this pair's.
        await expectLeaseCheckViolation(setLease(authorityId, Prisma.sql`"consumed_at" + INTERVAL '1 hour'`));
        await expectLeaseCheckViolation(setLease(authorityId, Prisma.sql`"expires_at"`));
        await expect(setLease(authorityId, Prisma.sql`"consumed_at" + INTERVAL '10 minutes'`), name).resolves.toBe(1);
        await expect(setLease(authorityId, Prisma.sql`"consumed_at" + INTERVAL '30 minutes'`), name).resolves.toBe(1);
        await expect(setLease(authorityId, Prisma.sql`NULL`), name).resolves.toBe(1);
      }

      const run = await admit(workspaceId, discoveryRun());
      await expect(setLease(run.authorityId, Prisma.sql`"consumed_at" + INTERVAL '3 hours'`)).resolves.toBe(1);
      await expectLeaseCheckViolation(
        setLease(run.authorityId, Prisma.sql`"consumed_at" + INTERVAL '3 hours 0.001 seconds'`),
      );

      // A lease short enough for any pair is still refused where no lease belongs.
      for (const [, request] of OTHER_OPERATIONS) {
        const { authorityId } = await admit(workspaceId, request());
        await expectLeaseCheckViolation(setLease(authorityId, Prisma.sql`"consumed_at" + INTERVAL '10 minutes'`));
      }
      await expectLeaseCheckViolation(
        owner.$executeRaw(platformAuthorityInsert(Prisma.sql`now() + INTERVAL '10 minutes'`)),
      );
    },
    TIMEOUT,
  );

  liveDatabaseIt(
    'judges ICP requests without a lease by their Grant window, as before the migration',
    async () => {
      const workspaceId = await seedWorkspace();
      for (const [name, request] of ICP_OPERATIONS) {
        const binding = await admit(workspaceId, request());
        await setLease(binding.authorityId, Prisma.sql`NULL`);

        expect(await attestOutcome(binding), name).toBe('ACTIVE');
        await age(binding.authorityId, PAST_GRANT_WINDOW);
        expect(await attestOutcome(binding), name).toBe('EXECUTION_BUDGET_GRANT_EXPIRED');
      }
    },
    TIMEOUT,
  );

  liveDatabaseIt(
    'keeps both functions SECURITY DEFINER with their volatility, owner and EXECUTE grants',
    async () => {
      const functions = await owner.$queryRaw<
        Array<{
          name: string;
          language: string;
          definer: boolean;
          volatility: string;
          config: string[] | null;
          owned_by_table_owner: boolean;
          app_user: boolean;
          platform_writer: boolean;
          public: boolean;
        }>
      >`
        SELECT p.proname::text AS name, l.lanname::text AS language, p.prosecdef AS definer,
               p.provolatile::text AS volatility, p.proconfig AS config,
               p.proowner = c.relowner AS owned_by_table_owner,
               has_function_privilege('app_user', p.oid, 'EXECUTE') AS app_user,
               has_function_privilege('execution_budget_platform_writer', p.oid, 'EXECUTE')
                 AS platform_writer,
               has_function_privilege('public', p.oid, 'EXECUTE') AS public
          FROM pg_proc p
          JOIN pg_language l ON l.oid = p.prolang
          JOIN pg_namespace n ON n.oid = p.pronamespace
          JOIN pg_class c ON c.relname = 'execution_budget_authority' AND c.relnamespace = n.oid
         WHERE n.nspname = 'public'
           AND p.proname IN ('consume_workspace_execution_authority', 'attest_authorized_tool_budget_v1')
         ORDER BY p.proname`;

      const pinned = ['search_path=pg_catalog, public, pg_temp'];
      expect(functions).toEqual([
        {
          name: 'attest_authorized_tool_budget_v1',
          language: 'plpgsql',
          definer: true,
          volatility: 's',
          config: pinned,
          owned_by_table_owner: true,
          app_user: true,
          platform_writer: true,
          public: false,
        },
        {
          name: 'consume_workspace_execution_authority',
          language: 'plpgsql',
          definer: true,
          volatility: 'v',
          config: pinned,
          owned_by_table_owner: true,
          app_user: true,
          platform_writer: false,
          public: false,
        },
      ]);
    },
    TIMEOUT,
  );

  liveDatabaseIt(
    'reads the authority from public even when app_user shadows it with a temporary table',
    async () => {
      const workspaceId = await seedWorkspace();
      const binding = await admit(workspaceId, discoveryRun());
      await age(binding.authorityId, LEASE_SECONDS + 120);
      expect(await attestOutcome(binding)).toBe('EXECUTION_BUDGET_GRANT_EXPIRED');

      // A new single-connection session, so attest is first compiled after the shadow exists.
      const session = new PrismaClient({ datasourceUrl: singleConnection(APP_DATABASE_URL!) });
      try {
        const outcome = await session
          .$transaction(async (tx) => {
            await tx.$executeRaw`SELECT set_config('app.current_workspace_id', ${workspaceId}, true)`;
            await tx.$executeRawUnsafe(
              'CREATE TEMPORARY TABLE "execution_budget_authority" ON COMMIT DROP AS ' +
                'SELECT * FROM public."execution_budget_authority" WITH NO DATA',
            );
            await tx.$executeRaw`INSERT INTO pg_temp."execution_budget_authority"
              SELECT * FROM public."execution_budget_authority" WHERE "id" = ${binding.authorityId}::uuid`;
            // The forged copy is the row as it looked at admission: inside its Grant window.
            await tx.$executeRawUnsafe(
              `UPDATE pg_temp."execution_budget_authority" SET ${shiftAssignments('+')}`,
              LEASE_SECONDS + 120,
            );
            await tx.$queryRaw`SELECT * FROM attest_authorized_tool_budget_v1(
              ${workspaceId}, ${binding.authorityId}::uuid, ${binding.accountKey})`;
          })
          .then(
            () => 'ACTIVE',
            (error: unknown) => markerOf(error),
          );
        expect(outcome).toBe('EXECUTION_BUDGET_GRANT_EXPIRED');
      } finally {
        await session.$disconnect();
      }
    },
    TIMEOUT,
  );
});
