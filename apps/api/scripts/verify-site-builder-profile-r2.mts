/**
 * R2-A3 Profile correctness against the real Ubuntu development PostgreSQL.
 * Proves app_user/FORCE RLS, UUID token, deterministic two-connection CAS,
 * stable 409/412 semantics, cross-workspace non-disclosure, and retry merge.
 *
 * Run from apps/api:
 *   ALLOW_DEV_DB_VERIFIER=true DOTENV_CONFIG_PATH=/global/backend/apps/api/.env \
 *     node --import tsx scripts/verify-site-builder-profile-r2.mts
 */
import 'dotenv/config';
import { HttpException, NotFoundException } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { ProfilePrecondition } from '../src/site-builder/profile-contract';
import { SitesService } from '../src/site-builder/sites.service';

function isLoopback(hostname: string): boolean {
  return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(
    hostname.toLowerCase(),
  );
}

function requireDevelopmentDatabase(): void {
  if (
    process.env.ALLOW_DEV_DB_VERIFIER !== 'true' ||
    process.env.NODE_ENV === 'production'
  ) {
    throw new Error(
      'refusing Profile verifier: require ALLOW_DEV_DB_VERIFIER=true and non-production NODE_ENV',
    );
  }
  for (const [name, raw] of [
    ['DATABASE_URL', process.env.DATABASE_URL],
    ['APP_DATABASE_URL', process.env.APP_DATABASE_URL],
  ] as const) {
    if (!raw) throw new Error(`${name} is required`);
    const target = new URL(raw);
    if (!isLoopback(target.hostname) || target.pathname !== '/global_dev') {
      throw new Error(
        `refusing ${name} target ${target.hostname}${target.pathname}; require loopback/global_dev`,
      );
    }
  }
}

function ok(message: string): void {
  console.log(`  ✅ ${message}`);
}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`assertion failed: ${message}`);
  ok(message);
}

function context(workspaceId: string) {
  return { userId: 'verify-profile-r2', workspaceId, roles: [] };
}

function errorCode(error: unknown): string | undefined {
  if (!(error instanceof HttpException)) return undefined;
  const response = error.getResponse();
  if (!response || typeof response !== 'object') return undefined;
  return (response as { error?: { code?: string } }).error?.code;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  return { promise: new Promise<void>((done) => (resolve = done)), resolve };
}

function barrierPrisma(
  base: PrismaService,
  gate: {
    readers: number;
    ready: ReturnType<typeof deferred>;
    release: ReturnType<typeof deferred>;
  },
): PrismaService {
  return {
    withWorkspace: <T,>(
      workspaceId: string,
      fn: (tx: Prisma.TransactionClient) => Promise<T>,
    ): Promise<T> =>
      base.withWorkspace(workspaceId, (tx) =>
        fn({
          site: {
            findUnique: tx.site.findUnique.bind(tx.site),
            updateMany: async (
              args: Parameters<typeof tx.site.updateMany>[0],
            ) => {
              gate.readers += 1;
              if (gate.readers === 2) gate.ready.resolve();
              await gate.release.promise;
              return tx.site.updateMany(args);
            },
          },
          asset: { findMany: tx.asset.findMany.bind(tx.asset) },
        } as unknown as Prisma.TransactionClient),
      ),
  } as PrismaService;
}

async function waitForBarrier(promise: Promise<void>): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('production CAS barrier timed out')),
          5_000,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function main(): Promise<void> {
  requireDevelopmentDatabase();
  const owner = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
  const appA = new PrismaService();
  const appB = new PrismaService();
  const service = new SitesService(appA);
  const wsA = randomUUID();
  const wsB = randomUUID();
  const siteA = randomUUID();
  const siteB = randomUUID();
  let verificationError: unknown;

  try {
    await Promise.all([owner.$connect(), appA.$connect(), appB.$connect()]);
    const role = await appA.$queryRaw<
      { currentUser: string; isSuper: boolean; bypassRls: boolean }[]
    >`
      SELECT current_user AS "currentUser",
             r.rolsuper AS "isSuper",
             r.rolbypassrls AS "bypassRls"
        FROM pg_roles r
       WHERE r.rolname = current_user`;
    check(
      role[0]?.isSuper === false && role[0]?.bypassRls === false,
      `${role[0]?.currentUser} is non-superuser/non-BYPASSRLS`,
    );

    const relation = await owner.$queryRaw<
      {
        rowSecurity: boolean;
        forceRowSecurity: boolean;
        dataType: string;
        nullable: boolean;
        defaultExpr: string | null;
      }[]
    >`
      SELECT c.relrowsecurity AS "rowSecurity",
             c.relforcerowsecurity AS "forceRowSecurity",
             format_type(a.atttypid, a.atttypmod) AS "dataType",
             NOT a.attnotnull AS nullable,
             pg_get_expr(d.adbin, d.adrelid) AS "defaultExpr"
        FROM pg_class c
        JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'profile_version_id'
        LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
       WHERE c.oid = 'site'::regclass`;
    check(
      relation[0]?.rowSecurity && relation[0]?.forceRowSecurity,
      'Site remains ENABLE + FORCE RLS',
    );
    check(
      relation[0]?.dataType === 'uuid' && relation[0]?.nullable === false,
      'profile_version_id is UUID NOT NULL',
    );
    check(
      relation[0]?.defaultExpr?.includes('gen_random_uuid') === true,
      'profile_version_id has DB UUID default',
    );

    await owner.workspace.createMany({
      data: [
        { id: wsA, name: 'R2-A3 Profile verify A' },
        { id: wsB, name: 'R2-A3 Profile verify B' },
      ],
    });
    await appA.withWorkspace(wsA, (tx) =>
      tx.site.create({
        data: {
          id: siteA,
          workspaceId: wsA,
          name: 'Profile Verify A',
          slug: `profile-a-${randomUUID()}`,
          intake: {},
          profile: { brand: { slogan: 'initial' } },
        },
      }),
    );
    await appA.withWorkspace(wsB, (tx) =>
      tx.site.create({
        data: {
          id: siteB,
          workspaceId: wsB,
          name: 'Profile Verify B',
          slug: `profile-b-${randomUUID()}`,
          intake: {},
        },
      }),
    );

    const initial = await service.getProfile(context(wsA), siteA);
    check(
      typeof initial.versionId === 'string' && initial.versionId.length === 36,
      'GET exposes an opaque UUID version token',
    );
    await service.getProfile(context(wsB), siteA).then(
      () => {
        throw new Error('cross-workspace GET unexpectedly succeeded');
      },
      (error: unknown) =>
        check(
          error instanceof NotFoundException,
          'cross-workspace GET is indistinguishable 404',
        ),
    );

    const gate = { readers: 0, ready: deferred(), release: deferred() };
    const serviceA = new SitesService(barrierPrisma(appA, gate));
    const serviceB = new SitesService(barrierPrisma(appB, gate));
    const patches = [
      { brand: { slogan: 'winner brand' } },
      { contact: { publicEmails: ['winner@example.com'] } },
    ];
    const contenders = [
      serviceA.patchProfile(context(wsA), siteA, patches[0], {
        expectedVersionId: initial.versionId,
        source: 'if-match',
      }),
      serviceB.patchProfile(context(wsA), siteA, patches[1], {
        expectedVersionId: initial.versionId,
        source: 'if-match',
      }),
    ];
    await waitForBarrier(gate.ready.promise);
    gate.release.resolve();
    const results = await Promise.allSettled(contenders);
    const winnerIndex = results.findIndex(
      (result) => result.status === 'fulfilled',
    );
    const loserIndex = results.findIndex(
      (result) => result.status === 'rejected',
    );
    check(
      winnerIndex >= 0 && loserIndex >= 0 && results.length === 2,
      'production SitesService on two connections produces exactly one CAS winner',
    );
    check(
      gate.readers === 2,
      'barrier forced both production Service calls through the same-base CAS point',
    );
    const loserError = (results[loserIndex] as PromiseRejectedResult).reason;
    check(
      loserError instanceof HttpException && loserError.getStatus() === 412,
      'same-base production Service loser returns If-Match 412',
    );

    const afterRace = await service.getProfile(context(wsA), siteA);
    const winner = results[winnerIndex] as PromiseFulfilledResult<{
      versionId: string;
    }>;
    check(
      afterRace.versionId === winner.value.versionId,
      'winner profile and next token committed atomically',
    );
    const staleBody: ProfilePrecondition = {
      expectedVersionId: initial.versionId,
      source: 'baseVersionId',
    };
    const staleHeader: ProfilePrecondition = {
      expectedVersionId: initial.versionId,
      source: 'if-match',
    };
    const bodyError = await service
      .patchProfile(
        context(wsA),
        siteA,
        { companyProfile: { city: 'Berlin' } },
        staleBody,
      )
      .catch((error: unknown) => error);
    const headerError = await service
      .patchProfile(
        context(wsA),
        siteA,
        { companyProfile: { city: 'Berlin' } },
        staleHeader,
      )
      .catch((error: unknown) => error);
    check(
      bodyError instanceof HttpException &&
        bodyError.getStatus() === 409 &&
        errorCode(bodyError) === 'SPEC_VERSION_CONFLICT',
      'stale body token returns stable 409 conflict',
    );
    check(
      headerError instanceof HttpException &&
        headerError.getStatus() === 412 &&
        errorCode(headerError) === 'SPEC_VERSION_CONFLICT',
      'stale If-Match token returns stable 412 conflict',
    );

    const retryPatch = patches[loserIndex];
    const retried = await service.patchProfile(
      context(wsA),
      siteA,
      retryPatch,
      { expectedVersionId: afterRace.versionId, source: 'baseVersionId' },
    );
    check(
      'brand' in retried && 'contact' in retried,
      'loser re-GET/retry preserves both independently edited groups',
    );

    const crossWrite = await service
      .patchProfile(
        context(wsB),
        siteA,
        { brand: { slogan: 'leak' } },
        { expectedVersionId: retried.versionId, source: 'baseVersionId' },
      )
      .catch((error: unknown) => error);
    check(
      crossWrite instanceof NotFoundException,
      'cross-workspace PATCH returns 404 without current token disclosure',
    );
    const untouchedB = await service.getProfile(context(wsB), siteB);
    check(
      Object.keys(untouchedB).length === 1,
      'other workspace Site remained unchanged',
    );
  } catch (error) {
    verificationError = error;
  } finally {
    const cleanupErrors: unknown[] = [];
    try {
      await owner.site.deleteMany({ where: { id: { in: [siteA, siteB] } } });
      await owner.workspace.deleteMany({ where: { id: { in: [wsA, wsB] } } });
      const [workspaceResidues, siteResidues] = await Promise.all([
        owner.workspace.count({ where: { id: { in: [wsA, wsB] } } }),
        owner.site.count({ where: { id: { in: [siteA, siteB] } } }),
      ]);
      if (workspaceResidues !== 0 || siteResidues !== 0) {
        throw new Error(
          `fixture residue: workspaces=${workspaceResidues}, sites=${siteResidues}`,
        );
      }
      ok('verification fixtures removed');
    } catch (error) {
      cleanupErrors.push(error);
    }
    await Promise.allSettled([
      owner.$disconnect(),
      appA.$disconnect(),
      appB.$disconnect(),
    ]);
    if (verificationError && cleanupErrors.length) {
      throw new AggregateError(
        [verificationError, ...cleanupErrors],
        'Profile verification and cleanup failed',
      );
    }
    if (verificationError) throw verificationError;
    if (cleanupErrors.length)
      throw new AggregateError(
        cleanupErrors,
        'Profile verifier cleanup failed',
      );
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
