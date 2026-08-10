import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { open, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

import { canonicalDigest } from "../../model-runtime/context-engine";
import type { ExecutionBroker } from "../../tools/tool-contract";
import {
  OPENOX_PRICING_AUTHORITY,
  settlementOpenOxPrice,
  settlementPricingSnapshotSha256,
  type SettlementDispatch,
} from "../site-builder-model-settlement";
import {
  COPY_SONNET_RECOVERY_EXECUTION,
  COPY_SONNET_RECOVERY_PLAN,
  COPY_SONNET_RECOVERY_RUNTIME_BINDING_ARTIFACT_ID,
  COPY_SONNET_RECOVERY_RUNTIME_BINDING_OUTPUT_PATH,
} from "./copy-sonnet-recovery-contract";
import {
  COPY_SONNET_RECOVERY_CREDENTIAL_PURPOSE as CREDENTIAL_PURPOSE,
  COPY_SONNET_RECOVERY_EXPECTED_COMPILED_ARTIFACT_TREE_DIGEST as EXPECTED_COMPILED_ARTIFACT_TREE_DIGEST,
  COPY_SONNET_RECOVERY_EXPECTED_RUNTIME_BINDING_ARTIFACT_DIGEST as EXPECTED_RUNTIME_BINDING_ARTIFACT_DIGEST,
  COPY_SONNET_RECOVERY_EXPECTED_RUNTIME_BINDING_FILE_SHA256 as EXPECTED_RUNTIME_BINDING_FILE_SHA256,
  COPY_SONNET_RECOVERY_MAXIMUM_INPUT_TOKENS_PER_WIRE as MAXIMUM_INPUT_TOKENS_PER_WIRE,
  COPY_SONNET_RECOVERY_MAXIMUM_LIFETIME_MS as MAXIMUM_LIFETIME_MS,
  COPY_SONNET_RECOVERY_MAXIMUM_OUTPUT_TOKENS_PER_WIRE as MAXIMUM_OUTPUT_TOKENS_PER_WIRE,
  COPY_SONNET_RECOVERY_NEW_API_CHANNEL_TYPE as NEW_API_ANTHROPIC_CHANNEL_TYPE,
  COPY_SONNET_RECOVERY_OPENOX_BASE_URL as OPENOX_ANTHROPIC_BASE_URL,
  COPY_SONNET_RECOVERY_OPENOX_GROUP as OPENOX_GROUP,
  COPY_SONNET_RECOVERY_QUOTA_PER_NATIVE_UNIT as QUOTA_PER_NATIVE_UNIT,
  COPY_SONNET_RECOVERY_TRANSPORT_PROTOCOL as ANTHROPIC_MESSAGES_TRANSPORT_PROTOCOL,
  COPY_SONNET_RECOVERY_ZERO_CALL_PREFLIGHT_ARTIFACT_ID,
  COPY_SONNET_RECOVERY_ZERO_CALL_PREFLIGHT_SCHEMA_VERSION,
  copySonnetRecoveryMaximumNativeCostPerWire as calculateMaximumNativeCostPerWire,
  copySonnetRecoveryQuotaPoints as quotaPoints,
  validateCopySonnetRecoveryZeroCallPreflightArtifact,
  type CopySonnetRecoveryObservedRequest as ObservedRequest,
  type CopySonnetRecoveryZeroCallPreflightArtifact,
} from "./copy-sonnet-recovery-zero-call-preflight-artifact";
import {
  COPY_SONNET_RECOVERY_OPENOX_PRICING_TOOL_ID,
  type CopySonnetRecoveryOpenOxPricingOutput,
} from "./copy-sonnet-recovery-openox-pricing-tool";

export {
  COPY_SONNET_RECOVERY_ZERO_CALL_PREFLIGHT_ARTIFACT_ID,
  COPY_SONNET_RECOVERY_ZERO_CALL_PREFLIGHT_OUTPUT_PATH,
  COPY_SONNET_RECOVERY_ZERO_CALL_PREFLIGHT_SCHEMA_VERSION,
  validateCopySonnetRecoveryZeroCallPreflightArtifact,
} from "./copy-sonnet-recovery-zero-call-preflight-artifact";
export type { CopySonnetRecoveryZeroCallPreflightArtifact } from "./copy-sonnet-recovery-zero-call-preflight-artifact";

const TOKEN_NAME = "Site Builder Copy Sonnet Recovery v18";
const RETIRED_V16_TOKEN_ID = 24;
const RETIRED_V16_TOKEN_NAME = "Site Builder Copy Sonnet Recovery v16";
const RETIRED_V17_TOKEN_ID = 25;
const RETIRED_V17_TOKEN_NAME = "Site Builder Copy Sonnet Recovery v17";
const DISABLED_TOKEN_STATUS = 2;
const PAGE_SIZE = 100;
const MAXIMUM_PAGES = 100;
const MAXIMUM_RESPONSE_BYTES = 1_048_576;
const CONTROL_PLANE_TIMEOUT_MS = 5_000;
const PREFLIGHT_LOCK_PATH = join(
  tmpdir(),
  "global-site-builder-copy-sonnet-recovery-zero-call-preflight-v18.lock",
);
const SHA256 = /^[0-9a-f]{64}$/u;
const GIT_COMMIT = /^[0-9a-f]{40}$/u;

interface RuntimeBindingShape {
  artifactId?: unknown;
  artifactDigest?: unknown;
  compiledRuntimeExpectation?: {
    artifactTreeDigest?: unknown;
  };
  dispatchAuthorization?: unknown;
  dispatchCapable?: unknown;
  manifest?: {
    taskId?: unknown;
    plannedExecutions?: unknown;
    maximumWireCalls?: unknown;
    maximumRepairCallsPerExecution?: unknown;
    executions?: Array<{
      alias?: unknown;
      protocol?: unknown;
      reasoning?: unknown;
    }>;
  };
}

interface Channel {
  id?: unknown;
  name?: unknown;
  type?: unknown;
  status?: unknown;
  base_url?: unknown;
  models?: unknown;
  group?: unknown;
  model_mapping?: unknown;
}

interface Token {
  id?: unknown;
  name?: unknown;
  status?: unknown;
  expired_time?: unknown;
  remain_quota?: unknown;
  unlimited_quota?: unknown;
  model_limits_enabled?: unknown;
  model_limits?: unknown;
  group?: unknown;
  cross_group_retry?: unknown;
}

interface ApiEnvelope {
  success?: unknown;
  message?: unknown;
  data?: unknown;
}

export interface CopySonnetRecoveryZeroCallPreflightInput {
  repositoryRoot: string;
  executionHeadCommit: string;
  runtimeBindingBytes: Uint8Array;
  adminBaseUrl: string;
  gatewayOrigin: string;
  adminAccessToken: string;
  adminUserId: number;
  pricingBroker?: ExecutionBroker;
}

interface RuntimeDeps {
  fetch?: typeof fetch;
  now?: () => Date;
  controlPlaneTimeoutMs?: number;
  readRepositoryState?: (repositoryRoot: string) => {
    head: string;
    clean: boolean;
  };
  withExclusiveLock?: <T>(operation: () => Promise<T>) => Promise<T>;
}

export interface CopySonnetRecoveryZeroCallPreflightResult {
  secret: { tokenId: number; apiKey: string };
  artifact: CopySonnetRecoveryZeroCallPreflightArtifact;
}

function fail(code: string): never {
  throw new Error(code);
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function bearerTokenSha256(apiKey: string): string {
  // This is a compatibility fingerprint for a random opaque provider token,
  // not a password verifier or credential-storage scheme.
  // codeql[js/insufficient-password-hash]
  return createHash("sha256").update(apiKey).digest("hex");
}

function errnoCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

async function withPreflightLock<T>(operation: () => Promise<T>): Promise<T> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(PREFLIGHT_LOCK_PATH, "wx", 0o600);
    await handle.writeFile(`${process.pid}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (errnoCode(error) === "EEXIST") {
      fail("COPY_SONNET_RECOVERY_PREFLIGHT_ALREADY_RUNNING");
    }
    throw error;
  }
  try {
    return await operation();
  } finally {
    await unlink(PREFLIGHT_LOCK_PATH).catch(() => undefined);
  }
}

function readRepositoryState(repositoryRoot: string): { head: string; clean: boolean } {
  const head = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  }).trim();
  const status = execFileSync(
    "git",
    ["status", "--porcelain", "--untracked-files=all"],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    },
  ).trim();
  return { head, clean: status === "" };
}

function assertRepositoryState(input: CopySonnetRecoveryZeroCallPreflightInput, deps: RuntimeDeps): void {
  const state = (deps.readRepositoryState ?? readRepositoryState)(
    input.repositoryRoot,
  );
  if (state.head !== input.executionHeadCommit || state.clean !== true) {
    fail("COPY_SONNET_RECOVERY_REPOSITORY_STATE_INVALID");
  }
}

function splitCsv(value: unknown): string[] {
  if (typeof value !== "string") return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .sort();
}

function trimSlash(value: string): string {
  return value.trim().replace(/\/+$/u, "");
}

function canonicalLocalOrigin(value: string): string {
  try {
    const url = new URL(value);
    const approved =
      url.protocol === "http:" &&
      ((["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
        url.port === "3001") ||
        (url.hostname === "new-api" && url.port === "3000")) &&
      (url.pathname === "/" || url.pathname === "") &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash;
    if (!approved) fail("COPY_SONNET_RECOVERY_CONTROL_PLANE_ORIGIN_INVALID");
    return url.origin;
  } catch {
    fail("COPY_SONNET_RECOVERY_CONTROL_PLANE_ORIGIN_INVALID");
  }
}

async function boundedJson(
  response: Response,
  onBodySha256?: (digest: string) => void,
): Promise<unknown> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const parsed = Number(contentLength);
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > MAXIMUM_RESPONSE_BYTES) {
      fail("COPY_SONNET_RECOVERY_CONTROL_PLANE_RESPONSE_INVALID");
    }
  }
  if (!response.body) fail("COPY_SONNET_RECOVERY_CONTROL_PLANE_RESPONSE_INVALID");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAXIMUM_RESPONSE_BYTES) {
      await reader.cancel();
      fail("COPY_SONNET_RECOVERY_CONTROL_PLANE_RESPONSE_INVALID");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  onBodySha256?.(sha256(bytes));
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    fail("COPY_SONNET_RECOVERY_CONTROL_PLANE_RESPONSE_INVALID");
  }
}

function adminHeaders(input: CopySonnetRecoveryZeroCallPreflightInput) {
  return {
    authorization: `Bearer ${input.adminAccessToken.trim()}`,
    "content-type": "application/json",
    "new-api-user": String(input.adminUserId),
  };
}

async function requestJson(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  observation: ObservedRequest[],
  authority: ObservedRequest["authority"],
  timeoutMs: number,
  onBodySha256?: (digest: string) => void,
): Promise<unknown> {
  const parsed = new URL(url);
  observation.push({
    method: init.method ?? "GET",
    authority,
    path: parsed.pathname,
  });
  const response = await fetchImpl(url, {
    ...init,
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (response.status >= 300 && response.status < 400) {
    fail("COPY_SONNET_RECOVERY_CONTROL_PLANE_REDIRECT_REJECTED");
  }
  const body = await boundedJson(response, onBodySha256);
  if (!response.ok) fail("COPY_SONNET_RECOVERY_CONTROL_PLANE_UNAVAILABLE");
  if (
    authority === "new_api_admin" &&
    (!body ||
      typeof body !== "object" ||
      (body as ApiEnvelope).success !== true)
  ) {
    fail("COPY_SONNET_RECOVERY_CONTROL_PLANE_UNAVAILABLE");
  }
  return body;
}

function pageItems<T>(value: unknown): { items: T[]; total: number } {
  const data = (value as ApiEnvelope | undefined)?.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    fail("COPY_SONNET_RECOVERY_CONTROL_PLANE_RESPONSE_INVALID");
  }
  const page = data as { items?: unknown; total?: unknown };
  if (!Array.isArray(page.items)) {
    fail("COPY_SONNET_RECOVERY_CONTROL_PLANE_RESPONSE_INVALID");
  }
  const total = page.total;
  if (!Number.isSafeInteger(total) || (total as number) < page.items.length) {
    fail("COPY_SONNET_RECOVERY_CONTROL_PLANE_RESPONSE_INVALID");
  }
  return { items: page.items as T[], total: total as number };
}

async function listAll<T>(
  kind: "channel" | "token",
  input: CopySonnetRecoveryZeroCallPreflightInput,
  fetchImpl: typeof fetch,
  observation: ObservedRequest[],
  timeoutMs: number,
): Promise<T[]> {
  const items: T[] = [];
  let expectedTotal: number | undefined;
  for (let page = 1; page <= MAXIMUM_PAGES; page += 1) {
    const body = await requestJson(
      fetchImpl,
      `${trimSlash(input.adminBaseUrl)}/api/${kind}/?p=${page}&page_size=${PAGE_SIZE}`,
      { headers: adminHeaders(input) },
      observation,
      "new_api_admin",
      timeoutMs,
    );
    const batch = pageItems<T>(body);
    expectedTotal ??= batch.total;
    if (
      batch.total !== expectedTotal ||
      items.length + batch.items.length > expectedTotal
    ) {
      fail("COPY_SONNET_RECOVERY_CONTROL_PLANE_RESPONSE_INVALID");
    }
    items.push(...batch.items);
    if (items.length === expectedTotal) return items;
    if (batch.items.length === 0) {
      fail("COPY_SONNET_RECOVERY_CONTROL_PLANE_RESPONSE_INVALID");
    }
  }
  fail("COPY_SONNET_RECOVERY_CONTROL_PLANE_RESPONSE_INVALID");
}

function validateRuntimeBinding(
  input: CopySonnetRecoveryZeroCallPreflightInput,
): CopySonnetRecoveryZeroCallPreflightArtifact["runtimeBinding"] {
  let parsed: RuntimeBindingShape;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(input.runtimeBindingBytes));
  } catch {
    fail("COPY_SONNET_RECOVERY_RUNTIME_BINDING_INVALID");
  }
  const execution = parsed.manifest?.executions?.[0];
  if (
    parsed.artifactId !== COPY_SONNET_RECOVERY_RUNTIME_BINDING_ARTIFACT_ID ||
    !SHA256.test(String(parsed.artifactDigest)) ||
    !SHA256.test(String(parsed.compiledRuntimeExpectation?.artifactTreeDigest)) ||
    parsed.dispatchAuthorization !== "NOT_AUTHORIZED" ||
    parsed.dispatchCapable !== false ||
    parsed.manifest?.taskId !== COPY_SONNET_RECOVERY_PLAN.taskId ||
    parsed.manifest.plannedExecutions !== 1 ||
    parsed.manifest.maximumWireCalls !== 2 ||
    parsed.manifest.maximumRepairCallsPerExecution !== 1 ||
    parsed.manifest.executions?.length !== 1 ||
    execution?.alias !== COPY_SONNET_RECOVERY_EXECUTION.alias ||
    execution.protocol !== COPY_SONNET_RECOVERY_EXECUTION.protocol ||
    execution.reasoning !== COPY_SONNET_RECOVERY_EXECUTION.reasoning
  ) {
    fail("COPY_SONNET_RECOVERY_RUNTIME_BINDING_INVALID");
  }
  const trackedBytes = readFileSync(
    resolve(input.repositoryRoot, COPY_SONNET_RECOVERY_RUNTIME_BINDING_OUTPUT_PATH),
  );
  const fileSha256 = sha256(input.runtimeBindingBytes);
  if (
    fileSha256 !== sha256(trackedBytes) ||
    fileSha256 !== EXPECTED_RUNTIME_BINDING_FILE_SHA256 ||
    parsed.artifactDigest !== EXPECTED_RUNTIME_BINDING_ARTIFACT_DIGEST ||
    parsed.compiledRuntimeExpectation?.artifactTreeDigest !==
      EXPECTED_COMPILED_ARTIFACT_TREE_DIGEST
  ) {
    fail("COPY_SONNET_RECOVERY_RUNTIME_BINDING_INVALID");
  }
  return {
    path: COPY_SONNET_RECOVERY_RUNTIME_BINDING_OUTPUT_PATH,
    fileSha256,
    artifactDigest: parsed.artifactDigest as string,
    compiledArtifactTreeDigest: parsed.compiledRuntimeExpectation
      ?.artifactTreeDigest as string,
  };
}

function hasIdentityModelMapping(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return false;
    }
    const entries = Object.entries(parsed as Record<string, unknown>);
    return (
      entries.length === 0 ||
      (entries.length === 1 &&
        entries[0][0] === COPY_SONNET_RECOVERY_EXECUTION.alias &&
        entries[0][1] === COPY_SONNET_RECOVERY_EXECUTION.alias)
    );
  } catch {
    return false;
  }
}

function exactRoute(channels: Channel[]): Channel {
  const matches = channels.filter(
    (channel) =>
      channel.status === 1 &&
      splitCsv(channel.models).includes(COPY_SONNET_RECOVERY_EXECUTION.alias) &&
      splitCsv(channel.group).includes(OPENOX_GROUP),
  );
  if (matches.length !== 1 || !Number.isSafeInteger(matches[0].id)) {
    fail("COPY_SONNET_RECOVERY_ROUTE_AMBIGUOUS");
  }
  const route = matches[0];
  if (
    typeof route.name !== "string" ||
    !route.name.trim() ||
    route.type !== NEW_API_ANTHROPIC_CHANNEL_TYPE ||
    typeof route.base_url !== "string" ||
    trimSlash(route.base_url) !== OPENOX_ANTHROPIC_BASE_URL ||
    !hasIdentityModelMapping(route.model_mapping)
  ) {
    fail("COPY_SONNET_RECOVERY_ROUTE_IDENTITY_INVALID");
  }
  return route;
}

function routeIdentity(route: Channel): string {
  return canonicalDigest({
    id: route.id,
    name: route.name,
    type: route.type,
    baseUrl: trimSlash(route.base_url as string),
    models: splitCsv(route.models),
    group: splitCsv(route.group),
    modelMapping: "IDENTITY",
  });
}

function assertNoPriorPurposeToken(tokens: Token[]): void {
  const retiredV16Tokens = tokens.filter(
    (token) => token.name === RETIRED_V16_TOKEN_NAME,
  );
  const retiredV17Tokens = tokens.filter(
    (token) => token.name === RETIRED_V17_TOKEN_NAME,
  );
  if (
    retiredV16Tokens.length > 1 ||
    retiredV16Tokens.some((token) => !isExactRetiredV16Token(token)) ||
    retiredV17Tokens.length !== 1 ||
    retiredV17Tokens.some((token) => !isExactRetiredV17Token(token)) ||
    tokens.some(
      (token) =>
        isV18PurposeToken(token) ||
        (typeof token.name === "string" &&
          token.name.startsWith("Site Builder Copy Sonnet Recovery") &&
          token.name !== RETIRED_V16_TOKEN_NAME &&
          token.name !== RETIRED_V17_TOKEN_NAME),
    )
  ) {
    fail("COPY_SONNET_RECOVERY_TOKEN_EXISTS");
  }
}

function isPurposeToken(token: Token): boolean {
  return token.name === TOKEN_NAME;
}

function isV18PurposeToken(token: Token): boolean {
  return typeof token.name === "string" && token.name.startsWith(TOKEN_NAME);
}

function isExactRetiredV16Token(token: Token): boolean {
  return (
    token.id === RETIRED_V16_TOKEN_ID &&
    token.name === RETIRED_V16_TOKEN_NAME &&
    token.status === DISABLED_TOKEN_STATUS
  );
}

function isExactRetiredV17Token(token: Token): boolean {
  return (
    token.id === RETIRED_V17_TOKEN_ID &&
    token.name === RETIRED_V17_TOKEN_NAME &&
    token.status === DISABLED_TOKEN_STATUS
  );
}

export async function disableCopySonnetRecoveryPurposeTokens(
  input: CopySonnetRecoveryZeroCallPreflightInput,
  fetchImpl: typeof fetch,
  observation: ObservedRequest[],
  timeoutMs: number,
): Promise<void> {
  const tokens = await listAll<Token>(
    "token",
    input,
    fetchImpl,
    observation,
    timeoutMs,
  );
  const matches = tokens.filter(
    (token) => isV18PurposeToken(token) && token.status === 1,
  );
  for (const token of matches) {
    if (!Number.isSafeInteger(token.id) || (token.id as number) <= 0) {
      fail("COPY_SONNET_RECOVERY_TOKEN_CLEANUP_FAILED");
    }
    await requestJson(
      fetchImpl,
      `${trimSlash(input.adminBaseUrl)}/api/token/?status_only=true`,
      {
        method: "PUT",
        headers: adminHeaders(input),
        body: JSON.stringify({ id: token.id, status: 2 }),
      },
      observation,
      "new_api_admin",
      timeoutMs,
    );
  }
  const readback = await listAll<Token>(
    "token",
    input,
    fetchImpl,
    observation,
    timeoutMs,
  );
  if (
    readback.some(
      (token) => isV18PurposeToken(token) && token.status === 1,
    )
  ) {
    fail("COPY_SONNET_RECOVERY_TOKEN_CLEANUP_FAILED");
  }
}

function assertExactToken(token: Token, expiresAtSeconds: number, quotaCapPoints: number): number {
  if (
    !Number.isSafeInteger(token.id) ||
    (token.id as number) <= 0 ||
    token.name !== TOKEN_NAME ||
    token.status !== 1 ||
    token.expired_time !== expiresAtSeconds ||
    token.remain_quota !== quotaCapPoints ||
    token.unlimited_quota !== false ||
    token.model_limits_enabled !== true ||
    JSON.stringify(splitCsv(token.model_limits)) !==
      JSON.stringify([COPY_SONNET_RECOVERY_EXECUTION.alias]) ||
    JSON.stringify(splitCsv(token.group)) !== JSON.stringify([OPENOX_GROUP]) ||
    token.cross_group_retry !== false
  ) {
    fail("COPY_SONNET_RECOVERY_TOKEN_READBACK_INVALID");
  }
  return token.id as number;
}

function bearerHeaders(apiKey: string) {
  return { authorization: `Bearer ${apiKey}`, "content-type": "application/json" };
}

function liveRemainingQuota(value: unknown, quotaCapPoints: number): number {
  const data = (value as { data?: unknown } | undefined)?.data ?? value;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    fail("COPY_SONNET_RECOVERY_LIVE_SCOPE_INVALID");
  }
  const usage = data as Record<string, unknown>;
  const modelLimits =
    usage.model_limits &&
    typeof usage.model_limits === "object" &&
    !Array.isArray(usage.model_limits)
      ? (usage.model_limits as Record<string, unknown>)
      : undefined;
  const allowlist = modelLimits ? Object.keys(modelLimits).sort() : [];
  if (
    usage.unlimited_quota !== false ||
    usage.model_limits_enabled !== true ||
    JSON.stringify(allowlist) !== JSON.stringify([COPY_SONNET_RECOVERY_EXECUTION.alias]) ||
    modelLimits?.[COPY_SONNET_RECOVERY_EXECUTION.alias] !== true ||
    usage.total_granted !== quotaCapPoints ||
    usage.total_available !== quotaCapPoints
  ) {
    fail("COPY_SONNET_RECOVERY_LIVE_SCOPE_INVALID");
  }
  return quotaCapPoints;
}

function assertExactModelInventory(value: unknown): void {
  const models = (value as { data?: unknown } | undefined)?.data;
  if (!Array.isArray(models)) fail("COPY_SONNET_RECOVERY_LIVE_SCOPE_INVALID");
  const aliases: string[] = [];
  for (const entry of models) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      fail("COPY_SONNET_RECOVERY_LIVE_SCOPE_INVALID");
    }
    const id = (entry as { id?: unknown }).id;
    if (typeof id !== "string" || !id.trim()) {
      fail("COPY_SONNET_RECOVERY_LIVE_SCOPE_INVALID");
    }
    aliases.push(id);
  }
  aliases.sort();
  if (JSON.stringify(aliases) !== JSON.stringify([COPY_SONNET_RECOVERY_EXECUTION.alias])) {
    fail("COPY_SONNET_RECOVERY_LIVE_SCOPE_INVALID");
  }
}

function assertEmptyLogShape(value: unknown): void {
  const rows = (value as { data?: unknown } | undefined)?.data;
  if (!Array.isArray(rows) || rows.length !== 0) {
    fail("COPY_SONNET_RECOVERY_SETTLEMENT_PREFLIGHT_INVALID");
  }
}

async function readOpenOxCatalog(
  input: CopySonnetRecoveryZeroCallPreflightInput,
  observation: ObservedRequest[],
): Promise<CopySonnetRecoveryOpenOxPricingOutput> {
  if (!input.pricingBroker) {
    fail("COPY_SONNET_RECOVERY_PRICING_BROKER_REQUIRED");
  }
  const result = await input.pricingBroker.invoke<
    Record<string, never>,
    CopySonnetRecoveryOpenOxPricingOutput
  >(
    COPY_SONNET_RECOVERY_OPENOX_PRICING_TOOL_ID,
    {},
    {
      workspaceId: "site-builder-copy-sonnet-recovery-v18",
      purpose: CREDENTIAL_PURPOSE,
    },
  );
  const output = result.data;
  if (
    !output ||
    typeof output !== "object" ||
    Array.isArray(output) ||
    !output.catalog ||
    typeof output.catalog !== "object" ||
    Array.isArray(output.catalog) ||
    !SHA256.test(output.responseSha256)
  ) {
    fail("COPY_SONNET_RECOVERY_PRICE_INVALID");
  }
  observation.push({
    method: "GET",
    authority: "tool_broker",
    path: OPENOX_PRICING_AUTHORITY.catalogEndpoint,
  });
  return output;
}

async function provisionAndAttestCopySonnetRecoveryZeroCallUnlocked(
  input: CopySonnetRecoveryZeroCallPreflightInput,
  deps: RuntimeDeps = {},
): Promise<CopySonnetRecoveryZeroCallPreflightResult> {
  if (
    !GIT_COMMIT.test(input.executionHeadCommit) ||
    !input.adminAccessToken.trim() ||
    !Number.isSafeInteger(input.adminUserId) ||
    input.adminUserId <= 0
  ) {
    fail("COPY_SONNET_RECOVERY_PREFLIGHT_INPUT_INVALID");
  }
  assertRepositoryState(input, deps);
  const adminOrigin = canonicalLocalOrigin(input.adminBaseUrl);
  const gatewayOrigin = canonicalLocalOrigin(input.gatewayOrigin);
  if (adminOrigin !== gatewayOrigin) fail("COPY_SONNET_RECOVERY_CONTROL_PLANE_ORIGIN_INVALID");

  const runtimeBinding = validateRuntimeBinding(input);
  const fetchImpl = deps.fetch ?? fetch;
  const now = deps.now?.() ?? new Date();
  if (!Number.isFinite(now.getTime())) fail("COPY_SONNET_RECOVERY_PREFLIGHT_INPUT_INVALID");
  const timeoutMs =
    Number.isSafeInteger(deps.controlPlaneTimeoutMs) && (deps.controlPlaneTimeoutMs ?? 0) > 0
      ? deps.controlPlaneTimeoutMs!
      : CONTROL_PLANE_TIMEOUT_MS;
  const observation: ObservedRequest[] = [];

  const channels = await listAll<Channel>("channel", input, fetchImpl, observation, timeoutMs);
  const route = exactRoute(channels);
  const initialPricing = await readOpenOxCatalog(input, observation);
  const { catalog, responseSha256: catalogResponseSha256 } = initialPricing;
  const price = settlementOpenOxPrice(catalog, COPY_SONNET_RECOVERY_EXECUTION.alias, OPENOX_GROUP);
  if (!price || price.currency !== "USD") fail("COPY_SONNET_RECOVERY_PRICE_INVALID");

  const nativeCostPerWire = calculateMaximumNativeCostPerWire(
    price.inputPriceMicrounitsPerMillionTokens,
    price.outputPriceMicrounitsPerMillionTokens,
    price.cacheReadPriceMicrounitsPerMillionTokens,
    price.cacheWritePriceMicrounitsPerMillionTokens,
  );
  const maximumQuotaPointsPerWire = quotaPoints(nativeCostPerWire);
  const quotaCapPoints = maximumQuotaPointsPerWire * COPY_SONNET_RECOVERY_PLAN.maximumWireCalls;
  if (!Number.isSafeInteger(quotaCapPoints)) fail("COPY_SONNET_RECOVERY_QUOTA_INVALID");

  const priorTokens = await listAll<Token>("token", input, fetchImpl, observation, timeoutMs);
  assertNoPriorPurposeToken(priorTokens);
  assertRepositoryState(input, deps);
  const expiresAtSeconds = Math.floor(
    (now.getTime() + MAXIMUM_LIFETIME_MS) / 1_000,
  );
  const expiresAt = new Date(expiresAtSeconds * 1_000);
  let creationAttempted = false;
  try {
    creationAttempted = true;
    await requestJson(
    fetchImpl,
    `${trimSlash(input.adminBaseUrl)}/api/token/`,
    {
      method: "POST",
      headers: adminHeaders(input),
      body: JSON.stringify({
        name: TOKEN_NAME,
        expired_time: expiresAtSeconds,
        remain_quota: quotaCapPoints,
        unlimited_quota: false,
        model_limits_enabled: true,
        model_limits: COPY_SONNET_RECOVERY_EXECUTION.alias,
        allow_ips: "",
        group: OPENOX_GROUP,
        cross_group_retry: false,
      }),
    },
    observation,
    "new_api_admin",
    timeoutMs,
    );

  const createdTokens = await listAll<Token>("token", input, fetchImpl, observation, timeoutMs);
  const matches = createdTokens.filter(isPurposeToken);
  if (matches.length !== 1) fail("COPY_SONNET_RECOVERY_TOKEN_READBACK_INVALID");
  const tokenId = assertExactToken(matches[0], expiresAtSeconds, quotaCapPoints);
  const keyEnvelope = (await requestJson(
    fetchImpl,
    `${trimSlash(input.adminBaseUrl)}/api/token/${tokenId}/key`,
    { method: "POST", headers: adminHeaders(input) },
    observation,
    "new_api_admin",
    timeoutMs,
  )) as ApiEnvelope;
  const rawKey = (keyEnvelope.data as { key?: unknown } | undefined)?.key;
  if (typeof rawKey !== "string" || !rawKey.trim()) {
    fail("COPY_SONNET_RECOVERY_TOKEN_READBACK_INVALID");
  }
  const apiKey = rawKey.startsWith("sk-") ? rawKey : `sk-${rawKey}`;

  const [usage, models, logs, postChannels, postPricing, postTokens] = await Promise.all([
    requestJson(fetchImpl, `${gatewayOrigin}/api/usage/token/`, { headers: bearerHeaders(apiKey) }, observation, "new_api_bearer", timeoutMs),
    requestJson(fetchImpl, `${gatewayOrigin}/v1/models`, { headers: bearerHeaders(apiKey) }, observation, "new_api_bearer", timeoutMs),
    requestJson(fetchImpl, `${gatewayOrigin}/api/log/token`, { headers: bearerHeaders(apiKey) }, observation, "new_api_bearer", timeoutMs),
    listAll<Channel>("channel", input, fetchImpl, observation, timeoutMs),
    readOpenOxCatalog(input, observation),
    listAll<Token>("token", input, fetchImpl, observation, timeoutMs),
  ]);
  const remainingQuotaPoints = liveRemainingQuota(usage, quotaCapPoints);
  assertExactModelInventory(models);
  assertEmptyLogShape(logs);
  const postRoute = exactRoute(postChannels);
  const postPrice = settlementOpenOxPrice(
    postPricing.catalog,
    COPY_SONNET_RECOVERY_EXECUTION.alias,
    OPENOX_GROUP,
  );
  if (
    routeIdentity(postRoute) !== routeIdentity(route) ||
    !postPrice ||
    postPrice.pricingVersion !== price.pricingVersion ||
    postPricing.responseSha256 !== catalogResponseSha256 ||
    postTokens.filter(isV18PurposeToken).length !== 1 ||
    postTokens.filter((token) => token.name === RETIRED_V17_TOKEN_NAME).length !== 1 ||
    postTokens.some(
      (token) =>
        token.name === RETIRED_V17_TOKEN_NAME && !isExactRetiredV17Token(token),
    )
  ) {
    fail("COPY_SONNET_RECOVERY_POST_CREATE_DRIFT");
  }
  assertExactToken(
    postTokens.find(isPurposeToken)!,
    expiresAtSeconds,
    quotaCapPoints,
  );

  const dispatch: SettlementDispatch = {
    taskId: COPY_SONNET_RECOVERY_PLAN.taskId,
    alias: COPY_SONNET_RECOVERY_EXECUTION.alias,
    protocol: ANTHROPIC_MESSAGES_TRANSPORT_PROTOCOL,
    channelId: route.id as number,
    upstreamModelId: COPY_SONNET_RECOVERY_EXECUTION.alias,
    upstreamProductLine: price.productLine,
    upstreamGroupName: OPENOX_GROUP,
    pricingCurrency: price.currency,
    inputPriceMicrounitsPerMillionTokens: price.inputPriceMicrounitsPerMillionTokens,
    outputPriceMicrounitsPerMillionTokens: price.outputPriceMicrounitsPerMillionTokens,
    cacheReadPriceMicrounitsPerMillionTokens: price.cacheReadPriceMicrounitsPerMillionTokens,
    cacheWritePriceMicrounitsPerMillionTokens: price.cacheWritePriceMicrounitsPerMillionTokens,
    ledgerMicrousdPerPricingUnit: 1_000_000,
    pricingVersion: price.pricingVersion,
  };
  const withoutDigest = {
    schemaVersion: COPY_SONNET_RECOVERY_ZERO_CALL_PREFLIGHT_SCHEMA_VERSION,
    artifactId: COPY_SONNET_RECOVERY_ZERO_CALL_PREFLIGHT_ARTIFACT_ID,
    classification: "CONTROL_PLANE_ATTESTATION_ONLY" as const,
    executionHeadCommit: input.executionHeadCommit,
    capturedAt: now.toISOString(),
    preflightOnly: true as const,
    dispatchAuthorization: "NOT_AUTHORIZED" as const,
    dispatchCapable: false as const,
    observedModelWireCalls: 0 as const,
    observedModelCost: { CNY: 0 as const, USD: 0 as const },
    runtimeBinding,
    credential: {
      purpose: CREDENTIAL_PURPOSE,
      tokenId,
      bearerTokenSha256: bearerTokenSha256(apiKey),
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      quotaMode: "limited" as const,
      quotaCapPoints,
      remainingQuotaPoints,
      maximumQuotaPointsPerWire,
    },
    executionScope: {
      taskId: COPY_SONNET_RECOVERY_PLAN.taskId,
      alias: COPY_SONNET_RECOVERY_EXECUTION.alias,
      protocol: COPY_SONNET_RECOVERY_EXECUTION.protocol,
      transportProtocol: ANTHROPIC_MESSAGES_TRANSPORT_PROTOCOL,
      reasoning: COPY_SONNET_RECOVERY_EXECUTION.reasoning,
      maximumExecutions: 1 as const,
      maximumWireCalls: 2 as const,
      maximumRepairCallsPerExecution: 1 as const,
    },
    route: {
      channelId: route.id as number,
      channelName: typeof route.name === "string" ? route.name : "",
      channelType: NEW_API_ANTHROPIC_CHANNEL_TYPE,
      baseUrl: OPENOX_ANTHROPIC_BASE_URL,
      modelMapping: "IDENTITY" as const,
      upstreamModelId: COPY_SONNET_RECOVERY_EXECUTION.alias,
      group: OPENOX_GROUP,
    },
    pricing: {
      authority: OPENOX_PRICING_AUTHORITY.provider,
      origin: OPENOX_PRICING_AUTHORITY.origin,
      catalogEndpoint: OPENOX_PRICING_AUTHORITY.catalogEndpoint,
      catalogResponseSha256,
      snapshotSha256: settlementPricingSnapshotSha256(catalog, [dispatch]),
      pricingVersion: price.pricingVersion,
      currency: "USD" as const,
      inputPriceMicrounitsPerMillionTokens: price.inputPriceMicrounitsPerMillionTokens,
      outputPriceMicrounitsPerMillionTokens: price.outputPriceMicrounitsPerMillionTokens,
      cacheReadPriceMicrounitsPerMillionTokens:
        price.cacheReadPriceMicrounitsPerMillionTokens,
      cacheWritePriceMicrounitsPerMillionTokens:
        price.cacheWritePriceMicrounitsPerMillionTokens,
      maximumInputTokensPerWire: MAXIMUM_INPUT_TOKENS_PER_WIRE,
      maximumOutputTokensPerWire: MAXIMUM_OUTPUT_TOKENS_PER_WIRE,
      maximumNativeCostMicrounitsPerWire: nativeCostPerWire,
      maximumNativeCostMicrounits:
        nativeCostPerWire * COPY_SONNET_RECOVERY_PLAN.maximumWireCalls,
      quotaPerNativeUnit: QUOTA_PER_NATIVE_UNIT,
    },
    settlement: {
      status: "READY_FOR_REQUEST_BOUND_OBSERVATION" as const,
      logEndpoint: "/api/log/token" as const,
      requestIdentityHeader: "x-oneapi-request-id" as const,
      zeroCallLogShapeObserved: true as const,
      futurePhysicalCallSettlement:
        "UNPROVEN_UNTIL_SEPARATELY_AUTHORIZED_DISPATCH" as const,
    },
    controlPlaneObservation: {
      observedNetworkCalls: observation.length,
      requests: observation,
      prohibitedModelEndpointCalls: 0 as const,
    },
    requiredFollowup: [
      "SEPARATE_V18_DISPATCH_AUTHORIZATION",
      "REQUEST_BOUND_SETTLEMENT_PER_PHYSICAL_WIRE",
      "GIT_REVIEWED_CAPABILITY_EVIDENCE",
    ] as const,
  };
  const artifact: CopySonnetRecoveryZeroCallPreflightArtifact = {
    ...withoutDigest,
    artifactDigest: canonicalDigest(withoutDigest),
  };
  validateCopySonnetRecoveryZeroCallPreflightArtifact(artifact);
    return { secret: { tokenId, apiKey }, artifact };
  } catch (error) {
    if (creationAttempted) {
      try {
        await disableCopySonnetRecoveryPurposeTokens(
          input,
          fetchImpl,
          observation,
          timeoutMs,
        );
      } catch {
        fail("COPY_SONNET_RECOVERY_TOKEN_CLEANUP_FAILED");
      }
    }
    throw error;
  }
}

export async function provisionAndAttestCopySonnetRecoveryZeroCall(
  input: CopySonnetRecoveryZeroCallPreflightInput,
  deps: RuntimeDeps = {},
): Promise<CopySonnetRecoveryZeroCallPreflightResult> {
  const runExclusive = deps.withExclusiveLock ?? withPreflightLock;
  return runExclusive(() =>
    provisionAndAttestCopySonnetRecoveryZeroCallUnlocked(input, deps),
  );
}
