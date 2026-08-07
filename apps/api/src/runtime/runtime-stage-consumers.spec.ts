import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SOURCES = [
  '../auth/auth.module.ts',
  '../auth/jwks-token-verifier.ts',
  '../model-gateway/model-gateway.module.ts',
  '../site-builder/storage.service.ts',
  '../compliance/data-rights.context.ts',
  '../site-builder/site-release.service.ts',
] as const;

describe('runtime safety consumer wiring', () => {
  it.each(SOURCES)(
    '%s does not recalculate stage from mutable NODE_ENV',
    (relativePath) => {
      const source = readFileSync(
        resolve(process.cwd(), 'src/runtime', relativePath),
        'utf8',
      );
      expect(source).not.toMatch(/process\.env\.NODE_ENV|env\.NODE_ENV/u);
    },
  );

  it('resolves the worker process snapshot before any external client or DB construction', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/temporal/worker.ts'),
      'utf8',
    );
    const snapshotIndex = source.indexOf(
      'resolveRuntimeProcessSnapshot(process.env)',
    );
    const firstExternalSideEffect = Math.min(
      ...[
        'new PrismaService(',
        'new StorageService(',
        'NativeConnection.connect(',
        'buildGatewayProvider(',
      ]
        .map((needle) => source.indexOf(needle))
        .filter((index) => index >= 0),
    );
    expect(snapshotIndex).toBeGreaterThan(-1);
    expect(snapshotIndex).toBeLessThan(firstExternalSideEffect);
    expect(source.match(/resolveRuntimeProcessSnapshot\(process\.env\)/gu)).toHaveLength(
      1,
    );
  });
});
