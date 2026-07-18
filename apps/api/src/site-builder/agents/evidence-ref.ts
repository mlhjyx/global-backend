import { createHash } from "node:crypto";
import type {
  EvidenceRefV2,
  EvidenceSourceRole,
  EvidenceSourceType,
} from "@global/contracts";
import { scrubPii } from "./pii";

export const EVIDENCE_NORMALIZATION_VERSION = "evidence-text/1" as const;
export const EVIDENCE_HASH_ALGORITHM = "sha256" as const;
export const MAX_EVIDENCE_SNAPSHOT_CODE_POINTS = 20_000;
export const MAX_EVIDENCE_QUOTE_CODE_POINTS = 512;
export const MIN_EVIDENCE_QUOTE_CODE_POINTS = 8;
export const MAX_EVIDENCE_METADATA_CODE_POINTS = 512;
export const MAX_EVIDENCE_DISPLAY_URL_CODE_POINTS = 2_048;
const SELECTOR_CONTEXT_CODE_POINTS = 32;

const SENSITIVE_QUERY_KEY =
  /(?:^|[_-])(token|key|secret|signature|password|passwd|auth|authorization|credential|jwt|session|code)(?:$|[_-])/i;

function isSensitiveQueryKey(key: string): boolean {
  const boundaryNormalized = key
    .normalize("NFKC")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2");
  return SENSITIVE_QUERY_KEY.test(boundaryNormalized);
}

export interface FrozenEvidenceSource {
  sourceKey: string;
  sourceType: EvidenceSourceType;
  sourceRole: EvidenceSourceRole;
  hashAlgorithm: "sha256";
  contentHash: string;
  upstreamContentHash?: string;
  normalizationVersion: typeof EVIDENCE_NORMALIZATION_VERSION;
  snapshotText: string;
  displayUrl?: string;
  fetchedAt?: string;
  provenance: Record<string, unknown>;
}

export interface FreezeEvidenceSourceInput {
  sourceKey: string;
  sourceType: EvidenceSourceType;
  sourceRole: EvidenceSourceRole;
  rawText: string;
  upstreamContentHash?: string;
  displayUrl?: string;
  fetchedAt?: string;
  provenance: Record<string, unknown>;
}

export interface RawEvidenceReferenceInput {
  sourceId?: string;
  sourceType?: EvidenceSourceType;
  contentHash?: string;
  quote?: string;
}

export type EvidenceReferenceFailureReason =
  | "missing_evidence"
  | "missing_quote"
  | "quote_too_short"
  | "quote_too_long"
  | "unknown_source"
  | "source_hash_mismatch"
  | "source_type_mismatch"
  | "unsupported_quote";

export type EvidenceReferenceResolution =
  | { ok: true; ref: EvidenceRefV2 }
  | { ok: false; reason: EvidenceReferenceFailureReason };

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function codePoints(text: string): string[] {
  return Array.from(text);
}

function foldAsciiCase(text: string): string {
  return text.replace(/[A-Z]/g, (character) => character.toLowerCase());
}

/**
 * Exact matching remains primary. If a model changed only ASCII letter case,
 * recover the frozen source spelling only when the same-length slice is
 * unique. Whitespace, punctuation, digits and all non-ASCII code points must
 * already be identical; ambiguity remains fail-closed.
 */
function resolveExactQuoteSlice(
  snapshotText: string,
  quote: string,
): { quote: string; codeUnitStart: number } | null {
  const exactStart = snapshotText.indexOf(quote);
  if (exactStart >= 0) return { quote, codeUnitStart: exactStart };

  const foldedQuote = foldAsciiCase(quote);
  let match: { quote: string; codeUnitStart: number } | null = null;
  for (
    let codeUnitStart = 0;
    codeUnitStart <= snapshotText.length - quote.length;
    codeUnitStart += 1
  ) {
    const candidate = snapshotText.slice(
      codeUnitStart,
      codeUnitStart + quote.length,
    );
    if (foldAsciiCase(candidate) !== foldedQuote) continue;
    if (match) return null;
    match = { quote: candidate, codeUnitStart };
  }
  return match;
}

function stripControlCharacters(text: string): string {
  return codePoints(text)
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return (
        codePoint === 0x09 ||
        codePoint === 0x0a ||
        (codePoint >= 0x20 && codePoint !== 0x7f)
      );
    })
    .join("");
}

/** Normalize the persisted/model-visible corpus once; quote matching is exact after this point. */
export function normalizeEvidenceText(rawText: string): string {
  const normalized = stripControlCharacters(
    scrubPii(rawText).normalize("NFC").replace(/\r\n?/g, "\n"),
  )
    .split("\n")
    .map((line) => line.replace(/[^\S\n]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return codePoints(normalized)
    .slice(0, MAX_EVIDENCE_SNAPSHOT_CODE_POINTS)
    .join("");
}

/** Free-text provenance metadata follows the same PII/control-character policy as corpus text. */
export function sanitizeEvidenceMetadataText(
  rawText: string | undefined,
): string | undefined {
  if (!rawText) return undefined;
  const normalized = normalizeEvidenceText(rawText);
  if (!normalized) return undefined;
  return codePoints(normalized)
    .slice(0, MAX_EVIDENCE_METADATA_CODE_POINTS)
    .join("");
}

function sanitizeUrlPathSegment(segment: string): string {
  let decoded = segment;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    // Keep malformed percent encoding display-only and still scrub visible PII.
  }
  const scrubbed = scrubPii(decoded);
  return scrubbed === decoded ? segment : encodeURIComponent(scrubbed);
}

/** Display-only URL: credentials, fragments, PII and sensitive query values are not retained. */
export function sanitizeEvidenceUrl(
  rawUrl: string | undefined,
): string | undefined {
  if (!rawUrl) return undefined;
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    url.username = "";
    url.password = "";
    url.hash = "";
    url.pathname = url.pathname
      .split("/")
      .map(sanitizeUrlPathSegment)
      .join("/");
    const sanitizedQuery = new URLSearchParams();
    for (const [key, value] of url.searchParams.entries()) {
      sanitizedQuery.append(
        scrubPii(key),
        isSensitiveQueryKey(key) ? "[redacted]" : scrubPii(value),
      );
    }
    url.search = sanitizedQuery.toString();
    const serialized = url.toString();
    return codePoints(serialized).length <=
      MAX_EVIDENCE_DISPLAY_URL_CODE_POINTS
      ? serialized
      : undefined;
  } catch {
    return undefined;
  }
}

export function freezeEvidenceSource(
  input: FreezeEvidenceSourceInput,
): FrozenEvidenceSource {
  const snapshotText = normalizeEvidenceText(input.rawText);
  if (!snapshotText) throw new Error("evidence source snapshot is empty");
  if (
    input.upstreamContentHash &&
    !/^[0-9a-f]{64}$/.test(input.upstreamContentHash)
  ) {
    throw new Error("upstream evidence hash must be lowercase sha256");
  }
  return {
    sourceKey: input.sourceKey.slice(0, 1024),
    sourceType: input.sourceType,
    sourceRole: input.sourceRole,
    hashAlgorithm: EVIDENCE_HASH_ALGORITHM,
    contentHash: sha256(snapshotText),
    upstreamContentHash: input.upstreamContentHash,
    normalizationVersion: EVIDENCE_NORMALIZATION_VERSION,
    snapshotText,
    displayUrl: sanitizeEvidenceUrl(input.displayUrl),
    fetchedAt: input.fetchedAt,
    provenance: input.provenance,
  };
}

export function evidenceSourceDedupeKey(
  siteId: string,
  source: FrozenEvidenceSource,
): string {
  return sha256(
    [
      siteId,
      source.sourceKey,
      source.sourceType,
      source.sourceRole,
      source.normalizationVersion,
      source.contentHash,
      source.upstreamContentHash ?? "",
    ].join("\u001f"),
  );
}

export function resolveEvidenceReference(
  input: RawEvidenceReferenceInput | undefined,
  sources: ReadonlyMap<string, FrozenEvidenceSource>,
  options: { evidenceRefId: string },
): EvidenceReferenceResolution {
  if (!input?.sourceId || !input.sourceType || !input.contentHash) {
    return { ok: false, reason: "missing_evidence" };
  }
  if (!input.quote) return { ok: false, reason: "missing_quote" };
  const quoteLength = codePoints(input.quote).length;
  if (quoteLength < MIN_EVIDENCE_QUOTE_CODE_POINTS) {
    return { ok: false, reason: "quote_too_short" };
  }
  if (quoteLength > MAX_EVIDENCE_QUOTE_CODE_POINTS) {
    return { ok: false, reason: "quote_too_long" };
  }
  const source = sources.get(input.sourceId);
  if (!source) return { ok: false, reason: "unknown_source" };
  if (source.sourceType !== input.sourceType) {
    return { ok: false, reason: "source_type_mismatch" };
  }
  if (source.contentHash !== input.contentHash) {
    return { ok: false, reason: "source_hash_mismatch" };
  }
  const resolvedQuote = resolveExactQuoteSlice(source.snapshotText, input.quote);
  if (!resolvedQuote) {
    return { ok: false, reason: "unsupported_quote" };
  }
  const quoteCodeUnitStart = resolvedQuote.codeUnitStart;
  const start = codePoints(
    source.snapshotText.slice(0, quoteCodeUnitStart),
  ).length;
  const end = start + quoteLength;
  const snapshotCodePoints = codePoints(source.snapshotText);
  const prefix = snapshotCodePoints
    .slice(Math.max(0, start - SELECTOR_CONTEXT_CODE_POINTS), start)
    .join("");
  const suffix = snapshotCodePoints
    .slice(end, end + SELECTOR_CONTEXT_CODE_POINTS)
    .join("");
  const assetId =
    typeof source.provenance.assetId === "string"
      ? source.provenance.assetId
      : undefined;

  return {
    ok: true,
    ref: {
      version: 2,
      evidenceRefId: options.evidenceRefId,
      sourceId: input.sourceId,
      sourceType: source.sourceType,
      sourceRole: source.sourceRole,
      hashAlgorithm: EVIDENCE_HASH_ALGORITHM,
      contentHash: source.contentHash,
      quote: resolvedQuote.quote,
      selector: {
        start,
        end,
        ...(prefix ? { prefix } : {}),
        ...(suffix ? { suffix } : {}),
      },
      ...(assetId ? { assetId } : {}),
      ...(source.displayUrl ? { url: source.displayUrl } : {}),
      ...(source.fetchedAt ? { fetchedAt: source.fetchedAt } : {}),
    },
  };
}
