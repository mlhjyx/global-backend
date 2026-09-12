import { describe, expect, it } from "vitest";
import { capabilityValidUntil } from "./platform-capability-freshness";
const NOW = 1_800_000_000_000;
const input = () => ({
  issuedAt: NOW,
  expiresAt: NOW + 30_000,
  temporalPermission: { observedAt: NOW, validUntil: NOW + 60_000 },
  issuer: { observedAt: NOW, validUntil: NOW + 60_000 },
  revocationConsumer: { observedAt: NOW - 29_000, validUntil: NOW + 1_000 },
  undeliveredCount: 0,
  oldestUndeliveredCreatedAt: null,
});
describe("platform capability underlying freshness", () => {
  it("cannot extend a nearly expired consumer lease with a new signed envelope", () => {
    expect(capabilityValidUntil(input(), NOW)).toBe(NOW + 1_000);
    expect(
      capabilityValidUntil(
        { ...input(), issuedAt: NOW + 1_000, expiresAt: NOW + 31_000 },
        NOW + 1_000,
      ),
    ).toBeNull();
  });
  it("admits empty backlog with explicit null while retaining lease deadline", () => {
    expect(capabilityValidUntil(input(), NOW)).toBe(NOW + 1_000);
  });
  it("bounds freshness by oldest outstanding delivery", () => {
    expect(
      capabilityValidUntil(
        {
          ...input(),
          undeliveredCount: 1,
          oldestUndeliveredCreatedAt: NOW - 29_500,
        },
        NOW,
      ),
    ).toBe(NOW + 500);
  });
  it.each([
    { undeliveredCount: 0, oldestUndeliveredCreatedAt: NOW },
    { undeliveredCount: 1, oldestUndeliveredCreatedAt: null },
    { undeliveredCount: -1 },
    { undeliveredCount: 0.5 },
    { oldestUndeliveredCreatedAt: undefined },
    { undeliveredCount: 1, oldestUndeliveredCreatedAt: NOW + 1 },
    { undeliveredCount: 1, oldestUndeliveredCreatedAt: NOW - 30_000 },
    { issuedAt: NOW + 1 },
    { expiresAt: NOW },
    { expiresAt: NOW + 30_001 },
    { temporalPermission: { observedAt: NOW + 1, validUntil: NOW + 2 } },
    { issuer: { observedAt: NOW, validUntil: NOW } },
    {
      revocationConsumer: {
        observedAt: NOW - 30_000,
        validUntil: NOW + 30_000,
      },
    },
    { revocationConsumer: { observedAt: NOW, validUntil: NOW + 30_001 } },
  ])("rejects inconsistent or stale evidence %#", (mutation) => {
    expect(capabilityValidUntil({ ...input(), ...mutation }, NOW)).toBeNull();
  });
  it.each([null, {}, [], NaN, Infinity, "snapshot"])(
    "rejects malformed snapshot %#",
    (value) => {
      expect(capabilityValidUntil(value, NOW)).toBeNull();
    },
  );
});

describe("freshness malformed object and numeric boundaries", () => {
  it("rejects extra and accessor properties without invoking getters", () => {
    expect(capabilityValidUntil({ ...input(), extra: true }, NOW)).toBeNull();
    const candidate = input();
    Object.defineProperty(candidate, "issuer", {
      get() {
        throw new Error("must not execute");
      },
      enumerable: true,
    });
    expect(capabilityValidUntil(candidate, NOW)).toBeNull();
  });
  it("rejects proxies that throw during structural inspection", () => {
    const candidate = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error("hostile");
        },
      },
    );
    expect(capabilityValidUntil(candidate, NOW)).toBeNull();
  });
  it.each([NaN, Infinity, -1, 0.5])("rejects invalid clock %s", (now) => {
    expect(capabilityValidUntil(input(), now)).toBeNull();
  });
  it("checks each dependency independently and chooses its earliest expiry", () => {
    for (const key of [
      "temporalPermission",
      "issuer",
      "revocationConsumer",
    ] as const) {
      expect(
        capabilityValidUntil(
          { ...input(), [key]: { observedAt: NOW, validUntil: NOW + 100 } },
          NOW,
        ),
      ).toBe(NOW + 100);
      expect(capabilityValidUntil({ ...input(), [key]: {} }, NOW)).toBeNull();
      expect(
        capabilityValidUntil(
          { ...input(), [key]: { observedAt: NaN, validUntil: NOW + 100 } },
          NOW,
        ),
      ).toBeNull();
    }
  });
  it("rejects missing root fields and prototype-backed inputs", () => {
    const missing: Record<string, unknown> = { ...input() };
    delete missing.issuedAt;
    expect(capabilityValidUntil(missing, NOW)).toBeNull();
    expect(capabilityValidUntil(Object.create(input()), NOW)).toBeNull();
  });
});
