import { describe, expect, it } from 'vitest';
import { resolveRuntimeProcessSnapshot } from '../runtime/runtime-admission';
import { createTokenVerifier } from './auth.module';
import { DevTokenVerifier } from './dev-token-verifier';
import { JwksTokenVerifier } from './jwks-token-verifier';

describe('AuthModule canonical runtime admission', () => {
  it('uses the development verifier only when the canonical stage is development', () => {
    const runtime = resolveRuntimeProcessSnapshot({
      DEPLOYMENT_STAGE: 'development',
      NODE_ENV: 'test',
    });
    expect(createTokenVerifier(runtime)).toBeInstanceOf(DevTokenVerifier);
  });

  it('uses the frozen JWKS configuration for an admitted pilot', () => {
    const runtime = resolveRuntimeProcessSnapshot({
      DEPLOYMENT_STAGE: 'pilot',
      NODE_ENV: 'production',
      AUTH_JWKS_URI: 'https://identity.example.test/jwks.json',
      AUTH_ISSUER: 'https://identity.example.test',
      MODEL_GATEWAY_URL: 'https://models.example.test/v1',
      MODEL_GATEWAY_KEY: 'test-key',
      S3_ACCESS_KEY: 'test-access',
      S3_SECRET_KEY: 'test-secret',
      DATA_PROCESSOR_JURISDICTION: 'EU',
      SITE_RENDERER_BUILD_ID: 'site-renderer@1.0.0+sha.abc123',
    });
    expect(createTokenVerifier(runtime)).toBeInstanceOf(JwksTokenVerifier);
  });
});
