import { describe, expect, it } from "vitest";
import {
  guardReplyClassification,
  looksLikeAutoReply,
  replyGuardViolationCodes,
  REPLY_CONFIDENCE_FLOOR,
  type ReplyClassification,
} from "./reply-classify";

function classification(overrides: Partial<ReplyClassification> = {}): ReplyClassification {
  return {
    intent: "POSITIVE",
    confidence: 0.86,
    rationale: "asks for a call",
    matchedSignals: ["would like a call next week"],
    ...overrides,
  };
}

describe("looksLikeAutoReply", () => {
  it("matches English, German and Chinese out-of-office markers", () => {
    expect(looksLikeAutoReply("I am currently out of the office until Monday.")).toBe(true);
    expect(looksLikeAutoReply("This is an automatic reply.")).toBe(true);
    expect(looksLikeAutoReply("Abwesenheitsnotiz: bis 24. November nicht im Büro.")).toBe(true);
    expect(looksLikeAutoReply("Automatische Antwort: Ihre Nachricht wurde empfangen.")).toBe(true);
    expect(looksLikeAutoReply("我设置了自动回复，暂不在办公室。")).toBe(true);
    expect(looksLikeAutoReply("Please send pricing for your laser systems.")).toBe(false);
  });
});

describe("guardReplyClassification", () => {
  it("passes a confident POSITIVE reply untouched", () => {
    const result = guardReplyClassification(
      classification(),
      "Thanks — we would like a call next week.",
    );
    expect(result.violations).toEqual([]);
    expect(result.final.intent).toBe("POSITIVE");
  });

  it("keeps a confident UNSUBSCRIBE untouched (downstream auto-unsubscribe path)", () => {
    const result = guardReplyClassification(
      classification({ intent: "UNSUBSCRIBE", confidence: 0.92 }),
      "Bitte nehmen Sie mich aus Ihrem Verteiler.",
    );
    expect(result.violations).toEqual([]);
    expect(result.final.intent).toBe("UNSUBSCRIBE");
  });

  it("keeps a confident OUT_OF_OFFICE untouched", () => {
    const result = guardReplyClassification(
      classification({ intent: "OUT_OF_OFFICE", confidence: 0.95 }),
      "Abwesenheitsnotiz: Ich bin nicht im Büro.",
    );
    expect(result.violations).toEqual([]);
    expect(result.final.intent).toBe("OUT_OF_OFFICE");
  });

  it("escalates low confidence to NEEDS_HUMAN and never leaves it silent", () => {
    const result = guardReplyClassification(
      classification({ intent: "NEUTRAL", confidence: REPLY_CONFIDENCE_FLOOR - 0.01 }),
      "Sounds interesting, we might follow up at some point.",
    );
    expect(result.final.intent).toBe("NEEDS_HUMAN");
    expect(replyGuardViolationCodes(result)).toEqual(["LOW_CONFIDENCE_ESCALATED"]);
  });

  it("escalates a low-confidence NEEDS_HUMAN without reporting a violation", () => {
    const result = guardReplyClassification(
      classification({ intent: "NEEDS_HUMAN", confidence: 0.3 }),
      "Ambiguous message.",
    );
    expect(result.final.intent).toBe("NEEDS_HUMAN");
    expect(result.violations).toEqual([]);
  });

  it("refuses POSITIVE on auto-reply text (OUT_OF_OFFICE adversarial sample)", () => {
    const result = guardReplyClassification(
      classification({ intent: "POSITIVE", confidence: 0.9 }),
      "Thank you for your message. I am currently out of the office. This is an automatic reply.",
    );
    expect(result.final.intent).toBe("NEEDS_HUMAN");
    expect(replyGuardViolationCodes(result)).toEqual(["AUTO_REPLY_CONFLICT"]);
  });

  it("refuses UNSUBSCRIBE on auto-reply text (boilerplate STOP text must not auto-unsubscribe)", () => {
    const result = guardReplyClassification(
      classification({ intent: "UNSUBSCRIBE", confidence: 0.9 }),
      "Abwesenheitsnotiz: Ich bin nicht im Büro. Um sich abzumelden, antworten Sie mit STOP.",
    );
    expect(result.final.intent).toBe("NEEDS_HUMAN");
    expect(replyGuardViolationCodes(result)).toEqual(["AUTO_REPLY_CONFLICT"]);
  });

  it("reports both violations when auto-reply conflicts and confidence is low", () => {
    const result = guardReplyClassification(
      classification({ intent: "POSITIVE", confidence: 0.4 }),
      "Automatische Antwort: Ich bin abwesend.",
    );
    expect(result.final.intent).toBe("NEEDS_HUMAN");
    expect(replyGuardViolationCodes(result)).toEqual([
      "AUTO_REPLY_CONFLICT",
      "LOW_CONFIDENCE_ESCALATED",
    ]);
  });

  it("escalates intents outside the closed set", () => {
    const result = guardReplyClassification(
      classification({ intent: "MAYBE" as unknown as ReplyClassification["intent"] }),
      "Plain reply.",
    );
    expect(result.final.intent).toBe("NEEDS_HUMAN");
    expect(replyGuardViolationCodes(result)).toEqual(["INVALID_INTENT"]);
  });

  it("preserves confidence and rationale of the model output", () => {
    const result = guardReplyClassification(
      classification({ intent: "NEGATIVE", confidence: 0.75, rationale: "has a supplier" }),
      "We already have a supplier.",
    );
    expect(result.final.confidence).toBe(0.75);
    expect(result.final.rationale).toBe("has a supplier");
  });
});
