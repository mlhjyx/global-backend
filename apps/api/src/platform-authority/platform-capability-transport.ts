import { TextDecoder } from "node:util";
import type { CapabilitySnapshotTransport } from "./platform-capability-cache";

export interface CapabilityTransportConfig {
  readonly endpoint: string;
  readonly backendSha: string;
  readonly growthosSha: string;
  readonly policyDigest: string;
  readonly schedules: readonly Readonly<{
    scheduleId: string;
    workflowType: string;
    taskQueue: string;
    mode: string;
  }>[];
}
export type CapabilityServiceTokenProvider = (
  signal: AbortSignal,
) => Promise<string>;
const MAX_BYTES = 16384;
const COMPACT_JWS = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
function unavailable(): never {
  throw new Error("PLATFORM_CAPABILITY_UNAVAILABLE");
}
function snapshotConfiguration(config: CapabilityTransportConfig) {
  try {
    const value = structuredClone(config);
    const url = new URL(value.endpoint);
    const loopback = url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    if (
      (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !url.pathname.startsWith("/") ||
      url.pathname === "/" ||
      ![value.backendSha, value.growthosSha].every((s) =>
        /^[a-f0-9]{40}$/.test(s),
      ) ||
      !/^[a-f0-9]{64}$/.test(value.policyDigest) ||
      !Array.isArray(value.schedules) ||
      value.schedules.length === 0 ||
      value.schedules.length > 4 ||
      new Set(value.schedules.map((row) => row.scheduleId)).size !==
        value.schedules.length ||
      !value.schedules.every(
        (row) =>
          Object.keys(row).sort().join(",") ===
            "mode,scheduleId,taskQueue,workflowType" &&
          [row.scheduleId, row.workflowType, row.taskQueue].every((field) =>
            /^[A-Za-z0-9._-]{1,191}$/.test(field),
          ) &&
          ["ENABLED", "INTENTIONALLY_DISABLED_NO_EGRESS"].includes(row.mode),
      )
    )
      throw new Error();
    return { ...value, endpoint: url.href };
  } catch {
    throw new Error("PLATFORM_CAPABILITY_TRANSPORT_INVALID");
  }
}
/** Configured internal service IO only. Obtains an existing SaaS service token;
 * never mints a token, obtains a Grant or performs a schedule/provider action.
 * The returned compact JWS still must pass the cache's signature/row validation. */
export function createCapabilityTransport(
  config: CapabilityTransportConfig,
  serviceToken: CapabilityServiceTokenProvider,
  fetcher: typeof fetch = fetch,
): CapabilitySnapshotTransport {
  const trusted = snapshotConfiguration(config);
  return async (nonce, parentSignal) => {
    if (!/^[a-f0-9]{32}$/.test(nonce) || parentSignal.aborted)
      return unavailable();
    const controller = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const cancel = () => controller.abort();
    parentSignal.addEventListener("abort", cancel, { once: true });
    let timeout: ReturnType<typeof setTimeout>;
    let onAbort: () => void = () => {};
    const expired = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new Error("PLATFORM_CAPABILITY_UNAVAILABLE"));
      controller.signal.addEventListener("abort", onAbort, { once: true });
      timeout = setTimeout(cancel, 3000);
    });
    const operation = async () => {
      const token = await serviceToken(controller.signal);
      if (
        controller.signal.aborted ||
        typeof token !== "string" ||
        Buffer.byteLength(token) > MAX_BYTES ||
        !COMPACT_JWS.test(token)
      )
        return unavailable();
      const response = await fetcher(trusted.endpoint, {
        method: "POST",
        redirect: "manual",
        credentials: "omit",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/jose",
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        },
        body: JSON.stringify({
          operationId: "platformAutomationCapabilities_v1",
          nonce,
          backendSha: trusted.backendSha,
          growthosSha: trusted.growthosSha,
          policyDigest: trusted.policyDigest,
          namespace: "platform-automation",
          schedules: trusted.schedules,
        }),
      });
      if (
        controller.signal.aborted ||
        response.status !== 200 ||
        response.redirected ||
        (response.url && response.url !== trusted.endpoint) ||
        response.headers
          .get("content-type")
          ?.split(";")[0]
          .trim()
          .toLowerCase() !== "application/jose" ||
        !response.body
      )
        return unavailable();
      const declared = response.headers.get("content-length");
      if (
        declared !== null &&
        (!/^[0-9]+$/.test(declared) || Number(declared) > MAX_BYTES)
      )
        return unavailable();
      reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const chunk = await reader.read();
        if (controller.signal.aborted) return unavailable();
        if (chunk.done) break;
        if (
          !(chunk.value instanceof Uint8Array) ||
          chunk.value.byteLength === 0
        )
          return unavailable();
        size += chunk.value.byteLength;
        if (size > MAX_BYTES) return unavailable();
        chunks.push(chunk.value);
      }
      const value = new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: true,
      }).decode(Buffer.concat(chunks, size));
      if (!COMPACT_JWS.test(value)) return unavailable();
      return value;
    };
    try {
      return await Promise.race([operation(), expired]);
    } catch {
      return unavailable();
    } finally {
      clearTimeout(timeout!);
      parentSignal.removeEventListener("abort", cancel);
      controller.signal.removeEventListener("abort", onAbort);
      controller.abort();
      // Cancellation must not delay return if an injected/failed stream ignores it.
      if (reader) {
        void reader.cancel().catch(() => {});
        try {
          reader.releaseLock();
        } catch {
          /* pending read is aborted */
        }
      }
    }
  };
}
