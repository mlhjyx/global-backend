import { BadRequestException } from "@nestjs/common";
import Ajv from "ajv";
import { describe, expect, it } from "vitest";
import {
  QUALIFICATION_FEEDBACK_SCHEMA,
  parseQualificationFeedback,
  qualificationFeedbackDigest,
  type QualificationFeedbackEvent,
} from "./qualification-feedback.contract";

const event: QualificationFeedbackEvent = {
  schemaVersion: "qualification-feedback-reference/v1",
  eventType: "QUALIFICATION_DECISION_RECORDED",
  producer: "growthos-saas",
  eventId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  workspaceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  opportunityId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  leadId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  decisionId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  revision: "9223372036854775807",
  decision: "REJECTED",
  occurredAt: "2024-02-29T23:59:59.123456789Z",
};
const schemaValid = new Ajv({ strict: true }).compile(
  QUALIFICATION_FEEDBACK_SCHEMA,
);

describe("qualification feedback reference contract", () => {
  it.each([
    "1",
    "9007199254740992",
    "9007199254740993",
    "9223372036854775806",
    "9223372036854775807",
  ])("preserves valid revision %s exactly", (revision) => {
    const input = { ...event, revision };
    expect(schemaValid(input)).toBe(true);
    const parsed = parseQualificationFeedback(input);
    expect(parsed).toEqual(input);
    expect(parsed).not.toBe(input);
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  const invalid: unknown[] = [
    null,
    undefined,
    [],
    "payload",
    1,
    true,
    ...["schemaVersion", "eventType", "producer", "decision"].map((key) => ({
      ...event,
      [key]: "invalid",
    })),
    ...Object.keys(event).map((key) =>
      Object.fromEntries(
        Object.entries(event).filter(([name]) => name !== key),
      ),
    ),
    ...[
      "eventId",
      "workspaceId",
      "opportunityId",
      "leadId",
      "decisionId",
    ].flatMap((key) =>
      [
        "AAAAaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        "invalid",
        " aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        "aaaaaaaaaaaa4aaa8aaaaaaaaaaaaaaa",
      ].map((value) => ({ ...event, [key]: value })),
    ),
    ...[
      "0",
      "-1",
      "+1",
      "01",
      "1.0",
      "1e2",
      " 1",
      "1 ",
      "1\n",
      "9223372036854775808",
      "9999999999999999999",
      "10000000000000000000",
      1,
      Number("9007199254740993"),
      null,
    ].map((revision) => ({ ...event, revision })),
    ...[
      "2023-02-29T00:00:00Z",
      "2024-02-30T00:00:00Z",
      "1900-02-29T00:00:00Z",
      "2024-04-31T00:00:00Z",
      "2024-00-01T00:00:00Z",
      "2024-01-00T00:00:00Z",
      "2024-01-01T24:00:00Z",
      "2024-01-01T00:60:00Z",
      "2024-01-01T00:00:60Z",
      "2024-01-01T00:00:00+00:00",
      "2024-01-01t00:00:00z",
      "2024-01-01T00:00:00.Z",
      "2024-01-01T00:00:00.1234567890Z",
      "2024-01-01T00:00:00Z\n",
    ].map((occurredAt) => ({ ...event, occurredAt })),
    ...["reason", "rawPayload", "actor", "unknown"].map((key) => ({
      ...event,
      [key]: "sensitive-sentinel",
    })),
  ];
  it.each(invalid.map((input, index) => ({ input, index })))(
    "rejects invalid case $index in runtime and schema with bounded error",
    ({ input }) => {
      expect(schemaValid(input)).toBe(false);
      try {
        parseQualificationFeedback(input);
        expect.fail("must reject invalid feedback");
      } catch (error) {
        expect(error).toBeInstanceOf(BadRequestException);
        expect((error as BadRequestException).getStatus()).toBe(400);
        expect(
          JSON.stringify((error as BadRequestException).getResponse()),
        ).toContain("FEEDBACK_INVALID");
        expect(
          JSON.stringify((error as BadRequestException).getResponse()),
        ).not.toContain("sensitive-sentinel");
      }
    },
  );
  it.each([
    "2000-02-29T00:00:00Z",
    "2024-01-31T00:00:00.1Z",
    "2024-04-30T00:00:00.000000000Z",
  ])("accepts valid calendar instant %s", (occurredAt) => {
    const input = { ...event, occurredAt, decision: "CORRECTED" as const };
    expect(schemaValid(input)).toBe(true);
    expect(parseQualificationFeedback(input)).toEqual(input);
  });
  it("hashes a fixed field order and preserves exact timestamp precision", () => {
    const reordered = Object.fromEntries(
      Object.entries(event).reverse(),
    ) as QualificationFeedbackEvent;
    const digest = qualificationFeedbackDigest(event);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).toBe(
      "fd9acaba39424a24ac6149dec2496ea8d25c6152956665a5a058a51a7b7e160e",
    );
    expect(qualificationFeedbackDigest(reordered)).toBe(digest);
    for (const key of Object.keys(
      event,
    ) as (keyof QualificationFeedbackEvent)[]) {
      expect(
        qualificationFeedbackDigest({ ...event, [key]: `${event[key]}x` }),
      ).not.toBe(digest);
    }
    expect(
      qualificationFeedbackDigest({
        ...event,
        occurredAt: "2024-02-29T23:59:59.100Z",
      }),
    ).not.toBe(
      qualificationFeedbackDigest({
        ...event,
        occurredAt: "2024-02-29T23:59:59.1Z",
      }),
    );
  });
  it("matches exact bigint comparisons across every int64 prefix boundary", () => {
    const maximum = 9223372036854775807n;
    for (let power = 0n; power < 20n; power += 1n) {
      const scale = 10n ** power;
      const boundary = (maximum / scale) * scale;
      for (const value of [
        boundary - 1n,
        boundary,
        boundary + 1n,
        boundary + scale - 1n,
        boundary + scale,
      ]) {
        const input = { ...event, revision: value.toString() };
        const accepted = value > 0n && value <= maximum;
        expect(schemaValid(input)).toBe(accepted);
        if (accepted)
          expect(parseQualificationFeedback(input).revision).toBe(
            value.toString(),
          );
        else
          expect(() => parseQualificationFeedback(input)).toThrow(
            BadRequestException,
          );
      }
    }
  });
  it("freezes the complete public schema", () => {
    function check(value: unknown): void {
      if (value && typeof value === "object") {
        expect(Object.isFrozen(value)).toBe(true);
        Object.values(value).forEach(check);
      }
    }
    check(QUALIFICATION_FEEDBACK_SCHEMA);
  });
});
