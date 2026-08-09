import { createHash } from "node:crypto";

const REQUEST_ID = /^[A-Za-z0-9_-]{8,128}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,191}$/;
const DEFAULT_MAXIMUM_RESPONSE_BYTES = 1024 * 1024;
const MAXIMUM_POLL_DURATION_MS = 30_000;

interface LogRow {
  request_id?: unknown;
  type?: unknown;
  quota?: unknown;
  prompt_tokens?: unknown;
  completion_tokens?: unknown;
  model_name?: unknown;
  channel?: unknown;
  other?: unknown;
}

interface ResolverDependencies {
  fetch?: typeof fetch;
  wait?: (milliseconds: number) => Promise<void>;
  maximumResponseBytes?: number;
}

const CAPTURED_FETCH = fetch;

export interface NewApiRequestBoundSettlementResolverSettings {
  gatewayOrigin: string;
  apiKey: string;
  resolverId: string;
  maximumPollDurationMs: number;
}

export interface NewApiRequestBoundSettlementInput {
  requestId: string | null;
  alias: string;
  protocol: string;
  expectedChannelId: number;
  usage?: { inputTokens?: number; outputTokens?: number };
  maxOutputTokens: number;
  maximumQuotaPoints: number;
  signal?: AbortSignal;
}

export type NewApiRequestBoundSettlement =
  | {
      status: "settled";
      requestId: string;
      resolverId: string;
      alias: string;
      protocol: string;
      channelId: number;
      quota: number;
      inputTokens: number;
      outputTokens: number;
      receiptDigest: string;
    }
  | {
      status: "unknown";
      requestId: string | null;
      resolverId: string;
      reason:
        | "request_id_missing"
        | "log_unavailable"
        | "log_ambiguous"
        | "log_invalid"
        | "model_mismatch"
        | "channel_mismatch";
    };

function canonicalOrigin(value: string): string {
  const parsed = new URL(value);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(
    parsed.hostname.toLowerCase(),
  );
  if (
    (parsed.protocol !== "https:" &&
      !(parsed.protocol === "http:" && loopback)) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("NEW_API_SETTLEMENT_GATEWAY_ORIGIN_INVALID");
  }
  return parsed.origin;
}

function safeInteger(value: unknown, minimum: number): value is number {
  return Number.isSafeInteger(value) && Number(value) >= minimum;
}

function logMetadata(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return parsed != null &&
        typeof parsed === "object" &&
        !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : undefined;
    } catch {
      return undefined;
    }
  }
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function effectiveInputTokens(
  row: LogRow,
  protocol: string,
): number | undefined {
  const anthropicProtocol = /^anthropic(?:_|-)messages$/u.test(protocol);
  if (!safeInteger(row.prompt_tokens, anthropicProtocol ? 0 : 1)) {
    return undefined;
  }
  const metadata = logMetadata(row.other);
  if (!anthropicProtocol) {
    if (metadata?.usage_semantic === "anthropic") return undefined;
    return row.prompt_tokens;
  }
  if (metadata?.usage_semantic !== "anthropic") return undefined;
  const cacheCreationTokens = metadata.cache_creation_tokens ?? 0;
  const cacheReadTokens = metadata.cache_tokens ?? 0;
  if (
    !safeInteger(cacheCreationTokens, 0) ||
    !safeInteger(cacheReadTokens, 0)
  ) {
    return undefined;
  }
  const total = row.prompt_tokens + cacheCreationTokens + cacheReadTokens;
  return safeInteger(total, 1) ? total : undefined;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("non-finite canonical number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  throw new Error("unsupported canonical JSON value");
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

async function boundedJson(
  response: Response,
  maximumBytes: number,
): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const parsed = Number(declared);
    if (!safeInteger(parsed, 0) || parsed > maximumBytes) {
      throw new Error("NEW_API_SETTLEMENT_RESPONSE_TOO_LARGE");
    }
  }
  if (!response.body) throw new Error("NEW_API_SETTLEMENT_RESPONSE_MISSING");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error("NEW_API_SETTLEMENT_RESPONSE_TOO_LARGE");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

export class NewApiRequestBoundSettlementResolver {
  private readonly gatewayOrigin: string;
  private readonly fetchImpl: typeof fetch;
  private readonly wait: (milliseconds: number) => Promise<void>;
  private readonly maximumResponseBytes: number;

  constructor(
    private readonly settings: NewApiRequestBoundSettlementResolverSettings,
    dependencies: ResolverDependencies = {},
  ) {
    this.gatewayOrigin = canonicalOrigin(settings.gatewayOrigin);
    if (
      !settings.apiKey.trim() ||
      !IDENTIFIER.test(settings.resolverId) ||
      !safeInteger(settings.maximumPollDurationMs, 1) ||
      settings.maximumPollDurationMs > MAXIMUM_POLL_DURATION_MS
    ) {
      throw new Error("NEW_API_SETTLEMENT_RESOLVER_INVALID");
    }
    this.fetchImpl = dependencies.fetch ?? CAPTURED_FETCH;
    this.wait =
      dependencies.wait ??
      ((milliseconds) =>
        new Promise((resolveWait) => setTimeout(resolveWait, milliseconds)));
    this.maximumResponseBytes =
      dependencies.maximumResponseBytes ?? DEFAULT_MAXIMUM_RESPONSE_BYTES;
    if (!safeInteger(this.maximumResponseBytes, 1)) {
      throw new Error("NEW_API_SETTLEMENT_RESOLVER_INVALID");
    }
  }

  private unknown(
    requestId: string | null,
    reason: Extract<
      NewApiRequestBoundSettlement,
      { status: "unknown" }
    >["reason"],
  ): NewApiRequestBoundSettlement {
    return Object.freeze({
      status: "unknown" as const,
      requestId,
      resolverId: this.settings.resolverId,
      reason,
    });
  }

  private async waitUntil(delay: number, signal: AbortSignal): Promise<void> {
    if (delay <= 0 || signal.aborted) return;
    await Promise.race([
      this.wait(delay),
      new Promise<void>((resolveAbort) =>
        signal.addEventListener("abort", () => resolveAbort(), { once: true }),
      ),
    ]);
  }

  async resolve(
    input: NewApiRequestBoundSettlementInput,
  ): Promise<NewApiRequestBoundSettlement> {
    if (!input.requestId || !REQUEST_ID.test(input.requestId)) {
      return this.unknown(input.requestId, "request_id_missing");
    }
    if (
      !input.alias.trim() ||
      !input.protocol.trim() ||
      !safeInteger(input.expectedChannelId, 1) ||
      !safeInteger(input.maxOutputTokens, 1) ||
      !safeInteger(input.maximumQuotaPoints, 1)
    ) {
      return this.unknown(input.requestId, "log_invalid");
    }

    const timeout = AbortSignal.timeout(this.settings.maximumPollDurationMs);
    const signal = input.signal
      ? AbortSignal.any([input.signal, timeout])
      : timeout;
    for (const delay of [0, 50, 150, 400]) {
      if (signal.aborted) break;
      if (delay > 0) {
        await this.waitUntil(delay, signal);
        if (signal.aborted) break;
      }
      let response: Response;
      let body: unknown;
      try {
        response = await this.fetchImpl(`${this.gatewayOrigin}/api/log/token`, {
          headers: { Authorization: `Bearer ${this.settings.apiKey}` },
          signal,
        });
        if (!response.ok) continue;
        body = await boundedJson(response, this.maximumResponseBytes);
      } catch {
        continue;
      }
      const rows = ((body as { data?: unknown })?.data ?? []) as unknown;
      if (!Array.isArray(rows)) continue;
      const matching = (rows as LogRow[]).filter(
        (row) => row.request_id === input.requestId,
      );
      if (matching.length === 0) continue;
      if (matching.length !== 1 || matching[0]!.type !== 2) {
        return this.unknown(input.requestId, "log_ambiguous");
      }
      const row = matching[0]!;
      if (row.model_name !== input.alias) {
        return this.unknown(input.requestId, "model_mismatch");
      }
      if (row.channel !== input.expectedChannelId) {
        return this.unknown(input.requestId, "channel_mismatch");
      }
      const inputTokens = effectiveInputTokens(row, input.protocol);
      if (
        !safeInteger(row.quota, 0) ||
        row.quota > input.maximumQuotaPoints ||
        inputTokens === undefined ||
        !safeInteger(row.completion_tokens, 0) ||
        row.completion_tokens > input.maxOutputTokens ||
        (input.usage?.inputTokens !== undefined &&
          input.usage.inputTokens !== inputTokens) ||
        (input.usage?.outputTokens !== undefined &&
          input.usage.outputTokens !== row.completion_tokens)
      ) {
        return this.unknown(input.requestId, "log_invalid");
      }
      const receipt = Object.freeze({
        requestId: input.requestId,
        resolverId: this.settings.resolverId,
        alias: input.alias,
        protocol: input.protocol,
        channelId: row.channel,
        quota: row.quota,
        inputTokens,
        outputTokens: row.completion_tokens,
      });
      const settled = Object.freeze({
        status: "settled" as const,
        ...receipt,
        receiptDigest: digest(receipt),
      });
      return settled;
    }
    return this.unknown(input.requestId, "log_unavailable");
  }
}
