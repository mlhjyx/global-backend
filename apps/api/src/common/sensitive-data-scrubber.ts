import { createHash } from "node:crypto";

const EMAIL_RE =
  /(?<![\p{L}\p{N}\p{M}!#$%&'*+/=?^_`{|}~.-])[\p{L}\p{N}\p{M}!#$%&'*+/=?^_`{|}~-]+(?:\.[\p{L}\p{N}\p{M}!#$%&'*+/=?^_`{|}~-]+)*@[\p{L}\p{N}\p{M}](?:[\p{L}\p{N}\p{M}-]{0,61}[\p{L}\p{N}\p{M}])?(?:\.[\p{L}\p{N}\p{M}](?:[\p{L}\p{N}\p{M}-]{0,61}[\p{L}\p{N}\p{M}])?)*\.[\p{L}\p{N}\p{M}](?:[\p{L}\p{N}\p{M}-]{0,61}[\p{L}\p{N}\p{M}])(?![\p{L}\p{N}\p{M}-])/giu;
const PHONE_RE = /(?:\+?\d[\d\s().-]{7,}\d)/g;
const URL_RE = /\b(?:https?|postgres(?:ql)?):\/\/[^\s|"'<>]+/giu;
const BEARER_RE = /\b(Bearer)\s+[^\s,;]+/giu;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;
const SECRET_ASSIGNMENT_RE =
  /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|secret|token)\s*([:=])\s*([^\s,;|&]+)/giu;
const SENSITIVE_QUERY_KEY =
  /^(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|auth|password|passwd|secret|token|client[_-]?secret)$/i;
const SENSITIVE_OBJECT_KEY =
  /^(?:authorization|proxyAuthorization|cookie|setCookie|password|passwd|secret|token|accessToken|refreshToken|apiKey|accessKey|privateKey|clientSecret|credential)$/i;
const SAFE_ERROR_NAMES = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "URIError",
  "AggregateError",
]);

function redactBearerCredential(
  match: string,
  scheme: string,
  offset: number,
  source: string,
): string {
  const publicMissingCredentialPhrase =
    match.toLowerCase() === "bearer token" &&
    source.slice(Math.max(0, offset - "missing ".length), offset).toLowerCase() ===
      "missing ";
  return publicMissingCredentialPhrase ? match : `${scheme} [redacted]`;
}

export interface ScrubOptions {
  maxDepth?: number;
  maxItems?: number;
  maxLength?: number;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Persistable diagnostic token for an untrusted value. Every value is reduced
 * to a one-way digest. A string that merely looks like a machine code is still
 * untrusted: names and company identifiers can have the same shape.
 */
export function diagnosticErrorToken(value: unknown): string {
  const candidate = value instanceof Error ? value.message : value;
  const text =
    typeof candidate === "string"
      ? candidate
      : candidate === undefined
        ? "undefined"
        : candidate === null
          ? "null"
          : String(candidate);
  return `ERROR_TEXT_SHA256:${sha256(text)}`;
}

/** Safe structured substitute for logging an unknown exception object. */
export function diagnosticErrorSummary(value: unknown): {
  name: string;
  codeDigest?: string;
  messageDigest: string;
} {
  if (value instanceof Error) {
    const candidateCode = (value as Error & { code?: unknown }).code;
    return {
      name: SAFE_ERROR_NAMES.has(value.name) ? value.name : "Error",
      ...(candidateCode === undefined
        ? {}
        : {
            codeDigest: sha256(
              typeof candidateCode === "string"
                ? candidateCode
                : String(candidateCode),
            ),
          }),
      messageDigest: sha256(value.message),
    };
  }
  return {
    name: "UnknownError",
    messageDigest: sha256(
      value === undefined
        ? "undefined"
        : value === null
          ? "null"
          : String(value),
    ),
  };
}

function sanitizeUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.username = "";
    url.password = "";
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_QUERY_KEY.test(key)) {
        url.searchParams.set(key, "[redacted]");
      } else {
        const values = url.searchParams.getAll(key);
        url.searchParams.delete(key);
        for (const value of values) {
          url.searchParams.append(key, scrubSensitiveText(value));
        }
      }
    }
    return url.toString();
  } catch {
    return "[redacted-url]";
  }
}

export function scrubSensitiveText(
  text: string,
  options: Pick<ScrubOptions, "maxLength"> = {},
): string {
  const maxLength = Math.max(32, options.maxLength ?? 4_000);
  const scrubbed = String(text)
    .replace(URL_RE, sanitizeUrl)
    .replace(BEARER_RE, redactBearerCredential)
    .replace(JWT_RE, "[redacted-jwt]")
    .replace(SECRET_ASSIGNMENT_RE, "$1$2[redacted]")
    .replace(EMAIL_RE, "[redacted-email]")
    .replace(PHONE_RE, "[redacted-phone]");
  return scrubbed.length <= maxLength
    ? scrubbed
    : `${scrubbed.slice(0, Math.max(0, maxLength - 12))}[truncated]`;
}

function normalizedObjectKey(key: string): string {
  return key.replace(/[-_\s]/g, "");
}

export function scrubSensitiveData(
  value: unknown,
  options: ScrubOptions = {},
): unknown {
  const maxDepth = Math.max(1, options.maxDepth ?? 8);
  const maxItems = Math.max(1, options.maxItems ?? 100);
  const seen = new WeakSet<object>();

  const visit = (current: unknown, depth: number): unknown => {
    if (typeof current === "string") {
      return scrubSensitiveText(current, options);
    }
    if (
      current === null ||
      typeof current === "number" ||
      typeof current === "boolean" ||
      typeof current === "undefined"
    ) {
      return current;
    }
    if (typeof current === "bigint") return current.toString();
    if (typeof current === "symbol" || typeof current === "function") {
      return `[${typeof current}]`;
    }
    if (typeof current !== "object") return "[unknown]";
    if (depth >= maxDepth) return "[max-depth]";
    if (current instanceof Date) return current.toISOString();
    if (seen.has(current)) return "[circular]";
    seen.add(current);

    if (current instanceof Error) {
      return {
        ...diagnosticErrorSummary(current),
        ...(current.cause === undefined
          ? {}
          : { cause: visit(current.cause, depth + 1) }),
      };
    }
    if (Array.isArray(current)) {
      return current.slice(0, maxItems).map((item) => visit(item, depth + 1));
    }

    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(current).slice(0, maxItems)) {
      output[key] = SENSITIVE_OBJECT_KEY.test(normalizedObjectKey(key))
        ? "[redacted]"
        : visit(item, depth + 1);
    }
    return output;
  };

  return visit(value, 0);
}
