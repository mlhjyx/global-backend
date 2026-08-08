import { describe, expect, it } from 'vitest';
import {
  diagnosticErrorSummary,
  diagnosticErrorToken,
  scrubSensitiveData,
  scrubSensitiveText,
} from './sensitive-data-scrubber';

describe('sensitive data scrubber', () => {
  it('preserves the stable missing-credential message while redacting real bearer values', () => {
    expect(scrubSensitiveText('missing bearer token')).toBe(
      'missing bearer token',
    );
    expect(scrubSensitiveText('Authorization: bearer token')).toBe(
      'Authorization: bearer [redacted]',
    );
    expect(scrubSensitiveText('Bearer opaque-credential')).toBe(
      'Bearer [redacted]',
    );
  });

  it('redacts credentials, bearer/JWT values, email, phone and URL secrets', () => {
    const input = [
      'contact=jane.doe@example.com',
      'phone=+49 30 1234 5678',
      'Authorization: Bearer abc.def.ghi',
      'postgresql://owner:db-secret@db.example/app',
      'https://user:pass@example.test/path?api_key=top-secret&ok=visible#private',
    ].join(' | ');
    const output = scrubSensitiveText(input);

    expect(output).toContain('[redacted-email]');
    expect(output).toContain('[redacted-phone]');
    expect(output).toContain('Bearer [redacted]');
    expect(output).not.toContain('jane.doe');
    expect(output).not.toContain('db-secret');
    expect(output).not.toContain('top-secret');
    expect(output).not.toContain('#private');
    expect(output).toContain('ok=visible');
  });

  it('recursively redacts sensitive keys without mutating the caller object', () => {
    const input = {
      errorCode: 'PROVIDER_TIMEOUT',
      authorization: 'Bearer secret-token',
      nested: {
        apiKey: 'secret-key',
        cookie: 'session=secret',
        message: 'mail jane@example.com',
      },
      amountMinor: 25,
    };
    const copy = structuredClone(input);
    const output = scrubSensitiveData(input) as Record<string, unknown>;

    expect(input).toEqual(copy);
    expect(output).toMatchObject({
      errorCode: 'PROVIDER_TIMEOUT',
      authorization: '[redacted]',
      amountMinor: 25,
    });
    expect(JSON.stringify(output)).not.toContain('secret-key');
    expect(JSON.stringify(output)).not.toContain('jane@example.com');
  });

  it('reduces Error values to digests, including nested causes', () => {
    const cyclic: Record<string, unknown> = {
      error: new Error('provider echoed Jane Doe and a private prompt', {
        cause: Object.assign(new Error('inner ACME account failure'), {
          code: 'ACME',
        }),
      }),
    };
    cyclic.self = cyclic;
    const output = scrubSensitiveData(cyclic, { maxDepth: 6 });
    const rendered = JSON.stringify(output);

    expect(rendered).toContain('messageDigest');
    expect(rendered).toContain('codeDigest');
    expect(rendered).not.toContain('Jane Doe');
    expect(rendered).not.toContain('private prompt');
    expect(rendered).not.toContain('ACME');
    expect(rendered).not.toContain('stack');
    expect(rendered).toContain('[circular]');
  });

  it('bounds output text instead of relying on post-hoc provider excerpt truncation', () => {
    const output = scrubSensitiveText(
      `prefix jane@example.com ${'x'.repeat(2_000)}`,
      { maxLength: 256 },
    );
    expect(output.length).toBeLessThanOrEqual(256);
    expect(output).not.toContain('jane@example.com');
  });

  it('normalizes non-JSON primitives, dates, error causes, and bounded collections', () => {
    const caused = new Error('outer token=secret', {
      cause: new Error('inner jane@example.com'),
    });
    const output = scrubSensitiveData(
      {
        bigint: 42n,
        symbol: Symbol('private'),
        functionValue: () => 'private',
        date: new Date('2026-08-07T00:00:00.000Z'),
        error: caused,
        list: [1, 2, 3],
      },
      { maxItems: 2 },
    ) as Record<string, unknown>;

    expect(output.bigint).toBe('42');
    // The object itself is bounded; exercise the remaining primitive branches
    // independently so their rendered values cannot expose implementation text.
    expect(scrubSensitiveData(Symbol('private'))).toBe('[symbol]');
    expect(scrubSensitiveData(() => 'private')).toBe('[function]');
    expect(scrubSensitiveData(new Date('2026-08-07T00:00:00.000Z'))).toBe(
      '2026-08-07T00:00:00.000Z',
    );
    const renderedError = JSON.stringify(scrubSensitiveData(caused));
    expect(renderedError).toContain('messageDigest');
    expect(renderedError).not.toContain('inner jane@example.com');
    expect(renderedError).not.toContain('outer token=secret');
    expect(
      scrubSensitiveData([1, 2, 3], { maxItems: 2 }),
    ).toEqual([1, 2]);
  });

  it('enforces max depth and minimum text bounds for unusual values', () => {
    const deep = { one: { two: { three: 'jane@example.com' } } };
    expect(scrubSensitiveData(deep, { maxDepth: 2 })).toEqual({
      one: { two: '[max-depth]' },
    });
    const bounded = scrubSensitiveText('x'.repeat(200), { maxLength: 1 });
    expect(bounded.length).toBeLessThanOrEqual(32);
    expect(bounded).toContain('[truncated]');
  });

  it('redacts normalized secret keys and malformed credential-like URLs', () => {
    const output = scrubSensitiveData({
      'client-secret': 'do-not-leak',
      proxy_authorization: 'Bearer do-not-leak',
      nested: 'postgresql://%zz:password@host/db',
    });
    const rendered = JSON.stringify(output);
    expect(rendered).not.toContain('do-not-leak');
    expect(rendered).not.toContain('password');
  });

  it('reduces every untrusted diagnostic value to an irreversible digest', () => {
    expect(diagnosticErrorToken('PROVIDER_TIMEOUT')).toMatch(
      /^ERROR_TEXT_SHA256:[0-9a-f]{64}$/,
    );
    expect(diagnosticErrorToken('ACME')).toMatch(
      /^ERROR_TEXT_SHA256:[0-9a-f]{64}$/,
    );
    const token = diagnosticErrorToken(
      'Provider response mentioned Jane Doe and a private prompt fragment',
    );
    expect(token).toMatch(/^ERROR_TEXT_SHA256:[0-9a-f]{64}$/);
    expect(token).not.toContain('Jane Doe');

    const summary = diagnosticErrorSummary(
      new Error('Contact Jane Doe failed during lawful-basis processing'),
    );
    const rendered = JSON.stringify(summary);
    expect(summary).toMatchObject({ name: 'Error' });
    expect(rendered).toMatch(/messageDigest/);
    expect(rendered).not.toContain('Jane Doe');
    expect(rendered).not.toContain('lawful-basis');

    const coded = Object.assign(new Error('private detail'), {
      name: 'ProviderSpecificJaneDoeError',
      code: 'PROVIDER_UNAVAILABLE',
    });
    expect(diagnosticErrorToken(coded)).toMatch(/^ERROR_TEXT_SHA256:/);
    expect(diagnosticErrorSummary(coded)).toMatchObject({
      name: 'Error',
      codeDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(JSON.stringify(diagnosticErrorSummary(coded))).not.toContain(
      'PROVIDER_UNAVAILABLE',
    );
    for (const value of [undefined, null, { private: 'Jane Doe' }]) {
      const unknown = diagnosticErrorSummary(value);
      expect(unknown.name).toBe('UnknownError');
      expect(JSON.stringify(unknown)).not.toContain('Jane Doe');
    }
    expect(diagnosticErrorToken(undefined)).toMatch(/^ERROR_TEXT_SHA256:/);
    expect(diagnosticErrorToken(null)).toMatch(/^ERROR_TEXT_SHA256:/);
    expect(diagnosticErrorToken({ private: true })).toMatch(
      /^ERROR_TEXT_SHA256:/,
    );
    expect(scrubSensitiveText('https://[invalid')).toBe('[redacted-url]');
  });
});
