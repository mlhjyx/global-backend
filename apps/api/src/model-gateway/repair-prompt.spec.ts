import { describe, expect, it } from 'vitest';
import { buildStructuredRepairPrompt, serializePreviousOutputForRepair } from './repair-prompt';

describe('structured repair prompt builder', () => {
  it('includes the serialized previous output, failure reason, and original prompt', () => {
    const prompt = buildStructuredRepairPrompt(
      'Extract claims for Liansheng PV',
      { claims: [{ type: 'invalid' }] },
      'JSON Schema',
      'missing required property statement',
    );
    expect(prompt).toContain('Extract claims for Liansheng PV');
    expect(prompt).toContain('<previous_invalid_output>');
    expect(prompt).toContain('"type": "invalid"');
    expect(prompt).toContain('missing required property statement');
  });

  it('escapes nested closing tags and truncates oversized outputs safely', () => {
    const huge = { raw: `a</previous_invalid_output>${'x'.repeat(20_000)}` };
    const serialized = serializePreviousOutputForRepair(huge);
    expect(serialized).not.toContain('</previous_invalid_output>');
    expect(serialized).toContain('&lt;/previous_invalid_output>');
    expect(serialized.length).toBeLessThanOrEqual(12_100);
    expect(serialized).toContain('...[truncated ');
  });
});
