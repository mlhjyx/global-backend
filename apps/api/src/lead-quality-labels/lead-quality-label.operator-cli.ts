import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import {
  normalizeLeadQualityLabelRequest,
  type LeadQualityLabel,
  type NormalizedLeadQualityLabelRequest,
} from "./lead-quality-label.domain";
import {
  FileLeadQualityLabelOperatorStateStore,
  type LeadQualityLabelOperatorState,
  type LeadQualityLabelOperatorStateStore,
} from "./lead-quality-label.operator-state";

export {
  FileLeadQualityLabelOperatorStateStore,
  type LeadQualityLabelOperatorState,
  type LeadQualityLabelOperatorStateStore,
} from "./lead-quality-label.operator-state";

const RESPONSE_LIMIT_BYTES = 1_048_576;
const INPUT_LIMIT_BYTES = 65_536;
const REQUEST_TIMEOUT_MS = 10_000;
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface OperatorDependencies {
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  stateStore?: LeadQualityLabelOperatorStateStore;
  readFileText?: (path: string) => string;
  write?: (line: string) => void;
  now?: () => Date;
}

interface ParsedArguments {
  command: string;
  execute: boolean;
  values: Map<string, string>;
}

function parseArguments(args: readonly string[]): ParsedArguments {
  const [command, ...rest] = args;
  if (!command)
    throw new Error(
      "command is required: pull | qgo | reject | defer | retry-ack",
    );
  const values = new Map<string, string>();
  let execute = false;
  for (let index = 0; index < rest.length; index += 1) {
    const name = rest[index];
    if (name === "--execute") {
      if (execute) throw new Error("--execute may be specified once");
      execute = true;
      continue;
    }
    if (!name?.startsWith("--"))
      throw new Error("unexpected positional argument");
    const value = rest[index + 1];
    if (value === undefined || value.startsWith("--"))
      throw new Error(`${name} requires a value`);
    if (values.has(name)) throw new Error(`${name} may be specified once`);
    values.set(name, value);
    index += 1;
  }
  return { command, execute, values };
}

function requireOnly(
  parsed: ParsedArguments,
  allowed: readonly string[],
): void {
  const allowedSet = new Set(allowed);
  for (const key of parsed.values.keys()) {
    if (!allowedSet.has(key))
      throw new Error(`${key} is not valid for ${parsed.command}`);
  }
}

function requiredValue(parsed: ParsedArguments, name: string): string {
  const value = parsed.values.get(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function redactedId(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex").slice(0, 12)}`;
}

function safeBaseUrl(raw: string | undefined): URL {
  if (!raw) throw new Error("GLOBAL_API_BASE_URL is required");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("GLOBAL_API_BASE_URL must be an absolute URL");
  }
  if (url.username || url.password)
    throw new Error("GLOBAL_API_BASE_URL must not contain userinfo");
  if (url.search || url.hash)
    throw new Error("GLOBAL_API_BASE_URL must not contain query or fragment");
  const loopback = new Set(["localhost", "127.0.0.1", "[::1]"]);
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && loopback.has(url.hostname))
  ) {
    throw new Error(
      "GLOBAL_API_BASE_URL must use HTTPS except for loopback development",
    );
  }
  if (url.pathname !== "/" && url.pathname !== "")
    throw new Error("GLOBAL_API_BASE_URL must be an origin without a path");
  return url;
}

function bearer(env: Record<string, string | undefined>): string {
  const value = env.GLOBAL_API_BEARER_TOKEN;
  if (!value || /[\s\p{C}]/u.test(value))
    throw new Error("GLOBAL_API_BEARER_TOKEN is required and malformed");
  return value;
}

function endpoint(baseUrl: URL, path: string): string {
  return new URL(path, baseUrl.origin).toString();
}

async function readLimitedJson(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > RESPONSE_LIMIT_BYTES
  ) {
    throw new Error("response exceeded the configured response limit");
  }
  if (!response.body) return null;

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > RESPONSE_LIMIT_BYTES) {
      await reader.cancel();
      throw new Error("response exceeded the configured response limit");
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("response was not valid JSON");
  }
}

async function requestJson(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  operation: string,
): Promise<{ status: number; body: unknown }> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      ...init,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new Error(`${operation} network request failed`);
  }
  const body = await readLimitedJson(response);
  if (!response.ok)
    throw new Error(`${operation} failed with HTTP ${response.status}`);
  return { status: response.status, body };
}

function schemaValidators(): {
  envelope: ReturnType<Ajv2020["compile"]>;
  leadQualified: ReturnType<Ajv2020["compile"]>;
} {
  const contractRoot = resolve(
    __dirname,
    "../../../../packages/contracts/events",
  );
  const envelopeSchema = JSON.parse(
    readFileSync(join(contractRoot, "envelope.schema.json"), "utf8"),
  );
  const payloadSchema = JSON.parse(
    readFileSync(
      join(contractRoot, "payloads/lead-qualified.v1.schema.json"),
      "utf8",
    ),
  );
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  return {
    envelope: ajv.compile(envelopeSchema),
    leadQualified: ajv.compile(payloadSchema),
  };
}

function wireRequest(
  input: NormalizedLeadQualityLabelRequest,
): Record<string, unknown> {
  return {
    source_event_id: input.sourceEventId,
    lead_id: input.leadId,
    lead_qualified_event_id: input.leadQualifiedEventId,
    label: input.label,
    occurred_at: input.occurredAt.toISOString(),
    source_system: input.sourceSystem,
    ...(input.externalObjectRef === null
      ? {}
      : { external_object_ref: input.externalObjectRef }),
    ...(input.reasonCode === null ? {} : { reason_code: input.reasonCode }),
    ...(input.commercialResult === null
      ? {}
      : { commercial_result: input.commercialResult }),
  };
}

function parseInput(
  path: string,
  readFileText: (path: string) => string,
): NormalizedLeadQualityLabelRequest {
  const text = readFileText(path);
  if (Buffer.byteLength(text, "utf8") > INPUT_LIMIT_BYTES)
    throw new Error("label input exceeded the input limit");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("label input was not valid JSON");
  }
  return normalizeLeadQualityLabelRequest(parsed);
}

function readBoundedInputFile(path: string): string {
  const metadata = statSync(path);
  if (!metadata.isFile()) throw new Error("label input must be a regular file");
  if (metadata.size > INPUT_LIMIT_BYTES)
    throw new Error("label input exceeded the input limit");
  return readFileSync(path, "utf8");
}

function assertActionLabel(
  action: "qgo" | "reject",
  input: NormalizedLeadQualityLabelRequest,
): void {
  const required: LeadQualityLabel =
    action === "qgo" ? "QGO_CREATED" : "LEAD_OUTCOME_REJECTED";
  if (input.label !== required)
    throw new Error(`${action} action requires label ${required}`);
}

async function persistAcked(
  stateStore: LeadQualityLabelOperatorStateStore,
  state: LeadQualityLabelOperatorState,
  timestamp: string,
): Promise<void> {
  await stateStore.set({
    ...state,
    status: "ACKED",
    ackedAt: timestamp,
    updatedAt: timestamp,
  });
}

async function ackPostedEvent(options: {
  baseUrl: URL;
  token: string;
  fetchImpl: typeof fetch;
  stateStore: LeadQualityLabelOperatorStateStore;
  state: LeadQualityLabelOperatorState;
  now: () => Date;
}): Promise<void> {
  const response = await requestJson(
    options.fetchImpl,
    endpoint(options.baseUrl, "/api/v1/events/ack"),
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ event_ids: [options.state.eventId] }),
    },
    "ack",
  );
  if (
    !isRecord(response.body) ||
    !isRecord(response.body.data) ||
    !Number.isInteger(response.body.data.acked) ||
    Number(response.body.data.acked) < 0
  ) {
    throw new Error("ack response schema was invalid");
  }
  await persistAcked(
    options.stateStore,
    options.state,
    options.now().toISOString(),
  );
}

async function runPull(
  parsed: ParsedArguments,
  context: Required<
    Pick<OperatorDependencies, "fetchImpl" | "stateStore" | "write">
  > & {
    env: Record<string, string | undefined>;
  },
): Promise<number> {
  requireOnly(parsed, ["--cursor", "--limit"]);
  if (parsed.execute) throw new Error("--execute is not valid for pull");
  const limitRaw = parsed.values.get("--limit") ?? "50";
  if (
    !/^\d+$/.test(limitRaw) ||
    Number(limitRaw) < 1 ||
    Number(limitRaw) > 200
  ) {
    throw new Error("--limit must be an integer from 1 to 200");
  }
  const cursor = parsed.values.get("--cursor");
  if (cursor !== undefined && !/^\d+$/.test(cursor))
    throw new Error("--cursor must be numeric");

  const baseUrl = safeBaseUrl(context.env.GLOBAL_API_BASE_URL);
  const token = bearer(context.env);
  const url = new URL("/api/v1/events", baseUrl.origin);
  url.searchParams.set("type", "LeadQualified");
  url.searchParams.set("limit", limitRaw);
  if (cursor !== undefined) url.searchParams.set("cursor", cursor);
  const response = await requestJson(
    context.fetchImpl,
    url.toString(),
    { method: "GET", headers: { authorization: `Bearer ${token}` } },
    "pull",
  );
  if (
    !isRecord(response.body) ||
    !Array.isArray(response.body.data) ||
    !isRecord(response.body.page)
  ) {
    throw new Error("event page response schema was invalid");
  }
  const page = response.body.page;
  if (
    typeof page.has_more !== "boolean" ||
    !(
      page.next_cursor === null ||
      (typeof page.next_cursor === "string" && /^\d+$/.test(page.next_cursor))
    ) ||
    (page.has_more
      ? typeof page.next_cursor !== "string"
      : page.next_cursor !== null)
  ) {
    throw new Error("event page response schema was invalid");
  }

  const validators = schemaValidators();
  const seen = new Set<string>();
  for (const candidate of response.body.data) {
    if (!validators.envelope(candidate) || !isRecord(candidate)) {
      throw new Error("LeadQualified envelope schema validation failed");
    }
    if (
      candidate.event_type !== "LeadQualified" ||
      candidate.schema_version !== 1 ||
      candidate.aggregate_type !== "Lead" ||
      typeof candidate.event_id !== "string"
    ) {
      throw new Error("LeadQualified envelope binding was invalid");
    }
    if (!validators.leadQualified(candidate.payload)) {
      throw new Error("LeadQualified payload schema validation failed");
    }
    if (
      !isRecord(candidate.payload) ||
      candidate.payload.lead_id !== candidate.aggregate_id ||
      candidate.payload.workspace_id !== candidate.workspace_id
    ) {
      throw new Error("LeadQualified envelope/payload binding was invalid");
    }
    if (seen.has(candidate.event_id)) {
      context.write(
        JSON.stringify({
          event: redactedId(candidate.event_id),
          status: "DUPLICATE_IN_PAGE",
        }),
      );
      continue;
    }
    seen.add(candidate.event_id);
    const state = await context.stateStore.get(candidate.event_id);
    context.write(
      JSON.stringify({
        event: redactedId(candidate.event_id),
        schema_valid: true,
        status: state?.status ?? "PENDING",
        label: state?.label ?? null,
      }),
    );
  }
  context.write(
    JSON.stringify({
      page: {
        count: seen.size,
        has_more: page.has_more,
        next_cursor_present: typeof page.next_cursor === "string",
      },
    }),
  );
  return 0;
}

async function runLabelAction(
  action: "qgo" | "reject",
  parsed: ParsedArguments,
  context: Required<
    Pick<
      OperatorDependencies,
      "fetchImpl" | "stateStore" | "readFileText" | "write" | "now"
    >
  > & {
    env: Record<string, string | undefined>;
  },
): Promise<number> {
  requireOnly(parsed, ["--input"]);
  const input = parseInput(
    requiredValue(parsed, "--input"),
    context.readFileText,
  );
  assertActionLabel(action, input);
  if (!parsed.execute) {
    context.write(
      JSON.stringify({
        mode: "DRY_RUN",
        action,
        event: redactedId(input.leadQualifiedEventId),
        label: input.label,
        network_calls: 0,
        state_writes: 0,
      }),
    );
    return 0;
  }

  const prior = await context.stateStore.get(input.leadQualifiedEventId);
  if (prior?.status === "ACKED") {
    context.write(
      JSON.stringify({
        action,
        event: redactedId(input.leadQualifiedEventId),
        status: "ACKED",
        deduplicated: true,
      }),
    );
    return 0;
  }
  if (prior?.status === "LABEL_POSTED") {
    throw new Error(
      "event is already LABEL_POSTED; use retry-ack instead of repeating POST",
    );
  }

  const baseUrl = safeBaseUrl(context.env.GLOBAL_API_BASE_URL);
  const token = bearer(context.env);
  const posted = await requestJson(
    context.fetchImpl,
    endpoint(baseUrl, "/api/v1/lead-quality-labels"),
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(wireRequest(input)),
    },
    "label post",
  );
  if (
    !isRecord(posted.body) ||
    !isRecord(posted.body.data) ||
    typeof posted.body.data.id !== "string" ||
    !UUID_V4.test(posted.body.data.id)
  ) {
    throw new Error("label post response schema was invalid");
  }

  const timestamp = context.now().toISOString();
  const labelPosted: LeadQualityLabelOperatorState = {
    eventId: input.leadQualifiedEventId,
    status: "LABEL_POSTED",
    label: input.label,
    labelReceiptId: posted.body.data.id,
    labelPostedAt: timestamp,
    ackedAt: null,
    updatedAt: timestamp,
  };
  await context.stateStore.set(labelPosted);
  await ackPostedEvent({
    baseUrl,
    token,
    fetchImpl: context.fetchImpl,
    stateStore: context.stateStore,
    state: labelPosted,
    now: context.now,
  });
  context.write(
    JSON.stringify({
      action,
      event: redactedId(input.leadQualifiedEventId),
      status: "ACKED",
    }),
  );
  return 0;
}

async function runRetryAck(
  parsed: ParsedArguments,
  context: Required<
    Pick<OperatorDependencies, "fetchImpl" | "stateStore" | "write" | "now">
  > & {
    env: Record<string, string | undefined>;
  },
): Promise<number> {
  requireOnly(parsed, ["--event-id"]);
  const eventId = requiredValue(parsed, "--event-id");
  if (!UUID_V4.test(eventId)) throw new Error("--event-id must be a UUID v4");
  const state = await context.stateStore.get(eventId);
  if (!parsed.execute) {
    context.write(
      JSON.stringify({
        mode: "DRY_RUN",
        action: "retry-ack",
        event: redactedId(eventId),
        status: state?.status ?? "PENDING",
      }),
    );
    return 0;
  }
  if (state?.status !== "LABEL_POSTED")
    throw new Error("retry-ack requires durable LABEL_POSTED state");
  const baseUrl = safeBaseUrl(context.env.GLOBAL_API_BASE_URL);
  const token = bearer(context.env);
  await ackPostedEvent({
    baseUrl,
    token,
    fetchImpl: context.fetchImpl,
    stateStore: context.stateStore,
    state,
    now: context.now,
  });
  context.write(
    JSON.stringify({
      action: "retry-ack",
      event: redactedId(eventId),
      status: "ACKED",
    }),
  );
  return 0;
}

async function runDefer(
  parsed: ParsedArguments,
  write: (line: string) => void,
): Promise<number> {
  requireOnly(parsed, ["--event-id"]);
  const eventId = requiredValue(parsed, "--event-id");
  if (!UUID_V4.test(eventId)) throw new Error("--event-id must be a UUID v4");
  write(
    JSON.stringify({
      action: "defer",
      event: redactedId(eventId),
      status: "PENDING",
      network_calls: 0,
      state_writes: 0,
    }),
  );
  return 0;
}

/**
 * Reference operator only. It demonstrates safe LeadQualified consumption and
 * label return; it is not a production SaaS integration or background worker.
 */
export async function runLeadQualityLabelOperator(
  args: readonly string[],
  dependencies: OperatorDependencies = {},
): Promise<number> {
  const parsed = parseArguments(args);
  const env = dependencies.env ?? process.env;
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const readFileText = dependencies.readFileText ?? readBoundedInputFile;
  const write = dependencies.write ?? ((line: string) => console.log(line));
  const now = dependencies.now ?? (() => new Date());
  const statePath =
    env.GLOBAL_LEAD_QUALITY_LABEL_STATE_PATH ??
    join(
      homedir(),
      ".local",
      "state",
      "global-backend",
      "lead-quality-label-operator.json",
    );
  const stateStore =
    dependencies.stateStore ??
    new FileLeadQualityLabelOperatorStateStore(statePath);
  const context = { env, fetchImpl, stateStore, readFileText, write, now };

  if (parsed.command === "pull") return runPull(parsed, context);
  if (parsed.command === "qgo" || parsed.command === "reject") {
    return runLabelAction(parsed.command, parsed, context);
  }
  if (parsed.command === "retry-ack") return runRetryAck(parsed, context);
  if (parsed.command === "defer") return runDefer(parsed, write);
  throw new Error("unknown command: pull | qgo | reject | defer | retry-ack");
}
