import { describe, expect, it } from "vitest";
import {
  INQUIRY_FORM_SCHEMA_VERSION,
  INQUIRY_SUBMITTED_EVENT_TYPE,
  INQUIRY_SUBMITTED_SCHEMA_VERSION,
  type InquiryFormDefinitionV1,
  type InquirySubmittedV1,
} from "@global/contracts";

describe("M1-d inquiry/consent/outbox boundary", () => {
  it("defines a versioned renderer form and consent reference without a receiver", () => {
    expect(INQUIRY_FORM_SCHEMA_VERSION).toBe("site-builder-inquiry-form/v1");
    const form: InquiryFormDefinitionV1 = {
      schemaVersion: INQUIRY_FORM_SCHEMA_VERSION,
      formId: "primary-inquiry",
      fields: ["name", "work_email", "message"],
      consent: {
        noticeId: "privacy-inquiry",
        noticeVersion: "2026-07-19",
        required: true,
        purposes: ["respond_to_inquiry"],
      },
      submission: { mode: "disabled_until_m2" },
    };
    expect(form.submission).toEqual({ mode: "disabled_until_m2" });
  });

  it("reserves the future outbox payload envelope but no delivery semantics", () => {
    expect(INQUIRY_SUBMITTED_EVENT_TYPE).toBe("site_builder.inquiry.submitted");
    expect(INQUIRY_SUBMITTED_SCHEMA_VERSION).toBe(1);
    const event: InquirySubmittedV1 = {
      eventType: INQUIRY_SUBMITTED_EVENT_TYPE,
      schemaVersion: INQUIRY_SUBMITTED_SCHEMA_VERSION,
      eventId: "11111111-1111-4111-8111-111111111111",
      workspaceId: "22222222-2222-4222-8222-222222222222",
      siteId: "33333333-3333-4333-8333-333333333333",
      inquiryId: "44444444-4444-4444-8444-444444444444",
      occurredAt: "2026-07-19T12:00:00.000Z",
      consent: {
        noticeId: "privacy-inquiry",
        noticeVersion: "2026-07-19",
        purposes: ["respond_to_inquiry"],
      },
    };
    expect(event).not.toHaveProperty("recipientEmail");
    expect(event).not.toHaveProperty("deliveryStatus");
  });
});
