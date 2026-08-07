import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function activeValue(source: string, name: string): string | undefined {
  const prefix = `${name}=`;
  return source
    .split(/\r?\n/u)
    .find((line) => line.startsWith(prefix))
    ?.slice(prefix.length);
}

describe('checked-in auth environment template', () => {
  it('keeps the development token verifier disabled and grants no default all-scope admin role', () => {
    const source = readFileSync(resolve(__dirname, '../../.env.example'), 'utf8');

    expect(activeValue(source, 'AUTH_ALLOW_DEV_TOKENS')).toBe('false');
    expect(activeValue(source, 'AUTH_ROLE_SCOPE_MAP')).toBe('{"local.reader":["acquisition:read"]}');
    expect(source).not.toContain('"local.admin"');
  });
});
