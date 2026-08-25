import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MODEL_STRUCTURED_OUTPUT_WIRE_UPPER_BOUND } from '../model-gateway/model-execution-envelope';
import { SITE_BUILD_PAID_ACTIVITY_MAXIMUM_ATTEMPTS } from './site-build-execution-envelope';

const source = (path: string): string =>
  readFileSync(resolve(process.cwd(), 'src', path), 'utf8');

describe('Site Build technical budget execution-envelope integrity', () => {
  it('makes Router reservation and Quote consume one structured-output wire cap', () => {
    expect(MODEL_STRUCTURED_OUTPUT_WIRE_UPPER_BOUND).toBe(2);
    expect(source('model-gateway/router-model-gateway.ts')).toMatch(
      /baseCents\s*\*\s*MODEL_STRUCTURED_OUTPUT_WIRE_UPPER_BOUND/,
    );
    expect(source('site-builder/site-build-technical-budget-quote.ts')).toContain(
      'MODEL_STRUCTURED_OUTPUT_WIRE_UPPER_BOUND',
    );
    expect(source('site-builder/site-build-technical-budget-quote.ts')).not.toContain(
      'STRUCTURED_OUTPUT_WIRE_UPPER_BOUND = 2',
    );
  });

  it('makes Temporal retries and Quote consume one paid Activity attempt cap', () => {
    expect(SITE_BUILD_PAID_ACTIVITY_MAXIMUM_ATTEMPTS).toBe(2);
    expect(source('temporal/refurbish.workflow.ts')).toContain(
      'retry: { maximumAttempts: SITE_BUILD_PAID_ACTIVITY_MAXIMUM_ATTEMPTS }',
    );
    expect(source('site-builder/site-build-technical-budget-quote.ts')).toContain(
      'SITE_BUILD_PAID_ACTIVITY_MAXIMUM_ATTEMPTS',
    );
    expect(source('site-builder/site-build-technical-budget-quote.ts')).not.toContain(
      'TEMPORAL_ACTIVITY_ATTEMPT_UPPER_BOUND = 2',
    );
  });
});
