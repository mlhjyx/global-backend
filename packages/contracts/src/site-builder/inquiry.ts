export const INQUIRY_FORM_SCHEMA_VERSION =
  "site-builder-inquiry-form/v1" as const;
export const INQUIRY_SUBMITTED_EVENT_TYPE =
  "site_builder.inquiry.submitted" as const;
export const INQUIRY_SUBMITTED_SCHEMA_VERSION = 1 as const;

export type InquiryFieldV1 = "name" | "work_email" | "message";
export type InquiryConsentPurposeV1 = "respond_to_inquiry";

export interface InquiryConsentNoticeRefV1 {
  noticeId: string;
  noticeVersion: string;
  required: boolean;
  purposes: InquiryConsentPurposeV1[];
}

/** Renderer-only contract. M1-d deliberately has no public receiver URL. */
export interface InquiryFormDefinitionV1 {
  schemaVersion: typeof INQUIRY_FORM_SCHEMA_VERSION;
  formId: string;
  fields: InquiryFieldV1[];
  consent: InquiryConsentNoticeRefV1;
  submission: { mode: "disabled_until_m2" };
}

/** Reserved future outbox payload; persistence, reception and delivery belong to M2. */
export interface InquirySubmittedV1 {
  eventType: typeof INQUIRY_SUBMITTED_EVENT_TYPE;
  schemaVersion: typeof INQUIRY_SUBMITTED_SCHEMA_VERSION;
  eventId: string;
  workspaceId: string;
  siteId: string;
  inquiryId: string;
  occurredAt: string;
  consent: Omit<InquiryConsentNoticeRefV1, "required">;
}
