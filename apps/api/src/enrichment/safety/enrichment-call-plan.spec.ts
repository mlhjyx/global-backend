import { describe, expect, it } from "vitest";
import { buildFrozenEnrichmentPlan } from "./enrichment-call-plan";
import type { TrustedPlanInput } from "./enrichment-safety.contract";
const input = (): TrustedPlanInput => ({
  workspaceId: "w1",
  companyId: "co1",
  entrypoint: "http",
  businessRunId: null,
  requestSha256: "a".repeat(64),
  admittedAtMs: 1000,
  deadlineAtMs: 601000,
  targets: [
    {
      contactId: "c1",
      contactOrdinal: 0,
      inputVersion: "v1",
      beforeDigest: "b".repeat(64),
      pointRefs: [],
    },
  ],
  slots: [
    {
      slotKey: "f1",
      contactId: "c1",
      contactOrdinal: 0,
      phase: "FINDER",
      provider: "hunter",
      toolId: "contact_email.find.hunter",
      toolVersion: "1.0.0",
      quoteMicrousd: "1780",
      pricingVersion: "p1",
      dependsOnSlotKey: null,
    },
    {
      slotKey: "v1",
      contactId: "c1",
      contactOrdinal: 0,
      phase: "VERIFY",
      provider: "millionverifier",
      toolId: "contact_email.verify.millionverifier",
      toolVersion: "1.0.0",
      quoteMicrousd: "1700",
      pricingVersion: "p1",
      dependsOnSlotKey: "f1",
    },
  ],
  limits: {
    authorityCapMicrousd: "500000",
    companyCapMicrousd: "500000",
    contactCapMicrousd: "150000",
    finderCompanyMax: 10,
    finderContactMax: 3,
    verifyAddressMax: 6,
    maxContacts: 10,
  },
});
describe("frozen worst-case enrichment plan", () => {
  it("retains exact quotes, deadline and a stable canonical digest across object key order", () => {
    const a = input();
    const p = buildFrozenEnrichmentPlan(a);
    const q = buildFrozenEnrichmentPlan({ ...a, limits: { ...a.limits } });
    expect(p.version).toBe(1);
    expect(p.planSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(p.planSha256).toBe(q.planSha256);
    expect(p.slots.map((s) => s.quoteMicrousd)).toEqual(["1780", "1700"]);
    expect(p.deadlineAtMs).toBe(601000);
  });
  it("deep freezes fresh data rather than trusting a mutable caller snapshot", () => {
    const a = input();
    const p = buildFrozenEnrichmentPlan(a);
    expect(p).not.toBe(a);
    expect(Object.isFrozen(p)).toBe(true);
    expect(Object.isFrozen(p.slots[0])).toBe(true);
    expect(Object.isFrozen(p.limits)).toBe(true);
  });
  it.each([
    "authorityCapMicrousd",
    "companyCapMicrousd",
    "contactCapMicrousd",
  ] as const)(
    "counts every potential slot against %s, not just the likely first success",
    (cap) => {
      const a = input();
      expect(() =>
        buildFrozenEnrichmentPlan({
          ...a,
          limits: { ...a.limits, [cap]: "3479" },
        }),
      ).toThrow();
    },
  );
  it("allows exact equality to the tightest cap", () => {
    const a = input();
    expect(
      buildFrozenEnrichmentPlan({
        ...a,
        limits: { ...a.limits, authorityCapMicrousd: "3480" },
      }).slots,
    ).toHaveLength(2);
  });
  it("tightens discovery-run company cap to the original 500000 ceiling", () => {
    const a = input();
    const p = buildFrozenEnrichmentPlan({
      ...a,
      entrypoint: "discovery_run",
      businessRunId: "business-run",
      limits: {
        ...a.limits,
        authorityCapMicrousd: "900000",
        companyCapMicrousd: "900000",
      },
    });
    expect(p.limits.companyCapMicrousd).toBe("500000");
  });
  it.each(["findymail", "truelist"])(
    "does not silently remove reachable unsupported provider %s",
    (provider) => {
      const a = input();
      expect(() =>
        buildFrozenEnrichmentPlan({
          ...a,
          slots: [{ ...a.slots[0]!, provider }],
        }),
      ).toThrow();
    },
  );
  it("rejects duplicate slot identity", () => {
    const a = input();
    expect(() =>
      buildFrozenEnrichmentPlan({ ...a, slots: [a.slots[0]!, a.slots[0]!] }),
    ).toThrow();
  });
  it("rejects cross-contact prerequisites", () => {
    const a = input();
    expect(() =>
      buildFrozenEnrichmentPlan({
        ...a,
        targets: [
          ...a.targets,
          { ...a.targets[0]!, contactId: "c2", contactOrdinal: 1 },
        ],
        slots: [
          a.slots[0]!,
          { ...a.slots[1]!, contactId: "c2", contactOrdinal: 1 },
        ],
      }),
    ).toThrow();
  });
  it("rejects a cycle and a missing predecessor", () => {
    const a = input();
    expect(() =>
      buildFrozenEnrichmentPlan({
        ...a,
        slots: [{ ...a.slots[0]!, dependsOnSlotKey: "v1" }, a.slots[1]!],
      }),
    ).toThrow();
    expect(() =>
      buildFrozenEnrichmentPlan({
        ...a,
        slots: [{ ...a.slots[1]!, dependsOnSlotKey: "absent" }],
      }),
    ).toThrow();
  });
  it.each([0, 11])("rejects invalid maxContacts %s", (maxContacts) => {
    const a = input();
    expect(() =>
      buildFrozenEnrichmentPlan({ ...a, limits: { ...a.limits, maxContacts } }),
    ).toThrow();
  });
  it("rejects a deadline extension beyond the original ten minutes", () => {
    const a = input();
    expect(() =>
      buildFrozenEnrichmentPlan({ ...a, deadlineAtMs: 601001 }),
    ).toThrow();
  });
  it("rejects a finder count beyond the original company cap", () => {
    const a = input();
    expect(() =>
      buildFrozenEnrichmentPlan({
        ...a,
        slots: Array.from({ length: 11 }, (_, n) => ({
          ...a.slots[0]!,
          slotKey: "f" + n,
        })),
      }),
    ).toThrow();
  });
  it("rejects a missing or noncanonical finite price quote", () => {
    const a = input();
    expect(() =>
      buildFrozenEnrichmentPlan({
        ...a,
        slots: [{ ...a.slots[0]!, quoteMicrousd: "1e3" }],
      }),
    ).toThrow();
  });
});
