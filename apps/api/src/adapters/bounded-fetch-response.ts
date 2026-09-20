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
