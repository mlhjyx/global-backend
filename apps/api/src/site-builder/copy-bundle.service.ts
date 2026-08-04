import { createHash } from "node:crypto";

import {
  COPY_BUNDLE_SCHEMA_VERSION,
  COPY_BUNDLE_SET_SCHEMA_VERSION,
  COPY_SLOT_CATALOG_VERSION,
  copyBundleInputHash,
  finalizeCopyBundle,
  type CopyBundleSetV1,
  type CopySlotType,
  type RestrictedRichTextNode,
} from "@global/contracts";
import type {
  PublishableClaimSnapshot,
  PublishableClaimSnapshotItem,
} from "./publishable-claim-snapshot";

export const COPY_GENERATION_CONTRACT_VERSION =
  "site-builder-task-contract/site_builder.copy/v2" as const;

export interface CopySlotDefinition {
  key: string;
  type: CopySlotType;
  maxGraphemes: number;
  factual: boolean;
}

export interface CopyAudienceContext {
  industry: string | null;
  products: string[];
  targetMarkets: string[];
}

export interface CopyBrandVoiceContext {
  voice: string;
  style: string[];
  sourceRef: string;
}

export interface CopyCtaPolicy {
  intent: "contact";
  allowedLabels: string[];
}

export interface CopyGenerationContext {
  audience: CopyAudienceContext;
  brandVoice: CopyBrandVoiceContext;
  prohibitedAssertions: string[];
  ctaPolicy: CopyCtaPolicy;
}

export interface CopyBrandProfileContextSource {
  id: string;
  version: number;
  tone: unknown;
}

export type CopySlotContentMode =
  "claim_exact" | "creative_non_factual" | "cta_allowlist" | "deterministic";

export interface CopySlotGeneratorInput {
  locale: string;
  sourceLocale: string;
  slot: CopySlotDefinition;
  snapshot: Pick<PublishableClaimSnapshot, "digest" | "items">;
  context: CopyGenerationContext;
  contextDigest: string;
}

export interface CopySlotGeneratorResult {
  content: string | RestrictedRichTextNode;
  claimRefs: string[];
}

export interface CopySlotGenerator {
  generateSlot(input: CopySlotGeneratorInput): Promise<CopySlotGeneratorResult>;
}

export class CopyBundleGenerationError extends Error {
  constructor(
    readonly code: "COPY_DEFAULT_LOCALE_FAILED" | "COPY_LOCALE_SET_INVALID",
    message: string,
    readonly cause?: unknown,
  ) {
    super(`${code}: ${message}`);
    this.name = "CopyBundleGenerationError";
  }
}

export interface GenerateCopyBundlesInput {
  locales: readonly string[];
  sourceLocale: string;
  snapshotId: string;
  snapshot: PublishableClaimSnapshot;
  slots: readonly CopySlotDefinition[];
  generationContexts: Readonly<
    Record<string, { context: CopyGenerationContext; contextDigest: string }>
  >;
  approvedOutboundDomains: readonly string[];
}

export interface GenerateCopyBundlesResult {
  set: CopyBundleSetV1;
  degradedLocales: string[];
}

const PROTECTED_FACT =
  /\b(?:ISO\s*\d{3,5}(?::\d{4})?|CE|FDA|UL|\d+(?:[.,]\d+)?\s*(?:%|bar|mbar|pa|kpa|mpa|psi|hz|khz|mhz|ghz|rpm|v|mv|kv|a|ma|w|kw|mw|mm|cm|m|km|mg|g|kg|lb|ml|l))\b/giu;
const PROTECTED_FACT_ASSERTION =
  /\b(?:ISO\s*\d{3,5}(?::\d{4})?|CE|FDA|UL|\d+(?:[.,]\d+)?\s*(?:%|bar|mbar|pa|kpa|mpa|psi|hz|khz|mhz|ghz|rpm|v|mv|kv|a|ma|w|kw|mw|mm|cm|m|km|mg|g|kg|lb|ml|l))\b/iu;

const DEFAULT_PROHIBITED_ASSERTIONS = Object.freeze([
  "market-leading",
  "industry-leading",
  "world-class",
  "best-in-class",
  "award-winning",
  "trusted by",
  "certified",
  "compliant",
  "approved",
  "guaranteed",
  "marktführend",
  "weltklasse",
  "preisgekrönt",
  "zertifiziert",
  "konform",
  "garantiert",
]);

const UNSUPPORTED_ASSERTION =
  /(?:\p{N}|\b(?:we|our|we['’](?:re|ve)|wir|unser(?:e|er|es|en)?|certif(?:ied|ication)|compliant|approved|guaranteed|leading|trusted\s+by|serving|since|customers?|countries|years?|patented|award[- ]winning|zertifiziert|konform|garantiert|führend|kunden|länder|jahren?)\b)/iu;
const UNSUPPORTED_CONTACT =
  /(?:https?:\/\/|\/\/[a-z0-9]|www\.|\b[^\s@]+@[^\s@]+\.[^\s@]+\b|\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}\b|(?:^|[^\p{L}\p{N}])\+?\d(?:[\s().-]*\d){6,}(?=$|[^\p{L}\p{N}]))/iu;

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
    .join(",")}}`;
}

function safetyFold(value: string, locale?: string): string {
  const normalized = value
    .normalize("NFKC")
    .replace(/\p{Cf}/gu, "")
    .replace(/\p{Dash_Punctuation}/gu, "-")
    .replace(/\s+/gu, " ");
  return locale ? normalized.toLocaleLowerCase(locale) : normalized;
}

function assertionFold(value: string, locale: string): string {
  return safetyFold(value, locale).replace(/[-\s]+/gu, " ");
}

function boundedText(value: unknown, maximum: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.normalize("NFC").trim();
  if (
    !normalized ||
    normalized.length > maximum ||
    [...normalized].some((character) => {
      const code = character.codePointAt(0)!;
      return code < 32 || code === 127;
    })
  ) {
    return null;
  }
  return normalized;
}

function boundedTextList(
  value: unknown,
  maximumItems: number,
  maximumLength: number,
): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .map((item) => boundedText(item, maximumLength))
        .filter((item): item is string => item !== null),
    ),
  ].slice(0, maximumItems);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function ctaLabels(locale: string): string[] {
  return locale === "de-DE"
    ? ["Kontakt aufnehmen", "Kontaktieren Sie uns", "Informationen anfragen"]
    : ["Get in touch", "Contact us", "Request information"];
}

export function buildCopyGenerationContext(input: {
  locale: string;
  intake: unknown;
  brandProfile: CopyBrandProfileContextSource | null;
}): CopyGenerationContext {
  const intake = record(input.intake);
  const company = record(intake.company);
  const tone = record(input.brandProfile?.tone);
  const voice = boundedText(tone.voice, 160) ?? "restrained and professional";
  const style = boundedTextList(tone.style, 8, 80);
  const industry = boundedText(intake.industry, 160);
  const products = boundedTextList(intake.products, 24, 160);
  const targetMarkets = boundedTextList(intake.targetMarkets, 24, 160);
  const companyNames = [
    boundedText(company.nameEn, 160),
    boundedText(company.nameZh, 160),
  ].filter(
    (value): value is string => value !== null && Array.from(value).length >= 4,
  );
  return {
    audience: {
      industry,
      products,
      targetMarkets,
    },
    brandVoice: {
      voice,
      style: style.length > 0 ? style : ["clear", "concise"],
      sourceRef: input.brandProfile
        ? `brand-profile:${input.brandProfile.id}:v${input.brandProfile.version}`
        : "copy-default-brand-voice/v1",
    },
    prohibitedAssertions: [
      ...new Set(
        [...DEFAULT_PROHIBITED_ASSERTIONS, ...companyNames].map((value) =>
          value.slice(0, 80).trim(),
        ),
      ),
    ].slice(0, 32),
    ctaPolicy: { intent: "contact", allowedLabels: ctaLabels(input.locale) },
  };
}

export function copyGenerationContextDigest(
  context: CopyGenerationContext,
): string {
  return createHash("sha256")
    .update(canonicalJson(context), "utf8")
    .digest("hex");
}

function semanticCopySlotKey(key: string): string {
  const parts = key.split(".");
  return parts.length > 2 ? parts.slice(2).join(".") : key;
}

export function copySlotContentMode(
  slot: CopySlotDefinition,
): CopySlotContentMode {
  const semanticKey = semanticCopySlotKey(slot.key);
  if (
    slot.type === "cta_label" ||
    semanticKey
      .replace(/[^a-z0-9]/giu, "")
      .toLowerCase()
      .includes("cta")
  ) {
    return "cta_allowlist";
  }
  if (slot.factual) return "claim_exact";
  if (
    slot.type === "form_label" ||
    /^(?:nav\.|inquiry\.|faq\.q)/u.test(slot.key)
  ) {
    return "deterministic";
  }
  return "creative_non_factual";
}

function plainGeneratorContent(output: CopySlotGeneratorResult): string {
  if (typeof output.content !== "string") {
    throw new Error("COPY_OUTPUT_CONTENT_MALFORMED");
  }
  const content = output.content.normalize("NFC");
  if (
    !content ||
    content !== content.trim() ||
    /<\/?[a-z][^>]*>/iu.test(safetyFold(content))
  ) {
    throw new Error("COPY_OUTPUT_CONTENT_MALFORMED");
  }
  return content;
}

export function validateCopySlotGeneratorOutput(input: {
  locale: string;
  slot: CopySlotDefinition;
  output: CopySlotGeneratorResult;
  claims: ReadonlyMap<string, { statement: string }>;
  context: CopyGenerationContext;
}): void {
  const content = plainGeneratorContent(input.output);
  const mode = copySlotContentMode(input.slot);
  if (graphemeCount(content) > input.slot.maxGraphemes) {
    throw new Error("COPY_SLOT_BUDGET_EXCEEDED");
  }
  if (new Set(input.output.claimRefs).size !== input.output.claimRefs.length) {
    throw new Error("COPY_CLAIM_REF_REPEATED");
  }
  const cited = input.output.claimRefs.map((claimId) => {
    const claim = input.claims.get(claimId);
    if (!claim) throw new Error("COPY_CLAIM_REF_UNKNOWN");
    return claim.statement;
  });
  if (cited.length > 0) {
    if (mode === "cta_allowlist") {
      throw new Error("COPY_CTA_POLICY_VIOLATION");
    }
    if (mode === "deterministic") {
      throw new Error("COPY_DETERMINISTIC_SLOT_VIOLATION");
    }
    if (content !== cited.join(" · ")) {
      throw new Error("COPY_FACT_ASSERTION_UNSUPPORTED");
    }
    return;
  }

  if (mode === "claim_exact" || mode === "deterministic") {
    if (
      content !==
      neutralCopySlotGeneratorResult(input.slot, input.locale).content
    ) {
      throw new Error("COPY_DETERMINISTIC_SLOT_VIOLATION");
    }
    return;
  }
  if (mode === "cta_allowlist") {
    if (!input.context.ctaPolicy.allowedLabels.includes(content)) {
      throw new Error("COPY_CTA_POLICY_VIOLATION");
    }
    return;
  }
  const folded = safetyFold(content, input.locale);
  if (UNSUPPORTED_CONTACT.test(folded)) {
    throw new Error("COPY_UNSUPPORTED_CONTACT");
  }
  if (
    PROTECTED_FACT_ASSERTION.test(folded) ||
    UNSUPPORTED_ASSERTION.test(folded) ||
    input.context.prohibitedAssertions.some((phrase) =>
      assertionFold(content, input.locale).includes(
        assertionFold(phrase, input.locale),
      ),
    )
  ) {
    throw new Error("COPY_UNSUPPORTED_ASSERTION");
  }
}

/** Tokens that translation/tone may not silently normalize or convert. */
export function protectedFactTokens(
  item: PublishableClaimSnapshotItem,
): string[] {
  return [...new Set(item.statement.match(PROTECTED_FACT) ?? [])].sort();
}

function graphemeCount(value: string): number {
  type SegmenterLike = { segment(input: string): Iterable<unknown> };
  type SegmenterConstructor = new (
    locale?: string,
    options?: { granularity: "grapheme" },
  ) => SegmenterLike;
  const Segmenter = (Intl as unknown as { Segmenter?: SegmenterConstructor })
    .Segmenter;
  return Segmenter
    ? Array.from(
        new Segmenter(undefined, { granularity: "grapheme" }).segment(value),
      ).length
    : Array.from(value.normalize("NFC")).length;
}

function constrainGraphemes(value: string, maximum: number): string {
  if (graphemeCount(value) <= maximum) return value;
  type SegmenterLike = {
    segment(input: string): Iterable<{ segment: string }>;
  };
  type SegmenterConstructor = new (
    locale?: string,
    options?: { granularity: "grapheme" },
  ) => SegmenterLike;
  const Segmenter = (Intl as unknown as { Segmenter?: SegmenterConstructor })
    .Segmenter;
  const graphemes = Segmenter
    ? Array.from(
        new Segmenter(undefined, { granularity: "grapheme" }).segment(value),
        (item) => item.segment,
      )
    : Array.from(value.normalize("NFC"));
  if (maximum === 1) return graphemes[0] ?? "";
  return `${graphemes
    .slice(0, maximum - 1)
    .join("")
    .trimEnd()}…`;
}

export function neutralCopySlotContent(key: string, locale: string): string {
  const german = locale === "de-DE";
  const semanticKey = semanticCopySlotKey(key)
    .replace(/[^a-z0-9]/giu, "")
    .toLowerCase();
  if (/^nav\.home$/.test(key)) return german ? "Startseite" : "Home";
  if (/^nav\.products$/.test(key)) return german ? "Lösungen" : "Solutions";
  if (/^nav\.contact$/.test(key)) return german ? "Kontakt" : "Contact";
  if (
    semanticKey.includes("cta") ||
    /(?:^|\.)(?:primary|secondary)?cta(?:\.label)?$|(?:^|\.)submit$|(?:all|add)label$/.test(
      key,
    )
  )
    return german ? "Kontakt aufnehmen" : "Get in touch";
  if (/^inquiry\.field\.name$/.test(key)) return "Name";
  if (/^inquiry\.field\.email$/.test(key))
    return german ? "Geschäftliche E-Mail" : "Work email";
  if (/^inquiry\.field\.message$/.test(key))
    return german ? "Ihre Anfrage" : "Your inquiry";
  if (/^inquiry\.m0\.note$/.test(key)) {
    return german
      ? "Das Anfrageformular wird mit der Veröffentlichung aktiviert."
      : "The inquiry form is enabled when the site is published.";
  }
  if (/^seo\..*\.title$/.test(key))
    return german ? "Unternehmenswebsite" : "Company website";
  if (/^seo\./.test(key)) {
    return german
      ? "Informieren Sie sich über verfügbare Lösungen und Kontaktmöglichkeiten."
      : "Explore available solutions and ways to get in touch.";
  }
  if (/\.title$|\.headline$/.test(key))
    return german ? "Praktische Lösungen" : "Practical solutions";
  if (/^faq\.q/.test(key))
    return german
      ? "Wie erhalte ich weitere Informationen?"
      : "How can I learn more?";
  if (/^products\.p\d+\.name$/.test(key)) return german ? "Lösung" : "Solution";
  return german
    ? "Weitere Informationen sind auf Anfrage verfügbar."
    : "Further information is available on request.";
}

export function neutralCopySlotGeneratorResult(
  slot: CopySlotDefinition,
  locale: string,
): CopySlotGeneratorResult {
  return {
    content: constrainGraphemes(
      neutralCopySlotContent(slot.key, locale),
      slot.maxGraphemes,
    ),
    claimRefs: [],
  };
}

export function canonicalizeCopySlotOutput(
  locale: string,
  slot: CopySlotDefinition,
  output: CopySlotGeneratorResult,
  claims: ReadonlyMap<
    string,
    { statement: string; protectedTokens: readonly string[] }
  >,
  context: CopyGenerationContext,
): CopySlotGeneratorResult & { factual: boolean } {
  validateCopySlotGeneratorOutput({ locale, slot, output, claims, context });
  const claimRefs = [...output.claimRefs];
  const mode = copySlotContentMode(slot);
  const content =
    claimRefs.length > 0
      ? claimRefs.map((claimId) => claims.get(claimId)!.statement).join(" · ")
      : mode === "claim_exact" || mode === "deterministic"
        ? constrainGraphemes(
            neutralCopySlotContent(slot.key, locale),
            slot.maxGraphemes,
          )
        : (output.content as string);
  return {
    content:
      slot.type === "rich_text"
        ? {
            type: "doc",
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: content }],
              },
            ],
          }
        : content,
    claimRefs,
    factual: claimRefs.length > 0,
  };
}

export class CopyBundleService {
  constructor(
    private readonly generator: CopySlotGenerator,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async generate(
    input: GenerateCopyBundlesInput,
  ): Promise<GenerateCopyBundlesResult> {
    if (
      input.locales.length === 0 ||
      input.locales[0] !== input.sourceLocale ||
      new Set(input.locales).size !== input.locales.length ||
      new Set(input.slots.map((slot) => slot.key)).size !== input.slots.length
    ) {
      throw new CopyBundleGenerationError(
        "COPY_LOCALE_SET_INVALID",
        "source locale must be first and locales/slots must be unique",
      );
    }
    for (const locale of input.locales) {
      const frozenContext = input.generationContexts[locale];
      if (
        !frozenContext ||
        copyGenerationContextDigest(frozenContext.context) !==
          frozenContext.contextDigest
      ) {
        throw new CopyBundleGenerationError(
          "COPY_LOCALE_SET_INVALID",
          `generation context for ${locale} is missing or does not match its digest`,
        );
      }
    }

    const claims = new Map(
      input.snapshot.items.map((item) => [
        item.claimId,
        {
          statement: item.statement,
          protectedTokens: protectedFactTokens(item),
        },
      ]),
    );
    const bundles: CopyBundleSetV1["bundles"] = {};
    const degradedLocales: string[] = [];

    for (const locale of input.locales) {
      try {
        const frozenContext = input.generationContexts[locale]!;
        const generated = await Promise.all(
          input.slots.map(async (slot) => ({
            slot,
            output: await this.generator.generateSlot({
              locale,
              sourceLocale: input.sourceLocale,
              slot,
              snapshot: {
                digest: input.snapshot.digest,
                items: input.snapshot.items,
              },
              context: frozenContext.context,
              contextDigest: frozenContext.contextDigest,
            }),
          })),
        );
        const inputHash = copyBundleInputHash({
          claimSnapshotDigest: input.snapshot.digest,
          taskContractVersion: COPY_GENERATION_CONTRACT_VERSION,
          locale,
          sourceLocale: input.sourceLocale,
          slots: input.slots,
          contextDigest: frozenContext.contextDigest,
        });
        bundles[locale] = finalizeCopyBundle(
          {
            schemaVersion: COPY_BUNDLE_SCHEMA_VERSION,
            slotCatalogVersion: COPY_SLOT_CATALOG_VERSION,
            locale,
            sourceLocale: input.sourceLocale,
            status: "complete",
            claimSnapshot: {
              id: input.snapshotId,
              digest: input.snapshot.digest,
            },
            inputHash,
            slots: Object.fromEntries(
              generated.map(({ slot, output }) => {
                const canonical = canonicalizeCopySlotOutput(
                  locale,
                  slot,
                  output,
                  claims,
                  frozenContext.context,
                );
                return [
                  slot.key,
                  {
                    type: slot.type,
                    maxGraphemes: slot.maxGraphemes,
                    factual: canonical.factual,
                    content: canonical.content,
                    claimRefs: canonical.claimRefs,
                  },
                ];
              }),
            ),
          },
          {
            supportedLocales: [...input.locales],
            claims,
            approvedOutboundDomains: input.approvedOutboundDomains,
          },
        );
      } catch (error) {
        if (locale === input.sourceLocale) {
          throw new CopyBundleGenerationError(
            "COPY_DEFAULT_LOCALE_FAILED",
            `source locale ${locale} did not produce a valid CopyBundle`,
            error,
          );
        }
        degradedLocales.push(locale);
      }
    }

    return {
      set: {
        schemaVersion: COPY_BUNDLE_SET_SCHEMA_VERSION,
        sourceLocale: input.sourceLocale,
        bundles,
      },
      degradedLocales,
    };
  }
}
