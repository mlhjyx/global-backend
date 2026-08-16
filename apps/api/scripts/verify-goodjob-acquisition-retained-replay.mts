import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../src/prisma/prisma.service";
import { createDiscoveryActivities } from "../src/temporal/discovery.activities";

export const RETAINED_REPLAY_FLAG =
  "--verify-goodjob-acquisition-retained-replay";
const MANIFEST_ENV = "ACQUISITION_RETAINED_REPLAY_MANIFEST";
const REPOSITORY_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const EVIDENCE_DIRECTORY = join(REPOSITORY_ROOT, "docs/evidence/acquisition");
const EVIDENCE_FILE = join(
  EVIDENCE_DIRECTORY,
  "goodjob-acquisition-retained-replay.json",
);

const CHANNELS = [
  {
    channel: "nppes",
    providerKey: "nppes",
    runId: "312a08db-4985-4348-bca2-dcb80828e29c",
    workspaceId: "bc160c9c-1107-4a28-acbf-fcc03c13b718",
  },
  {
    channel: "world_bank_procurement",
    providerKey: "world_bank_procurement",
    runId: "ad380b3a-9701-4ba0-b6ee-4e8a65f5f91a",
    workspaceId: "80b2f1f5-789c-40fa-a876-2a01a1750861",
  },
  {
    channel: "usaspending_awards",
    providerKey: "usaspending_awards",
    runId: "78df54a2-69a2-4072-90cb-50bdb3fb940c",
    workspaceId: "67715f0e-d210-4c83-9510-6f19432f104e",
  },
  {
    channel: "uk_contracts_finder",
    providerKey: "uk_contracts_finder",
    runId: "eedfd02e-0333-4750-a249-67faf8f24263",
    workspaceId: "0408bd25-38aa-4e50-b5ba-bbbc91efa791",
  },
] as const;

type Channel = (typeof CHANNELS)[number]["channel"];
type JsonRecord = Record<string, unknown>;

export interface ReplayManifestEntry {
  channel: Channel;
  runId: string;
  workspaceId: string;
  providerKey: string;
}

export interface StableSummary {
  count: number;
  digest: string;
}

export interface ReplaySnapshot {
  run: StableSummary;
  raw: StableSummary;
  governance: StableSummary;
  identityLinks: StableSummary;
  identityConflicts: StableSummary;
  fieldEvidence: StableSummary;
  canonicalCompanies: StableSummary;
  organizationIdentifiers: StableSummary;
  leads: StableSummary;
  outbox: StableSummary;
  qualityLedger: StableSummary;
  relayState: { publishedCount: number; parkedCount: number };
}

interface ConnectedIdentity {
  databaseName: string;
  currentUser: string;
  superuser: boolean;
  bypassRls: boolean;
}

interface RuntimeSnapshot {
  summary: ReplaySnapshot;
  terminal: {
    workspaceId: string;
    runId: string;
    planId: string;
    icpId: string;
    status: "DONE" | "PARTIAL" | "FAILED";
    stats: Record<string, unknown>;
  };
  visibleAcceptedRawCount: number;
  restrictedRawCount: number;
}

type ReplayResult = {
  suppressed: number;
  identityQuality: Record<
    string,
    {
      acceptedRows: number;
      boundRows: number;
      replayedRows: number;
      conflictRows: number;
      suppressedRows: number;
    }
  >;
};

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SENSITIVE_KEY =
  /^(?:authorization|cookie|credential|database.?url|dsn|password|passwd|secret|token|payload|value|source.?url)$/iu;
const URL_VALUE = /\b(?:https?|postgres(?:ql)?|mysql|redis):\/\//iu;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseReplayInvocation(argv: readonly string[]): {
  verify: true;
} {
  if (argv.length !== 1 || argv[0] !== RETAINED_REPLAY_FLAG) {
    throw new Error(
      `explicit invocation requires exactly ${RETAINED_REPLAY_FLAG}`,
    );
  }
  return { verify: true };
}

export function assertReplayDatabaseUrl(databaseUrl: string | undefined): {
  databaseName: string;
  hostKind: "loopback";
} {
  if (!databaseUrl) throw new Error("APP_DATABASE_URL is required");
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error("APP_DATABASE_URL must be a valid PostgreSQL URL");
  }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
    throw new Error("APP_DATABASE_URL must use PostgreSQL");
  }
  if (
    !new Set(["127.0.0.1", "localhost", "[::1]", "::1"]).has(
      parsed.hostname.toLowerCase(),
    )
  ) {
    throw new Error("APP_DATABASE_URL must target loopback");
  }
  const databaseName = decodeURIComponent(
    parsed.pathname.replace(/^\/+|\/+$/gu, ""),
  );
  if (
    !databaseName ||
    databaseName.includes("/") ||
    !databaseName.toLowerCase().includes("acceptance")
  ) {
    throw new Error("APP_DATABASE_URL database name must contain acceptance");
  }
  return { databaseName, hostKind: "loopback" };
}

export function assertConnectionIdentity(
  admitted: { databaseName: string; hostKind: "loopback" },
  actual: ConnectedIdentity | undefined,
) {
  if (!actual || actual.databaseName !== admitted.databaseName) {
    throw new Error("connected database does not match the admitted database");
  }
  if (actual.currentUser !== "app_user")
    throw new Error("connection must use exactly app_user");
  if (actual.superuser || actual.bypassRls) {
    throw new Error("app_user must be NOSUPERUSER and NOBYPASSRLS");
  }
  return admitted;
}

export function parseReplayManifest(
  raw: string | undefined,
): ReplayManifestEntry[] {
  if (!raw) throw new Error(`${MANIFEST_ENV} is required`);
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`${MANIFEST_ENV} must be valid JSON`);
  }
  if (!Array.isArray(decoded) || decoded.length !== CHANNELS.length) {
    throw new Error(
      "retained replay manifest must contain exactly four entries",
    );
  }
  const seenRuns = new Set<string>();
  const seenWorkspaces = new Set<string>();
  return CHANNELS.map((definition) => {
    const matches = decoded.filter(
      (candidate) =>
        isRecord(candidate) && candidate.channel === definition.channel,
    );
    const candidate = matches[0];
    if (matches.length !== 1 || !candidate)
      throw new Error(
        `manifest requires exactly one ${definition.channel} entry`,
      );
    const unexpected = Object.keys(candidate).filter(
      (key) => !["channel", "runId", "workspaceId"].includes(key),
    );
    if (unexpected.length > 0)
      throw new Error(
        `manifest ${definition.channel} entry contains unexpected fields`,
      );
    if (
      typeof candidate.runId !== "string" ||
      typeof candidate.workspaceId !== "string" ||
      !UUID.test(candidate.runId) ||
      !UUID.test(candidate.workspaceId) ||
      candidate.runId.toLowerCase() !== definition.runId ||
      candidate.workspaceId.toLowerCase() !== definition.workspaceId
    ) {
      throw new Error(
        `manifest ${definition.channel} identifiers do not match the canonical run`,
      );
    }
    if (
      seenRuns.has(candidate.runId) ||
      seenWorkspaces.has(candidate.workspaceId)
    ) {
      throw new Error("manifest runId and workspaceId values must be unique");
    }
    seenRuns.add(candidate.runId);
    seenWorkspaces.add(candidate.workspaceId);
    return {
      channel: definition.channel,
      providerKey: definition.providerKey,
      runId: candidate.runId,
      workspaceId: candidate.workspaceId,
    };
  });
}

function canonicalJson(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function buildStableSummary(rows: readonly unknown[]): StableSummary {
  const rowDigests = rows.map((row) => digest(row)).sort();
  return { count: rows.length, digest: digest(rowDigests) };
}

const SNAPSHOT_FIELDS: ReadonlyArray<
  Exclude<keyof ReplaySnapshot, "relayState">
> = [
  "run",
  "raw",
  "governance",
  "identityLinks",
  "identityConflicts",
  "fieldEvidence",
  "canonicalCompanies",
  "organizationIdentifiers",
  "leads",
  "outbox",
  "qualityLedger",
];

export function assertSnapshotsEqual(
  before: ReplaySnapshot,
  after: ReplaySnapshot,
): void {
  for (const field of SNAPSHOT_FIELDS) {
    if (
      before[field].count !== after[field].count ||
      before[field].digest !== after[field].digest
    ) {
      throw new Error(`retained replay changed ${field}`);
    }
  }
}

export function assertChannelReplaySemantics(input: {
  channel: Channel;
  providerKey: string;
  visibleAcceptedRawCount: number;
  restrictedRawCount: number;
  result: ReplayResult;
}): void {
  const quality = input.result.identityQuality[input.providerKey] ?? {
    acceptedRows: 0,
    boundRows: 0,
    replayedRows: 0,
    conflictRows: 0,
    suppressedRows: 0,
  };
  if (
    input.channel !== "usaspending_awards" &&
    input.restrictedRawCount !== 0
  ) {
    throw new Error(`${input.channel} unexpectedly contains restricted Raw`);
  }
  if (
    input.result.suppressed !== input.restrictedRawCount ||
    quality.acceptedRows !== input.visibleAcceptedRawCount ||
    quality.boundRows !== input.visibleAcceptedRawCount ||
    quality.replayedRows !== input.visibleAcceptedRawCount ||
    quality.conflictRows !== 0 ||
    quality.suppressedRows !== input.restrictedRawCount
  ) {
    throw new Error(
      `${input.channel} replay identity quality does not match visible and restricted Raw`,
    );
  }
}

export function throwingEgressStub(label: string): unknown {
  return new Proxy(Object.create(null) as JsonRecord, {
    get() {
      throw new Error(`forbidden retained replay egress access: ${label}`);
    },
  });
}

function assertNoSensitiveMaterial(value: unknown, path = "$"): void {
  if (typeof value === "string") {
    if (URL_VALUE.test(value))
      throw new Error(`sensitive URL-like material at ${path}`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertNoSensitiveMaterial(entry, `${path}[${index}]`),
    );
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key))
      throw new Error(`sensitive output field at ${path}.${key}`);
    assertNoSensitiveMaterial(entry, `${path}.${key}`);
  }
}

export function serializeSafeResult(value: unknown): string {
  assertNoSensitiveMaterial(value);
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function writeReplayEvidence(value: unknown): Promise<void> {
  const destination = resolve(EVIDENCE_FILE);
  const withinEvidenceDirectory = relative(
    resolve(EVIDENCE_DIRECTORY),
    destination,
  );
  if (
    withinEvidenceDirectory.startsWith("..") ||
    isAbsolute(withinEvidenceDirectory)
  ) {
    throw new Error(
      "replay evidence destination escaped the evidence directory",
    );
  }
  await mkdir(EVIDENCE_DIRECTORY, { recursive: true });
  await writeFile(destination, serializeSafeResult(value), {
    encoding: "utf8",
    mode: 0o600,
    flag: "w",
  });
}

function resolveRootCompanyIds(
  companyIds: readonly string[],
  mappings: readonly { sourceCompanyId: string; canonicalCompanyId: string }[],
): string[] {
  const bySource = new Map(
    mappings.map((mapping) => [
      mapping.sourceCompanyId,
      mapping.canonicalCompanyId,
    ]),
  );
  return [
    ...new Set(
      companyIds.map((companyId) => {
        const visited = new Set<string>();
        let current = companyId;
        while (bySource.has(current)) {
          if (visited.has(current))
            throw new Error("active canonical mapping contains a cycle");
          visited.add(current);
          current = bySource.get(current)!;
        }
        return current;
      }),
    ),
  ].sort();
}

async function captureSnapshot(
  prisma: PrismaService,
  entry: ReplayManifestEntry,
): Promise<RuntimeSnapshot> {
  return prisma.withWorkspace(
    entry.workspaceId,
    async (tx) => {
      const run = await tx.discoveryRun.findFirst({
        where: { id: entry.runId, workspaceId: entry.workspaceId },
        select: {
          id: true,
          workspaceId: true,
          planId: true,
          icpId: true,
          status: true,
          stats: true,
          completedAt: true,
        },
      });
      if (
        !run ||
        !["DONE", "PARTIAL", "FAILED"].includes(run.status) ||
        !run.completedAt ||
        !isRecord(run.stats)
      ) {
        throw new Error(
          `${entry.channel} canonical run is missing a stable terminal state`,
        );
      }

      const raw = await tx.rawSourceRecord.findMany({
        where: { runId: entry.runId },
        orderBy: { id: "asc" },
        select: {
          id: true,
          providerKey: true,
          externalId: true,
          contentHash: true,
          parserVersion: true,
          ingestKey: true,
          payloadHash: true,
          payloadBytes: true,
          ingestVersion: true,
          ingestStatus: true,
          dispositionCode: true,
          fetchedAt: true,
          createdAt: true,
          payload: true,
        },
      });
      if (raw.some((row) => row.providerKey !== entry.providerKey)) {
        throw new Error(`${entry.channel} run contains an unexpected provider`);
      }
      const rawIds = raw.map((row) => row.id);
      const governance = await tx.rawSourceGovernanceDisposition.findMany({
        where: {
          workspaceId: entry.workspaceId,
          runId: entry.runId,
        },
        orderBy: { rawRecordId: "asc" },
        select: {
          id: true,
          rawRecordId: true,
          providerKey: true,
          effect: true,
          reasonCode: true,
          detectedFields: true,
          rawPayloadHash: true,
          rawIngestVersion: true,
          rawCreatedAt: true,
          actor: true,
          governanceVersion: true,
          createdAt: true,
        },
      });
      const links =
        rawIds.length === 0
          ? []
          : await tx.identityLink.findMany({
              where: { rawRecordId: { in: rawIds } },
              orderBy: { id: "asc" },
              select: {
                id: true,
                rawRecordId: true,
                canonicalType: true,
                canonicalId: true,
                matchRule: true,
                confidence: true,
                status: true,
                resolverVersion: true,
                inputHash: true,
                conflictId: true,
                createdAt: true,
              },
            });
      const identityConflicts =
        rawIds.length === 0
          ? []
          : await tx.organizationIdentityConflict.findMany({
              where: { rawRecordId: { in: rawIds } },
              orderBy: { id: "asc" },
              select: {
                id: true,
                rawRecordId: true,
                conflictType: true,
                fingerprint: true,
                status: true,
                revision: true,
                facts: true,
                createdAt: true,
                resolvedAt: true,
              },
            });
      const linkedCompanyIds = links
        .filter((row) => row.canonicalType === "company")
        .map((row) => row.canonicalId);
      const mappings =
        linkedCompanyIds.length === 0
          ? []
          : await tx.organizationCanonicalMapping.findMany({
              where: { status: "ACTIVE" },
              select: { sourceCompanyId: true, canonicalCompanyId: true },
            });
      const rootCompanyIds = resolveRootCompanyIds(linkedCompanyIds, mappings);
      const [companies, evidence, identifiers, leads, outbox, quality] =
        await Promise.all([
          rootCompanyIds.length === 0
            ? []
            : tx.canonicalCompany.findMany({
                where: { id: { in: rootCompanyIds } },
                orderBy: { id: "asc" },
                select: {
                  id: true,
                  name: true,
                  domain: true,
                  country: true,
                  region: true,
                  industry: true,
                  employeeCount: true,
                  revenueUsd: true,
                  attributes: true,
                  status: true,
                  dedupeKey: true,
                  version: true,
                  createdAt: true,
                  updatedAt: true,
                },
              }),
          rawIds.length === 0
            ? []
            : tx.fieldEvidence.findMany({
                where: { rawRecordId: { in: rawIds } },
                orderBy: { id: "asc" },
                select: {
                  id: true,
                  entityType: true,
                  entityId: true,
                  field: true,
                  value: true,
                  providerKey: true,
                  rawRecordId: true,
                  confidence: true,
                  license: true,
                  allowedActions: true,
                  dataClass: true,
                  fetchedAt: true,
                },
              }),
          rawIds.length === 0 && rootCompanyIds.length === 0
            ? []
            : tx.organizationIdentifier.findMany({
                where: {
                  OR: [
                    ...(rawIds.length > 0
                      ? [{ rawRecordId: { in: rawIds } }]
                      : []),
                    ...(rootCompanyIds.length > 0
                      ? [{ companyId: { in: rootCompanyIds } }]
                      : []),
                  ],
                },
                orderBy: { id: "asc" },
                select: {
                  id: true,
                  companyId: true,
                  scheme: true,
                  jurisdiction: true,
                  normalizedValue: true,
                  authorityProviderKey: true,
                  rawRecordId: true,
                  confidence: true,
                  normalizerVersion: true,
                  validatorVersion: true,
                  status: true,
                  firstSeenAt: true,
                  lastSeenAt: true,
                  createdAt: true,
                  revokedAt: true,
                },
              }),
          rootCompanyIds.length === 0
            ? []
            : tx.lead.findMany({
                where: {
                  icpId: run.icpId,
                  canonicalCompanyId: { in: rootCompanyIds },
                },
                orderBy: { id: "asc" },
                select: {
                  id: true,
                  canonicalCompanyId: true,
                  status: true,
                  fitVerdict: true,
                  fitReasons: true,
                  queue: true,
                  totalScore: true,
                  scores: true,
                  scoreDetail: true,
                  version: true,
                  createdAt: true,
                  updatedAt: true,
                },
              }),
          tx.outboxEvent.findMany({
            where: { workspaceId: entry.workspaceId },
            orderBy: { eventId: "asc" },
            select: {
              eventId: true,
              eventType: true,
              schemaVersion: true,
              aggregateType: true,
              aggregateId: true,
              producer: true,
              correlationId: true,
              causationId: true,
              privacyClassification: true,
              payload: true,
              occurredAt: true,
              publishedAt: true,
              parkedAt: true,
            },
          }),
          tx.providerQualityRunContribution.findMany({
            where: { runId: entry.runId },
            orderBy: { providerKey: "asc" },
          }),
        ]);

      const semanticOutbox = outbox.map(
        ({ payload, publishedAt: _publishedAt, ...row }) => ({
          ...row,
          payloadDigest: digest(payload),
        }),
      );
      const summary: ReplaySnapshot = {
        run: buildStableSummary([run]),
        raw: buildStableSummary(
          raw.map(({ payload, ...row }) => ({
            ...row,
            payloadDigest: digest(payload),
          })),
        ),
        governance: buildStableSummary(governance),
        identityLinks: buildStableSummary(links),
        identityConflicts: buildStableSummary(identityConflicts),
        fieldEvidence: buildStableSummary(
          evidence.map(({ value, ...row }) => ({
            ...row,
            valueDigest: digest(value),
          })),
        ),
        canonicalCompanies: buildStableSummary(companies),
        organizationIdentifiers: buildStableSummary(identifiers),
        leads: buildStableSummary(leads),
        outbox: buildStableSummary(semanticOutbox),
        qualityLedger: buildStableSummary(quality),
        relayState: {
          publishedCount: outbox.filter((row) => row.publishedAt !== null)
            .length,
          parkedCount: outbox.filter((row) => row.parkedAt !== null).length,
        },
      };
      return {
        summary,
        terminal: {
          workspaceId: entry.workspaceId,
          runId: run.id,
          planId: run.planId,
          icpId: run.icpId,
          status: run.status as "DONE" | "PARTIAL" | "FAILED",
          stats: run.stats as Record<string, unknown>,
        },
        visibleAcceptedRawCount: raw.filter(
          (row) => row.ingestStatus === "ACCEPTED",
        ).length,
        restrictedRawCount: governance.filter(
          (row) => row.effect === "RESTRICT_PROCESSING",
        ).length,
      };
    },
    { maxWait: 10_000, timeout: 60_000 },
  );
}

async function verifyChannel(
  prisma: PrismaService,
  activities: ReturnType<typeof createDiscoveryActivities>,
  entry: ReplayManifestEntry,
) {
  const first = await captureSnapshot(prisma, entry);
  await new Promise((settle) => setTimeout(settle, 2_500));
  const before = await captureSnapshot(prisma, entry);
  assertSnapshotsEqual(first.summary, before.summary);

  const replayResult = await activities.canonicalizeRun({
    workspaceId: entry.workspaceId,
    runId: entry.runId,
  });
  assertChannelReplaySemantics({
    channel: entry.channel,
    providerKey: entry.providerKey,
    visibleAcceptedRawCount: before.visibleAcceptedRawCount,
    restrictedRawCount: before.restrictedRawCount,
    result: replayResult,
  });
  await activities.finalizeRun(before.terminal);
  const after = await captureSnapshot(prisma, entry);
  assertSnapshotsEqual(before.summary, after.summary);

  return {
    channel: entry.channel,
    runSelector: entry.runId.slice(0, 8),
    workspaceSelector: entry.workspaceId.slice(0, 8),
    visibleAcceptedRawCount: before.visibleAcceptedRawCount,
    restrictedRawCount: before.restrictedRawCount,
    governanceApplicability:
      entry.channel === "usaspending_awards"
        ? before.restrictedRawCount > 0
          ? "RESTRICTED_ROWS_FILTERED"
          : "SAFE_CANONICAL_RUN_NO_RESTRICTIONS"
        : "NOT_APPLICABLE",
    replay: {
      suppressed: replayResult.suppressed,
      identityQuality: replayResult.identityQuality[entry.providerKey] ?? null,
    },
    before: before.summary,
    after: after.summary,
    relayState: {
      before: before.summary.relayState,
      after: after.summary.relayState,
    },
    proved: true,
  };
}

async function main(): Promise<void> {
  parseReplayInvocation(process.argv.slice(2));
  const admitted = assertReplayDatabaseUrl(process.env.APP_DATABASE_URL);
  const manifest = parseReplayManifest(process.env[MANIFEST_ENV]);
  const prisma = new PrismaService();
  await prisma.$connect();
  try {
    const identities = await prisma.$queryRaw<ConnectedIdentity[]>(Prisma.sql`
      SELECT current_database() AS "databaseName",
             current_user AS "currentUser",
             role.rolsuper AS superuser,
             role.rolbypassrls AS "bypassRls"
      FROM pg_roles AS role
      WHERE role.rolname = current_user
    `);
    assertConnectionIdentity(admitted, identities[0]);
    const activities = createDiscoveryActivities({
      prisma,
      providers: throwingEgressStub("provider"),
      gateway: throwingEgressStub("gateway"),
      broker: throwingEgressStub("broker"),
    } as never);
    const channels = [];
    for (const entry of manifest)
      channels.push(await verifyChannel(prisma, activities, entry));
    const result = {
      schemaVersion: "goodjob-acquisition-retained-replay/v1",
      capturedAt: new Date().toISOString(),
      status: "PASS",
      mode: "DIRECT_RETAINED_RAW_REPLAY_NO_PROVIDER_EGRESS",
      database: admitted,
      channels,
    };
    await writeReplayEvidence(result);
    process.stdout.write(
      serializeSafeResult({
        written: true,
        path: relative(REPOSITORY_ROOT, EVIDENCE_FILE),
        status: result.status,
        channels: channels.map((channel) => ({
          channel: channel.channel,
          proved: channel.proved,
        })),
      }),
    );
  } finally {
    await prisma.$disconnect();
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
  main().catch((error: unknown) => {
    const code =
      error instanceof Error &&
      /^[A-Za-z][A-Za-z0-9_:-]{0,127}$/u.test(error.message)
        ? error.message
        : "RETAINED_REPLAY_VERIFICATION_FAILED";
    process.stderr.write(`${JSON.stringify({ status: "FAIL", code })}\n`);
    process.exitCode = 1;
  });
}
