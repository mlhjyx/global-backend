import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ACCEPTANCE_CAPTURE_FLAG =
  "--capture-goodjob-acquisition-acceptance";
export const ACCEPTANCE_CAPTURE_SCHEMA = "goodjob-acquisition-acceptance/v1";

const REPOSITORY_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const EVIDENCE_DIRECTORY = join(REPOSITORY_ROOT, "docs/evidence/acquisition");
const EVIDENCE_FILE = join(
  EVIDENCE_DIRECTORY,
  "goodjob-acquisition-acceptance.json",
);

const CANONICAL_RUNS = [
  {
    channel: "nppes",
    runSelector: "312a08db",
    providerKey: "nppes",
    sourcePolicyDomain: "npiregistry.cms.hhs.gov",
  },
  {
    channel: "world_bank_procurement",
    runSelector: "ad380b3a",
    providerKey: "world_bank_procurement",
    sourcePolicyDomain: "search.worldbank.org",
  },
  {
    channel: "usaspending_awards",
    runSelector: "78df54a2",
    providerKey: "usaspending_awards",
    sourcePolicyDomain: "api.usaspending.gov",
  },
  {
    channel: "uk_contracts_finder",
    runSelector: "eedfd02e",
    providerKey: "uk_contracts_finder",
    sourcePolicyDomain: "www.contractsfinder.service.gov.uk",
  },
] as const;

type JsonRecord = Record<string, unknown>;

export interface DatabaseAdmission {
  databaseName: string;
  hostKind: "loopback";
  currentUser?: string;
  superuser?: false;
  bypassRls?: false;
}

interface ConnectionIdentity {
  database_name: string;
  current_user: string;
  superuser: boolean;
  bypass_rls: boolean;
}

interface CanonicalRunReference {
  channel: (typeof CANONICAL_RUNS)[number]["channel"];
  runId: string;
  workspaceId: string;
}

interface HealthCapture {
  ok: boolean;
  status: number;
  body: unknown;
}

interface GitCapture {
  head: string;
  clean: boolean;
  changedPathCount: number;
}

interface ChannelCapture extends JsonRecord {
  channel: string;
  runSelector: string;
  run: { id: string; status: string } & JsonRecord;
  outbox: {
    eventTypeCounts: Record<string, number>;
    leadQualifiedCount: number;
  } & JsonRecord;
}

export interface AcceptanceEnvelopeInput {
  capturedAt: string;
  git: GitCapture;
  database: DatabaseAdmission;
  health: {
    ready: HealthCapture;
    build: HealthCapture;
  };
  channels: ChannelCapture[];
  historicalGovernance: JsonRecord;
}

const SENSITIVE_KEY =
  /(?:authorization|cookie|credential|database.?url|dsn|password|passwd|secret|token|url|uri)/iu;
const URL_VALUE = /\b(?:https?|postgres(?:ql)?|mysql|redis):\/\/[^\s"'<>]+/giu;
const BEARER_VALUE = /\bBearer\s+[A-Za-z0-9._~+/=-]+/giu;
const PASSWORD_ASSIGNMENT = /\b(?:password|passwd|pwd)\s*[=:]\s*[^\s,;]+/giu;

function countBy(values: string[]): Record<string, number> {
  return values.reduce<Record<string, number>>((result, value) => {
    result[value] = (result[value] ?? 0) + 1;
    return result;
  }, {});
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readBoolean(value: unknown, key: string): boolean | null {
  if (!isJsonRecord(value)) return null;
  return typeof value[key] === "boolean" ? value[key] : null;
}

function readString(value: unknown, key: string): string | null {
  if (!isJsonRecord(value)) return null;
  return typeof value[key] === "string" ? value[key] : null;
}

export function parseCaptureInvocation(argv: string[]): { capture: true } {
  const unexpected = argv.filter(
    (argument) => argument !== ACCEPTANCE_CAPTURE_FLAG,
  );
  if (
    argv.length !== 1 ||
    !argv.includes(ACCEPTANCE_CAPTURE_FLAG) ||
    unexpected.length > 0
  ) {
    throw new Error(
      `Refusing acceptance capture: invoke with the single explicit flag ${ACCEPTANCE_CAPTURE_FLAG}.`,
    );
  }
  return { capture: true };
}

export function assertAcceptanceDatabaseUrl(
  databaseUrl: string | undefined,
): DatabaseAdmission {
  if (!databaseUrl) {
    throw new Error(
      "Refusing acceptance capture: ACQUISITION_ACCEPTANCE_DATABASE_URL is required.",
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error("Refusing acceptance capture: database URL is invalid.");
  }

  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
    throw new Error(
      "Refusing acceptance capture: only PostgreSQL is admitted.",
    );
  }

  const loopbackHosts = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
  if (!loopbackHosts.has(parsed.hostname.toLowerCase())) {
    throw new Error(
      "Refusing acceptance capture: database host must be loopback.",
    );
  }

  const databaseName =
    decodeURIComponent(parsed.pathname.replace(/^\/+/, "")).split("/")[0] ?? "";
  if (!databaseName.toLowerCase().includes("acceptance")) {
    throw new Error(
      'Refusing acceptance capture: database name must contain "acceptance".',
    );
  }

  return { databaseName, hostKind: "loopback" };
}

export function assertConnectionIdentity(
  admitted: DatabaseAdmission,
  actual: ConnectionIdentity | undefined,
): DatabaseAdmission {
  if (!actual || actual.database_name !== admitted.databaseName) {
    throw new Error(
      "Refusing acceptance capture: connected database does not exactly match the admitted URL database name.",
    );
  }
  if (actual.superuser || actual.bypass_rls) {
    throw new Error(
      "Refusing acceptance capture: connection role must be a non-superuser without BYPASSRLS.",
    );
  }
  return {
    ...admitted,
    currentUser: actual.current_user,
    superuser: false,
    bypassRls: false,
  };
}

function assertLoopbackApiOrigin(origin: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new Error("Refusing acceptance capture: API origin is invalid.");
  }
  const loopbackHosts = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    !loopbackHosts.has(parsed.hostname.toLowerCase())
  ) {
    throw new Error(
      "Refusing acceptance capture: API origin must be HTTP(S) loopback.",
    );
  }
  if (
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(
      "Refusing acceptance capture: API origin must not contain credentials, paths, query, or fragment.",
    );
  }
  return parsed;
}

export function sanitizeForEvidence(
  value: unknown,
  seen = new WeakSet<object>(),
): unknown {
  if (typeof value === "string") {
    return value
      .replace(URL_VALUE, "[REDACTED_URL]")
      .replace(BEARER_VALUE, "[REDACTED]")
      .replace(PASSWORD_ASSIGNMENT, "[REDACTED]");
  }
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value))
    return value.map((entry) => sanitizeForEvidence(entry, seen));
  if (!isJsonRecord(value)) return value;
  if (seen.has(value)) return "[REDACTED_CYCLE]";
  seen.add(value);

  const result: JsonRecord = {};
  for (const [key, entry] of Object.entries(value)) {
    result[key] = SENSITIVE_KEY.test(key)
      ? "[REDACTED]"
      : sanitizeForEvidence(entry, seen);
  }
  seen.delete(value);
  return result;
}

export function buildAcceptanceEnvelope(input: AcceptanceEnvelopeInput) {
  const buildIdentity =
    isJsonRecord(input.health.build.body) &&
    isJsonRecord(input.health.build.body.build)
      ? input.health.build.body.build
      : input.health.build.body;
  const reportedByRuntime = readBoolean(buildIdentity, "attested") === true;
  const reportedBuildSha = readString(buildIdentity, "build_sha");
  const buildShaMatches =
    reportedBuildSha === null ? null : reportedBuildSha === input.git.head;
  const effective =
    input.git.clean && reportedByRuntime && buildShaMatches === true;
  const reason = !input.git.clean
    ? "dirty_worktree"
    : !reportedByRuntime
      ? "runtime_unattested"
      : reportedBuildSha === null
        ? "build_sha_missing"
        : buildShaMatches
          ? "attested_clean_matching_build"
          : "build_sha_mismatch";
  const leadQualifiedCount = input.channels.reduce(
    (sum, channel) => sum + channel.outbox.leadQualifiedCount,
    0,
  );

  return sanitizeForEvidence({
    schemaVersion: ACCEPTANCE_CAPTURE_SCHEMA,
    capturedAt: input.capturedAt,
    mode: "READ_ONLY_RETAINED_EVIDENCE_CAPTURE",
    database: input.database,
    git: input.git,
    health: input.health,
    attestation: {
      reportedByRuntime,
      reportedBuildSha,
      buildShaMatches,
      effective,
      reason,
    },
    replay: {
      rerunByThisCapture: false,
      status: "NOT_RERUN",
      note: "This script reads retained rows only and does not invoke providers, workflows, workers, or replay mutations.",
    },
    claims: {
      scope: "RETAINED_EVIDENCE_SNAPSHOT",
      fullEndToEndClaim: false,
      leadQualifiedProduced: leadQualifiedCount > 0,
      leadQualifiedCount,
      note:
        leadQualifiedCount === 0
          ? "No retained LeadQualified outbox event was observed in the four canary workspaces."
          : "A retained LeadQualified outbox event exists; this capture does not claim that it was produced by a replay.",
    },
    historicalGovernance: input.historicalGovernance,
    channels: input.channels,
  });
}

export function parseGovernanceWorkspaceManifest(
  raw: string | undefined,
): string[] {
  if (!raw) {
    throw new Error(
      "Refusing acceptance capture: ACQUISITION_ACCEPTANCE_GOVERNANCE_WORKSPACE_MANIFEST is required.",
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(
      "Refusing acceptance capture: governance workspace manifest is invalid JSON.",
    );
  }
  const uuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > 64 ||
    value.some((entry) => typeof entry !== "string" || !uuid.test(entry))
  ) {
    throw new Error(
      "Refusing acceptance capture: governance workspace manifest must contain 1-64 UUIDs.",
    );
  }
  const unique = [...new Set(value as string[])];
  if (unique.length !== value.length) {
    throw new Error(
      "Refusing acceptance capture: governance workspace manifest contains duplicates.",
    );
  }
  return unique.sort();
}

async function captureHistoricalGovernance(
  prisma: import("@prisma/client").PrismaClient,
  workspaceIds: readonly string[],
): Promise<JsonRecord> {
  const rows: JsonRecord[] = [];
  for (const workspaceId of workspaceIds) {
    rows.push(
      ...(await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_workspace_id', ${workspaceId}, true)`;
        return tx.$queryRaw<JsonRecord[]>`
          SELECT
            workspace_id::text AS "workspaceId",
            raw_record_id::text AS "rawRecordId",
            run_id::text AS "runId",
            provider_key AS "providerKey",
            effect,
            reason_code AS "reasonCode",
            detected_fields AS "detectedFields",
            raw_payload_hash AS "rawPayloadHash",
            raw_ingest_version AS "rawIngestVersion",
            actor,
            governance_version AS "governanceVersion",
            created_at AS "createdAt"
          FROM raw_source_governance_disposition
          WHERE workspace_id = ${workspaceId}::uuid
            AND provider_key = 'usaspending_awards'
          ORDER BY created_at ASC, raw_record_id ASC
        `;
      })),
    );
  }
  const detectedFieldCombinationCounts = countBy(
    rows.map((row) => JSON.stringify(row.detectedFields)),
  );
  return {
    scope: "EXPLICIT_RLS_WORKSPACE_MANIFEST",
    status: "CAPTURED",
    workspaceCount: workspaceIds.length,
    workspacesWithRows: new Set(rows.map((row) => String(row.workspaceId)))
      .size,
    count: rows.length,
    effectCounts: countBy(rows.map((row) => String(row.effect))),
    reasonCounts: countBy(rows.map((row) => String(row.reasonCode))),
    actorCounts: countBy(rows.map((row) => String(row.actor))),
    governanceVersionCounts: countBy(
      rows.map((row) => String(row.governanceVersion)),
    ),
    detectedFieldCombinationCounts,
    rawSnapshotVerification: {
      status: "NOT_RECHECKED_BY_APP_ROLE",
      note: "Restricted Raw rows are intentionally invisible to app_user; owner-side migration acceptance verifies retained Raw snapshot hashes separately.",
    },
    rows,
  };
}

function readGitCapture(): GitCapture {
  const head = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
  }).trim();
  const status = execFileSync(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    {
      cwd: REPOSITORY_ROOT,
      encoding: "utf8",
    },
  );
  const changedPathCount = status.split("\n").filter(Boolean).length;
  return { head, clean: changedPathCount === 0, changedPathCount };
}

async function fetchHealth(
  origin: URL,
  endpoint: "/api/v1/health/ready" | "/api/v1/health/build",
): Promise<HealthCapture> {
  const endpointUrl = new URL(endpoint, origin);
  try {
    const response = await fetch(endpointUrl, {
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
      headers: { accept: "application/json" },
    });
    const bodyText = (await response.text()).slice(0, 64 * 1024);
    let body: unknown = bodyText;
    try {
      body = JSON.parse(bodyText);
    } catch {
      // A non-JSON health response remains evidence, after recursive sanitization.
    }
    return {
      ok: response.ok,
      status: response.status,
      body: sanitizeForEvidence(body),
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      body: { error: error instanceof Error ? error.name : "UnknownError" },
    };
  }
}

function sha256Json(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function captureChannel(
  prisma: import("@prisma/client").PrismaClient,
  definition: (typeof CANONICAL_RUNS)[number],
  reference: CanonicalRunReference,
): Promise<ChannelCapture> {
  const [provider, sourcePolicy] = await Promise.all([
    prisma.dataProvider.findUnique({
      where: { key: definition.providerKey },
      select: {
        key: true,
        class: true,
        status: true,
        costPerCallCents: true,
        createdAt: true,
      },
    }),
    prisma.sourcePolicy.findUnique({
      where: { domain: definition.sourcePolicyDomain },
      select: {
        domain: true,
        sourceType: true,
        accessMode: true,
        allowedPaths: true,
        disallowedPaths: true,
        robotsStatus: true,
        termsStatus: true,
        personalData: true,
        allowedPurpose: true,
        crawlDelayMs: true,
        retentionDays: true,
        reviewStatus: true,
        owner: true,
        notes: true,
        updatedAt: true,
      },
    }),
  ]);

  const evidence = await prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_workspace_id', ${reference.workspaceId}, true)`;
      const run = await tx.discoveryRun.findFirst({
        where: { id: reference.runId, workspaceId: reference.workspaceId },
        select: {
          id: true,
          workspaceId: true,
          planId: true,
          icpId: true,
          status: true,
          stats: true,
          createdAt: true,
          completedAt: true,
        },
      });
      if (!run || !run.id.toLowerCase().startsWith(definition.runSelector)) {
        throw new Error(
          `Retained ${definition.channel} run is missing or does not match selector ${definition.runSelector}.`,
        );
      }
      const raw = await tx.rawSourceRecord.findMany({
        where: { runId: run.id },
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          providerKey: true,
          sourceClass: true,
          externalId: true,
          contentHash: true,
          parserVersion: true,
          ingestKey: true,
          payloadHash: true,
          payloadBytes: true,
          ingestVersion: true,
          ingestStatus: true,
          dispositionCode: true,
          retentionDays: true,
          fetchedAt: true,
          createdAt: true,
          payload: true,
        },
      });
      const rawIds = raw.map((row) => row.id);
      const links =
        rawIds.length === 0
          ? []
          : await tx.identityLink.findMany({
              where: { rawRecordId: { in: rawIds } },
              orderBy: { createdAt: "asc" },
              select: {
                rawRecordId: true,
                canonicalType: true,
                canonicalId: true,
                matchRule: true,
                confidence: true,
                status: true,
                resolverVersion: true,
                inputHash: true,
              },
            });
      const companyIds = [
        ...new Set(
          links
            .filter((link) => link.canonicalType === "company")
            .map((link) => link.canonicalId),
        ),
      ];
      const [companies, identifiers, fieldEvidence, leads, quality, outbox] =
        await Promise.all([
          companyIds.length === 0
            ? []
            : tx.canonicalCompany.findMany({
                where: { id: { in: companyIds } },
                orderBy: { createdAt: "asc" },
                select: {
                  id: true,
                  name: true,
                  country: true,
                  region: true,
                  industry: true,
                  status: true,
                  version: true,
                  createdAt: true,
                  updatedAt: true,
                },
              }),
          companyIds.length === 0
            ? []
            : tx.organizationIdentifier.findMany({
                where: { companyId: { in: companyIds } },
                orderBy: { createdAt: "asc" },
                select: {
                  companyId: true,
                  rawRecordId: true,
                  scheme: true,
                  jurisdiction: true,
                  normalizedValue: true,
                  authorityProviderKey: true,
                  confidence: true,
                  validatorVersion: true,
                  status: true,
                },
              }),
          rawIds.length === 0 && companyIds.length === 0
            ? []
            : tx.fieldEvidence.findMany({
                where: {
                  OR: [
                    ...(rawIds.length > 0
                      ? [{ rawRecordId: { in: rawIds } }]
                      : []),
                    ...(companyIds.length > 0
                      ? [
                          {
                            entityType: "company",
                            entityId: { in: companyIds },
                          },
                        ]
                      : []),
                  ],
                },
                orderBy: { fetchedAt: "asc" },
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
          companyIds.length === 0
            ? []
            : tx.lead.findMany({
                where: {
                  icpId: run.icpId,
                  canonicalCompanyId: { in: companyIds },
                },
                orderBy: { createdAt: "asc" },
                select: {
                  id: true,
                  canonicalCompanyId: true,
                  status: true,
                  fitVerdict: true,
                  queue: true,
                  totalScore: true,
                  version: true,
                  createdAt: true,
                  updatedAt: true,
                },
              }),
          tx.providerQualityRunContribution.findMany({
            where: { runId: run.id },
            orderBy: { providerKey: "asc" },
            select: {
              providerKey: true,
              terminalStatus: true,
              attemptedCount: true,
              successCount: true,
              zeroResultCount: true,
              failureCount: true,
              failedRunCount: true,
              processedCount: true,
              rawCount: true,
              acceptedCount: true,
              boundCount: true,
              domainCount: true,
              authorityCount: true,
              conflictCount: true,
              duplicateCount: true,
              completedAt: true,
            },
          }),
          tx.outboxEvent.findMany({
            where: { workspaceId: run.workspaceId },
            orderBy: { occurredAt: "asc" },
            select: {
              eventType: true,
              aggregateType: true,
              aggregateId: true,
              occurredAt: true,
              publishedAt: true,
              parkedAt: true,
            },
          }),
        ]);

      let usaGovernanceHistory: {
        status: "NOT_APPLICABLE" | "CAPTURED" | "NOT_IMPLEMENTED";
        rows: JsonRecord[];
      } = { status: "NOT_APPLICABLE", rows: [] };
      if (definition.channel === "usaspending_awards") {
        const relation = await tx.$queryRaw<
          Array<{ relation_name: string | null }>
        >`
        SELECT to_regclass('public.raw_source_governance_disposition')::text AS relation_name
      `;
        if (!relation[0]?.relation_name) {
          usaGovernanceHistory = { status: "NOT_IMPLEMENTED", rows: [] };
        } else {
          const rows = await tx.$queryRaw<JsonRecord[]>`
          SELECT
            raw_record_id::text AS "rawRecordId",
            run_id::text AS "runId",
            effect,
            reason_code AS "reasonCode",
            detected_fields AS "detectedFields",
            raw_payload_hash AS "rawPayloadHash",
            raw_ingest_version AS "rawIngestVersion",
            actor,
            governance_version AS "governanceVersion",
            created_at AS "createdAt"
          FROM raw_source_governance_disposition
          WHERE workspace_id = ${reference.workspaceId}::uuid
            AND provider_key = 'usaspending_awards'
          ORDER BY created_at ASC
        `;
          usaGovernanceHistory = { status: "CAPTURED", rows };
        }
      }

      return {
        run,
        raw,
        links,
        companies,
        identifiers,
        fieldEvidence,
        leads,
        quality,
        outbox,
        usaGovernanceHistory,
      };
    },
    { maxWait: 10_000, timeout: 60_000 },
  );

  const eventTypeCounts = countBy(
    evidence.outbox.map((event) => event.eventType),
  );
  const leadQualifiedCount = eventTypeCounts.LeadQualified ?? 0;

  return {
    channel: definition.channel,
    runSelector: definition.runSelector,
    provider,
    sourcePolicy,
    run: {
      id: evidence.run.id,
      workspaceId: evidence.run.workspaceId,
      planId: evidence.run.planId,
      icpId: evidence.run.icpId,
      status: evidence.run.status,
      stats: sanitizeForEvidence(evidence.run.stats),
      createdAt: evidence.run.createdAt,
      completedAt: evidence.run.completedAt,
    },
    raw: {
      count: evidence.raw.length,
      ingestStatusCounts: countBy(evidence.raw.map((row) => row.ingestStatus)),
      rows: evidence.raw.map(({ payload, ...row }) => ({
        ...row,
        payloadDigest: sha256Json(payload),
        payloadCaptured: false,
      })),
    },
    identity: {
      linkCount: evidence.links.length,
      linkStatusCounts: countBy(evidence.links.map((link) => link.status)),
      links: evidence.links,
      identifierCount: evidence.identifiers.length,
      identifierStatusCounts: countBy(
        evidence.identifiers.map((identifier) => identifier.status),
      ),
      identifiers: evidence.identifiers,
    },
    canonicalCompanies: {
      count: evidence.companies.length,
      rows: evidence.companies,
    },
    fieldEvidence: {
      count: evidence.fieldEvidence.length,
      rows: evidence.fieldEvidence.map(({ value, ...row }) => ({
        ...row,
        valueDigest: sha256Json(value),
        valueCaptured: false,
      })),
    },
    leads: {
      count: evidence.leads.length,
      rows: evidence.leads,
    },
    qualityLedger: {
      count: evidence.quality.length,
      rows: evidence.quality,
    },
    outbox: {
      scope: "RUN_WORKSPACE",
      count: evidence.outbox.length,
      eventTypeCounts,
      publishedCount: evidence.outbox.filter(
        (event) => event.publishedAt !== null,
      ).length,
      parkedCount: evidence.outbox.filter((event) => event.parkedAt !== null)
        .length,
      leadQualifiedCount,
      leadQualifiedProduced: leadQualifiedCount > 0,
      rows: evidence.outbox,
      payloadCaptured: false,
    },
    usaHistoricalGovernanceDisposition:
      definition.channel === "usaspending_awards"
        ? {
            scope: "PROVIDER_IN_RUN_WORKSPACE_INCLUDING_HISTORY",
            status: evidence.usaGovernanceHistory.status,
            blocked: evidence.usaGovernanceHistory.status === "NOT_IMPLEMENTED",
            count: evidence.usaGovernanceHistory.rows.length,
            effectCounts: countBy(
              evidence.usaGovernanceHistory.rows.map((row) =>
                String(row.effect),
              ),
            ),
            reasonCounts: countBy(
              evidence.usaGovernanceHistory.rows.map((row) =>
                String(row.reasonCode),
              ),
            ),
            rows: evidence.usaGovernanceHistory.rows,
          }
        : null,
  };
}

function parseCanonicalRunManifest(
  raw: string | undefined,
): CanonicalRunReference[] {
  if (!raw) {
    throw new Error(
      "Refusing acceptance capture: ACQUISITION_ACCEPTANCE_RUN_MANIFEST is required for RLS-scoped reads.",
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(
      "Refusing acceptance capture: canonical run manifest is invalid JSON.",
    );
  }
  if (!Array.isArray(value) || value.length !== CANONICAL_RUNS.length) {
    throw new Error(
      "Refusing acceptance capture: canonical run manifest must contain exactly four entries.",
    );
  }
  const uuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
  return CANONICAL_RUNS.map((definition) => {
    const match = value.find(
      (entry) => isJsonRecord(entry) && entry.channel === definition.channel,
    );
    if (
      !isJsonRecord(match) ||
      typeof match.runId !== "string" ||
      typeof match.workspaceId !== "string" ||
      !uuid.test(match.runId) ||
      !uuid.test(match.workspaceId) ||
      !match.runId.toLowerCase().startsWith(definition.runSelector)
    ) {
      throw new Error(
        `Refusing acceptance capture: invalid manifest entry for ${definition.channel}.`,
      );
    }
    return {
      channel: definition.channel,
      runId: match.runId,
      workspaceId: match.workspaceId,
    };
  });
}

async function captureLiveEvidence(
  databaseUrl: string,
  database: DatabaseAdmission,
): Promise<unknown> {
  const { PrismaClient } = await import("@prisma/client");
  const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
  const apiOrigin = assertLoopbackApiOrigin(
    process.env.ACQUISITION_ACCEPTANCE_API_ORIGIN ?? "http://127.0.0.1:3000",
  );
  const runManifest = parseCanonicalRunManifest(
    process.env.ACQUISITION_ACCEPTANCE_RUN_MANIFEST,
  );
  const governanceWorkspaceManifest = parseGovernanceWorkspaceManifest(
    process.env.ACQUISITION_ACCEPTANCE_GOVERNANCE_WORKSPACE_MANIFEST,
  );
  try {
    await prisma.$connect();
    const [connectionIdentity] = await prisma.$queryRaw<ConnectionIdentity[]>`
      SELECT current_database() AS database_name,
             current_user AS current_user,
             role.rolsuper AS superuser,
             role.rolbypassrls AS bypass_rls
      FROM pg_roles role
      WHERE role.rolname = current_user
    `;
    const admittedDatabase = assertConnectionIdentity(
      database,
      connectionIdentity,
    );
    const [ready, build] = await Promise.all([
      fetchHealth(apiOrigin, "/api/v1/health/ready"),
      fetchHealth(apiOrigin, "/api/v1/health/build"),
    ]);
    const historicalGovernance = await captureHistoricalGovernance(
      prisma,
      governanceWorkspaceManifest,
    );
    const channels = [];
    for (const [index, definition] of CANONICAL_RUNS.entries()) {
      channels.push(
        await captureChannel(prisma, definition, runManifest[index]),
      );
    }
    return buildAcceptanceEnvelope({
      capturedAt: new Date().toISOString(),
      git: readGitCapture(),
      database: admittedDatabase,
      health: { ready, build },
      channels,
      historicalGovernance,
    });
  } finally {
    await prisma.$disconnect();
  }
}

async function writeEvidence(document: unknown): Promise<void> {
  const destination = resolve(EVIDENCE_FILE);
  const pathWithinEvidenceDirectory = relative(
    resolve(EVIDENCE_DIRECTORY),
    destination,
  );
  if (
    pathWithinEvidenceDirectory.startsWith("..") ||
    isAbsolute(pathWithinEvidenceDirectory)
  ) {
    throw new Error(
      "Refusing acceptance capture: evidence destination escaped the acquisition evidence directory.",
    );
  }
  const serialized = `${JSON.stringify(sanitizeForEvidence(document), null, 2)}\n`;
  if (/\b(?:https?|postgres(?:ql)?|mysql|redis):\/\//iu.test(serialized)) {
    throw new Error(
      "Refusing acceptance capture: URL-like material remained after sanitization.",
    );
  }
  await mkdir(EVIDENCE_DIRECTORY, { recursive: true });
  await writeFile(destination, serialized, {
    encoding: "utf8",
    mode: 0o600,
    flag: "w",
  });
}

async function main(): Promise<void> {
  parseCaptureInvocation(process.argv.slice(2));
  await import("dotenv/config");
  const databaseUrl = process.env.ACQUISITION_ACCEPTANCE_DATABASE_URL;
  const database = assertAcceptanceDatabaseUrl(databaseUrl);
  const document = await captureLiveEvidence(databaseUrl as string, database);
  await writeEvidence(document);
  process.stdout.write(
    `${JSON.stringify({ written: true, path: relative(REPOSITORY_ROOT, EVIDENCE_FILE) })}\n`,
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
