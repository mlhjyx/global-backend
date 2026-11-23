import { isCanonicalArtifactUuid } from "../../durable-results/artifact/artifact.types";
import { EMAIL_VERIFICATION_STATES } from "../../discovery/contact-point-verification-state";
import { blindContactKey } from "../../compliance/pii-crypto";
import { normalizeEnrichedEmail } from "../finders/email-enrichment-provider";
import {
  canonicalSafetyJson,
  closedSafetyRecord,
  deepFreezeSafety,
  denseSafetyArray,
  invalidPlan,
  safetyDigest,
  safetyIdentifier,
  safetyInteger,
  type ContactTargetSnapshot,
} from "./enrichment-safety.contract";

/** Preserve the original complete selection; oversize input is never truncated. */
export function buildTargetSnapshot(
  value: unknown,
): readonly ContactTargetSnapshot[] {
  const source = denseSafetyArray(value, 10);
  const contacts = new Set<string>();
  const result = source.map(
    (raw: unknown, ordinal: number): ContactTargetSnapshot => {
      const row = closedSafetyRecord(raw, [
        "contactId",
        "contactOrdinal",
        "inputVersion",
        "beforeDigest",
        "pointRefs",
      ]);
      const contactId = safetyIdentifier(row.contactId);
      if (
        contacts.has(contactId) ||
        safetyInteger(row.contactOrdinal, 0, 9) !== ordinal
      )
        return invalidPlan();
      contacts.add(contactId);
      const pointRefs = denseSafetyArray(row.pointRefs, 100).map(
        safetyIdentifier,
      );
      if (new Set(pointRefs).size !== pointRefs.length) return invalidPlan();
      return {
        contactId,
        contactOrdinal: ordinal,
        inputVersion: safetyIdentifier(row.inputVersion),
        beforeDigest: safetyDigest(row.beforeDigest),
        pointRefs,
      };
    },
  );
  if (Buffer.byteLength(canonicalSafetyJson(result), "utf8") > 65536)
    return invalidPlan();
  return deepFreezeSafety(result);
}

export interface FinderPhysicalInput {
  readonly workspaceId: string;
  readonly contactId: string;
  readonly inputVersion: string;
}
export interface VerificationPhysicalInput {
  readonly workspaceId: string;
  readonly contactId: string;
  readonly provider: "millionverifier" | "emailable" | "zerobounce";
  readonly email: string;
  readonly providerTimeoutSeconds: number | null;
}
function physicalBlindDigest(material: unknown): string {
  // Reuse the existing keyed blind index, not a public email hash or a new crypto/key authority.
  const blinded = blindContactKey(canonicalSafetyJson(material));
  if (!blinded.startsWith("bi:v1:")) return invalidPlan();
  return safetyDigest(blinded.slice("bi:v1:".length));
}
export function finderPhysicalInputFingerprint(
  input: FinderPhysicalInput,
): string {
  const row = closedSafetyRecord(input, [
    "workspaceId",
    "contactId",
    "inputVersion",
  ]);
  return physicalBlindDigest({
    version: "contact-enrichment-physical-input/v1",
    workspaceId: safetyIdentifier(row.workspaceId),
    contactId: safetyIdentifier(row.contactId),
    phase: "FINDER",
    provider: "hunter",
    inputVersion: safetyDigest(row.inputVersion),
  });
}
export function verificationPhysicalInputFingerprint(
  input: VerificationPhysicalInput,
): string {
  const row = closedSafetyRecord(input, [
    "workspaceId",
    "contactId",
    "provider",
    "email",
    "providerTimeoutSeconds",
  ]);
  if (
    row.provider !== "millionverifier" &&
    row.provider !== "emailable" &&
    row.provider !== "zerobounce"
  )
    return invalidPlan();
  if (typeof row.email !== "string" || row.email.length > 320)
    return invalidPlan();
  const candidate = row.email.trim().toLowerCase();
  const domain = candidate.slice(candidate.lastIndexOf("@") + 1);
  const email = normalizeEnrichedEmail(candidate, domain);
  if (!email) return invalidPlan();
  // Only MillionVerifier sends this option on its physical request. Local retry/abort/account settings are not identity.
  const timeout =
    row.provider === "millionverifier"
      ? safetyInteger(row.providerTimeoutSeconds, 1, 30)
      : row.providerTimeoutSeconds === null
        ? null
        : invalidPlan();
  return physicalBlindDigest({
    version: "contact-enrichment-physical-input/v1",
    workspaceId: safetyIdentifier(row.workspaceId),
    contactId: safetyIdentifier(row.contactId),
    phase: "VERIFY",
    provider: row.provider,
    email,
    wireOptions: { providerTimeoutSeconds: timeout },
  });
}

/** Original provider-generated catch-all nonce is account-derived, not a fresh physical-input identity. */
export function smtpPhysicalInputFingerprint(input: {
  workspaceId: string;
  contactId: string;
  originalInput: import("../../tools/builtin-tools").SmtpProbeInput;
}): string {
  const row = closedSafetyRecord(input, [
    "workspaceId",
    "contactId",
    "originalInput",
  ]);
  const wire = closedSafetyRecord(row.originalInput, [
    "domain",
    "mxHost",
    "rcptTo",
  ]);
  if (
    typeof wire.domain !== "string" ||
    typeof wire.mxHost !== "string" ||
    wire.domain.length > 253 ||
    wire.mxHost.length > 254
  )
    return invalidPlan();
  const recipients = denseSafetyArray(wire.rcptTo, 2);
  if (
    recipients.length !== 2 ||
    recipients.some((entry) => typeof entry !== "string")
  )
    return invalidPlan();
  const [real, nonce] = recipients as readonly [string, string];
  const email = normalizeEnrichedEmail(real, wire.domain);
  const suffix = "@" + wire.domain;
  if (
    !email ||
    email !== real ||
    wire.domain !== wire.domain.toLowerCase() ||
    wire.domain !== email.slice(email.lastIndexOf("@") + 1) ||
    !nonce.endsWith(suffix) ||
    !/^x-verify-[a-f0-9]{20}$/.test(nonce.slice(0, -suffix.length)) ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.?$/.test(wire.mxHost)
  )
    return invalidPlan();
  return physicalBlindDigest({
    version: "contact-enrichment-physical-input/v1",
    workspaceId: safetyIdentifier(row.workspaceId),
    contactId: safetyIdentifier(row.contactId),
    phase: "SMTP",
    provider: "smtp_self",
    email,
    wireOptions: {
      domain: wire.domain,
      mxHost: wire.mxHost.toLowerCase().replace(/\.$/, ""),
      protocol: "smtp.rcpt_probe/v1",
    },
  });
}


/** Transient current-point data; only the resulting existing-key blind digest enters the frozen target. */
export interface EnrichmentPointBeforeSnapshot {
  readonly id: string; readonly type: string; readonly value: string; readonly status: string; readonly verificationState: string;
  readonly validSince: string | null; readonly verifiedAt: string | null; readonly nextReverifyAt: string | null;
  readonly lastVerificationEventId: string | null; readonly confidence: number | null;
}
export function contactTargetBeforeDigest(input: { inputVersion: string; points: readonly EnrichmentPointBeforeSnapshot[] }): string {
  const row = closedSafetyRecord(input, ["inputVersion", "points"]);
  const time = (value: unknown): string | null => {
    if (value === null) return null;
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return invalidPlan();
    const date = new Date(value); if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) return invalidPlan(); return value;
  };
  const points = denseSafetyArray(row.points, 100).map((raw) => {
    const point = closedSafetyRecord(raw, ["id", "type", "value", "status", "verificationState", "validSince", "verifiedAt", "nextReverifyAt", "lastVerificationEventId", "confidence"]);
    if (!isCanonicalArtifactUuid(point.id) || typeof point.value !== "string" || Buffer.byteLength(point.value, "utf8") > 4096 || point.value.includes("\0") ||
        typeof point.verificationState !== "string" || !EMAIL_VERIFICATION_STATES.some((state) => state === point.verificationState) ||
        (point.lastVerificationEventId !== null && !isCanonicalArtifactUuid(point.lastVerificationEventId))) return invalidPlan();
    return { id: point.id, type: safetyIdentifier(point.type), value: point.value, status: safetyIdentifier(point.status), verificationState: point.verificationState,
      validSince: time(point.validSince), verifiedAt: time(point.verifiedAt), nextReverifyAt: time(point.nextReverifyAt), lastVerificationEventId: point.lastVerificationEventId,
      confidence: point.confidence === null ? null : safetyInteger(point.confidence, 0, 100) };
  }).sort((a, b) => a.id.localeCompare(b.id));
  if (new Set(points.map((point) => point.id)).size !== points.length) return invalidPlan();
  return physicalBlindDigest({ version: "contact-enrichment-before-state/v1", inputVersion: safetyDigest(row.inputVersion), points });
}
