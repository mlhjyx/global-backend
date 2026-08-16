import { createHash } from "node:crypto";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { constants as fsConstants, existsSync } from "node:fs";
import { open, unlink } from "node:fs/promises";
import { connect } from "node:net";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Canonical local acquisition-acceptance runtime entrypoint.
 *
 * Database credentials must be supplied only through the two dedicated
 * ACQUISITION_ACCEPTANCE_* process variables. Generic .env DATABASE_URL values
 * are intentionally ignored so a normal development database cannot be
 * mistaken for the acceptance data plane.
 */

export const RUNTIME_STATE_SCHEMA =
  "local-acquisition-acceptance-runtime/v1" as const;

type RuntimeCommand = "start" | "status" | "stop";
type JsonRecord = Record<string, unknown>;

export interface AcceptanceRuntimeConfig {
  ownerDatabaseUrl: string;
  appDatabaseUrl: string;
  databaseName: "global_identity_fresh2_acceptance";
  databasePort: 55432;
  temporalAddress: "127.0.0.1:7234";
  apiOrigin: "http://127.0.0.1:3000";
}

export interface RuntimePidState {
  schemaVersion: typeof RUNTIME_STATE_SCHEMA;
  repositoryRoot: string;
  startedAt: string;
  apiPid: number;
  workerPid: number;
}

interface ProviderSwitchRow {
  key: string;
  status: string;
}

interface SourcePolicyRow {
  domain: string;
  sourceType: string;
  accessMode: string;
  reviewStatus: string;
  robotsStatus: string;
  termsStatus: string;
  personalData: boolean;
  allowedPurpose: unknown;
  retentionDays: number;
}

interface RoleRow {
  currentDatabase: string;
  currentUser: string;
  superuser: boolean;
  bypassrls: boolean;
}

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const API_ROOT = resolve(dirname(SCRIPT_PATH), "..");
const REPOSITORY_ROOT = resolve(API_ROOT, "..", "..");
const API_ENTRY = resolve(API_ROOT, "dist/main.js");
const WORKER_ENTRY = resolve(API_ROOT, "dist/temporal/worker.js");
const STATE_HASH = createHash("sha256")
  .update(REPOSITORY_ROOT)
  .digest("hex")
  .slice(0, 12);
const STATE_PATH = `/private/tmp/global-backend-acquisition-runtime-${STATE_HASH}.json`;
const EXPECTED_DATABASE = "global_identity_fresh2_acceptance";
const EXPECTED_DATABASE_PORT = 55_432;
const EXPECTED_TEMPORAL_ADDRESS = "127.0.0.1:7234";
const EXPECTED_API_ORIGIN = "http://127.0.0.1:3000";
const ACCEPTANCE_OWNER_DATABASE_ENV =
  "ACQUISITION_ACCEPTANCE_OWNER_DATABASE_URL";
const ACCEPTANCE_APP_DATABASE_ENV = "ACQUISITION_ACCEPTANCE_APP_DATABASE_URL";
const TRACKED_PROVIDERS = [
  "nppes",
  "world_bank_procurement",
  "usaspending_awards",
  "uk_contracts_finder",
  "singapore_gebiz",
  "brazil_pncp",
  "ror",
  "sec_edgar",
  "mexico_denue",
  "fmcsa_qcmobile",
  "eu_ecolabel",
  "sbir_sttr_companies",
  "koneps",
] as const;
const MUST_REMAIN_DISABLED = [
  "singapore_gebiz",
  "brazil_pncp",
  "ror",
  "sec_edgar",
  "mexico_denue",
  "fmcsa_qcmobile",
  "eu_ecolabel",
  "sbir_sttr_companies",
  "koneps",
] as const;
const MUST_REMAIN_ENABLED = [
  "nppes",
  "world_bank_procurement",
  "usaspending_awards",
  "uk_contracts_finder",
] as const;
const REQUIRED_SOURCE_POLICIES = [
  {
    domain: "npiregistry.cms.hhs.gov",
    sourceType: "company_registry",
    personalData: true,
    allowedPurpose: ["discovery", "enrichment"],
  },
  {
    domain: "search.worldbank.org",
    sourceType: "gov_opportunity",
    personalData: true,
    allowedPurpose: ["discovery"],
  },
  {
    domain: "api.usaspending.gov",
    sourceType: "gov_award",
    personalData: true,
    allowedPurpose: ["discovery"],
  },
  {
    domain: "www.contractsfinder.service.gov.uk",
    sourceType: "gov_opportunity",
    personalData: true,
    allowedPurpose: ["discovery"],
  },
  {
    domain: "data.gov.sg",
    sourceType: "gov_award",
    personalData: true,
    allowedPurpose: ["discovery"],
  },
  {
    domain: "pncp.gov.br",
    sourceType: "gov_opportunity",
    personalData: true,
    allowedPurpose: ["discovery"],
  },
  {
    domain: "api.ror.org",
    sourceType: "company_registry",
    personalData: false,
    allowedPurpose: ["discovery"],
  },
  {
    domain: "www.sec.gov",
    sourceType: "company_registry",
    personalData: false,
    allowedPurpose: ["discovery"],
  },
  {
    domain: "data.sec.gov",
    sourceType: "company_registry",
    personalData: true,
    allowedPurpose: ["enrichment"],
  },
  {
    domain: "www.inegi.org.mx",
    sourceType: "company_registry",
    personalData: true,
    allowedPurpose: ["discovery"],
  },
  {
    domain: "mobile.fmcsa.dot.gov",
    sourceType: "company_registry",
    personalData: true,
    allowedPurpose: ["discovery"],
    reviewStatus: "SUSPENDED",
    termsStatus: "UNREVIEWED",
  },
  {
    domain: "apps.data.env.service.ec.europa.eu",
    sourceType: "certification",
    personalData: true,
    allowedPurpose: ["discovery"],
  },
  {
    domain: "api.www.sbir.gov",
    sourceType: "gov_award",
    personalData: true,
    allowedPurpose: ["discovery"],
    reviewStatus: "SUSPENDED",
    termsStatus: "UNREVIEWED",
  },
  {
    domain: "apis.data.go.kr",
    sourceType: "gov_award",
    personalData: true,
    allowedPurpose: ["discovery"],
    reviewStatus: "SUSPENDED",
    termsStatus: "UNREVIEWED",
  },
] as const;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function safeFailureEnvelope(_error: unknown) {
  return {
    status: "blocked" as const,
    code: "acceptance_runtime_command_failed" as const,
  };
}

export function parseRuntimeCommand(argv: readonly string[]): RuntimeCommand {
  if (
    argv.length !== 1 ||
    !["start", "status", "stop"].includes(argv[0] ?? "")
  ) {
    throw new Error(
      "usage: local-acquisition-acceptance-runtime.mts start|status|stop",
    );
  }
  return argv[0] as RuntimeCommand;
}

function parseDatabaseUrl(
  label: string,
  value: string | undefined,
  expectedUsername: "global" | "app_user",
) {
  if (!value) throw new Error(`${label} is required`);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid PostgreSQL URL`);
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error(`${label} must use PostgreSQL`);
  }
  if (parsed.search)
    throw new Error(`${label} must not contain query parameters`);
  if (parsed.hash) throw new Error(`${label} must not contain a fragment`);
  const username = decodeURIComponent(parsed.username);
  if (username !== expectedUsername) {
    throw new Error(
      `${label} must use ${expectedUsername === "global" ? "owner role global" : "app role app_user"}`,
    );
  }
  if (!parsed.password) throw new Error(`${label} must include a credential`);
  const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
  if (!loopbackHosts.has(parsed.hostname.toLowerCase())) {
    throw new Error(`${label} must target loopback`);
  }
  const port = Number(parsed.port || "5432");
  if (port !== EXPECTED_DATABASE_PORT) {
    throw new Error(`${label} must target port 55432`);
  }
  const database = decodeURIComponent(
    parsed.pathname.replace(/^\/+|\/+$/gu, ""),
  );
  if (database !== EXPECTED_DATABASE) {
    throw new Error(`${label} must target ${EXPECTED_DATABASE}`);
  }
  return {
    url: value,
    host: parsed.hostname.toLowerCase(),
    port,
    database,
    username,
  };
}

export function assertAcceptanceRuntimeConfig(
  env: Record<string, string | undefined>,
): AcceptanceRuntimeConfig {
  const owner = parseDatabaseUrl(
    ACCEPTANCE_OWNER_DATABASE_ENV,
    env[ACCEPTANCE_OWNER_DATABASE_ENV],
    "global",
  );
  const app = parseDatabaseUrl(
    ACCEPTANCE_APP_DATABASE_ENV,
    env[ACCEPTANCE_APP_DATABASE_ENV],
    "app_user",
  );
  const canonicalHost = (host: string) =>
    host === "localhost" ? "127.0.0.1" : host.replace(/^\[|\]$/gu, "");
  if (
    canonicalHost(owner.host) !== canonicalHost(app.host) ||
    owner.port !== app.port ||
    owner.database !== app.database
  ) {
    throw new Error(
      `${ACCEPTANCE_OWNER_DATABASE_ENV} and ${ACCEPTANCE_APP_DATABASE_ENV} must target the same database target`,
    );
  }
  return Object.freeze({
    ownerDatabaseUrl: owner.url,
    appDatabaseUrl: app.url,
    databaseName: EXPECTED_DATABASE,
    databasePort: EXPECTED_DATABASE_PORT,
    temporalAddress: EXPECTED_TEMPORAL_ADDRESS,
    apiOrigin: EXPECTED_API_ORIGIN,
  });
}

/**
 * Child-only overrides. Both dist entries import `dotenv/config`, so merely
 * allowlisting the parent environment is insufficient: without an explicit
 * path, dotenv would repopulate webhook/API credentials from apps/api/.env.
 * Point every managed child at the empty device before either entry imports.
 */
export function buildChildEnvironment(
  input: Record<string, string | undefined>,
  config: AcceptanceRuntimeConfig,
): NodeJS.ProcessEnv {
  const output: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "TMPDIR", "LANG", "LC_ALL", "TZ", "NO_COLOR"])
    if (input[key] !== undefined) output[key] = input[key];
  return {
    ...output,
    DATABASE_URL: config.ownerDatabaseUrl,
    APP_DATABASE_URL: config.appDatabaseUrl,
    TEMPORAL_ADDRESS: config.temporalAddress,
    TEMPORAL_NAMESPACE: "default",
    API_BIND_HOST: "127.0.0.1",
    PORT: "3000",
    APP_ENVIRONMENT: "development",
    NODE_ENV: "development",
    AUTH_ALLOW_DEV_TOKENS: "true",
    MODEL_ALLOW_STUB: "true",
    DOTENV_CONFIG_PATH: "/dev/null",
    DOTENV_CONFIG_QUIET: "true",
  };
}

/** Secret-bearing source credentials are scoped to the Worker only. */
export function buildWorkerEnvironment(
  input: Record<string, string | undefined>,
  config: AcceptanceRuntimeConfig,
): NodeJS.ProcessEnv {
  const env = buildChildEnvironment(input, config);
  const denueToken = input.MEXICO_DENUE_TOKEN?.trim();
  if (denueToken) env.MEXICO_DENUE_TOKEN = denueToken;
  const fmcsaWebKey = input.FMCSA_QCMOBILE_WEB_KEY?.trim();
  if (fmcsaWebKey) env.FMCSA_QCMOBILE_WEB_KEY = fmcsaWebKey;
  const konepsServiceKey = input.KONEPS_SERVICE_KEY?.trim();
  if (konepsServiceKey) env.KONEPS_SERVICE_KEY = konepsServiceKey;
  const serperApiKey = input.SERPER_API_KEY?.trim();
  if (serperApiKey) env.SERPER_API_KEY = serperApiKey;
  const braveSearchApiKey = input.BRAVE_SEARCH_API_KEY?.trim();
  if (braveSearchApiKey) env.BRAVE_SEARCH_API_KEY = braveSearchApiKey;
  const publicWebSearchBackends = input.PUBLIC_WEB_SEARCH_BACKENDS?.trim();
  if (publicWebSearchBackends) {
    env.PUBLIC_WEB_SEARCH_BACKENDS = publicWebSearchBackends;
  }
  return env;
}

export function shouldRetainPidState(remainingPids: readonly unknown[]) {
  return remainingPids.length > 0;
}

export function commandExitCode(
  command: RuntimeCommand,
  result: JsonRecord,
): 0 | 1 {
  if (command === "stop") {
    const blockers = Array.isArray(result.finalInvariantBlockers)
      ? result.finalInvariantBlockers
      : ["provider_final_state_unproven"];
    return result.stopped === true && blockers.length === 0 ? 0 : 1;
  }
  return result.status === "ready" ? 0 : 1;
}

export function serializePidState(state: RuntimePidState): string {
  return `${JSON.stringify(
    {
      schemaVersion: state.schemaVersion,
      repositoryRoot: state.repositoryRoot,
      startedAt: state.startedAt,
      apiPid: state.apiPid,
      workerPid: state.workerPid,
    },
    null,
    2,
  )}\n`;
}

function parsePidState(value: unknown): RuntimePidState {
  if (!isRecord(value)) throw new Error("PID state must be a JSON object");
  const allowed = [
    "schemaVersion",
    "repositoryRoot",
    "startedAt",
    "apiPid",
    "workerPid",
  ];
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0)
    throw new Error("PID state contains unexpected fields");
  if (
    value.schemaVersion !== RUNTIME_STATE_SCHEMA ||
    value.repositoryRoot !== REPOSITORY_ROOT
  ) {
    throw new Error(
      "PID state does not belong to the current worktree runtime",
    );
  }
  if (
    typeof value.startedAt !== "string" ||
    new Date(value.startedAt).toISOString() !== value.startedAt
  ) {
    throw new Error("PID state has an invalid startedAt");
  }
  if (!Number.isSafeInteger(value.apiPid) || Number(value.apiPid) <= 1)
    throw new Error("PID state has an invalid API PID");
  if (!Number.isSafeInteger(value.workerPid) || Number(value.workerPid) <= 1)
    throw new Error("PID state has an invalid Worker PID");
  return value as unknown as RuntimePidState;
}

export function assertManagedPidCommand(
  command: string,
  expectedEntry: string,
): void {
  const tokens = command.trim().split(/\s+/u);
  if (
    !tokens[0] ||
    basename(tokens[0]).replace(/\.exe$/u, "") !== "node" ||
    tokens[1] !== expectedEntry
  ) {
    throw new Error(
      "refusing TERM: PID command is not the exact current worktree dist entry",
    );
  }
}

export function buildProviderSwitchReport(rows: readonly ProviderSwitchRow[]) {
  const statuses = Object.fromEntries(
    TRACKED_PROVIDERS.map((key) => [key, "MISSING"]),
  ) as Record<string, string>;
  for (const row of rows) {
    if ((TRACKED_PROVIDERS as readonly string[]).includes(row.key))
      statuses[row.key] = row.status;
  }
  const blockers = MUST_REMAIN_DISABLED.filter(
    (key) => statuses[key] !== "DISABLED",
  ).map((key) => `provider_${key}_must_remain_disabled`);
  blockers.push(
    ...MUST_REMAIN_ENABLED.filter((key) => statuses[key] !== "ENABLED").map(
      (key) => `provider_${key}_must_be_enabled`,
    ),
  );
  return { statuses, blockers };
}

function blockerDomain(domain: string): string {
  return domain.replace(/[^a-z0-9]+/giu, "_").replace(/^_+|_+$/gu, "");
}

export function buildSourcePolicyReport(rows: readonly SourcePolicyRow[]) {
  const byDomain = new Map(rows.map((row) => [row.domain, row]));
  const blockers: string[] = [];
  const policies: Record<
    string,
    {
      sourceType: string;
      accessMode: string;
      reviewStatus: string;
      robotsStatus: string;
      termsStatus: string;
      personalData: boolean;
      allowedPurpose: string[];
      retentionDays: number;
    }
  > = {};
  for (const expected of REQUIRED_SOURCE_POLICIES) {
    const row = byDomain.get(expected.domain);
    const key = blockerDomain(expected.domain);
    if (!row) {
      blockers.push(`source_policy_${key}_missing`);
      continue;
    }
    const allowedPurpose = Array.isArray(row.allowedPurpose)
      ? row.allowedPurpose.filter(
          (purpose): purpose is string => typeof purpose === "string",
        )
      : [];
    policies[expected.domain] = {
      sourceType: row.sourceType,
      accessMode: row.accessMode,
      reviewStatus: row.reviewStatus,
      robotsStatus: row.robotsStatus,
      termsStatus: row.termsStatus,
      personalData: row.personalData,
      allowedPurpose,
      retentionDays: row.retentionDays,
    };
    const exactPurposes =
      [...allowedPurpose].sort().join(",") ===
      [...expected.allowedPurpose].sort().join(",");
    const checks = [
      [row.sourceType === expected.sourceType, "source_type_mismatch"],
      [row.accessMode === "api", "access_mode_mismatch"],
      [
        row.reviewStatus ===
          ("reviewStatus" in expected ? expected.reviewStatus : "APPROVED"),
        "review_status_mismatch",
      ],
      [row.robotsStatus === "ALLOWS", "robots_status_mismatch"],
      [
        row.termsStatus ===
          ("termsStatus" in expected ? expected.termsStatus : "REVIEWED_OK"),
        "terms_status_mismatch",
      ],
      [row.personalData === expected.personalData, "personal_data_mismatch"],
      [exactPurposes, "allowed_purpose_mismatch"],
      [row.retentionDays === 365, "retention_days_mismatch"],
    ] as const;
    for (const [ok, suffix] of checks)
      if (!ok) blockers.push(`source_policy_${key}_${suffix}`);
  }
  return { policies, blockers };
}

export function buildAttestationBlockers(input: {
  gitClean: boolean;
  runtimeAttested: boolean;
  exactSourceProven: boolean;
  linuxProcfsAvailable: boolean;
}): string[] {
  const blockers: string[] = [];
  if (!input.gitClean) blockers.push("dirty_worktree");
  if (!input.runtimeAttested) blockers.push("runtime_build_unattested");
  if (!input.exactSourceProven)
    blockers.push("running_executable_exact_source_unproven");
  if (!input.linuxProcfsAvailable) blockers.push("linux_procfs_unavailable");
  return blockers;
}

/**
 * Operational success requires a valid receipt whose build SHA is the current
 * repository HEAD. The launcher consumes this evidence but never creates it.
 */
export function buildCurrentHeadAttestationBlockers(input: {
  runtimeAttested: boolean;
  buildShaMatchesHead: boolean | null;
}): string[] {
  if (!input.runtimeAttested) return ["runtime_build_unattested"];
  if (input.buildShaMatchesHead !== true)
    return ["runtime_build_sha_mismatch"];
  return [];
}

export function buildOperationalStatus(input: {
  databaseBlockers: readonly string[];
  attestationBlockers?: readonly string[];
  temporalReachable: boolean;
  apiLive: boolean;
  apiReady: boolean;
  statePresent: boolean;
  processesManaged: boolean;
}): { status: "ready" | "not_ready"; blockers: string[] } {
  const blockers = [
    ...input.databaseBlockers,
    ...(input.attestationBlockers ?? []),
    ...(!input.temporalReachable
      ? ["temporal_127_0_0_1_7234_unreachable"]
      : []),
    ...(!input.apiLive ? ["api_live_health_failed"] : []),
    ...(!input.apiReady ? ["api_readiness_not_ready"] : []),
    ...(!input.statePresent ? ["pid_state_missing"] : []),
    ...(input.statePresent && !input.processesManaged
      ? ["pid_state_not_fully_managed"]
      : []),
  ];
  return { status: blockers.length === 0 ? "ready" : "not_ready", blockers };
}

async function readState(): Promise<RuntimePidState | undefined> {
  let handle;
  try {
    handle = await open(
      STATE_PATH,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 8 * 1024)
      throw new Error("PID state must be a small regular file");
    return parsePidState(
      JSON.parse((await handle.readFile("utf8")) as string) as unknown,
    );
  } finally {
    await handle.close();
  }
}

async function writeState(state: RuntimePidState): Promise<void> {
  const handle = await open(
    STATE_PATH,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
    0o600,
  );
  try {
    await handle.writeFile(serializePidState(state), "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function pidCommand(pid: number): string | undefined {
  const result = spawnSync("ps", ["-p", String(pid), "-o", "command="], {
    encoding: "utf8",
  });
  if (result.status !== 0) return undefined;
  return result.stdout.trim() || undefined;
}

function inspectManagedProcess(pid: number, entry: string) {
  if (!pidAlive(pid)) return { pid, live: false, managed: false };
  const command = pidCommand(pid);
  if (!command)
    return {
      pid,
      live: true,
      managed: false,
      blocker: "pid_command_unavailable",
    };
  try {
    assertManagedPidCommand(command, entry);
    return { pid, live: true, managed: true };
  } catch {
    return {
      pid,
      live: true,
      managed: false,
      blocker: "pid_command_not_current_worktree_dist",
    };
  }
}

async function tcpProbe(
  host: string,
  port: number,
  timeoutMs = 2_000,
): Promise<boolean> {
  return await new Promise<boolean>((settle) => {
    const socket = connect({ host, port });
    const done = (result: boolean) => {
      socket.destroy();
      settle(result);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

async function fetchJson(path: string) {
  try {
    const response = await fetch(`${EXPECTED_API_ORIGIN}${path}`, {
      redirect: "error",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(3_000),
    });
    const text = (await response.text()).slice(0, 64 * 1024);
    let body: unknown = text;
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      /* retain bounded non-JSON response */
    }
    return { ok: response.ok, status: response.status, body };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      body: { error: error instanceof Error ? error.name : "UnknownError" },
    };
  }
}

function gitIdentity() {
  const head = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
  }).trim();
  const dirty = execFileSync(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    {
      cwd: REPOSITORY_ROOT,
      encoding: "utf8",
    },
  )
    .split("\n")
    .filter(Boolean).length;
  return { head, clean: dirty === 0, changedPathCount: dirty };
}

async function openDatabaseClients(config: AcceptanceRuntimeConfig) {
  const { PrismaClient } = await import("@prisma/client");
  return {
    owner: new PrismaClient({ datasourceUrl: config.ownerDatabaseUrl }),
    app: new PrismaClient({ datasourceUrl: config.appDatabaseUrl }),
  };
}

async function seedDatabaseGovernance(
  config: AcceptanceRuntimeConfig,
): Promise<void> {
  const { PrismaClient } = await import("@prisma/client");
  const owner = new PrismaClient({ datasourceUrl: config.ownerDatabaseUrl });
  try {
    await owner.$connect();
    const roles = await owner.$queryRawUnsafe<RoleRow[]>(
      `SELECT current_database() AS "currentDatabase",
              current_user AS "currentUser",
              role.rolsuper AS superuser,
              role.rolbypassrls AS bypassrls
         FROM pg_roles AS role
        WHERE role.rolname = current_user`,
    );
    const role = roles[0];
    if (
      !role ||
      role.currentDatabase !== EXPECTED_DATABASE ||
      role.currentUser !== "global"
    ) {
      throw new Error("governance seed target or owner role is not proven");
    }
    const { DiscoveryProviderRegistry } =
      await import("../src/discovery/provider.registry");
    await owner.$transaction(async (tx) => {
      await new DiscoveryProviderRegistry().seed(tx);
    });
  } finally {
    await owner.$disconnect();
  }
}

async function inspectDatabase(config: AcceptanceRuntimeConfig) {
  const clients = await openDatabaseClients(config);
  try {
    await Promise.all([clients.owner.$connect(), clients.app.$connect()]);
    const roleSql = `SELECT current_database() AS "currentDatabase",
                            current_user AS "currentUser",
                            role.rolsuper AS superuser,
                            role.rolbypassrls AS bypassrls
                       FROM pg_roles AS role
                      WHERE role.rolname = current_user`;
    const [ownerRows, appRows, providers, sourcePolicies, heartbeats] =
      await Promise.all([
        clients.owner.$queryRawUnsafe<RoleRow[]>(roleSql),
        clients.app.$queryRawUnsafe<RoleRow[]>(roleSql),
        clients.owner.$queryRawUnsafe<ProviderSwitchRow[]>(
          `SELECT key, status
           FROM data_provider
          WHERE key IN (
            'nppes',
            'world_bank_procurement',
            'usaspending_awards',
            'uk_contracts_finder',
            'singapore_gebiz',
            'brazil_pncp',
            'ror',
            'sec_edgar',
            'mexico_denue',
            'fmcsa_qcmobile',
            'eu_ecolabel',
            'sbir_sttr_companies',
            'koneps'
          )
          ORDER BY key`,
        ),
        clients.owner.$queryRawUnsafe<SourcePolicyRow[]>(
          `SELECT domain,
                source_type AS "sourceType",
                access_mode AS "accessMode",
                review_status AS "reviewStatus",
                robots_status AS "robotsStatus",
                terms_status AS "termsStatus",
                personal_data AS "personalData",
                allowed_purpose AS "allowedPurpose",
                retention_days AS "retentionDays"
           FROM source_policy
          WHERE domain IN (
            'npiregistry.cms.hhs.gov',
            'search.worldbank.org',
            'api.usaspending.gov',
            'www.contractsfinder.service.gov.uk',
            'data.gov.sg',
            'pncp.gov.br',
            'api.ror.org',
            'www.sec.gov',
            'data.sec.gov',
            'www.inegi.org.mx',
            'mobile.fmcsa.dot.gov',
            'apps.data.env.service.ec.europa.eu',
            'api.www.sbir.gov',
            'apis.data.go.kr'
          )
          ORDER BY domain`,
        ),
        clients.owner.$queryRawUnsafe<
          Array<{
            component: string;
            state: string;
            heartbeatAt: Date;
            ageMs: number;
          }>
        >(
          `SELECT DISTINCT ON (component)
                component,
                state,
                heartbeat_at AS "heartbeatAt",
                GREATEST(0, EXTRACT(EPOCH FROM (clock_timestamp() - heartbeat_at)) * 1000)::double precision AS "ageMs"
           FROM runtime_component_heartbeat
          WHERE component IN ('WORKER', 'OUTBOX_RELAY')
          ORDER BY component, (state = 'RUNNING') DESC, heartbeat_at DESC`,
        ),
      ]);
    const owner = ownerRows[0];
    const app = appRows[0];
    const targetOk = Boolean(
      owner &&
      app &&
      owner.currentDatabase === EXPECTED_DATABASE &&
      app.currentDatabase === EXPECTED_DATABASE,
    );
    const appRoleOk = Boolean(
      app && app.currentUser === "app_user" && !app.superuser && !app.bypassrls,
    );
    const ownerRoleOk = Boolean(
      owner &&
      owner.currentUser === "global" &&
      owner.currentUser !== app?.currentUser,
    );
    const providerSwitches = buildProviderSwitchReport(providers);
    const sourcePolicy = buildSourcePolicyReport(sourcePolicies);
    return {
      target: {
        ok: targetOk,
        database: EXPECTED_DATABASE,
        port: EXPECTED_DATABASE_PORT,
        ownerRole: owner?.currentUser ?? "UNPROVEN",
        appRole: app?.currentUser ?? "UNPROVEN",
      },
      appRole: {
        ok: appRoleOk,
        role: app?.currentUser ?? "UNPROVEN",
        superuser: app?.superuser ?? null,
        bypassrls: app?.bypassrls ?? null,
      },
      ownerRole: {
        ok: ownerRoleOk,
        role: owner?.currentUser ?? "UNPROVEN",
      },
      providerSwitches,
      sourcePolicy,
      heartbeats: Object.fromEntries(
        heartbeats.map((row) => [
          row.component,
          {
            state: row.state,
            heartbeatAt: row.heartbeatAt.toISOString(),
            ageMs: Math.round(Number(row.ageMs)),
          },
        ]),
      ),
      blockers: [
        ...(!targetOk ? ["database_target_not_proven"] : []),
        ...(!ownerRoleOk ? ["owner_role_not_proven"] : []),
        ...(!appRoleOk ? ["app_user_rls_role_not_proven"] : []),
        ...providerSwitches.blockers,
        ...sourcePolicy.blockers,
      ],
    };
  } finally {
    await Promise.allSettled([
      clients.owner.$disconnect(),
      clients.app.$disconnect(),
    ]);
  }
}

function runtimeAttestation(
  health: Awaited<ReturnType<typeof fetchJson>>,
  git: ReturnType<typeof gitIdentity>,
) {
  const body =
    isRecord(health.body) && isRecord(health.body.build)
      ? health.body.build
      : undefined;
  const attested = body?.attested === true;
  const buildSha = typeof body?.build_sha === "string" ? body.build_sha : null;
  return {
    reported: attested,
    buildShaMatchesHead: buildSha === null ? null : buildSha === git.head,
    exactSourceProven: git.clean && attested && buildSha === git.head,
  };
}

async function collectStatus(config: AcceptanceRuntimeConfig) {
  const [state, database, live, ready, build, temporalReachable] =
    await Promise.all([
      readState(),
      inspectDatabase(config).catch(() => ({
        target: {
          ok: false,
          database: EXPECTED_DATABASE,
          port: EXPECTED_DATABASE_PORT,
          ownerRole: "UNPROVEN",
          appRole: "UNPROVEN",
        },
        appRole: {
          ok: false,
          role: "UNPROVEN",
          superuser: null,
          bypassrls: null,
        },
        ownerRole: { ok: false, role: "UNPROVEN" },
        providerSwitches: buildProviderSwitchReport([]),
        sourcePolicy: buildSourcePolicyReport([]),
        heartbeats: {},
        blockers: ["database_inspection_failed"],
      })),
      fetchJson("/api/v1/health/live"),
      fetchJson("/api/v1/health/ready"),
      fetchJson("/api/v1/health/build"),
      tcpProbe("127.0.0.1", 7_234),
    ]);
  const git = gitIdentity();
  const attestation = runtimeAttestation(build, git);
  const linuxProcfsAvailable = existsSync("/proc/self/fd");
  const attestationBlockers = buildAttestationBlockers({
    gitClean: git.clean,
    runtimeAttested: attestation.reported,
    exactSourceProven: attestation.exactSourceProven,
    linuxProcfsAvailable,
  });
  const currentHeadAttestationBlockers =
    buildCurrentHeadAttestationBlockers({
      runtimeAttested: attestation.reported,
      buildShaMatchesHead: attestation.buildShaMatchesHead,
    });
  const processes = state
    ? {
        api: inspectManagedProcess(state.apiPid, API_ENTRY),
        worker: inspectManagedProcess(state.workerPid, WORKER_ENTRY),
      }
    : {
        api: { live: false, managed: false },
        worker: { live: false, managed: false },
      };
  const operational = buildOperationalStatus({
    databaseBlockers: database.blockers,
    attestationBlockers: currentHeadAttestationBlockers,
    temporalReachable,
    apiLive: live.ok,
    apiReady: ready.ok,
    statePresent: Boolean(state),
    processesManaged: Boolean(
      state && processes.api.managed && processes.worker.managed,
    ),
  });
  return {
    schemaVersion: RUNTIME_STATE_SCHEMA,
    status: operational.status,
    checkedAt: new Date().toISOString(),
    fixedTargets: {
      database: {
        host: "loopback",
        port: EXPECTED_DATABASE_PORT,
        name: EXPECTED_DATABASE,
      },
      temporal: EXPECTED_TEMPORAL_ADDRESS,
      api: EXPECTED_API_ORIGIN,
    },
    processState: state
      ? { startedAt: state.startedAt, ...processes }
      : { present: false },
    health: { live, ready, build },
    temporal: { reachable: temporalReachable },
    database,
    git,
    attestation: {
      ...attestation,
      releaseAttested: attestationBlockers.length === 0,
      receiptGeneratedByLauncher: false,
      blockers: attestationBlockers,
    },
    operationalBlockers: operational.blockers,
  };
}

function assertBuildInputs(): void {
  if (!existsSync(resolve(REPOSITORY_ROOT, "node_modules"))) {
    throw new Error(
      "workspace dependencies are missing; refusing to install automatically",
    );
  }
  // Do not rebuild here: Nest deletes dist before compiling, which would erase
  // an externally generated build-attestation receipt. Release evidence must
  // be produced explicitly by the build pipeline, never invented by launcher.
  for (const entry of [API_ENTRY, WORKER_ENTRY]) {
    if (!existsSync(entry))
      throw new Error(`expected dist entry is missing: ${entry}`);
  }
}

async function waitForReady(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await fetchJson("/api/v1/health/ready")).ok) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error(
    "API did not become ready before the local acceptance timeout",
  );
}

async function terminateManagedTargets(
  targets: readonly { name: string; pid: number; entry: string }[],
): Promise<string[]> {
  const inspected = targets.map((target) => ({
    ...target,
    inspection: inspectManagedProcess(target.pid, target.entry),
  }));
  const mismatches = inspected.filter(
    ({ inspection }) => inspection.live && !inspection.managed,
  );
  if (mismatches.length > 0) {
    throw new Error(
      `refusing TERM for unverified PIDs: ${mismatches.map(({ name }) => name).join(",")}`,
    );
  }
  for (const { pid, inspection } of inspected) {
    if (inspection.live) process.kill(pid, "SIGTERM");
  }
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && inspected.some(({ pid }) => pidAlive(pid))) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
  }
  return inspected.filter(({ pid }) => pidAlive(pid)).map(({ name }) => name);
}

async function startRuntime(config: AcceptanceRuntimeConfig): Promise<void> {
  const existing = await readState();
  if (existing)
    throw new Error(
      "runtime PID state already exists; inspect with status or stop first",
    );
  if (await tcpProbe("127.0.0.1", 3_000, 500))
    throw new Error("loopback API port 3000 is already in use");
  if (!(await tcpProbe("127.0.0.1", 7_234)))
    throw new Error("Temporal is not reachable at 127.0.0.1:7234");

  const beforeSeed = await inspectDatabase(config);
  const seedSafetyBlockers = [
    ...(!beforeSeed.target.ok ? ["database_target_not_proven"] : []),
    ...(!beforeSeed.ownerRole.ok ? ["owner_role_not_proven"] : []),
    ...(!beforeSeed.appRole.ok ? ["app_user_rls_role_not_proven"] : []),
  ];
  if (seedSafetyBlockers.length > 0) {
    throw new Error(
      `database seed safety preflight blocked: ${seedSafetyBlockers.join(",")}`,
    );
  }
  assertBuildInputs();
  await seedDatabaseGovernance(config);
  const database = await inspectDatabase(config);
  if (database.blockers.length > 0) {
    throw new Error(
      `database post-seed preflight blocked: ${database.blockers.join(",")}`,
    );
  }
  const apiEnv = buildChildEnvironment(process.env, config);
  const workerEnv = buildWorkerEnvironment(process.env, config);
  const api = spawn(process.execPath, [API_ENTRY], {
    cwd: API_ROOT,
    env: apiEnv,
    detached: true,
    stdio: "ignore",
  });
  const worker = spawn(process.execPath, [WORKER_ENTRY], {
    cwd: API_ROOT,
    env: workerEnv,
    detached: true,
    stdio: "ignore",
  });
  if (!api.pid || !worker.pid) {
    if (api.pid) process.kill(api.pid, "SIGTERM");
    if (worker.pid) process.kill(worker.pid, "SIGTERM");
    throw new Error("failed to allocate API and Worker PIDs");
  }
  api.unref();
  worker.unref();
  let stateWritten = false;
  try {
    await writeState({
      schemaVersion: RUNTIME_STATE_SCHEMA,
      repositoryRoot: REPOSITORY_ROOT,
      startedAt: new Date().toISOString(),
      apiPid: api.pid,
      workerPid: worker.pid,
    });
    stateWritten = true;
    await waitForReady(30_000);
  } catch (error) {
    const remaining = await terminateManagedTargets([
      { name: "worker", pid: worker.pid, entry: WORKER_ENTRY },
      { name: "api", pid: api.pid, entry: API_ENTRY },
    ]);
    if (stateWritten && !shouldRetainPidState(remaining))
      await unlink(STATE_PATH).catch(() => undefined);
    throw error;
  }
}

async function stopRuntime(
  config: AcceptanceRuntimeConfig,
): Promise<JsonRecord> {
  const state = await readState();
  if (!state) {
    const database = await inspectDatabase(config).catch(() => ({
      providerSwitches: buildProviderSwitchReport([]),
      sourcePolicy: buildSourcePolicyReport([]),
      blockers: ["database_inspection_failed"],
    }));
    return {
      stopped: false,
      reason: "pid_state_missing",
      finalInvariant: {
        providerSwitches: database.providerSwitches,
        sourcePolicy: database.sourcePolicy,
      },
      finalInvariantBlockers: database.blockers,
    };
  }
  const targets = [
    { name: "worker", pid: state.workerPid, entry: WORKER_ENTRY },
    { name: "api", pid: state.apiPid, entry: API_ENTRY },
  ];
  const remaining = await terminateManagedTargets(targets);
  if (!shouldRetainPidState(remaining)) await unlink(STATE_PATH);
  const database = await inspectDatabase(config).catch(() => ({
    providerSwitches: buildProviderSwitchReport([]),
    sourcePolicy: buildSourcePolicyReport([]),
    blockers: ["database_inspection_failed"],
  }));
  return {
    stopped: remaining.length === 0,
    signal: "SIGTERM",
    remaining,
    stateRetained: remaining.length > 0,
    finalInvariant: {
      providerSwitches: database.providerSwitches,
      sourcePolicy: database.sourcePolicy,
    },
    finalInvariantBlockers: database.blockers,
  };
}

async function main(): Promise<void> {
  const command = parseRuntimeCommand(process.argv.slice(2));
  const config = assertAcceptanceRuntimeConfig(process.env);
  if (command === "stop") {
    const result = await stopRuntime(config);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = commandExitCode(command, result);
    return;
  }
  if (command === "start") await startRuntime(config);
  const result = await collectStatus(config);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = commandExitCode(command, result);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(SCRIPT_PATH)) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify(safeFailureEnvelope(error))}\n`);
    process.exitCode = 1;
  });
}
