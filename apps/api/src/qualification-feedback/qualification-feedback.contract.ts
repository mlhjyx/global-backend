import { createHash } from "node:crypto";
import { BadRequestException } from "@nestjs/common";
import Ajv from "ajv";

export type QualificationFeedbackEvent = {
  schemaVersion: "qualification-feedback-reference/v1";
  eventType: "QUALIFICATION_DECISION_RECORDED";
  producer: "growthos-saas";
  eventId: string;
  workspaceId: string;
  opportunityId: string;
  leadId: string;
  decisionId: string;
  revision: string;
  decision: "REJECTED" | "CORRECTED";
  occurredAt: string;
};

// Encode the signed int64 upper bound lexically, including in the public schema.
// Never coerce a revision through a JavaScript number.
const maximumRevision = "9223372036854775807";
const revisionAlternatives = ["[1-9][0-9]{0,17}", maximumRevision];
for (let index = 0; index < maximumRevision.length; index += 1) {
  const smallerDigits = "0123456789".slice(
    index === 0 ? 1 : 0,
    "0123456789".indexOf(maximumRevision[index]),
  );
  if (smallerDigits) {
    revisionAlternatives.push(
      `${maximumRevision.slice(0, index)}[${smallerDigits}][0-9]{${maximumRevision.length - index - 1}}`,
    );
  }
}
const uuidSchema = {
  type: "string",
  minLength: 36,
  maxLength: 36,
  pattern:
    "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$(?![\\s\\S])",
} as const;
const ordinaryDate =
  "[0-9]{4}-(?:(?:01|03|05|07|08|10|12)-(?:0[1-9]|[12][0-9]|3[01])|(?:04|06|09|11)-(?:0[1-9]|[12][0-9]|30)|02-(?:0[1-9]|1[0-9]|2[0-8]))";
const leapDate =
  "(?:[0-9]{2}(?:0[48]|[2468][048]|[13579][26])|(?:[02468][048]|[13579][26])00)-02-29";
function freezeSchema<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freezeSchema);
    Object.freeze(value);
  }
  return value;
}

export const QUALIFICATION_FEEDBACK_SCHEMA = freezeSchema({
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "eventType",
    "producer",
    "eventId",
    "workspaceId",
    "opportunityId",
    "leadId",
    "decisionId",
    "revision",
    "decision",
    "occurredAt",
  ],
  properties: {
    schemaVersion: {
      type: "string",
      enum: ["qualification-feedback-reference/v1"],
    },
    eventType: { type: "string", enum: ["QUALIFICATION_DECISION_RECORDED"] },
    producer: { type: "string", enum: ["growthos-saas"] },
    eventId: uuidSchema,
    workspaceId: uuidSchema,
    opportunityId: uuidSchema,
    leadId: uuidSchema,
    decisionId: uuidSchema,
    revision: {
      type: "string",
      maxLength: 19,
      pattern: `^(?:${revisionAlternatives.join("|")})$(?![\\s\\S])`,
    },
    decision: { type: "string", enum: ["REJECTED", "CORRECTED"] },
    occurredAt: {
      type: "string",
      maxLength: 30,
      pattern: `^(?:${ordinaryDate}|${leapDate})T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]{1,9})?Z$(?![\\s\\S])`,
    },
  },
} as const);

const validate = new Ajv({
  strict: true,
  ownProperties: true,
}).compile<QualificationFeedbackEvent>(QUALIFICATION_FEEDBACK_SCHEMA);

function canonicalEvent(
  event: QualificationFeedbackEvent,
): QualificationFeedbackEvent {
  return {
    schemaVersion: event.schemaVersion,
    eventType: event.eventType,
    producer: event.producer,
    eventId: event.eventId,
    workspaceId: event.workspaceId,
    opportunityId: event.opportunityId,
    leadId: event.leadId,
    decisionId: event.decisionId,
    revision: event.revision,
    decision: event.decision,
    occurredAt: event.occurredAt,
  };
}

export function parseQualificationFeedback(
  input: unknown,
): Readonly<QualificationFeedbackEvent> {
  if (!validate(input)) {
    throw new BadRequestException({
      error: {
        code: "FEEDBACK_INVALID",
        message: "Invalid qualification feedback reference.",
      },
    });
  }
  return Object.freeze(canonicalEvent(input));
}

export function qualificationFeedbackDigest(
  event: QualificationFeedbackEvent,
): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalEvent(event)))
    .digest("hex");
}
