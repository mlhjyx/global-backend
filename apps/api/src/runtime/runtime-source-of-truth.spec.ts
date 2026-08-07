import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SOURCE_ROOT = resolve(__dirname, '..');

describe('runtime admission source of truth', () => {
  it('does not retain parallel auth or deployment-stage admission implementations', () => {
    expect(
      existsSync(resolve(SOURCE_ROOT, 'auth/auth-runtime-admission.ts')),
    ).toBe(false);
    expect(
      existsSync(resolve(SOURCE_ROOT, 'common/deployment-stage.ts')),
    ).toBe(false);
  });

  it('makes auth providers consume the immutable runtime snapshot', () => {
    const authModule = readFileSync(
      resolve(SOURCE_ROOT, 'auth/auth.module.ts'),
      'utf8',
    );

    expect(authModule).toContain('RuntimeIdentityService');
    expect(authModule).not.toContain('process.env');
    expect(authModule).not.toContain('auth-runtime-admission');
  });
});
