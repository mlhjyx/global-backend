import { ConsoleLogger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SensitiveLogger } from './sensitive-logger';

describe('SensitiveLogger', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('digests arbitrary Error messages, stacks and code values at the logger boundary', () => {
    const error = Object.assign(
      new Error('Jane Doe appeared in a provider prompt fragment'),
      { code: 'ACME' },
    );
    const delegate = vi
      .spyOn(ConsoleLogger.prototype, 'error')
      .mockImplementation(() => undefined);

    new SensitiveLogger().error(error);

    expect(delegate).toHaveBeenCalledTimes(1);
    const rendered = JSON.stringify(delegate.mock.calls[0]);
    expect(rendered).toContain('messageDigest');
    expect(rendered).toContain('codeDigest');
    expect(rendered).not.toContain('Jane Doe');
    expect(rendered).not.toContain('prompt fragment');
    expect(rendered).not.toContain('ACME');
    expect(rendered).not.toContain('stack');
  });
});
