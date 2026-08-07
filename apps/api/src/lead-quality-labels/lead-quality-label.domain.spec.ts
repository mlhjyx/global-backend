import { describe, expect, it } from "vitest";
import {
  classifyLeadQualityLabel,
  normalizeLeadQualityLabelRequest,
  type AcceptedLeadQualityLabel,
} from "./lead-quality-label.domain";

const positive = (
  label: AcceptedLeadQualityLabel["label"],
  commercialResult: AcceptedLeadQualityLabel["commercialResult"] = null,
  occurredAt = new Date("2026-08-07T12:00:00.000Z"),
  reasonCode: "NOT_ICP" | "BAD_TIMING" | null = null,
): AcceptedLeadQualityLabel =>
  ({ label, commercialResult, occurredAt, reasonCode }) as AcceptedLeadQualityLabel;

const context = {
  handoffOccurredAt: new Date("2026-08-07T11:00:00.000Z"),
  observedAt: new Date("2026-08-07T13:00:00.000Z"),
};

const input = (
  label: Parameters<typeof classifyLeadQualityLabel>[0]["label"],
  commercialResult: Parameters<typeof classifyLeadQualityLabel>[0]["commercialResult"] = null,
  occurredAt = new Date("2026-08-07T12:00:00.000Z"),
  reasonCode: "NOT_ICP" | "BAD_TIMING" | null = null,
) => ({ label, commercialResult, occurredAt, reasonCode });

describe("classifyLeadQualityLabel", () => {
  it("accepts QGO_CREATED when the repository has already bound a matching LeadQualified event", () => {
    expect(
      classifyLeadQualityLabel(
        input("QGO_CREATED"),
        [],
        context,
      ),
    ).toEqual({
      disposition: "ACCEPTED",
      heldReason: null,
    });
  });

  it("holds SALES_ACCEPTED until an accepted QGO_CREATED fact exists", () => {
    expect(
      classifyLeadQualityLabel(
        input("SALES_ACCEPTED"),
        [],
        context,
      ),
    ).toEqual({
      disposition: "HELD",
      heldReason: "MISSING_QGO_CREATED",
    });
    expect(
      classifyLeadQualityLabel(
        input("SALES_ACCEPTED"),
        [positive("QGO_CREATED")],
        context,
      ),
    ).toEqual({ disposition: "ACCEPTED", heldReason: null });
  });

  it("holds commercial outcomes until both accepted positive prerequisites exist", () => {
    expect(
      classifyLeadQualityLabel(
        input("COMMERCIAL_OUTCOME_VERIFIED", "WON"),
        [positive("QGO_CREATED")],
        context,
      ),
    ).toEqual({ disposition: "HELD", heldReason: "MISSING_PREREQUISITE" });

    expect(
      classifyLeadQualityLabel(
        input("COMMERCIAL_OUTCOME_VERIFIED", "WON"),
        [positive("QGO_CREATED"), positive("SALES_ACCEPTED")],
        context,
      ),
    ).toEqual({ disposition: "ACCEPTED", heldReason: null });
  });

  it("holds a rejection after any accepted positive fact and holds later positives after an accepted rejection", () => {
    expect(
      classifyLeadQualityLabel(
        input("LEAD_OUTCOME_REJECTED"),
        [positive("QGO_CREATED")],
        context,
      ),
    ).toEqual({
      disposition: "HELD",
      heldReason: "CONTRADICTORY_POSITIVE_LABEL",
    });

    expect(
      classifyLeadQualityLabel(
        input("QGO_CREATED"),
        [positive("LEAD_OUTCOME_REJECTED")],
        context,
      ),
    ).toEqual({ disposition: "HELD", heldReason: "CONTRADICTORY_REJECTION" });
  });

  it("holds a conflicting WON/LOST fact without changing the earlier accepted fact", () => {
    expect(
      classifyLeadQualityLabel(
        input("COMMERCIAL_OUTCOME_VERIFIED", "LOST"),
        [
          positive("QGO_CREATED"),
          positive("SALES_ACCEPTED"),
          positive("COMMERCIAL_OUTCOME_VERIFIED", "WON"),
        ],
        context,
      ),
    ).toEqual({
      disposition: "HELD",
      heldReason: "CONTRADICTORY_COMMERCIAL_RESULT",
    });
  });

  it("holds a different rejection reason for the same handoff as contradictory history", () => {
    expect(
      classifyLeadQualityLabel(
        input("LEAD_OUTCOME_REJECTED", null, undefined, "BAD_TIMING"),
        [
          positive(
            "LEAD_OUTCOME_REJECTED",
            null,
            new Date("2026-08-07T11:30:00.000Z"),
            "NOT_ICP",
          ),
        ],
        context,
      ),
    ).toEqual({ disposition: "HELD", heldReason: "CONTRADICTORY_REJECTION" });
  });

  it("holds facts timestamped before their exact handoff or beyond the bounded future skew", () => {
    expect(
      classifyLeadQualityLabel(
        input("QGO_CREATED", null, new Date("2026-08-07T10:59:59.999Z")),
        [],
        context,
      ),
    ).toEqual({ disposition: "HELD", heldReason: "OCCURRED_BEFORE_HANDOFF" });

    expect(
      classifyLeadQualityLabel(
        input("QGO_CREATED", null, new Date("2026-08-07T13:05:00.001Z")),
        [],
        context,
      ),
    ).toEqual({ disposition: "HELD", heldReason: "OCCURRED_AT_IN_FUTURE" });
  });

  it("holds a late-arriving older fact and never uses a future prerequisite", () => {
    expect(
      classifyLeadQualityLabel(
        input("QGO_CREATED", null, new Date("2026-08-07T11:30:00.000Z")),
        [positive("SALES_ACCEPTED", null, new Date("2026-08-07T12:00:00.000Z"))],
        context,
      ),
    ).toEqual({ disposition: "HELD", heldReason: "OUT_OF_ORDER_ARRIVAL" });

    expect(
      classifyLeadQualityLabel(
        input("SALES_ACCEPTED", null, new Date("2026-08-07T11:30:00.000Z")),
        [positive("QGO_CREATED", null, new Date("2026-08-07T12:00:00.000Z"))],
        context,
      ),
    ).toEqual({ disposition: "HELD", heldReason: "OUT_OF_ORDER_ARRIVAL" });
  });
});

describe("normalizeLeadQualityLabelRequest", () => {
  const base = {
    source_event_id: "crm:event:1001",
    lead_id: "11111111-1111-4111-8111-111111111111",
    lead_qualified_event_id: "22222222-2222-4222-8222-222222222222",
    occurred_at: "2026-08-07T12:00:00.000Z",
    source_system: "growth-saas",
  } as const;

  it("requires a closed reason_code only for LEAD_OUTCOME_REJECTED", () => {
    expect(() =>
      normalizeLeadQualityLabelRequest({
        ...base,
        label: "LEAD_OUTCOME_REJECTED",
      }),
    ).toThrow(/reason_code/i);
    expect(() =>
      normalizeLeadQualityLabelRequest({
        ...base,
        label: "QGO_CREATED",
        reason_code: "BAD_TIMING",
      }),
    ).toThrow(/reason_code/i);
    expect(
      normalizeLeadQualityLabelRequest({
        ...base,
        label: "LEAD_OUTCOME_REJECTED",
        reason_code: "INSUFFICIENT_EVIDENCE",
      }).reasonCode,
    ).toBe("INSUFFICIENT_EVIDENCE");
  });

  it("requires WON/LOST only for COMMERCIAL_OUTCOME_VERIFIED", () => {
    expect(() =>
      normalizeLeadQualityLabelRequest({
        ...base,
        label: "COMMERCIAL_OUTCOME_VERIFIED",
      }),
    ).toThrow(/commercial_result/i);
    expect(() =>
      normalizeLeadQualityLabelRequest({
        ...base,
        label: "SALES_ACCEPTED",
        commercial_result: "WON",
      }),
    ).toThrow(/commercial_result/i);
    expect(
      normalizeLeadQualityLabelRequest({
        ...base,
        label: "COMMERCIAL_OUTCOME_VERIFIED",
        commercial_result: "LOST",
      }).commercialResult,
    ).toBe("LOST");
  });

  it("rejects unknown labels/reasons, unexpected context fields, and malformed source identifiers", () => {
    expect(() =>
      normalizeLeadQualityLabelRequest({
        ...base,
        label: "OPPORTUNITY_CREATED",
      }),
    ).toThrow();
    expect(() =>
      normalizeLeadQualityLabelRequest({
        ...base,
        label: "LEAD_OUTCOME_REJECTED",
        reason_code: "FREE_TEXT",
      }),
    ).toThrow();
    expect(() =>
      normalizeLeadQualityLabelRequest({
        ...base,
        label: "QGO_CREATED",
        workspace_id: base.lead_id,
      }),
    ).toThrow(/workspace_id/i);
    expect(() =>
      normalizeLeadQualityLabelRequest({
        ...base,
        label: "QGO_CREATED",
        source_system: "Bad System",
      }),
    ).toThrow(/source_system/i);
    expect(() =>
      normalizeLeadQualityLabelRequest({
        ...base,
        label: "QGO_CREATED",
        occurred_at: "2026-08-07T12:00:00",
      }),
    ).toThrow(/occurred_at/i);
  });

  it("bounds source identifiers and rejects control/format characters without echoing the value", () => {
    for (const [field, value] of [
      ["source_event_id", `event:${"x".repeat(129)}`],
      ["source_event_id", "event:\u200bhidden"],
      ["source_system", "crm\u0000shadow"],
      ["external_object_ref", `ref:${"x".repeat(257)}`],
      ["external_object_ref", "object:\u2066hidden"],
    ] as const) {
      let thrown: unknown;
      try {
        normalizeLeadQualityLabelRequest({
          ...base,
          label: "QGO_CREATED",
          [field]: value,
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect(String((thrown as Error).message)).toContain(field);
      expect(String((thrown as Error).message)).not.toContain(value);
    }
  });
});
