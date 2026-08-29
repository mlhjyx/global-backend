const OBSERVATION_SCHEMA = "sec-edgar-submission-observation/v1";
const OBSERVATION_LICENSE = "US-GOV-PUBLIC-INFO";

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function exactKeys(value: JsonRecord, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  return (
    actual.length === required.length &&
    actual.every((key, index) => key === required[index])
  );
}

function normalizedName(value: unknown): string {
  return typeof value === "string"
    ? value.normalize("NFKC").trim().replaceAll(/\s+/gu, " ").toLowerCase()
    : "";
}

function normalizeCik(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const digits = value.replaceAll(/\D/gu, "");
  return digits && digits.length <= 10 ? digits.padStart(10, "0") : null;
}

function exactCikIdentifier(value: unknown, expectedCik: string): boolean {
  const identifier = record(value);
  return Boolean(
    identifier &&
    exactKeys(identifier, ["scheme", "value"]) &&
    identifier.scheme === "cik" &&
    normalizeCik(identifier.value) === expectedCik,
  );
}

export function validateSecEdgarDirectoryRawPayload(
  value: unknown,
  expected: { companyName: string; activeCik: string },
): { name: string; cik: string } {
  const payload = record(value);
  const cik = normalizeCik(expected.activeCik);
  const name = typeof payload?.name === "string" ? payload.name : "";
  if (
    !payload ||
    !cik ||
    payload.externalId !== `sec-edgar:${cik}` ||
    normalizedName(name) !== normalizedName(expected.companyName) ||
    !exactCikIdentifier(payload.identifier, cik)
  ) {
    throw new Error("SEC_EDGAR_DIRECTORY_RAW_BINDING_INVALID");
  }
  return { name, cik };
}

/**
 * Accepts only the filer-classification projection. Filing bodies, names,
 * addresses, contacts and arbitrary provider extensions never enter Raw Source.
 */
export function validateSecEdgarSubmissionObservation(
  value: unknown,
  expected: {
    companyName: string;
    activeCik: string;
    provenance: {
      sourceUrl: string;
      fetchedAt: string;
      contentHash: string;
      parserVersion: string;
    };
  },
): JsonRecord {
  const payload = record(value);
  const identifier = record(payload?.identifier);
  const attributes = record(payload?.attributes);
  const submission = record(attributes?.sec_edgar_submission);
  const provenance = record(payload?.provenance);
  const cik = normalizeCik(expected.activeCik);
  const valid = Boolean(
    payload &&
    identifier &&
    attributes &&
    submission &&
    provenance &&
    cik &&
    exactKeys(payload, [
      "externalId",
      "name",
      "identifier",
      "attributes",
      "license",
      "provenance",
    ]) &&
    exactKeys(identifier, ["scheme", "value"]) &&
    exactKeys(attributes, ["sec_edgar_submission"]) &&
    exactKeys(submission, [
      "schema_version",
      "cik",
      "entity_type",
      "semantic_scope",
    ]) &&
    exactKeys(provenance, [
      "sourceUrl",
      "fetchedAt",
      "contentHash",
      "parserVersion",
    ]) &&
    payload.externalId === `sec-edgar-submission:${cik}` &&
    normalizedName(payload.name) === normalizedName(expected.companyName) &&
    exactCikIdentifier(identifier, cik) &&
    payload.license === OBSERVATION_LICENSE &&
    submission.schema_version === OBSERVATION_SCHEMA &&
    submission.cik === cik &&
    submission.entity_type === "operating" &&
    submission.semantic_scope === "sec_filer_classification_only" &&
    provenance.sourceUrl === expected.provenance.sourceUrl &&
    provenance.fetchedAt === expected.provenance.fetchedAt &&
    provenance.contentHash === expected.provenance.contentHash &&
    provenance.parserVersion === expected.provenance.parserVersion &&
    /^[0-9a-f]{64}$/u.test(expected.provenance.contentHash),
  );
  if (!valid) throw new Error("SEC_EDGAR_SUBMISSION_OBSERVATION_INVALID");
  return payload!;
}
