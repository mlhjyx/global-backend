import { describe, expect, it } from 'vitest';
import { JwksTokenVerifier } from './jwks-token-verifier';
import {
  createRuntimeRolesToScopesPolicy,
  createTokenVerifier,
} from './auth.module';
import { UnavailableTokenVerifier } from './token-verifier';

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
  it.each([
    ['development loopback', developmentEnv()],
    ['development loopback with the retired opt-in', developmentEnv({ AUTH_ALLOW_DEV_TOKENS: 'true' })],
    ['development non-loopback', developmentEnv({ API_BIND_HOST: '192.0.2.10', AUTH_ALLOW_DEV_TOKENS: 'true' })],
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
  ])('boots a fail-closed unavailable verifier for %s', async (_case, env) => {
    const verifier = createTokenVerifier(env);
    expect(verifier).toBeInstanceOf(UnavailableTokenVerifier);
    await expect(verifier.verify('any-token')).rejects.toMatchObject({
      response: { error: { code: 'AUTH_VERIFICATION_UNAVAILABLE' } },
    });
  });

  it('uses the unavailable verifier for partial configuration instead of throwing or falling back', () => {
    expect(
      createTokenVerifier(
        developmentEnv({
          AUTH_ALLOW_DEV_TOKENS: 'true',
          AUTH_JWKS_URI: 'https://identity.example.test/jwks',
        }),
      ),
    ).toBeInstanceOf(UnavailableTokenVerifier);

    expect(
      createTokenVerifier(
        developmentEnv({
          AUTH_JWKS_URI: 'https://identity.example.test/jwks',
          AUTH_ISSUER: 'https://identity.example.test/',
        }),
      ),
    ).toBeInstanceOf(UnavailableTokenVerifier);
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

  it('boots a deny-all role policy for missing or malformed configuration', () => {
    expect(createRuntimeRolesToScopesPolicy(developmentEnv()).resolve(['operator'])).toEqual([]);
    expect(
      createRuntimeRolesToScopesPolicy(
        developmentEnv({ AUTH_ROLE_SCOPE_MAP_JSON: '{not-json' }),
      ).resolve(['operator']),
    ).toEqual([]);
  });

  it('uses the same strict configured role semantics when configuration is valid', () => {
    expect(
      createRuntimeRolesToScopesPolicy(
        developmentEnv({
          AUTH_ROLE_SCOPE_MAP_JSON: JSON.stringify({
            viewer: ['acquisition:read'],
          }),
        }),
      ).resolve(['viewer']),
    ).toEqual(['acquisition:read']);
  });
});
