import { describe, expect, it } from "vitest";
import {
  buildContactQualityFact,
  parseContactQualityFact,
  type ContactQualityPoint,
} from "./enrichment-quality-facts";
import type { EnrichmentContactApplyDecision } from "./enrichment-domain-commit";

const C = "00000000-0000-4000-8000-000000000002";
const P1 = "00000000-0000-4000-8000-000000000011";
const P2 = "00000000-0000-4000-8000-000000000012";
function point(
  id: string,
  emailType: string | null,
  verificationState: ContactQualityPoint["verificationState"],
  type = "email",
): ContactQualityPoint {
  return { id, type, emailType, verificationState };
}
function decision(
  value: Partial<EnrichmentContactApplyDecision> = {},
): EnrichmentContactApplyDecision {
  return {
    status: "APPLIED",
    contactId: C,
    reasonCode: "STORED",
    state: null,
    pointRefs: [],
    eventRefs: [],
    attemptRefs: [],
    newCandidatePoints: 0,
    ...value,
  } as EnrichmentContactApplyDecision;
}
function build(
  points: readonly ContactQualityPoint[],
  value: Partial<EnrichmentContactApplyDecision> = {},
  newPoint: { emailType: string | null; state: ContactQualityPoint["verificationState"] } | null = null,
) {
  return buildContactQualityFact({
    contactId: C,
    points,
    decision: decision(value),
    newPoint,
  });
}
describe("bounded per-contact quality facts from the original commit transaction", () => {
  it("reports an attempted miss as eligible and unresolved without inventing a state", () => {
    expect(build([], { reasonCode: "NO_MATCH" })).toEqual({
      contactId: C,
      beforeStates: [],
      afterStates: [],
      stockValidPersonal: false,
      organizationChannel: false,
      emailTypeUnknown: false,
      eligible: true,
      newCandidate: false,
      newValidPersonal: false,
      unresolved: true,
    });
  });
  it("keeps organization channels outside the personal denominator (A07)", () => {
    const fact = build([point(P1, "role", "VALID")], { reasonCode: "REUSED" });
    expect(fact.stockValidPersonal).toBe(false);
    expect(fact.organizationChannel).toBe(true);
    expect(fact.emailTypeUnknown).toBe(false);
    expect(fact.eligible).toBe(true);
    expect(fact.beforeStates).toEqual(["VALID"]);
    expect(fact.unresolved).toBe(true);
  });
  it("does not default an unknown email type to personal (A07)", () => {
    const fact = build([point(P1, null, "UNKNOWN")], { reasonCode: "NO_MATCH" });
    expect(fact.stockValidPersonal).toBe(false);
    expect(fact.organizationChannel).toBe(false);
    expect(fact.emailTypeUnknown).toBe(true);
    expect(fact.eligible).toBe(true);
    expect(fact.newValidPersonal).toBe(false);
  });
  it("protects a stock personal VALID point and never counts it as newly valid (A01/A05)", () => {
    const fact = build(
      [point(P1, "personal", "VALID")],
      {
        reasonCode: "STORED",
        state: "UNKNOWN",
        pointRefs: [P2],
        newCandidatePoints: 1,
      },
      { emailType: "personal", state: "UNKNOWN" },
    );
    expect(fact.stockValidPersonal).toBe(true);
    expect(fact.eligible).toBe(false);
    expect(fact.newCandidate).toBe(true);
    expect(fact.newValidPersonal).toBe(false);
    expect(fact.unresolved).toBe(false);
    expect(fact.afterStates).toEqual(["VALID", "UNKNOWN"]);
  });
  it("counts a first-time personal VALID as newly valid exactly once (A04/A10)", () => {
    const fact = build(
      [],
      {
        reasonCode: "STORED",
        state: "VALID",
        pointRefs: [P2],
        newCandidatePoints: 1,
      },
      { emailType: "personal", state: "VALID" },
    );
    expect(fact.newValidPersonal).toBe(true);
    expect(fact.stockValidPersonal).toBe(false);
    expect(fact.unresolved).toBe(false);
    expect(fact.afterStates).toEqual(["VALID"]);
  });
  it("does not count a VALID organization address as a personal success (A07)", () => {
    const fact = build(
      [],
      {
        reasonCode: "STORED",
        state: "VALID",
        pointRefs: [P2],
        newCandidatePoints: 1,
      },
      { emailType: "generic_sales", state: "VALID" },
    );
    expect(fact.newValidPersonal).toBe(false);
    expect(fact.organizationChannel).toBe(true);
    expect(fact.unresolved).toBe(true);
  });
  it("keeps UNKNOWN and CATCH_ALL_RISKY unresolved rather than zero (A02/A03)", () => {
    for (const state of ["UNKNOWN", "CATCH_ALL_RISKY"] as const) {
      const fact = build(
        [point(P1, "personal", state)],
        {
          reasonCode: "STORED",
          state,
          pointRefs: [P2],
          newCandidatePoints: 1,
        },
        { emailType: "personal", state },
      );
      expect(fact.unresolved).toBe(true);
      expect(fact.stockValidPersonal).toBe(false);
      expect(fact.newValidPersonal).toBe(false);
    }
  });
  it("does not fabricate a point state when the original commit wrote no point (A03/A04)", () => {
    const fact = build([], { reasonCode: "INVALID_ALL", state: "INVALID" });
    expect(fact.afterStates).toEqual([]);
    expect(fact.newCandidate).toBe(false);
    expect(fact.newValidPersonal).toBe(false);
    expect(fact.unresolved).toBe(true);
  });
  it("records an explicit gate skip as not attempted and not unresolved", () => {
    const fact = build([], { reasonCode: "SUPPRESSED" });
    expect(fact.unresolved).toBe(false);
    expect(fact.eligible).toBe(true);
    expect(fact.newCandidate).toBe(false);
  });
  it("deduplicates the four-state set in the original vocabulary order", () => {
    const fact = build([
      point(P1, "personal", "UNKNOWN"),
      point(P2, "role", "VALID"),
    ]);
    expect(fact.beforeStates).toEqual(["VALID", "UNKNOWN"]);
    expect(fact.afterStates).toEqual(["VALID", "UNKNOWN"]);
  });
  it.each([
    ["duplicate point ids", [point(P1, "personal", "VALID"), point(P1, "role", "UNKNOWN")]],
    ["invalid state", [point(P1, "personal", "BOGUS" as never)]],
  ])("rejects noncanonical point facts %s", (_label, points) => {
    expect(() => build(points)).toThrow();
  });
  it("rejects a claimed new point without its actual committed state", () => {
    expect(() =>
      build([], { reasonCode: "STORED", pointRefs: [P2], newCandidatePoints: 1 }, null),
    ).toThrow();
    expect(() =>
      build(
        [],
        { reasonCode: "STORED", state: "VALID", pointRefs: [P2], newCandidatePoints: 1 },
        { emailType: "personal", state: "UNKNOWN" },
      ),
    ).toThrow();
  });
  it("round-trips the closed persisted fact and rejects extra payload keys", () => {
    const fact = build(
      [],
      { reasonCode: "STORED", state: "VALID", pointRefs: [P2], newCandidatePoints: 1 },
      { emailType: "personal", state: "VALID" },
    );
    expect(parseContactQualityFact(fact)).toEqual(fact);
    expect(() =>
      parseContactQualityFact({ ...fact, email: "PII_SENTINEL" }),
    ).toThrow();
    expect(() =>
      parseContactQualityFact({ ...fact, contactId: "not-a-uuid" }),
    ).toThrow();
  });
});
