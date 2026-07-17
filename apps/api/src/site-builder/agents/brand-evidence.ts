import type { EvidenceSourceType } from "@global/contracts";
import type { IntakeInput } from "../intake.service";
import type { ResearchSource } from "./brand-research";
import {
  freezeEvidenceSource,
  normalizeEvidenceText,
  sanitizeEvidenceMetadataText,
  sanitizeEvidenceUrl,
  type FrozenEvidenceSource,
} from "./evidence-ref";

const KB_PER_DOCUMENT_CODE_POINTS = 4_000;
const KB_TOTAL_CODE_POINTS = 16_000;
const TRUNCATION_MARKER = "…[truncated]";

export interface KbEvidenceDigestSource {
  source: string;
  title: string;
  text: string;
  documentId: string;
  assetId: string | null;
  upstreamContentHash: string | null;
  chunks: { id: string; seq: number; textHash: string }[];
}

export interface PreparedBrandEvidence {
  intake: FrozenEvidenceSource;
  kb: FrozenEvidenceSource[];
  research: FrozenEvidenceSource[];
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function kbSourceType(source: string): EvidenceSourceType {
  if (source === "wizard") return "intake";
  if (
    source === "intake" ||
    source === "upload" ||
    source === "storefront" ||
    source === "web_research"
  ) {
    return source;
  }
  throw new Error(`unsupported KB evidence source type: ${source}`);
}

function boundedKbText(text: string, remaining: number): string {
  const normalized = Array.from(normalizeEvidenceText(text));
  const limit = Math.min(KB_PER_DOCUMENT_CODE_POINTS, remaining);
  if (normalized.length <= limit) return normalized.join("");
  const marker = Array.from(TRUNCATION_MARKER);
  if (limit <= marker.length) return "";
  return `${normalized.slice(0, limit - marker.length).join("")}${TRUNCATION_MARKER}`;
}

export function prepareBrandEvidenceSources(input: {
  siteId: string;
  profileVersionId: string;
  intake: IntakeInput;
  profile?: Record<string, unknown>;
  kb: KbEvidenceDigestSource[];
  research: ResearchSource[];
}): PreparedBrandEvidence {
  const intakeText = [
    `Company name (English): ${input.intake.company.nameEn ?? "not provided"}`,
    `Company name (Chinese): ${input.intake.company.nameZh}`,
    `Industry: ${input.intake.industry || "not provided"}`,
    `Products: ${input.intake.products.join(", ") || "not provided"}`,
    `Target markets: ${input.intake.targetMarkets.join(", ") || "not provided"}`,
    `Company website: ${input.intake.websiteUrl ?? "not provided"}`,
    `Site owner profile: ${stableJson(input.profile ?? {})}`,
  ].join("\n");
  const intake = freezeEvidenceSource({
    sourceKey: `intake:${input.profileVersionId}`,
    sourceType: "intake",
    sourceRole: "fact_candidate",
    rawText: intakeText,
    provenance: {
      kind: "site_intake_profile",
      siteId: input.siteId,
      profileVersionId: input.profileVersionId,
      parserVersion: "site-intake-profile/1",
    },
  });

  const kb: FrozenEvidenceSource[] = [];
  let used = 0;
  for (const doc of input.kb) {
    const body = boundedKbText(doc.text, KB_TOTAL_CODE_POINTS - used);
    if (!body) break;
    used += Array.from(body).length;
    const sourceType = kbSourceType(doc.source);
    const title = sanitizeEvidenceMetadataText(doc.title);
    kb.push(
      freezeEvidenceSource({
        sourceKey: `kb_document:${doc.documentId}:chunks:${doc.chunks.map((chunk) => chunk.id).join(",")}`,
        sourceType,
        sourceRole:
          sourceType === "web_research" ? "research_hint" : "fact_candidate",
        rawText: body,
        upstreamContentHash: doc.upstreamContentHash ?? undefined,
        provenance: {
          kind: "kb_digest_selection",
          documentId: doc.documentId,
          assetId: doc.assetId,
          ...(title ? { title } : {}),
          chunks: doc.chunks,
          parserVersion: "kb-digest/2",
        },
      }),
    );
    if (used >= KB_TOTAL_CODE_POINTS) break;
  }

  const research = input.research.map((source) => {
    const displayUrl = sanitizeEvidenceUrl(source.url);
    // C4: third-party search titles are arbitrary page data and may name people.
    // researchBrand emits no title; ignore one defensively if another caller adds it.
    const title =
      source.sourceType === "web_research"
        ? undefined
        : sanitizeEvidenceMetadataText(source.title);
    return freezeEvidenceSource({
      sourceKey: `${source.sourceType}:${displayUrl ?? `invalid-url:${source.upstreamContentHash}`}`,
      sourceType: source.sourceType,
      sourceRole: source.sourceRole,
      rawText: source.content,
      upstreamContentHash: source.upstreamContentHash,
      displayUrl,
      fetchedAt: source.fetchedAt,
      provenance: {
        kind:
          source.sourceType === "storefront"
            ? "storefront_crawl"
            : "search_origin_hint",
        ...(title ? { title } : {}),
        parserVersion: source.parserVersion,
        providerContentHash: source.providerContentHash,
      },
    });
  });

  return { intake, kb, research };
}
