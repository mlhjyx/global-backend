import { describe, expect, it } from 'vitest';
import {
  scrubSensitiveData,
  scrubSensitiveText,
} from './sensitive-data-scrubber';

describe('sensitive data scrubber', () => {
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

  it('handles Error values, cycles and excessive depth without leaking data', () => {
    const cyclic: Record<string, unknown> = {
      error: new Error('provider echoed jane@example.com with token=secret'),
    };
    cyclic.self = cyclic;
    const output = scrubSensitiveData(cyclic, { maxDepth: 4 });
    const rendered = JSON.stringify(output);

    expect(rendered).toContain('[redacted-email]');
    expect(rendered).not.toContain('secret');
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
});
