import { randomBytes } from "node:crypto";
import type { JSONWebKeySet } from "jose";
import {
  verifyCapabilityEnvelope,
  type CapabilityEnvelopeBinding,
} from "./platform-capability-signature";
import {
  validateCapabilityRows,
  type CapabilityScheduleBinding,
  type ValidatedCapabilityRow,
} from "./platform-capability-rows";

export interface CapabilityCacheConfig {
  readonly expected: Omit<CapabilityEnvelopeBinding, "nonce">;
  readonly schedules: readonly CapabilityScheduleBinding[];
  readonly jwks: JSONWebKeySet;
  readonly allowedKids: readonly string[];
}
/** This transport must be the bounded, authenticated internal HTTP adapter.
 * It cannot choose its endpoint from nonce or response content. No default fake. */
export type CapabilitySnapshotTransport = (
  nonce: string,
  signal: AbortSignal,
) => Promise<string>;
const unavailable = () => ({
  status: "failed" as const,
  code: "PLATFORM_CAPABILITY_UNAVAILABLE",
});
export function createCapabilityCache(
  config: CapabilityCacheConfig,
  transport: CapabilitySnapshotTransport,
  clock: () => number = Date.now,
) {
  // Only primitive configured identities/public keys are retained, before async IO.
  const trusted = structuredClone(config);
  let cached:
    | Readonly<{ notBefore: number; rows: readonly ValidatedCapabilityRow[] }>
    | undefined;
  let inFlight: Promise<void> | undefined;
  let controller: AbortController | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let stopped = false;
  let generation = 0;
  let lastNow = 0;
  const now = () => {
    const value = clock();
    if (!Number.isSafeInteger(value) || value < lastNow || value < 0) {
      cached = undefined;
      throw new Error("PLATFORM_CAPABILITY_UNAVAILABLE");
    }
    lastNow = value;
    return value;
  };
  function refresh(): Promise<void> {
    if (stopped) return Promise.resolve();
    if (inFlight) return inFlight;
    const version = generation;
    const active = new AbortController();
    controller = active;
    const nonce = randomBytes(16).toString("hex");
    let timeout: ReturnType<typeof setTimeout>;
    let onAbort: () => void = () => {};
    const expired = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new Error("PLATFORM_CAPABILITY_UNAVAILABLE"));
      active.signal.addEventListener("abort", onAbort, { once: true });
      timeout = setTimeout(() => active.abort(), 3000);
    });
    const operation = async () => {
      const token = await transport(nonce, active.signal);
      const envelope = await verifyCapabilityEnvelope(
        token,
        { ...trusted.expected, nonce },
        trusted.jwks,
        trusted.allowedKids,
        now(),
      );
      const issuedAt = (envelope.iat as number) * 1000;
      const rows = validateCapabilityRows(
        envelope.rows,
        trusted.schedules,
        issuedAt,
        (envelope.exp as number) * 1000,
        now(),
      );
      return Object.freeze({ notBefore: issuedAt, rows });
    };
    inFlight = Promise.race([operation(), expired])
      .then((snapshot) => {
        if (!stopped && generation === version && !active.signal.aborted)
          cached = snapshot;
      })
      .catch(() => {
        if (generation === version) cached = undefined;
      })
      .finally(() => {
        clearTimeout(timeout);
        active.signal.removeEventListener("abort", onAbort);
        if (controller === active) controller = undefined;
        inFlight = undefined;
      });
    return inFlight;
  }
  return Object.freeze({
    refresh,
    check(scheduleId: string) {
      try {
        const current = now();
        const row = cached?.rows.find(
          (candidate) => candidate.scheduleId === scheduleId,
        );
        if (
          stopped ||
          !cached ||
          current < cached.notBefore ||
          !row ||
          current >= row.validUntil
        )
          return unavailable();
        return { status: "ok" as const };
      } catch {
        return unavailable();
      }
    },
    start() {
      if (stopped || timer) return;
      void refresh();
      timer = setInterval(() => {
        void refresh();
      }, 10000);
      timer.unref();
    },
    stop() {
      stopped = true;
      generation++;
      cached = undefined;
      clearInterval(timer);
      timer = undefined;
      controller?.abort();
    },
  });
}
