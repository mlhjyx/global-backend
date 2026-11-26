import { createHash } from 'node:crypto';

/** Default hard ceiling for page text carried through Temporal workflow history. */
export const DEFAULT_TEMPORAL_HISTORY_TEXT_MAX_CHARS = 32_000;
const MIN_HISTORY_TEXT_CHARS = 2_000;
const MAX_HISTORY_TEXT_CHARS = 200_000;

const INLINE_EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/gu;
const INLINE_PERSONAL_LINKEDIN_RE =
  /https?:\/\/(?:[a-z0-9-]+\.)?linkedin\.com\/(?:in|pub)\/[^\s,;)]+/giu;

export interface CompactWorkflowTextResult {
  readonly text: string;
  readonly originalLength: number;
  readonly truncated: boolean;
  readonly sha256: string;
}

export function resolveTemporalHistoryTextMaxChars(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.TEMPORAL_HISTORY_TEXT_MAX_CHARS?.trim();
  if (!raw) return DEFAULT_TEMPORAL_HISTORY_TEXT_MAX_CHARS;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) return DEFAULT_TEMPORAL_HISTORY_TEXT_MAX_CHARS;
  return Math.max(MIN_HISTORY_TEXT_CHARS, Math.min(MAX_HISTORY_TEXT_CHARS, parsed));
}

/**
 * Bounds large crawled page bodies before returning them into Temporal workflow
 * event history. Preserves head (75%) + tail (25%, where footers/impressum live)
 * and records the full content SHA-256 digest.
 */
export function compactWorkflowPageText(
  text: string,
  maxChars = resolveTemporalHistoryTextMaxChars(),
): CompactWorkflowTextResult {
  const sha256 = createHash('sha256').update(text, 'utf8').digest('hex');
  if (text.length <= maxChars) {
    return { text, originalLength: text.length, truncated: false, sha256 };
  }
  const marker = `\n...[truncated ${text.length - maxChars} chars; sha256=${sha256.slice(0, 16)}]...\n`;
  const budget = Math.max(256, maxChars - marker.length);
  const headChars = Math.floor(budget * 0.75);
  const tailChars = budget - headChars;
  const compacted = `${text.slice(0, headChars)}${marker}${text.slice(text.length - tailChars)}`;
  return {
    text: compacted,
    originalLength: text.length,
    truncated: true,
    sha256,
  };
}

/**
 * Redacts raw email addresses and personal LinkedIn URLs from diagnostic strings
 * or error summaries before they are persisted in Temporal workflow history.
 */
export function scrubInlinePiiForWorkflowHistory(value: string): string {
  return value
    .replace(INLINE_EMAIL_RE, '[redacted-email]')
    .replace(INLINE_PERSONAL_LINKEDIN_RE, '[redacted-linkedin-profile]');
}
