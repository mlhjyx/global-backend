import { types } from "node:util";
import {
  encryptPii,
  decryptPii,
  isEncryptedPii,
  PII_PURPOSE,
} from "../../../compliance/pii-crypto";
import {
  invalidGenericOperationArtifact,
  type ArtifactMaterializer,
  type ArtifactMaterializationManifest,
} from "../artifact.types";
export const CONTACT_EMAIL_FIND_HUNTER_SCHEMA =
  "contact-email-find-hunter/v1" as const;
export const CONTACT_EMAIL_FIND_PROSPEO_SCHEMA =
  "contact-email-find-prospeo/v1" as const;
export const CONTACT_EMAIL_FIND_SCHEMAS = Object.freeze([
  CONTACT_EMAIL_FIND_HUNTER_SCHEMA,
  CONTACT_EMAIL_FIND_PROSPEO_SCHEMA,
] as const);
export type ContactEmailFindSchema =
  (typeof CONTACT_EMAIL_FIND_SCHEMAS)[number];
export function isContactEmailFindSchema(
  value: unknown,
): value is ContactEmailFindSchema {
  return (
    value === CONTACT_EMAIL_FIND_HUNTER_SCHEMA ||
    value === CONTACT_EMAIL_FIND_PROSPEO_SCHEMA
  );
}
export interface ContactEmailFindPayload {
  readonly status: "hit" | "miss";
  readonly email: string | null;
  readonly providerConfidence: number | null;
  readonly acceptAll: boolean | null;
  readonly pattern: string | null;
  readonly reason: "candidate_found" | "no_match";
}
export type BoundedFinderArtifactReader = (
  input: AsyncIterable<Uint8Array>,
  manifest: ArtifactMaterializationManifest,
) => Promise<string>;
const MAX_BYTES = 16384;
function invalid(): never {
  return invalidGenericOperationArtifact();
}
export function parseContactEmailFindPayload(
  value: unknown,
): ContactEmailFindPayload {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    types.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return invalid();
  const keys = [
    "status",
    "email",
    "providerConfidence",
    "acceptAll",
    "pattern",
    "reason",
  ];
  const own = Reflect.ownKeys(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    own.length !== keys.length ||
    own.some((key) => typeof key !== "string" || !keys.includes(key))
  )
    return invalid();
  const row: Record<string, unknown> = {};
  for (const key of keys) {
    const d = descriptors[key];
    if (!d?.enumerable || !Object.hasOwn(d, "value")) return invalid();
    row[key] = d.value;
  }
  if (row.status === "miss") {
    if (
      row.email !== null ||
      row.providerConfidence !== null ||
      row.acceptAll !== null ||
      row.pattern !== null ||
      row.reason !== "no_match"
    )
      return invalid();
    return Object.freeze({
      status: "miss",
      email: null,
      providerConfidence: null,
      acceptAll: null,
      pattern: null,
      reason: "no_match",
    });
  }
  if (
    row.status !== "hit" ||
    row.reason !== "candidate_found" ||
    typeof row.email !== "string" ||
    row.email.length > 320 ||
    Array.from(row.email).some((char) => {
      const code = char.charCodeAt(0);
      return code < 32 || code === 127;
    })
  )
    return invalid();
  const domain = row.email.slice(row.email.lastIndexOf("@") + 1);
  // Persisted-body shape only, equivalent to the original normalizer with its own domain.
  // Provider/domain qualification remains in the original adapter; durable parsing does not import orchestration.
  if (
    row.email !== row.email.trim().toLowerCase() ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(row.email) ||
    domain.replace(/\.+$/u, "") !== domain.replace(/^www\./u, "")
  )
    return invalid();
  const confidence = row.providerConfidence;
  if (
    confidence !== null &&
    (typeof confidence !== "number" ||
      !Number.isFinite(confidence) ||
      Object.is(confidence, -0) ||
      confidence < 0 ||
      confidence > 100)
  )
    return invalid();
  if (row.acceptAll !== null && typeof row.acceptAll !== "boolean")
    return invalid();
  if (
    row.pattern !== null &&
    (typeof row.pattern !== "string" ||
      row.pattern.length > 256 ||
      row.pattern.includes("\0"))
  )
    return invalid();
  return Object.freeze({
    status: "hit",
    email: row.email,
    providerConfidence: confidence as number | null,
    acceptAll: row.acceptAll as boolean | null,
    pattern: row.pattern as string | null,
    reason: "candidate_found",
  });
}
export function serializeContactEmailFindPayload(
  value: unknown,
  workspaceId: string,
): string {
  const payload = parseContactEmailFindPayload(value);
  const body = encryptPii(JSON.stringify(payload), {
    workspaceId,
    purpose: PII_PURPOSE.CONTACT_EMAIL_FIND_PAYLOAD,
  });
  if (Buffer.byteLength(body, "utf8") > MAX_BYTES) return invalid();
  return body;
}
export function decodeContactEmailFindBody(
  value: string,
  workspaceId: string,
): ContactEmailFindPayload {
  try {
    if (
      typeof value !== "string" ||
      !isEncryptedPii(value) ||
      Buffer.byteLength(value, "utf8") > MAX_BYTES
    )
      return invalid();
    return parseContactEmailFindPayload(
      JSON.parse(
        decryptPii(value, {
          workspaceId,
          purpose: PII_PURPOSE.CONTACT_EMAIL_FIND_PAYLOAD,
        }),
      ),
    );
  } catch {
    return invalid();
  }
}
async function originalBoundedReader(
  resultSchema: ContactEmailFindSchema,
  input: AsyncIterable<Uint8Array>,
  manifest: ArtifactMaterializationManifest,
): Promise<string> {
  // Defer loading the existing Prisma-backed registry, never replace its manifest/size/hash/UTF8 validation.
  // This path remains subject to the real client/tooling prerequisite. Private crypto tests inject only a fake bounded-reader port.
  const { readBoundedArtifactUtf8 } =
    await import("../artifact-materializer.registry");
  return readBoundedArtifactUtf8(input, manifest, {
    resultSchema,
    mediaTypes: new Set(["application/octet-stream"]),
    maxBytes: MAX_BYTES,
  });
}
export function createContactEmailFindMaterializer(
  options: {
    resultSchema?: ContactEmailFindSchema;
    readBounded?: BoundedFinderArtifactReader;
    now?: () => Date;
  } = {},
): ArtifactMaterializer<ContactEmailFindPayload> {
  const resultSchema = options.resultSchema ?? CONTACT_EMAIL_FIND_HUNTER_SCHEMA;
  const read =
    options.readBounded ??
    ((input: AsyncIterable<Uint8Array>, manifest: ArtifactMaterializationManifest) =>
      originalBoundedReader(resultSchema, input, manifest));
  const now = options.now ?? (() => new Date());
  return Object.freeze({
    resultSchema,
    async materialize(
      input: AsyncIterable<Uint8Array>,
      manifest: ArtifactMaterializationManifest,
      expectedFacts: unknown,
    ): Promise<ContactEmailFindPayload> {
      const current = now();
      if (
        expectedFacts !== undefined ||
        manifest.resultSchema !== resultSchema ||
        manifest.mediaType !== "application/octet-stream" ||
        manifest.privacyClass !== "PERSONAL_DATA" ||
        manifest.scopeKind !== "workspace" ||
        manifest.workspaceId === null ||
        !Number.isFinite(current.getTime()) ||
        !Number.isFinite(Date.parse(manifest.expiresAt)) ||
        Date.parse(manifest.expiresAt) <= current.getTime() ||
        !/^(0|[1-9][0-9]*)$/.test(manifest.sizeBytes) ||
        BigInt(manifest.sizeBytes) > BigInt(MAX_BYTES)
      )
        return invalid();
      const body = await read(input, manifest);
      return decodeContactEmailFindBody(body, manifest.workspaceId);
    },
  });
}
export const contactEmailFindMaterializer =
  createContactEmailFindMaterializer({
    resultSchema: CONTACT_EMAIL_FIND_HUNTER_SCHEMA,
  });
export const contactEmailFindProspeoMaterializer =
  createContactEmailFindMaterializer({
    resultSchema: CONTACT_EMAIL_FIND_PROSPEO_SCHEMA,
  });
