import {
  brotliDecompressSync,
  gunzipSync,
  inflateRawSync,
  inflateSync,
} from "node:zlib";
import { EgressBlockedError } from "./url-guard";

const MAX_CONTENT_ENCODING_LAYERS = 2;

function tooLarge(code: string): never {
  throw new Error(code);
}

/** Reads a WHATWG Fetch response with a hard pre-parse byte ceiling. */
export async function readFetchResponseBodyBounded(
  response: Response,
  maximumBytes: number,
  tooLargeCode: string,
): Promise<Buffer> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    return tooLarge(tooLargeCode);
  }
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    if (!/^(?:0|[1-9][0-9]*)$/.test(declared)) {
      return tooLarge(tooLargeCode);
    }
    const declaredBytes = Number(declared);
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes > maximumBytes) {
      return tooLarge(tooLargeCode);
    }
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let observedBytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      observedBytes += next.value.byteLength;
      if (observedBytes > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        return tooLarge(tooLargeCode);
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, observedBytes);
}

export function decodeJsonBytes<T>(
  bytes: Uint8Array,
  invalidCode: string,
): T {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(text) as T;
  } catch {
    throw new Error(invalidCode);
  }
}

function extractDeclaredCharset(
  body: Buffer,
  contentType: string | null | undefined,
): string | null {
  const fromHeader = /charset=["']?([\w-]+)/i.exec(contentType ?? "")?.[1];
  if (fromHeader) return fromHeader;
  const head = body.subarray(0, 2_048).toString("latin1");
  return (
    /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1] ??
    /<meta[^>]+content=["'][^"']*charset=([\w-]+)/i.exec(head)?.[1] ??
    /<\?xml[^>]+encoding=["']([\w-]+)["']/i.exec(head)?.[1] ??
    null
  );
}

/**
 * Decode an HTTP text payload honoring Content-Type / HTML meta / XML encoding
 * declarations (e.g. windows-1252, iso-8859-1, gbk, shift_jis, windows-1256).
 *
 * When `strictWithoutDeclaredCharset` is true (used by http.get artifacts),
 * payloads without a non-UTF8 charset declaration still require strict UTF-8 so
 * binary blobs fail closed instead of silently decoding as Latin-1.
 */
export function decodeHttpTextWithCharset(
  body: Buffer,
  contentType: string | null | undefined,
  options?: { strictWithoutDeclaredCharset?: boolean },
): string {
  const label = extractDeclaredCharset(body, contentType);
  if (label && !/^utf-?8$/i.test(label)) {
    try {
      return new TextDecoder(label, { fatal: false }).decode(body);
    } catch {
      // Unrecognized charset label: fall through to UTF-8 path.
    }
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch (error) {
    if (options?.strictWithoutDeclaredCharset) {
      throw error;
    }
    return new TextDecoder("windows-1252", { fatal: false }).decode(body);
  }
}

function isTooLargeZlibError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return (
    error instanceof RangeError ||
    code === "ERR_BUFFER_TOO_LARGE" ||
    code === "ERR_OUT_OF_RANGE"
  );
}

function decodeSingleEncoding(
  buf: Buffer,
  encoding: string,
  maxBytes: number,
): Buffer {
  if (encoding === "identity" || encoding === "") return buf;
  try {
    if (encoding === "gzip" || encoding === "x-gzip") {
      return gunzipSync(buf, { maxOutputLength: maxBytes });
    }
    if (encoding === "deflate") {
      try {
        return inflateSync(buf, { maxOutputLength: maxBytes });
      } catch (err) {
        if (isTooLargeZlibError(err)) throw err;
        return inflateRawSync(buf, { maxOutputLength: maxBytes });
      }
    }
    if (encoding === "br") {
      return brotliDecompressSync(buf, { maxOutputLength: maxBytes });
    }
  } catch (error) {
    if (isTooLargeZlibError(error)) {
      throw new EgressBlockedError("response_too_large");
    }
    throw new EgressBlockedError("invalid_content_encoding");
  }
  throw new EgressBlockedError("invalid_content_encoding");
}

/**
 * Bounded Content-Encoding decoder for gzip / deflate / br responses.
 * Rejects zip bombs exceeding `maxBytes` and excessive encoding chains.
 */
export function decompressHttpBody(
  body: Buffer,
  contentEncoding: string | undefined,
  maxBytes: number,
): Buffer {
  if (!contentEncoding || body.length === 0) return body;
  const encodings = contentEncoding
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 0 && part !== "identity");
  if (encodings.length === 0) return body;
  if (encodings.length > MAX_CONTENT_ENCODING_LAYERS) {
    throw new EgressBlockedError("invalid_content_encoding");
  }
  let current = body;
  for (let i = encodings.length - 1; i >= 0; i -= 1) {
    current = decodeSingleEncoding(current, encodings[i]!, maxBytes);
    if (current.length > maxBytes) {
      throw new EgressBlockedError("response_too_large");
    }
  }
  return current;
}
