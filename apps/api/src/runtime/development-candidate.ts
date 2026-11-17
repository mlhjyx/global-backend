import { ExecutionBudgetGrantError } from "../execution-budget/execution-budget-authority.types";
import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { constants } from "node:fs";
import { open, lstat } from "node:fs/promises";
import { join } from "node:path";

const IMAGE =
  /^ghcr\.io\/mlhjyx\/global-backend-development-candidate@sha256:[0-9a-f]{64}$/u;
const CACHE_PATH = "/run/secrets/development-candidate/admission.json";
const HASH = /^[0-9a-f]{64}$/u;
const SHA = /^[0-9a-f]{40}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export interface RuntimeCandidateContext {
  readonly instanceId: string;
  readonly workspaceIds: readonly string[];
  readonly validUntil: string;
  readonly authorizationSha256: string;
}
interface CandidateBuild {
  build_sha: string;
  artifact_digest: string;
  source_tree_digest: string;
}
interface DatabaseTarget {
  host: string;
  port: number;
  name: string;
}
interface CandidateInstance {
  apiOrigin: string;
  database: DatabaseTarget;
  temporal: {
    address: string;
    tlsServerName: string;
    configurationRevision: string;
  };
  controlPlane: { issuer: string; jwks: string; machineSubjects: string[] };
}
interface Marker {
  schemaVersion: string;
  candidateCommit: string;
  trustedWorkflowCommit: string;
  authorizationSha256: string;
  instanceManifestSha256: string;
  instanceId: string;
  workspaceIds: string[];
  validUntil: string;
}
interface Admission extends Marker {
  imageReference: string;
  artifactDigest: string;
  sourceTreeDigest: string;
  verificationKind: string;
  instance: CandidateInstance;
}
let active: RuntimeCandidateContext | undefined;
let denied = false;
let operationGate: CandidateOperationGate | undefined;
let expiryTimer: ReturnType<typeof setTimeout> | undefined;

function invalid(): never {
  throw new Error("DEVELOPMENT_CANDIDATE_ADMISSION_INVALID");
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
function databaseMatches(
  raw: string | undefined,
  target: DatabaseTarget,
  role?: string,
): boolean {
  try {
    const url = new URL(raw ?? "");
    return (
      ["postgres:", "postgresql:"].includes(url.protocol) &&
      url.hostname === target.host &&
      url.port === String(target.port) &&
      url.pathname === `/${target.name}` &&
      (!role || url.username === role)
    );
  } catch {
    return false;
  }
}

/** Validates the cache of an external verification, never a substitute for it.
 * readRuntimeCandidate also requires a root-owned, non-writable mount. The host
 * CLI first verifies the owner SSH signature and exact GitHub CI attestation.
 */
export function validateRuntimeCandidate(
  markerInput: unknown,
  receiptInput: unknown,
  build: CandidateBuild,
  env: NodeJS.ProcessEnv,
  now = Date.now(),
): RuntimeCandidateContext {
  try {
    const marker = markerInput as Marker,
      receipt = receiptInput as Admission;
    if (
      marker.schemaVersion !== "development-candidate-marker/v1" ||
      receipt.schemaVersion !== "development-candidate-admission/v1" ||
      env.APP_ENVIRONMENT !== "development" ||
      env.NODE_ENV !== "production" ||
      !IMAGE.test(env.RUNTIME_IMAGE_REFERENCE ?? "") ||
      env.RUNTIME_IMAGE_REFERENCE !== receipt.imageReference ||
      !SHA.test(marker.candidateCommit) ||
      !SHA.test(marker.trustedWorkflowCommit) ||
      !HASH.test(marker.authorizationSha256) ||
      !HASH.test(marker.instanceManifestSha256) ||
      marker.candidateCommit !== build.build_sha ||
      receipt.artifactDigest !== build.artifact_digest ||
      receipt.sourceTreeDigest !== build.source_tree_digest ||
      receipt.verificationKind !== "github-attestation-and-owner-ssh" ||
      typeof marker.instanceId !== "string" ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/u.test(marker.instanceId) ||
      marker.instanceId !== env.RUNTIME_CANDIDATE_INSTANCE_ID ||
      !Array.isArray(marker.workspaceIds) ||
      marker.workspaceIds.length !== 2 ||
      marker.workspaceIds.some((id) => !UUID.test(id)) ||
      new Set(marker.workspaceIds).size !== 2 ||
      !Number.isFinite(Date.parse(marker.validUntil)) ||
      Date.parse(marker.validUntil) <= now
    )
      invalid();
    for (const key of [
      "candidateCommit",
      "trustedWorkflowCommit",
      "authorizationSha256",
      "instanceManifestSha256",
      "instanceId",
      "workspaceIds",
      "validUntil",
    ] as const) {
      if (JSON.stringify(marker[key]) !== JSON.stringify(receipt[key]))
        invalid();
    }
    const instance = receipt.instance;
    if (
      createHash("sha256").update(canonical(instance)).digest("hex") !==
        marker.instanceManifestSha256 ||
      instance.database.host !== "127.0.0.1" ||
      instance.database.port === 5432 ||
      !/^global_candidate_[a-z0-9_]{1,50}$/u.test(instance.database.name) ||
      !databaseMatches(env.APP_DATABASE_URL, instance.database, "app_user") ||
      (env.DATABASE_URL &&
        !databaseMatches(env.DATABASE_URL, instance.database)) ||
      env.TEMPORAL_ADDRESS !== instance.temporal.address ||
      env.TEMPORAL_TLS_SERVER_NAME !== instance.temporal.tlsServerName ||
      !HASH.test(instance.temporal.configurationRevision) ||
      env.MACHINE_BOOTSTRAP_CONFIGURATION_REVISION !==
        instance.temporal.configurationRevision ||
      !instance.controlPlane.machineSubjects.includes(
        env.TEMPORAL_MACHINE_SUBJECT ?? "",
      ) ||
      env.AUTH_ISSUER !== instance.controlPlane.issuer ||
      env.AUTH_JWKS_URI !== instance.controlPlane.jwks ||
      env.PORT !== new URL(instance.apiOrigin).port ||
      env.SWEEP_SCHEDULER_ENABLED !== "off" ||
      env.RUNTIME_DEV_FAST_LANE_WORKSPACE_ID ||
      env.RUNTIME_DEV_FAST_LANE_TEMPORAL_ADDRESS
    )
      invalid();
    const writers = [
      ["RUNTIME_API_LEASE_DATABASE_URL", "runtime_api"],
      ["RUNTIME_WORKER_LEASE_DATABASE_URL", "runtime_worker"],
      ["RUNTIME_OUTBOX_RELAY_LEASE_DATABASE_URL", "runtime_outbox_relay"],
      ["RUNTIME_PLATFORM_WORKER_LEASE_DATABASE_URL", "runtime_platform_worker"],
    ];
    const present = writers.filter(([key]) => !!env[key!]);
    if (
      !present.length ||
      present.some(
        ([key, role]) => !databaseMatches(env[key!], instance.database, role),
      )
    )
      invalid();
    return Object.freeze({
      instanceId: marker.instanceId,
      workspaceIds: Object.freeze([...marker.workspaceIds]),
      validUntil: marker.validUntil,
      authorizationSha256: marker.authorizationSha256,
    });
  } catch {
    return invalid();
  }
}

async function readBoundedJson(
  path: string,
  rootOwned: boolean,
): Promise<unknown> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.size > 131_072 ||
      (rootOwned && (before.uid !== 0 || (before.mode & 0o022) !== 0))
    )
      invalid();
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      bytes.length > 131_072 ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs
    )
      invalid();
    return JSON.parse(bytes.toString("utf8"));
  } finally {
    await handle.close();
  }
}
export async function readRuntimeCandidate(
  artifactRoot: string,
  build: CandidateBuild,
  env: NodeJS.ProcessEnv,
): Promise<RuntimeCandidateContext | undefined> {
  let marker: unknown;
  try {
    marker = await readBoundedJson(
      join(artifactRoot, "runtime-candidate.json"),
      false,
    );
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === "ENOENT" &&
      !env.RUNTIME_CANDIDATE_INSTANCE_ID &&
      !env.RUNTIME_CANDIDATE_ADMISSION_FILE &&
      !(env.RUNTIME_IMAGE_REFERENCE ?? "").includes(
        "global-backend-development-candidate",
      )
    )
      return undefined;
    return invalid();
  }
  if (env.RUNTIME_CANDIDATE_ADMISSION_FILE !== CACHE_PATH) invalid();
  return validateRuntimeCandidate(
    marker,
    await readBoundedJson(CACHE_PATH, true),
    build,
    env,
  );
}
function activateRuntimeCandidate(context: RuntimeCandidateContext): void {
  if (active && canonical(active) !== canonical(context)) invalid();
  if (active) return;
  active = context;
  denied = false;
  operationGate = new CandidateOperationGate(context);
  // Existing graceful SIGTERM handling drains the named process. Budget and
  // HTTP scope checks also reject new work at the exact expiry instant.
  expiryTimer = setTimeout(
    () => process.kill(process.pid, "SIGTERM"),
    Math.max(0, Date.parse(context.validUntil) - Date.now()),
  );
  expiryTimer.unref();
}
export function runtimeCandidateContext(): RuntimeCandidateContext | undefined {
  return active;
}
export function denyRuntimeCandidate(): void {
  denied = true;
}
export async function prepareRuntimeCandidate(
  artifactRoot: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  let present = false;
  try {
    await lstat(join(artifactRoot, "runtime-candidate.json"));
    present = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") present = true;
  }
  if (
    present ||
    env.RUNTIME_CANDIDATE_INSTANCE_ID ||
    env.RUNTIME_CANDIDATE_ADMISSION_FILE ||
    (env.RUNTIME_IMAGE_REFERENCE ?? "").includes(
      "global-backend-development-candidate",
    )
  )
    denied = true;
}
export async function admitRuntimeCandidate(
  artifactRoot: string,
  build: CandidateBuild,
  env: NodeJS.ProcessEnv,
  mode = env.APP_ENVIRONMENT,
): Promise<void> {
  const candidate = await readRuntimeCandidate(artifactRoot, build, env);
  if (candidate && mode !== "development") invalid();
  if (candidate) activateRuntimeCandidate(candidate);
}
export function candidateWorkspaceAllowed(
  workspaceId: string,
  context = active,
  now = Date.now(),
): boolean {
  const requestedWithoutAdmission =
    !context &&
    Boolean(
      process.env.RUNTIME_CANDIDATE_INSTANCE_ID ||
      process.env.RUNTIME_CANDIDATE_ADMISSION_FILE ||
      (process.env.RUNTIME_IMAGE_REFERENCE ?? "").includes(
        "global-backend-development-candidate",
      ),
    );
  return (
    !denied &&
    !requestedWithoutAdmission &&
    (!context ||
      (now < Date.parse(context.validUntil) &&
        context.workspaceIds.includes(workspaceId)))
  );
}
export function assertCandidateWorkspaceAllowed(workspaceId: string): void {
  if (!candidateWorkspaceAllowed(workspaceId)) {
    scopeDenied();
  }
}

/** Resource quota is held at zero until physical supplier exposure is proven.
 * Grant allocation bounds internal accounts; it cannot certify the ordinary
 * acquisition gateway's generic token estimates as real supplier prices.
 * There is deliberately no environment flag or self-asserted receipt to open
 * this hold. A reviewed physical-wire budget implementation is required.
 */
export function assertCandidatePhysicalExecutionAllowed(): void {
  if (active || !candidateWorkspaceAllowed("")) {
    throw new ExecutionBudgetGrantError(
      "EXECUTION_BUDGET_VERIFICATION_UNAVAILABLE",
    );
  }
}

function scopeDenied(): never {
  throw new ExecutionBudgetGrantError("EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH");
}

export class CandidateOperationGate {
  private readonly operations = new AsyncLocalStorage<{
    workspaceId?: string;
    startedAt: number;
    open: boolean;
  }>();
  constructor(
    private readonly context: RuntimeCandidateContext,
    private readonly now = Date.now,
  ) {}
  async run<T>(action: () => Promise<T>, workspaceId?: string): Promise<T> {
    if (
      this.now() >= Date.parse(this.context.validUntil) ||
      (workspaceId && !this.context.workspaceIds.includes(workspaceId))
    )
      scopeDenied();
    const operation = { workspaceId, startedAt: this.now(), open: true };
    try {
      return await this.operations.run(operation, action);
    } finally {
      operation.open = false;
    }
  }
  assertTenant(workspaceId: string): void {
    const operation = this.operations.getStore(),
      now = this.now();
    if (
      !this.context.workspaceIds.includes(workspaceId) ||
      (operation?.workspaceId && operation.workspaceId !== workspaceId)
    )
      scopeDenied();
    if (
      now >= Date.parse(this.context.validUntil) &&
      (!operation?.open ||
        operation.startedAt >= Date.parse(this.context.validUntil) ||
        now - operation.startedAt > 15 * 60_000)
    )
      scopeDenied();
  }
}
export function assertRuntimeCandidateOperational(): void {
  assertCandidateWorkspaceAllowed(active?.workspaceIds[0] ?? "");
}
export function assertCandidateTenantAccess(workspaceId: string): void {
  if (denied || (!active && !candidateWorkspaceAllowed(workspaceId)))
    scopeDenied();
  operationGate?.assertTenant(workspaceId);
}
export async function runCandidateOperation<T>(
  action: () => Promise<T>,
  workspaceId?: string,
): Promise<T> {
  assertRuntimeCandidateOperational();
  if (workspaceId) assertCandidateWorkspaceAllowed(workspaceId);
  return operationGate ? operationGate.run(action, workspaceId) : action();
}

export async function readCandidateBudgetCache(): Promise<unknown> {
  return readBoundedJson(
    "/run/secrets/development-candidate/budget-allocations.json",
    true,
  );
}
