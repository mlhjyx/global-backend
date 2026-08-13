import { createHash } from 'node:crypto';

/**
 * Reduce an untrusted provider diagnostic to an irreversible correlation token.
 * Provider response bodies can contain echoed queries, identifiers or personal data.
 */
export function diagnosticErrorToken(value: unknown): string {
  const tokenPattern = /^ERROR_TEXT_SHA256:[a-f0-9]{64}$/;
  let text = 'unprintable';
  try {
    const candidate = value instanceof Error ? value.message : value;
    text =
      typeof candidate === 'string'
        ? candidate
        : candidate === undefined
          ? 'undefined'
          : candidate === null
            ? 'null'
            : String(candidate);
  } catch {
    // Redaction must be total even when an arbitrary thrown value has a hostile
    // coercion hook. Never allow diagnostics to break the fail-closed path.
  }
  if (tokenPattern.test(text)) return text;
  return `ERROR_TEXT_SHA256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}
