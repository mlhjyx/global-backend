import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../src/prisma/prisma.service";
import { createDiscoveryActivities } from "../src/temporal/discovery.activities";

export const SINGLE_REPLAY_FLAG = "--verify-single-retained-acquisition-replay";
export const SINGLE_REPLAY_OUTPUT_MODE = "STDOUT_ONLY";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const PROVIDER_KEY = /^[a-z][a-z0-9_]{0,127}$/u;

type ConnectionIdentity = {
  databaseName: string;
  currentUser: string;
  superuser: boolean;
  bypassRls: boolean;
};

type CountSnapshot = {
  canonicalCompanies: number;
  leads: number;
  fieldEvidence: number;
  authorityIdentifiers: number;
  identityLinks: number;
  outboxEvents: number;
};

export function parseSingleReplayInput(
  argv: readonly string[],
  env: Record<string, string | undefined>,
) {
  if (argv.length !== 1 || argv[0] !== SINGLE_REPLAY_FLAG)
    throw new Error("SINGLE_REPLAY_EXPLICIT_FLAG_REQUIRED");
  const databaseUrl = env.APP_DATABASE_URL;
  if (!databaseUrl) throw new Error("SINGLE_REPLAY_APP_DATABASE_URL_REQUIRED");
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error("SINGLE_REPLAY_DATABASE_URL_INVALID");
  }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol))
    throw new Error("SINGLE_REPLAY_DATABASE_PROTOCOL_INVALID");
  const hostname = parsed.hostname.toLocaleLowerCase("en-US");
  if (!new Set(["127.0.0.1", "localhost", "[::1]", "::1"]).has(hostname))
    throw new Error("SINGLE_REPLAY_DATABASE_NOT_LOOPBACK");
  const databaseName = decodeURIComponent(
    parsed.pathname.replace(/^\/+|\/+$/gu, ""),
  );
  if (
    !databaseName ||
    databaseName.includes("/") ||
    !databaseName.includes("acceptance")
  )
    throw new Error("SINGLE_REPLAY_DATABASE_NOT_ACCEPTANCE");
  const workspaceId = env.ACQUISITION_REPLAY_WORKSPACE_ID?.trim();
  const runId = env.ACQUISITION_REPLAY_RUN_ID?.trim();
  const providerKey = env.ACQUISITION_REPLAY_PROVIDER_KEY?.trim();
  if (!workspaceId || !UUID.test(workspaceId))
    throw new Error("SINGLE_REPLAY_WORKSPACE_ID_INVALID");
  if (!runId || !UUID.test(runId))
    throw new Error("SINGLE_REPLAY_RUN_ID_INVALID");
  if (!providerKey || !PROVIDER_KEY.test(providerKey))
    throw new Error("SINGLE_REPLAY_PROVIDER_KEY_INVALID");
  return { databaseName, workspaceId, runId, providerKey };
}

export function assertSingleReplayConnection(
  databaseName: string,
  actual: ConnectionIdentity | undefined,
): void {
  if (!actual || actual.databaseName !== databaseName)
    throw new Error("SINGLE_REPLAY_DATABASE_IDENTITY_MISMATCH");
  if (actual.currentUser !== "app_user")
    throw new Error("SINGLE_REPLAY_APP_USER_REQUIRED");
  if (actual.superuser || actual.bypassRls)
    throw new Error("SINGLE_REPLAY_RLS_ROLE_REQUIRED");
}

export function assertSingleReplayRun(
  expected: { workspaceId: string; runId: string; providerKey: string },
  run: { id: string; workspaceId: string; status: string } | null,
  raw: readonly { providerKey: string; ingestStatus: string }[],
): void {
  if (
    !run ||
    run.id !== expected.runId ||
    run.workspaceId !== expected.workspaceId
  )
    throw new Error("SINGLE_REPLAY_RUN_SCOPE_MISMATCH");
  if (!["DONE", "PARTIAL"].includes(run.status))
    throw new Error("SINGLE_REPLAY_RUN_NOT_TERMINAL");
  if (
    raw.length === 0 ||
    raw.some((row) => row.providerKey !== expected.providerKey)
  )
    throw new Error("SINGLE_REPLAY_PROVIDER_RUN_MISMATCH");
  if (!raw.some((row) => row.ingestStatus === "ACCEPTED"))
    throw new Error("SINGLE_REPLAY_NO_ACCEPTED_RAW");
}

export function throwingSingleReplayEgressStub(label: string): unknown {
  return new Proxy(Object.create(null) as Record<string, unknown>, {
    get() {
      throw new Error(`SINGLE_REPLAY_FORBIDDEN_EGRESS_${label}`);
    },
  });
}

function assertCountsUnchanged(
  before: CountSnapshot,
  after: CountSnapshot,
): void {
  for (const key of Object.keys(before) as (keyof CountSnapshot)[]) {
    if (before[key] !== after[key])
      throw new Error(`SINGLE_REPLAY_ENTITY_GROWTH_${key}`);
  }
}

async function main(): Promise<void> {
  const input = parseSingleReplayInput(process.argv.slice(2), process.env);
  const prisma = new PrismaService();
  await prisma.$connect();
  try {
    const identities = await prisma.$queryRaw<ConnectionIdentity[]>(Prisma.sql`
      SELECT current_database() AS "databaseName",
             current_user AS "currentUser",
             role.rolsuper AS superuser,
             role.rolbypassrls AS "bypassRls"
      FROM pg_roles AS role
      WHERE role.rolname = current_user
    `);
    assertSingleReplayConnection(input.databaseName, identities[0]);

    const capture = () =>
      prisma.withWorkspace(input.workspaceId, async (tx) => {
        const run = await tx.discoveryRun.findUnique({
          where: { id: input.runId },
          select: { id: true, workspaceId: true, status: true },
        });
        const raw = await tx.rawSourceRecord.findMany({
          where: { runId: input.runId },
          orderBy: { id: "asc" },
          select: { id: true, providerKey: true, ingestStatus: true },
        });
        const acceptedRawIds = raw
          .filter((row) => row.ingestStatus === "ACCEPTED")
          .map((row) => row.id);
        const [
          canonicalCompanies,
          leads,
          fieldEvidence,
          authorityIdentifiers,
          identityLinks,
          outboxEvents,
          links,
        ] = await Promise.all([
          tx.canonicalCompany.count(),
          tx.lead.count(),
          tx.fieldEvidence.count(),
          tx.organizationIdentifier.count(),
          tx.identityLink.count(),
          tx.outboxEvent.count(),
          tx.identityLink.findMany({
            where: { rawRecordId: { in: acceptedRawIds }, status: "ACTIVE" },
            orderBy: [{ rawRecordId: "asc" }, { canonicalId: "asc" }],
            select: { rawRecordId: true, canonicalId: true },
          }),
        ]);
        return {
          run,
          raw,
          acceptedRawIds,
          links,
          counts: {
            canonicalCompanies,
            leads,
            fieldEvidence,
            authorityIdentifiers,
            identityLinks,
            outboxEvents,
          },
        };
      });

    const before = await capture();
    assertSingleReplayRun(input, before.run, before.raw);
    const beforeLinks = JSON.stringify(before.links);
    const activities = createDiscoveryActivities({
      prisma,
      providers: throwingSingleReplayEgressStub("provider"),
      gateway: throwingSingleReplayEgressStub("gateway"),
      broker: throwingSingleReplayEgressStub("broker"),
    } as never);
    const replay = await activities.canonicalizeRun({
      workspaceId: input.workspaceId,
      runId: input.runId,
    });
    const after = await capture();
    assertCountsUnchanged(before.counts, after.counts);
    if (beforeLinks !== JSON.stringify(after.links))
      throw new Error("SINGLE_REPLAY_IDENTITY_LINK_DRIFT");
    if (
      after.links.length !== before.acceptedRawIds.length ||
      new Set(after.links.map((row) => row.rawRecordId)).size !==
        before.acceptedRawIds.length
    )
      throw new Error("SINGLE_REPLAY_ACCEPTED_RAW_NOT_EXACTLY_BOUND");
    const quality = replay.identityQuality[input.providerKey];
    if (
      !quality ||
      quality.acceptedRows !== before.acceptedRawIds.length ||
      quality.boundRows !== before.acceptedRawIds.length ||
      quality.replayedRows !== before.acceptedRawIds.length ||
      quality.conflictRows !== 0 ||
      quality.suppressedRows !== 0
    )
      throw new Error("SINGLE_REPLAY_IDENTITY_QUALITY_MISMATCH");

    process.stdout.write(
      `${JSON.stringify(
        {
          status: "PASS",
          mode: SINGLE_REPLAY_OUTPUT_MODE,
          providerKey: input.providerKey,
          workspaceId: input.workspaceId,
          runId: input.runId,
          acceptedRawCount: before.acceptedRawIds.length,
          beforeCounts: before.counts,
          afterCounts: after.counts,
          identityQuality: quality,
          egressAttempted: false,
          fileWritten: false,
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

const SCRIPT_PATH = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === resolve(SCRIPT_PATH)) {
  main().catch(() => {
    process.stderr.write(
      `${JSON.stringify({ status: "FAIL", code: "SINGLE_RETAINED_REPLAY_FAILED" })}\n`,
    );
    process.exitCode = 1;
  });
}
