import { describe, expect, it } from 'vitest';
import { DevTokenVerifier } from './dev-token-verifier';
import { JwksTokenVerifier } from './jwks-token-verifier';
import { createTokenVerifier } from './auth.module';

function developmentEnv(
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return {
    APP_ENVIRONMENT: 'development',
    NODE_ENV: 'development',
    API_BIND_HOST: '127.0.0.1',
    ...overrides,
  };
}

describe('AuthModule token verifier admission', () => {
  it('allows the dev verifier only with explicit development, opt-in and loopback', () => {
    expect(
      createTokenVerifier(
        developmentEnv({ AUTH_ALLOW_DEV_TOKENS: 'true' }),
      ),
    ).toBeInstanceOf(DevTokenVerifier);

    expect(
      createTokenVerifier(
        developmentEnv({
          API_BIND_HOST: '0:0:0:0:0:0:0:1',
          AUTH_ALLOW_DEV_TOKENS: 'true',
        }),
      ),
    ).toBeInstanceOf(DevTokenVerifier);
  });

  it.each([
    ['missing explicit opt-in', developmentEnv()],
    [
      'non-loopback bind',
      developmentEnv({
        API_BIND_HOST: '192.0.2.10',
        AUTH_ALLOW_DEV_TOKENS: 'true',
      }),
    ],
    [
      'test mode',
      {
        APP_ENVIRONMENT: 'test',
        NODE_ENV: 'test',
        API_BIND_HOST: '127.0.0.1',
        AUTH_ALLOW_DEV_TOKENS: 'true',
      },
    ],
    [
      'production mode',
      {
        APP_ENVIRONMENT: 'production',
        NODE_ENV: 'production',
        API_BIND_HOST: '127.0.0.1',
        AUTH_ALLOW_DEV_TOKENS: 'true',
      },
    ],
  ])('rejects dev tokens for %s', (_case, env) => {
    expect(() => createTokenVerifier(env)).toThrow(/DevTokenVerifier/);
  });

  it('rejects partial JWKS configuration instead of falling back to dev tokens', () => {
    expect(() =>
      createTokenVerifier(
        developmentEnv({
          AUTH_ALLOW_DEV_TOKENS: 'true',
          AUTH_JWKS_URI: 'https://identity.example.test/jwks',
        }),
      ),
    ).toThrow(/AUTH_JWKS_URI.*AUTH_ISSUER|AUTH_ISSUER.*AUTH_JWKS_URI/);

    expect(() =>
      createTokenVerifier(
        developmentEnv({
          AUTH_JWKS_URI: 'https://identity.example.test/jwks',
          AUTH_ISSUER: 'https://identity.example.test/',
        }),
      ),
    ).toThrow(/AUTH_AUDIENCE/);
  });

  it('selects the JWKS verifier without enabling the dev stub', () => {
    expect(
      createTokenVerifier(
        developmentEnv({
          AUTH_JWKS_URI: 'https://identity.example.test/jwks',
          AUTH_ISSUER: 'https://identity.example.test/',
          AUTH_AUDIENCE: 'global-api',
        }),
      ),
    ).toBeInstanceOf(JwksTokenVerifier);
  });
});
