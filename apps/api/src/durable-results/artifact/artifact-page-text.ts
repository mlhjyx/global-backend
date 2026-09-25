import { scrubPiiKeepingTaxIds } from '../../site-builder/agents/pii';

/**
 * Page-text normalization for subject-bound crawl4ai.fetch artifacts
 * (G3 5.4): NFC, LF newlines, no control characters, collapsed whitespace,
 * emails/phones redacted while company tax ids are kept. The code-point cap
 * keeps any normalized page within the 300 kB artifact contract (≤4 bytes per
 * code point). First run and replay both use this exact function.
 */
export const MAX_ARTIFACT_PAGE_TEXT_CODE_POINTS = 75_000;

function withoutControlCharacters(text: string): string {
  return Array.from(text)
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint === 0x09 || codePoint === 0x0a || (codePoint >= 0x20 && codePoint !== 0x7f);
    })
    .join('');
}

export function normalizeArtifactPageText(rawText: string): string {
  const normalized = withoutControlCharacters(
    scrubPiiKeepingTaxIds(rawText).normalize('NFC').replace(/\r\n?/gu, '\n'),
  )
    .split('\n')
    .map((line) => line.replace(/[^\S\n]+/gu, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
  return Array.from(normalized).slice(0, MAX_ARTIFACT_PAGE_TEXT_CODE_POINTS).join('');
}
