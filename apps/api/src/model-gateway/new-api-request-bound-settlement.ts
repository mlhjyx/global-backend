import { createHash } from "node:crypto";
import {
  NEW_API_REQUEST_BOUND_RESOLVER_ID,
  NEW_API_SETTLEMENT_READBACK_CAPABILITY_SCHEMA,
  NEW_API_SETTLEMENT_READBACK_CONTRACT,
  type NewApiRequestBoundSettlement,
  type NewApiRequestBoundSettlementInput,
  type NewApiRequestBoundSettlementReceipt,
  type NewApiRequestBoundSettlementResolverPort,
  type NewApiRequestBoundSettlementResolverSettings,
  type NewApiRequestBoundSettlementUnknownReason as UnknownReason,
  type NewApiSettlementReadbackCapability,
  type NewApiSettlementReadbackProbe,
  type NewApiSettlementReadbackProbePhase,
  type NewApiReportedMonetaryCharge,
} from "./settlement-readback-contract";

export {
  NEW_API_REQUEST_BOUND_RESOLVER_ID,
  NEW_API_SETTLEMENT_READBACK_CAPABILITY_SCHEMA,
  NEW_API_SETTLEMENT_READBACK_CONTRACT,
  type NewApiRequestBoundSettlement,
  type NewApiRequestBoundSettlementInput,
  type NewApiRequestBoundSettlementResolverPort,
  type NewApiRequestBoundSettlementResolverSettings,
  type NewApiSettlementReadbackCapability,
  type NewApiSettlementReadbackProbe,
  type NewApiSettlementReadbackProbePhase,
};

const OPAQUE_256 = /^[A-Za-z0-9_-]{43}$/u;
const MODEL_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/u;
const READER_CREDENTIAL = /^srb1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{43}$/u;
const CANONICAL_NON_NEGATIVE_DECIMAL = /^(?:0|[1-9][0-9]*)$/u;
const MAXIMUM_RESPONSE_BYTES = 16 * 1024;
const MAXIMUM_PROBE_DURATION_MS = 30_000;
const MAXIMUM_SIGNED_64 = 9_223_372_036_854_775_807n;
const MAXIMUM_DURABLE_MODEL_NUMBER = 1_000_000_000;
const SECOND_PROBE_DELAY_MS = 50;
const PROTOCOLS = new Set([
  "openai-chat-completions",
  "openai-responses",
  "anthropic-messages",
]);

interface ResolverDependencies {
  fetch?: typeof fetch;
  wait?: (milliseconds: number) => Promise<void>;
  maximumResponseBytes?: number;
}

const CAPTURED_FETCH = fetch;

interface ReadbackReceipt {
  request_id: unknown;
  type: unknown;
  model_name: unknown;
  channel_id: unknown;
  quota: unknown;
  prompt_tokens: unknown;
  completion_tokens: unknown;
  usage_semantic: unknown;
  cache_creation_tokens: unknown;
  cache_read_tokens: unknown;
  upstream_id_state: unknown;
  actual_charge?: unknown;
}

const RECEIPT_KEYS = [
  "request_id",
  "type",
  "model_name",
  "channel_id",
  "quota",
  "prompt_tokens",
  "completion_tokens",
  "usage_semantic",
  "cache_creation_tokens",
  "cache_read_tokens",
  "upstream_id_state",
] as const;

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
    parsed.hash ||
    (parsed.pathname !== "" && parsed.pathname !== "/")
  ) {
    throw new Error("NEW_API_SETTLEMENT_GATEWAY_ORIGIN_INVALID");
  }
  return parsed.origin;
}

function safeInteger(value: unknown, minimum: number): value is number {
  return Number.isSafeInteger(value) && Number(value) >= minimum;
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return (
    actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index])
  );
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("non-finite canonical number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (plainRecord(value)) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  throw new Error("unsupported canonical JSON value");
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

/**
 * Bounded lexical validation runs before JSON.parse so duplicate decoded keys
 * cannot be overwritten and numeric spellings cannot be rounded silently.
 */
class StrictJsonScanner {
  private index = 0;

  constructor(private readonly raw: string) {}

  scan(): void {
    this.skipWhitespace();
    this.scanValue();
    this.skipWhitespace();
    if (this.index !== this.raw.length) this.invalid();
  }

  private invalid(): never {
    throw new Error("NEW_API_SETTLEMENT_JSON_INVALID");
  }

  private skipWhitespace(): void {
    while (
      this.index < this.raw.length &&
      ["\t", "\n", "\r", " "].includes(this.raw[this.index]!)
    ) {
      this.index += 1;
    }
  }

  private scanValue(): void {
    const token = this.raw[this.index];
    if (token === "{") return this.scanObject();
    if (token === "[") return this.scanArray();
    if (token === '"') {
      this.scanString();
      return;
    }
    if (token === "-" || (token !== undefined && /[0-9]/u.test(token))) {
      this.scanInteger();
      return;
    }
    for (const literal of ["true", "false", "null"] as const) {
      if (this.raw.startsWith(literal, this.index)) {
        this.index += literal.length;
        return;
      }
    }
    this.invalid();
  }

  private scanObject(): void {
    this.index += 1;
    this.skipWhitespace();
    const keys = new Set<string>();
    if (this.raw[this.index] === "}") {
      this.index += 1;
      return;
    }
    while (true) {
      if (this.raw[this.index] !== '"') this.invalid();
      const key = this.scanString();
      if (keys.has(key)) this.invalid();
      keys.add(key);
      this.skipWhitespace();
      if (this.raw[this.index] !== ":") this.invalid();
      this.index += 1;
      this.skipWhitespace();
      this.scanValue();
      this.skipWhitespace();
      const separator = this.raw[this.index];
      if (separator === "}") {
        this.index += 1;
        return;
      }
      if (separator !== ",") this.invalid();
      this.index += 1;
      this.skipWhitespace();
    }
  }

  private scanArray(): void {
    this.index += 1;
    this.skipWhitespace();
    if (this.raw[this.index] === "]") {
      this.index += 1;
      return;
    }
    while (true) {
      this.scanValue();
      this.skipWhitespace();
      const separator = this.raw[this.index];
      if (separator === "]") {
        this.index += 1;
        return;
      }
      if (separator !== ",") this.invalid();
      this.index += 1;
      this.skipWhitespace();
    }
  }

  private scanString(): string {
    const start = this.index;
    this.index += 1;
    while (this.index < this.raw.length) {
      const character = this.raw[this.index]!;
      if (character === '"') {
        this.index += 1;
        try {
          const decoded: unknown = JSON.parse(
            this.raw.slice(start, this.index),
          );
          if (typeof decoded !== "string") this.invalid();
          return decoded;
        } catch {
          return this.invalid();
        }
      }
      if (character.charCodeAt(0) <= 0x1f) this.invalid();
      if (character === "\\") {
        this.index += 1;
        const escaped = this.raw[this.index];
        if (escaped === "u") {
          const codepoint = this.raw.slice(this.index + 1, this.index + 5);
          if (!/^[0-9a-fA-F]{4}$/u.test(codepoint)) this.invalid();
          this.index += 5;
          continue;
        }
        if (!escaped || !'"\\/bfnrt'.includes(escaped)) this.invalid();
      }
      this.index += 1;
    }
    return this.invalid();
  }

  private scanInteger(): void {
    if (this.raw[this.index] === "-") this.index += 1;
    if (this.raw[this.index] === "0") {
      this.index += 1;
      if (/[0-9]/u.test(this.raw[this.index] ?? "")) this.invalid();
    } else {
      if (!/[1-9]/u.test(this.raw[this.index] ?? "")) this.invalid();
      while (/[0-9]/u.test(this.raw[this.index] ?? "")) this.index += 1;
    }
    if (/[.eE]/u.test(this.raw[this.index] ?? "")) this.invalid();
  }
}

function parseStrictJson(raw: string): unknown {
  new StrictJsonScanner(raw).scan();
  return JSON.parse(raw) as unknown;
}

async function boundedText(
  response: Response,
  maximumBytes: number,
): Promise<string> {
  const declared = response.headers.get("content-length");
  if (
    declared !== null &&
    (!CANONICAL_NON_NEGATIVE_DECIMAL.test(declared) ||
      BigInt(declared) > BigInt(maximumBytes))
  ) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("NEW_API_SETTLEMENT_RESPONSE_TOO_LARGE");
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
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

async function cancelUnreadBody(response: Response | undefined): Promise<void> {
  await response?.body?.cancel().catch(() => undefined);
}

function assertSuccessHeaders(response: Response): void {
  if (
    response.headers.get("x-new-api-settlement-contract") !==
      NEW_API_SETTLEMENT_READBACK_CONTRACT ||
    response.headers.get("content-type") !== "application/json" ||
    response.headers.get("cache-control") !== "no-store"
  ) {
    throw new Error("NEW_API_SETTLEMENT_CONTRACT_INVALID");
  }
}

function statusClass(status: number): 2 | 4 | 5 | null {
  const value = Math.floor(status / 100);
  return value === 2 || value === 4 || value === 5 ? value : null;
}

function frozenProbe(
  sequence: 1 | 2,
  phase: NewApiSettlementReadbackProbePhase,
  httpStatusClass: 2 | 4 | 5 | null,
): NewApiSettlementReadbackProbe {
  return Object.freeze({ sequence, phase, httpStatusClass });
}

function freezeProbes(
  probes: readonly NewApiSettlementReadbackProbe[],
): readonly NewApiSettlementReadbackProbe[] {
  return Object.freeze([...probes]);
}

type ReceiptValidation =
  | {
      status: "valid";
      channelId: number;
      quota: number;
      inputTokens: number;
      outputTokens: number;
      upstreamIdState: "observed" | "absent";
      actualCharge?: NewApiReportedMonetaryCharge;
    }
  | {
      status: "invalid";
      reason: "log_invalid" | "model_mismatch" | "channel_mismatch";
    };

function parseActualCharge(value: unknown): NewApiReportedMonetaryCharge | null | undefined {
  if (value === undefined) return undefined;
  if (!plainRecord(value) || !exactKeys(value, ["currency", "amount_micros"]) ||
    typeof value.currency !== "string" || !/^[A-Z]{3}$/u.test(value.currency) ||
    typeof value.amount_micros !== "string" || !CANONICAL_NON_NEGATIVE_DECIMAL.test(value.amount_micros)) {
    return null;
  }
  const amountMicros = Number(value.amount_micros);
  return safeInteger(amountMicros, 0) ? Object.freeze({ currency: value.currency, amountMicros }) : null;
}

function hasReceiptShape(value: unknown, discovery: boolean): value is ReadbackReceipt {
  if (!plainRecord(value)) return false;
  const keys = discovery && Object.hasOwn(value, "actual_charge")
    ? [...RECEIPT_KEYS, "actual_charge"]
    : RECEIPT_KEYS;
  return exactKeys(value, keys);
}

function boundedReceiptTokenCount(value: unknown): value is number {
  return safeInteger(value, 0) && value <= MAXIMUM_DURABLE_MODEL_NUMBER;
}

function validateReceipt(
  value: unknown,
  input: NewApiRequestBoundSettlementInput & { requestId: string },
): ReceiptValidation {
  const discovery = input.profile === "discovery-v3";
  if (!hasReceiptShape(value, discovery)) {
    return { status: "invalid", reason: "log_invalid" };
  }
  const receipt = value;
  if (
    receipt.request_id !== input.requestId ||
    receipt.type !== "consume" ||
    typeof receipt.model_name !== "string" ||
    !MODEL_IDENTIFIER.test(receipt.model_name) ||
    Buffer.byteLength(receipt.model_name, "utf8") > 120 ||
    !safeInteger(receipt.channel_id, 1) ||
    receipt.channel_id > 1_000_000_000 ||
    typeof receipt.quota !== "string" ||
    !CANONICAL_NON_NEGATIVE_DECIMAL.test(receipt.quota) ||
    BigInt(receipt.quota) > MAXIMUM_SIGNED_64 ||
    !boundedReceiptTokenCount(receipt.prompt_tokens) ||
    !boundedReceiptTokenCount(receipt.completion_tokens) ||
    !boundedReceiptTokenCount(receipt.cache_creation_tokens) ||
    !boundedReceiptTokenCount(receipt.cache_read_tokens) ||
    (receipt.upstream_id_state !== "observed" &&
      receipt.upstream_id_state !== "absent")
  ) {
    return { status: "invalid", reason: "log_invalid" };
  }
  if (receipt.model_name !== input.alias) {
    return { status: "invalid", reason: "model_mismatch" };
  }
  if (!discovery && receipt.channel_id !== input.expectedChannelId) {
    return { status: "invalid", reason: "channel_mismatch" };
  }
  const actualCharge = parseActualCharge(receipt.actual_charge);
  if (actualCharge === null) return { status: "invalid", reason: "log_invalid" };
  const anthropic = input.protocol === "anthropic-messages";
  if (receipt.usage_semantic !== (anthropic ? "anthropic" : "openai")) {
    return { status: "invalid", reason: "log_invalid" };
  }
  const inputTokens = anthropic
    ? receipt.prompt_tokens +
      receipt.cache_creation_tokens +
      receipt.cache_read_tokens
    : receipt.prompt_tokens;
  const quota = BigInt(receipt.quota);
  if (
    !safeInteger(inputTokens, discovery ? 0 : 1) ||
    inputTokens > MAXIMUM_DURABLE_MODEL_NUMBER ||
    quota > BigInt(input.maximumQuotaPoints) ||
    receipt.completion_tokens > input.maxOutputTokens ||
    (input.usage?.inputTokens !== undefined &&
      input.usage.inputTokens !== inputTokens) ||
    (input.usage?.outputTokens !== undefined &&
      input.usage.outputTokens !== receipt.completion_tokens)
  ) {
    return { status: "invalid", reason: "log_invalid" };
  }
  return {
    status: "valid",
    channelId: receipt.channel_id,
    quota: Number(quota),
    inputTokens,
    outputTokens: receipt.completion_tokens,
    upstreamIdState: receipt.upstream_id_state,
    ...(actualCharge ? { actualCharge } : {}),
  };
}

function validInput(input: NewApiRequestBoundSettlementInput): boolean {
  return (
    MODEL_IDENTIFIER.test(input.alias) &&
    PROTOCOLS.has(input.protocol) &&
    (input.profile === "discovery-v3" ? input.expectedChannelId === undefined :
      input.profile === undefined && safeInteger(input.expectedChannelId, 1) && input.expectedChannelId <= 1_000_000_000) &&
    safeInteger(input.maxOutputTokens, 1) &&
    input.maxOutputTokens <= MAXIMUM_DURABLE_MODEL_NUMBER &&
    safeInteger(input.maximumQuotaPoints, 1) &&
    input.maximumQuotaPoints <= 1_000_000_000 &&
    (input.maximumProbeCount === 1 || input.maximumProbeCount === 2) &&
    input.probeAuthority !== null &&
    typeof input.probeAuthority === "object" &&
    typeof input.probeAuthority.claim === "function" &&
    typeof input.probeAuthority.record === "function" &&
    (input.usage?.inputTokens === undefined ||
      (safeInteger(input.usage.inputTokens, 0) &&
        input.usage.inputTokens <= MAXIMUM_DURABLE_MODEL_NUMBER)) &&
    (input.usage?.outputTokens === undefined ||
      (safeInteger(input.usage.outputTokens, 0) &&
        input.usage.outputTokens <= MAXIMUM_DURABLE_MODEL_NUMBER))
  );
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
      !READER_CREDENTIAL.test(settings.readerCredential) ||
      settings.resolverId !== NEW_API_REQUEST_BOUND_RESOLVER_ID ||
      !safeInteger(settings.maximumProbeDurationMs, 1) ||
      settings.maximumProbeDurationMs > MAXIMUM_PROBE_DURATION_MS
    ) {
      throw new Error("NEW_API_SETTLEMENT_RESOLVER_INVALID");
    }
    this.fetchImpl = dependencies.fetch ?? CAPTURED_FETCH;
    this.wait =
      dependencies.wait ??
      ((milliseconds) =>
        new Promise((resolveWait) => setTimeout(resolveWait, milliseconds)));
    this.maximumResponseBytes =
      dependencies.maximumResponseBytes ?? MAXIMUM_RESPONSE_BYTES;
    if (
      !safeInteger(this.maximumResponseBytes, 1) ||
      this.maximumResponseBytes > MAXIMUM_RESPONSE_BYTES
    ) {
      throw new Error("NEW_API_SETTLEMENT_RESOLVER_INVALID");
    }
  }

  private unknown(
    requestId: string | null,
    reason: UnknownReason,
    probes: readonly NewApiSettlementReadbackProbe[] = [],
  ): NewApiRequestBoundSettlement {
    return Object.freeze({
      status: "unknown" as const,
      requestId,
      resolverId: NEW_API_REQUEST_BOUND_RESOLVER_ID,
      reason,
      physicalCallCount: 0 as const,
      readbackProbes: freezeProbes(probes),
    });
  }

  private async waitForSecondProbe(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    await Promise.race([
      this.wait(SECOND_PROBE_DELAY_MS),
      new Promise<void>((resolveAbort) =>
        signal.addEventListener("abort", () => resolveAbort(), { once: true }),
      ),
    ]);
  }

  private async recordProbe(
    input: NewApiRequestBoundSettlementInput,
    probeId: string,
    probe: NewApiSettlementReadbackProbe,
    receipt?: NewApiRequestBoundSettlementReceipt,
  ): Promise<boolean> {
    try {
      await input.probeAuthority.record({
        probeId,
        probe,
        observedAt: new Date(),
        ...(receipt ? { receipt } : {}),
      });
      return true;
    } catch {
      return false;
    }
  }

  async checkCapability(
    input: { signal?: AbortSignal } = {},
  ): Promise<NewApiSettlementReadbackCapability> {
    const timeout = AbortSignal.timeout(this.settings.maximumProbeDurationMs);
    const signal = input.signal
      ? AbortSignal.any([input.signal, timeout])
      : timeout;
    let response: Response | undefined;
    try {
      response = await this.fetchImpl(
        `${this.gatewayOrigin}/api/settlement-readback/v1/capability`,
        {
          method: "GET",
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${this.settings.readerCredential}`,
          },
          redirect: "error",
          signal,
        },
      );
      if (!response.ok) {
        await cancelUnreadBody(response);
        response = undefined;
        throw new Error("unavailable");
      }
      assertSuccessHeaders(response);
      const body = parseStrictJson(
        await boundedText(response, this.maximumResponseBytes),
      );
      if (
        !plainRecord(body) ||
        !exactKeys(body, ["schema_version", "status"]) ||
        body.schema_version !== NEW_API_SETTLEMENT_READBACK_CAPABILITY_SCHEMA ||
        body.status !== "ready"
      ) {
        throw new Error("NEW_API_SETTLEMENT_CONTRACT_INVALID");
      }
      return Object.freeze({
        ready: true as const,
        resolverId: NEW_API_REQUEST_BOUND_RESOLVER_ID,
      });
    } catch (error) {
      await cancelUnreadBody(response);
      const message = error instanceof Error ? error.message : "";
      const reason =
        message.includes("CONTRACT") ||
        message.includes("JSON") ||
        message.includes("RESPONSE")
          ? ("contract_invalid" as const)
          : ("gateway_unavailable" as const);
      return Object.freeze({
        ready: false as const,
        resolverId: NEW_API_REQUEST_BOUND_RESOLVER_ID,
        reason,
      });
    }
  }

  async resolve(
    input: NewApiRequestBoundSettlementInput,
  ): Promise<NewApiRequestBoundSettlement> {
    if (!input.requestId || !OPAQUE_256.test(input.requestId)) {
      return this.unknown(input.requestId, "request_id_missing");
    }
    if (!input.nonce || !OPAQUE_256.test(input.nonce)) {
      return this.unknown(input.requestId, "nonce_missing");
    }
    if (!validInput(input)) {
      return this.unknown(input.requestId, "log_invalid");
    }

    const requestId = input.requestId;
    const timeout = AbortSignal.timeout(this.settings.maximumProbeDurationMs);
    const signal = input.signal
      ? AbortSignal.any([input.signal, timeout])
      : timeout;
    const probes: NewApiSettlementReadbackProbe[] = [];

    const sequences = ([1, 2] as const).slice(0, input.maximumProbeCount);
    for (const sequence of sequences) {
      if (sequence === 2) await this.waitForSecondProbe(signal);
      if (signal.aborted) {
        return this.unknown(requestId, "gateway_log_unavailable", probes);
      }

      let probeId: string | null;
      try {
        probeId = await input.probeAuthority.claim(sequence);
      } catch {
        probeId = null;
      }
      if (!probeId) {
        if (sequence < input.maximumProbeCount) continue;
        return this.unknown(requestId, "gateway_log_unavailable", probes);
      }

      let response: Response;
      try {
        response = await this.fetchImpl(
          `${this.gatewayOrigin}/api/settlement-readback/v1?request_id=${encodeURIComponent(requestId)}`,
          {
            method: "GET",
            headers: {
              Accept: "application/json",
              Authorization: `Bearer ${this.settings.readerCredential}`,
              "X-New-API-Settlement-Nonce": input.nonce,
            },
            redirect: "error",
            signal,
          },
        );
      } catch {
        const probe = frozenProbe(sequence, "gateway_log_unavailable", null);
        probes.push(probe);
        if (!(await this.recordProbe(input, probeId, probe))) {
          return this.unknown(requestId, "gateway_log_unavailable", probes);
        }
        if (sequence < input.maximumProbeCount) continue;
        return this.unknown(requestId, "gateway_log_unavailable", probes);
      }

      const responseClass = statusClass(response.status);
      if (response.status === 404) {
        await cancelUnreadBody(response);
        const probe = frozenProbe(sequence, "gateway_log_missing", 4);
        probes.push(probe);
        if (!(await this.recordProbe(input, probeId, probe))) {
          return this.unknown(requestId, "gateway_log_unavailable", probes);
        }
        return this.unknown(requestId, "gateway_log_missing", probes);
      }
      if (response.status === 409) {
        await cancelUnreadBody(response);
        const probe = frozenProbe(sequence, "gateway_log_ambiguous", 4);
        probes.push(probe);
        if (!(await this.recordProbe(input, probeId, probe))) {
          return this.unknown(requestId, "gateway_log_unavailable", probes);
        }
        return this.unknown(requestId, "log_ambiguous", probes);
      }
      if (response.status >= 500 && response.status <= 599) {
        await cancelUnreadBody(response);
        const probe = frozenProbe(sequence, "gateway_log_unavailable", 5);
        probes.push(probe);
        if (!(await this.recordProbe(input, probeId, probe))) {
          return this.unknown(requestId, "gateway_log_unavailable", probes);
        }
        if (sequence < input.maximumProbeCount) continue;
        return this.unknown(requestId, "gateway_log_unavailable", probes);
      }
      if (!response.ok) {
        await cancelUnreadBody(response);
        const probe = frozenProbe(
          sequence,
          "gateway_log_invalid",
          responseClass,
        );
        probes.push(probe);
        if (!(await this.recordProbe(input, probeId, probe))) {
          return this.unknown(requestId, "gateway_log_unavailable", probes);
        }
        return this.unknown(requestId, "log_invalid", probes);
      }

      let body: unknown;
      try {
        assertSuccessHeaders(response);
        body = parseStrictJson(
          await boundedText(response, this.maximumResponseBytes),
        );
      } catch {
        await cancelUnreadBody(response);
        const probe = frozenProbe(sequence, "gateway_log_invalid", 2);
        probes.push(probe);
        if (!(await this.recordProbe(input, probeId, probe))) {
          return this.unknown(requestId, "gateway_log_unavailable", probes);
        }
        return this.unknown(requestId, "log_invalid", probes);
      }
      if (!plainRecord(body) || !exactKeys(body, ["data"])) {
        const probe = frozenProbe(sequence, "gateway_log_invalid", 2);
        probes.push(probe);
        if (!(await this.recordProbe(input, probeId, probe))) {
          return this.unknown(requestId, "gateway_log_unavailable", probes);
        }
        return this.unknown(requestId, "log_invalid", probes);
      }
      if (!Array.isArray(body.data)) {
        const probe = frozenProbe(sequence, "gateway_log_invalid", 2);
        probes.push(probe);
        if (!(await this.recordProbe(input, probeId, probe))) {
          return this.unknown(requestId, "gateway_log_unavailable", probes);
        }
        return this.unknown(requestId, "log_invalid", probes);
      }
      if (body.data.length === 0) {
        const probe = frozenProbe(sequence, "gateway_log_pending", 2);
        probes.push(probe);
        if (!(await this.recordProbe(input, probeId, probe))) {
          return this.unknown(requestId, "gateway_log_unavailable", probes);
        }
        if (sequence < input.maximumProbeCount) continue;
        return this.unknown(requestId, "gateway_log_missing", probes);
      }
      if (body.data.length !== 1) {
        const probe = frozenProbe(sequence, "gateway_log_ambiguous", 2);
        probes.push(probe);
        if (!(await this.recordProbe(input, probeId, probe))) {
          return this.unknown(requestId, "gateway_log_unavailable", probes);
        }
        return this.unknown(requestId, "log_ambiguous", probes);
      }
      const validated = validateReceipt(body.data[0], {
        ...input,
        requestId,
      });
      if (validated.status === "invalid") {
        const probe = frozenProbe(sequence, "gateway_log_invalid", 2);
        probes.push(probe);
        if (!(await this.recordProbe(input, probeId, probe))) {
          return this.unknown(requestId, "gateway_log_unavailable", probes);
        }
        return this.unknown(requestId, validated.reason, probes);
      }
      return this.settleObservedReceipt(input, requestId, validated, probeId, sequence, probes);
    }

    return this.unknown(
      requestId,
      probes.some((probe) => probe.phase === "gateway_log_pending")
        ? "gateway_log_missing"
        : "gateway_log_unavailable",
      probes,
    );
  }

  private async settleObservedReceipt(
    input: NewApiRequestBoundSettlementInput,
    requestId: string,
    validated: Extract<ReceiptValidation, { status: "valid" }>,
    probeId: string,
    sequence: 1 | 2,
    probes: NewApiSettlementReadbackProbe[],
  ): Promise<NewApiRequestBoundSettlement> {
    const probe = frozenProbe(sequence, "gateway_log_observed", 2);
    probes.push(probe);
    const receipt = Object.freeze({
      requestId,
      resolverId: NEW_API_REQUEST_BOUND_RESOLVER_ID,
      alias: input.alias,
      protocol: input.protocol,
      channelId: validated.channelId,
      quota: validated.quota,
      inputTokens: validated.inputTokens,
      outputTokens: validated.outputTokens,
      upstreamIdState: validated.upstreamIdState,
      ...(validated.actualCharge ? { actualCharge: validated.actualCharge } : {}),
    });
    const settled = Object.freeze({
      status: "settled" as const,
      ...receipt,
      receiptDigest: digest(receipt),
      physicalCallCount: 0 as const,
      readbackProbes: freezeProbes(probes),
    });
    const evidence = input.profile === "discovery-v3" ? settled : undefined;
    return await this.recordProbe(input, probeId, probe, evidence)
      ? settled
      : this.unknown(requestId, "gateway_log_unavailable", probes);
  }
}
