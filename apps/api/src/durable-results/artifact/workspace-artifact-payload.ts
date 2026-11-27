import { createHash } from "node:crypto";
import { sanitizeEvidenceUrl } from "../../common/evidence-ref";
import type { Tool } from "../../tools/tool-contract";
import { parseArtifactExpectedFacts } from "./artifact-expected-facts";
import { normalizeArtifactPageText } from "./artifact-page-text";
import { invalidGenericOperationArtifact as invalid } from "./artifact.types";
import {
  parseContactEmailFindPayload,
  serializeContactEmailFindPayload,
} from "./materializers/contact-email-find.materializer";

export type WorkspaceArtifactSchema =
  | "crawl4ai-fetch/v1"
  | "crawl4ai-render/v1"
  | "http-get/v1"
  | "contact-email-find-hunter/v1"
  | "contact-email-find-prospeo/v1";

interface ArtifactPayload {
  readonly body: string;
  readonly mediaType: string;
  readonly expectedFacts: unknown;
  /** Exactly what the schema materializer reconstructs from body + facts. */
  readonly data: unknown;
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

export function record(value: unknown): Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : invalid();
}

export function stringField(value: unknown): string {
  return typeof value === "string" ? value : invalid();
}

function isPersistableUrl(url: string): boolean {
  try {
    parseArtifactExpectedFacts("crawl4ai-fetch/v1", {
      sanitizedUrl: url,
      contentHash: "0".repeat(24),
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * The persisted fact URL must satisfy the closed sanitized-URL contract
 * (lowercase path, no query/escapes, no long digit runs). When the exact page
 * URL cannot, the site origin is the truthful company-level provenance.
 */
function persistableUrl(raw: unknown): string {
  const sanitized = sanitizeEvidenceUrl(
    typeof raw === "string" ? raw : undefined,
  );
  if (!sanitized) return invalid();
  const url = new URL(sanitized);
  url.search = "";
  url.hash = "";
  const candidates = [url.toString(), `${url.protocol}//${url.hostname}/`];
  return candidates.find(isPersistableUrl) ?? invalid();
}

function isHtmlBody(value: string): boolean {
  return /^\s*<(?:!doctype\s+html\b|[a-z][a-z0-9:-]*\b)/i.test(value);
}

function crawl4aiFetchPayload(input: unknown, data: unknown): ArtifactPayload {
  const source = record(data);
  const text = normalizeArtifactPageText(stringField(source.text));
  const url = persistableUrl(source.url ?? record(input).url);
  const contentHash = shortHash(text);
  return {
    body: text,
    mediaType: "text/markdown",
    expectedFacts: { sanitizedUrl: url, contentHash },
    data: { url, text, contentHash },
  };
}

function crawl4aiRenderPayload(input: unknown, data: unknown): ArtifactPayload {
  const source = record(data);
  const url = persistableUrl(source.url ?? record(input).url);
  if (source.robotsBlocked === true) {
    return {
      body: "",
      mediaType: "text/html",
      expectedFacts: { sanitizedUrl: url, blocked: true },
      data: { url, html: "", robotsBlocked: true },
    };
  }
  const html = stringField(source.html);
  if (!isHtmlBody(html)) return invalid();
  return {
    body: html,
    mediaType: "text/html",
    expectedFacts: { sanitizedUrl: url, blocked: false },
    data: { url, html },
  };
}

function httpGetPayload(input: unknown, data: unknown): ArtifactPayload {
  const source = record(data);
  if (typeof source.blocked === "string") {
    return {
      body: "",
      mediaType: "text/plain",
      expectedFacts: {
        status: 0,
        ok: false,
        sanitizedUrl: null,
        blocked: source.blocked,
      },
      data: {
        status: 0,
        ok: false,
        mediaType: "text/plain",
        text: "",
        blocked: source.blocked,
      },
    };
  }
  const status = source.status;
  if (typeof status !== "number" || typeof source.ok !== "boolean")
    return invalid();
  const url = persistableUrl(source.finalUrl ?? record(input).url);
  const text = stringField(source.text);
  return {
    body: text,
    mediaType: "text/plain",
    expectedFacts: { status, ok: source.ok, sanitizedUrl: url, blocked: null },
    data: {
      status,
      ok: source.ok,
      mediaType: "text/plain",
      text,
      finalUrl: url,
    },
  };
}

function contactEmailFindPayload(
  _input: unknown,
  value: unknown,
  workspaceId: string,
): ArtifactPayload {
  const data = parseContactEmailFindPayload(value);
  return {
    body: serializeContactEmailFindPayload(data, workspaceId),
    mediaType: "application/octet-stream",
    expectedFacts: undefined,
    data,
  };
}

const PAYLOADS: Readonly<
  Record<
    WorkspaceArtifactSchema,
    (input: unknown, data: unknown, workspaceId: string) => ArtifactPayload
  >
> = Object.freeze({
  "crawl4ai-fetch/v1": crawl4aiFetchPayload,
  "crawl4ai-render/v1": crawl4aiRenderPayload,
  "http-get/v1": httpGetPayload,
  "contact-email-find-hunter/v1": contactEmailFindPayload,
  "contact-email-find-prospeo/v1": contactEmailFindPayload,
});

export function workspaceArtifactSchema(
  tool: Tool<unknown, unknown>,
): WorkspaceArtifactSchema {
  const strategy = tool.durableResultStrategy;
  if (
    strategy.kind !== "artifact_reference" ||
    !Object.hasOwn(PAYLOADS, strategy.schema)
  ) {
    return invalid();
  }
  return strategy.schema as WorkspaceArtifactSchema;
}

export function workspaceArtifactPayload(
  schema: WorkspaceArtifactSchema,
  input: unknown,
  data: unknown,
  workspaceId: string,
): ArtifactPayload {
  return PAYLOADS[schema](input, data, workspaceId);
}

export async function* bytesOfArtifact(body: string): AsyncIterable<Uint8Array> {
  if (body.length > 0) yield new TextEncoder().encode(body);
}
