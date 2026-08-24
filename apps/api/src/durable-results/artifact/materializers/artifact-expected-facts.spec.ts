import { describe, expect, it } from 'vitest';
import { parseArtifactExpectedFacts } from '../artifact-expected-facts';

describe('parseArtifactExpectedFacts', () => {
  it.each([
    ['http-get/v1', {
      status: 200,
      ok: true,
      sanitizedUrl: 'https://example.com/final',
      blocked: null,
    }],
    ['crawl4ai-fetch/v1', {
      sanitizedUrl: 'https://example.com/',
      contentHash: 'a'.repeat(24),
    }],
    ['crawl4ai-render/v1', {
      sanitizedUrl: 'https://example.com/',
      blocked: false,
    }],
  ] as const)('returns a frozen closed %s snapshot', (schema, facts) => {
    const parsed = parseArtifactExpectedFacts(schema, facts);
    expect(parsed).toEqual(facts);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(parsed).not.toBe(facts);
  });

  it.each([
    ['missing facts', 'http-get/v1', undefined],
    ['missing field', 'http-get/v1', { status: 200, ok: true, blocked: null }],
    ['extra header', 'http-get/v1', {
      status: 200, ok: true, sanitizedUrl: 'https://example.com/', blocked: null,
      headers: { authorization: 'forbidden' },
    }],
    ['raw PII URL', 'crawl4ai-fetch/v1', {
      sanitizedUrl: 'https://example.com/person@example.com', contentHash: 'a'.repeat(24),
    }],
    ['query-bearing URL', 'crawl4ai-fetch/v1', {
      sanitizedUrl: 'https://example.com/?page=1', contentHash: 'a'.repeat(24),
    }],
    ['uppercase host URL', 'crawl4ai-fetch/v1', {
      sanitizedUrl: 'https://EXAMPLE.com/', contentHash: 'a'.repeat(24),
    }],
    ['missing canonical slash URL', 'crawl4ai-fetch/v1', {
      sanitizedUrl: 'https://example.com', contentHash: 'a'.repeat(24),
    }],
    ['invalid percent URL', 'crawl4ai-fetch/v1', {
      sanitizedUrl: 'https://%zz/', contentHash: 'a'.repeat(24),
    }],
    ['numeric-only host URL', 'crawl4ai-fetch/v1', {
      sanitizedUrl: 'https://127.0.0.1/', contentHash: 'a'.repeat(24),
    }],
    ['digit-heavy path URL', 'crawl4ai-fetch/v1', {
      sanitizedUrl: 'https://example.com/2026/08/22/123', contentHash: 'a'.repeat(24),
    }],
    ['wrong hash', 'crawl4ai-fetch/v1', {
      sanitizedUrl: 'https://example.com/', contentHash: 'A'.repeat(24),
    }],
    ['invalid status type', 'http-get/v1', {
      status: '200', ok: true, sanitizedUrl: 'https://example.com/', blocked: null,
    }],
    ['invalid blocked code', 'http-get/v1', {
      status: 0, ok: false, sanitizedUrl: null, blocked: 'NOT SAFE',
    }],
    ['cross-schema facts', 'crawl4ai-render/v1', {
      status: 200, ok: true, sanitizedUrl: 'https://example.com/', blocked: null,
    }],
    ['proxy', 'http-get/v1', new Proxy({
      status: 200, ok: true, sanitizedUrl: 'https://example.com/', blocked: null,
    }, {})],
    ['accessor', 'http-get/v1', Object.defineProperties({}, {
      status: { enumerable: true, get: () => 200 },
      ok: { enumerable: true, value: true },
      sanitizedUrl: { enumerable: true, value: 'https://example.com/' },
      blocked: { enumerable: true, value: null },
    })],
  ] as const)('rejects %s with one bounded error', (_name, schema, facts) => {
    expect(() => parseArtifactExpectedFacts(schema, facts)).toThrow(
      'GENERIC_OPERATION_ARTIFACT_INVALID',
    );
  });

  it('accepts only the existing HTTP blocked contract as a blocked fact', () => {
    expect(parseArtifactExpectedFacts('http-get/v1', {
      status: 0,
      ok: false,
      sanitizedUrl: null,
      blocked: 'non_global_address',
    })).toEqual({
      status: 0,
      ok: false,
      sanitizedUrl: null,
      blocked: 'non_global_address',
    });
    expect(() => parseArtifactExpectedFacts('http-get/v1', {
      status: 0,
      ok: false,
      sanitizedUrl: 'https://example.com/',
      blocked: 'non_global_address',
    })).toThrow('GENERIC_OPERATION_ARTIFACT_INVALID');
  });

  it('rejects an unapproved schema even when the object resembles valid facts', () => {
    expect(() => parseArtifactExpectedFacts(
      'caller-selected/v1' as 'http-get/v1',
      {
        status: 200,
        ok: true,
        sanitizedUrl: 'https://example.com/',
        blocked: null,
      },
    )).toThrow('GENERIC_OPERATION_ARTIFACT_INVALID');
  });
});
