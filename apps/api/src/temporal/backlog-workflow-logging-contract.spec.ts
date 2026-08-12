import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const source = readFileSync(fileURLToPath(new URL('./backlog.workflow.ts', import.meta.url)), 'utf8');

describe('backlog workflow logging contract', () => {
  it('never serializes the caught error object into Temporal workflow history', () => {
    expect(source).toContain("safeTemporalErrorCode(error, 'ACQUISITION_ACTIVITY_FAILED')");
    expect(source).not.toMatch(/log\.warn\([^;]+\berr\s*[,}]\s*\)/s);
  });
});
