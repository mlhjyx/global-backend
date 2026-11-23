import { describe, expect, it } from "vitest";
import {
  parseQuotedEnrichmentSlot,
  parseEnrichmentCandidateRef,
} from "./enrichment-safety.contract";
const slot = () => ({
  slotKey: "s1",
  contactId: "c1",
  contactOrdinal: 0,
  phase: "FINDER",
  provider: "hunter",
  toolId: "contact_email.find.hunter",
  toolVersion: "1.0.0",
  quoteMicrousd: "1780",
  pricingVersion: "price-v1",
  dependsOnSlotKey: null,
});
describe("closed enrichment slot contract", () => {
  it("accepts only the exact finite metadata record", () =>
    expect(parseQuotedEnrichmentSlot(slot())).toEqual(slot()));
  it.each([
    null,
    [],
    { ...slot(), email: "sentinel@example.invalid" },
    { ...slot(), quoteMicrousd: "01" },
    { ...slot(), quoteMicrousd: 1780 },
    { ...slot(), phase: "OTHER" },
    { ...slot(), contactOrdinal: -1 },
  ])("rejects malformed or PII-bearing metadata %j", (value) =>
    expect(() => parseQuotedEnrichmentSlot(value)).toThrow(),
  );
});

const candidate = () => ({
  operationId: "00000000-0000-4000-8000-000000000009",
  resultDigest: "b".repeat(64),
  artifactRef: {
    schemaVersion: "generic-operation-artifact-ref/v1",
    artifactId: "00000000-0000-4000-8000-000000000010",
    operationId: "00000000-0000-4000-8000-000000000009",
    resultSchema: "contact-email-find-hunter/v1",
    sha256: "b".repeat(64),
    sizeBytes: "128",
    mediaType: "application/octet-stream",
    expiresAt: "2099-01-01T00:00:00.000Z",
  },
});
describe("closed original candidate reference metadata, not proof of ledger provenance", () => {
  it("preserves the original artifact receipt digest binding to encrypted body sha256", () => {
    const c = candidate();
    const parsed = parseEnrichmentCandidateRef(c);
    expect(parsed).toEqual(c);
    expect(parsed.resultDigest).toBe(parsed.artifactRef.sha256);
    expect(Object.isFrozen(parsed.artifactRef)).toBe(true);
  });
  it.each([
    null,
    { ...candidate(), email: "PII_SENTINEL" },
    { ...candidate(), operationId: "00000000-0000-4000-8000-000000000011" },
    { ...candidate(), resultDigest: "bad" },
    {
      ...candidate(),
      artifactRef: { ...candidate().artifactRef, resultSchema: "http-get/v1" },
    },
    {
      ...candidate(),
      artifactRef: { ...candidate().artifactRef, sizeBytes: "16385" },
    },
    {
      ...candidate(),
      artifactRef: { ...candidate().artifactRef, mediaType: "text/plain" },
    },
  ])("rejects mismatched or payload-bearing candidate %#", (value) =>
    expect(() => parseEnrichmentCandidateRef(value)).toThrow(),
  );
  it("rejects getters before evaluating them", () => {
    const c = candidate();
    let reads = 0;
    Object.defineProperty(c, "resultDigest", {
      enumerable: true,
      get() {
        reads += 1;
        return "d".repeat(64);
      },
    });
    expect(() => parseEnrichmentCandidateRef(c)).toThrow();
    expect(reads).toBe(0);
  });
});
describe("closed slot own-data boundary", () => {
  it("rejects an own getter without invoking it", () => {
    const s = slot();
    let reads = 0;
    Object.defineProperty(s, "provider", {
      enumerable: true,
      get() {
        reads += 1;
        return "hunter";
      },
    });
    expect(() => parseQuotedEnrichmentSlot(s)).toThrow();
    expect(reads).toBe(0);
  });
  it("rejects hidden and symbol extra payloads rather than silently dropping them", () => {
    const a = slot();
    Object.defineProperty(a, "email", {
      value: "PII_SENTINEL",
      enumerable: false,
    });
    expect(() => parseQuotedEnrichmentSlot(a)).toThrow();
    const b = slot();
    Object.defineProperty(b, Symbol("payload"), { value: "PII_SENTINEL" });
    expect(() => parseQuotedEnrichmentSlot(b)).toThrow();
  });
});

describe("original artifact receipt digest protocol regression", () => {
  it("rejects a candidate receipt digest unequal to its original artifact reference sha256", () => {
    const c = candidate();
    expect(() =>
      parseEnrichmentCandidateRef({ ...c, resultDigest: "a".repeat(64) }),
    ).toThrow();
  });
});
