import { createHash } from "node:crypto";

export const COPY_BUNDLE_SCHEMA_VERSION =
  "site-builder-copy-bundle/v1" as const;
export const COPY_SLOT_CATALOG_VERSION = "site-builder-copy-slots/v1" as const;

export const COPY_SLOT_TYPES = [
  "plain_text",
  "rich_text",
  "seo_title",
  "seo_description",
  "cta_label",
  "form_label",
  "alt_text",
  "legal_notice",
] as const;
export type CopySlotType = (typeof COPY_SLOT_TYPES)[number];

export type RestrictedRichTextNode =
  | { type: "doc"; content: RestrictedRichTextNode[] }
  | { type: "paragraph"; content: RestrictedRichTextNode[] }
  | { type: "strong"; content: RestrictedRichTextNode[] }
  | { type: "em"; content: RestrictedRichTextNode[] }
  | { type: "bullet_list"; content: RestrictedRichTextNode[] }
  | { type: "ordered_list"; content: RestrictedRichTextNode[] }
  | { type: "list_item"; content: RestrictedRichTextNode[] }
  | { type: "link"; href: string; content: RestrictedRichTextNode[] }
  | { type: "text"; text: string };

export interface CopySlotV1 {
  type: CopySlotType;
  maxGraphemes: number;
  factual: boolean;
  content: string | RestrictedRichTextNode;
  claimRefs: string[];
}

export interface CopyBundleDraftV1 {
  schemaVersion: typeof COPY_BUNDLE_SCHEMA_VERSION;
  slotCatalogVersion: typeof COPY_SLOT_CATALOG_VERSION;
  locale: string;
  sourceLocale: string;
  status: "complete" | "degraded";
  claimSnapshot: { id: string; digest: string };
  inputHash: string;
  slots: Record<string, CopySlotV1>;
}

export interface CopyBundleV1 extends CopyBundleDraftV1 {
  digest: string;
}

export interface CopyBundleValidationContext {
  supportedLocales: readonly string[];
  claims: ReadonlyMap<string, { protectedTokens: readonly string[] }>;
  approvedOutboundDomains: readonly string[];
}

export interface CopyBundleInputHashInput {
  claimSnapshotDigest: string;
  locale: string;
  sourceLocale: string;
  slots: readonly {
    key: string;
    type: CopySlotType;
    maxGraphemes: number;
    factual: boolean;
  }[];
}

export type CopyBundleContractErrorCode =
  | "COPY_BUNDLE_INVALID"
  | "COPY_LOCALE_UNSUPPORTED"
  | "COPY_SLOT_BUDGET_EXCEEDED"
  | "COPY_CLAIM_REF_REQUIRED"
  | "COPY_CLAIM_REF_UNKNOWN"
  | "COPY_PROTECTED_FACT_CHANGED"
  | "COPY_RAW_HTML_FORBIDDEN"
  | "COPY_RICH_TEXT_FORBIDDEN"
  | "COPY_OUTBOUND_DOMAIN_FORBIDDEN";

export class CopyBundleContractError extends Error {
  constructor(
    readonly code: CopyBundleContractErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "CopyBundleContractError";
  }
}

function fail(code: CopyBundleContractErrorCode, message: string): never {
  throw new CopyBundleContractError(code, message);
}

function sha256(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value), "utf8")
    .digest("hex");
}

function canonicalLocale(value: string): string | null {
  try {
    const canonical = Intl.getCanonicalLocales(value);
    return canonical.length === 1 ? canonical[0] : null;
  } catch {
    return null;
  }
}

function graphemeCount(value: string): number {
  type SegmenterLike = {
    segment(input: string): Iterable<unknown>;
  };
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

const RAW_HTML = /<\/?[A-Za-z][^>]*>/;
const CONTAINER_TYPES = new Set([
  "doc",
  "paragraph",
  "strong",
  "em",
  "bullet_list",
  "ordered_list",
  "list_item",
]);

function assertLink(
  href: string,
  approvedOutboundDomains: readonly string[],
): void {
  if (href.startsWith("/") || href.startsWith("#")) return;
  let parsed: URL;
  try {
    parsed = new URL(href);
  } catch {
    fail("COPY_OUTBOUND_DOMAIN_FORBIDDEN", `link ${href} is not a safe URL`);
  }
  if (
    parsed.protocol !== "https:" ||
    !approvedOutboundDomains.includes(parsed.hostname.toLowerCase())
  ) {
    fail(
      "COPY_OUTBOUND_DOMAIN_FORBIDDEN",
      `link domain ${parsed.hostname} is not approved`,
    );
  }
}

function richTextValue(
  value: unknown,
  approvedOutboundDomains?: readonly string[],
): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return fail("COPY_RICH_TEXT_FORBIDDEN", "rich text node must be an object");
  }
  const node = value as Record<string, unknown>;
  if (node.type === "text") {
    if (
      typeof node.text !== "string" ||
      Object.keys(node).some((key) => !["type", "text"].includes(key))
    ) {
      return fail("COPY_RICH_TEXT_FORBIDDEN", "text node is malformed");
    }
    if (RAW_HTML.test(node.text)) {
      return fail("COPY_RAW_HTML_FORBIDDEN", "raw HTML is not permitted");
    }
    return node.text;
  }
  if (node.type === "link") {
    if (
      typeof node.href !== "string" ||
      !Array.isArray(node.content) ||
      Object.keys(node).some(
        (key) => !["type", "href", "content"].includes(key),
      )
    ) {
      return fail("COPY_RICH_TEXT_FORBIDDEN", "link node is malformed");
    }
    if (approvedOutboundDomains) assertLink(node.href, approvedOutboundDomains);
    return node.content
      .map((child) => richTextValue(child, approvedOutboundDomains))
      .join("");
  }
  if (
    typeof node.type !== "string" ||
    !CONTAINER_TYPES.has(node.type) ||
    !Array.isArray(node.content) ||
    Object.keys(node).some((key) => !["type", "content"].includes(key))
  ) {
    return fail(
      "COPY_RICH_TEXT_FORBIDDEN",
      `node ${String(node.type)} is forbidden`,
    );
  }
  return node.content
    .map((child) => richTextValue(child, approvedOutboundDomains))
    .join("");
}

function slotText(
  key: string,
  slot: CopySlotV1,
  context: CopyBundleValidationContext,
): string {
  if (
    !COPY_SLOT_TYPES.includes(slot.type) ||
    !Number.isInteger(slot.maxGraphemes) ||
    slot.maxGraphemes < 1
  ) {
    return fail("COPY_BUNDLE_INVALID", `slot ${key} metadata is invalid`);
  }
  if (
    !Array.isArray(slot.claimRefs) ||
    slot.claimRefs.some((id) => typeof id !== "string")
  ) {
    return fail("COPY_BUNDLE_INVALID", `slot ${key} claimRefs are invalid`);
  }
  const text =
    slot.type === "rich_text"
      ? richTextValue(slot.content, context.approvedOutboundDomains)
      : typeof slot.content === "string"
        ? slot.content
        : fail("COPY_BUNDLE_INVALID", `slot ${key} must contain a string`);
  if (RAW_HTML.test(text)) {
    fail("COPY_RAW_HTML_FORBIDDEN", `slot ${key} contains raw HTML`);
  }
  if (graphemeCount(text) > slot.maxGraphemes) {
    fail(
      "COPY_SLOT_BUDGET_EXCEEDED",
      `slot ${key} exceeds ${slot.maxGraphemes} graphemes`,
    );
  }
  if (slot.factual && slot.claimRefs.length === 0) {
    fail(
      "COPY_CLAIM_REF_REQUIRED",
      `factual slot ${key} has no Claim reference`,
    );
  }
  for (const claimId of slot.claimRefs) {
    const claim = context.claims.get(claimId);
    if (!claim)
      fail("COPY_CLAIM_REF_UNKNOWN", `claim ${claimId} is not in the snapshot`);
    for (const token of claim.protectedTokens) {
      if (!text.includes(token)) {
        fail(
          "COPY_PROTECTED_FACT_CHANGED",
          `slot ${key} changed protected token ${token}`,
        );
      }
    }
  }
  return text;
}

export function copyBundleInputHash(input: CopyBundleInputHashInput): string {
  const canonical = {
    ...input,
    locale: canonicalLocale(input.locale) ?? input.locale,
    sourceLocale: canonicalLocale(input.sourceLocale) ?? input.sourceLocale,
    slots: [...input.slots].sort((left, right) =>
      left.key < right.key ? -1 : left.key > right.key ? 1 : 0,
    ),
  };
  return sha256(canonical);
}

export function validateCopyBundle(
  value: CopyBundleDraftV1,
  context: CopyBundleValidationContext,
): void {
  if (
    value.schemaVersion !== COPY_BUNDLE_SCHEMA_VERSION ||
    value.slotCatalogVersion !== COPY_SLOT_CATALOG_VERSION ||
    !/^[a-f0-9]{64}$/.test(value.claimSnapshot.digest) ||
    !/^[a-f0-9]{64}$/.test(value.inputHash) ||
    !["complete", "degraded"].includes(value.status)
  ) {
    fail("COPY_BUNDLE_INVALID", "bundle envelope is malformed");
  }
  const locale = canonicalLocale(value.locale);
  const sourceLocale = canonicalLocale(value.sourceLocale);
  if (
    !locale ||
    locale !== value.locale ||
    !sourceLocale ||
    sourceLocale !== value.sourceLocale ||
    !context.supportedLocales.includes(locale) ||
    !context.supportedLocales.includes(sourceLocale)
  ) {
    fail(
      "COPY_LOCALE_UNSUPPORTED",
      `locale ${value.locale} or source locale ${value.sourceLocale} is unsupported`,
    );
  }
  if (
    !value.slots ||
    typeof value.slots !== "object" ||
    Array.isArray(value.slots)
  ) {
    fail("COPY_BUNDLE_INVALID", "slots must be an object");
  }
  for (const [key, slot] of Object.entries(value.slots)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(key)) {
      fail("COPY_BUNDLE_INVALID", `slot key ${key} is invalid`);
    }
    slotText(key, slot, context);
  }
}

function canonicalDraft(value: CopyBundleDraftV1): CopyBundleDraftV1 {
  return {
    ...value,
    slots: Object.fromEntries(
      Object.entries(value.slots).sort(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0,
      ),
    ),
  };
}

export function finalizeCopyBundle(
  draft: CopyBundleDraftV1,
  context: CopyBundleValidationContext,
): CopyBundleV1 {
  validateCopyBundle(draft, context);
  const canonical = canonicalDraft(draft);
  return { ...canonical, digest: sha256(canonical) };
}

export function copyBundleToLegacyStrings(
  bundle: CopyBundleV1,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(bundle.slots).map(([key, slot]) => [
      key,
      slot.type === "rich_text"
        ? richTextValue(slot.content)
        : (slot.content as string),
    ]),
  );
}
