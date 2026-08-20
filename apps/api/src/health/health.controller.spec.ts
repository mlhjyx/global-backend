import { describe, expect, it, vi } from 'vitest';
import { HealthController } from './health.controller';

function controller(options: { readiness?: object; build?: object } = {}) {
  const prisma = { $queryRaw: vi.fn(async () => [{ ok: 1 }]) };
  const readiness = {
    check: vi.fn(async () => options.readiness ?? { status: 'ready', components: {} }),
  };
  const buildIdentity = {
    current: vi.fn(() =>
      options.build ?? {
        attested: false,
        schema_version: 'global-runtime-release-identity/v1',
        code: 'TEST_RUNTIME_UNATTESTED',
      },
    ),
  };
  return {
    instance: new HealthController(prisma as never, readiness as never, buildIdentity as never),
    prisma,
    readiness,
    buildIdentity,
  };
}

describe('HealthController compatibility and layered probes', () => {
  it('keeps the legacy liveness response and makes /live dependency-free', () => {
    const fixture = controller();
    expect(fixture.instance.check()).toMatchObject({ status: 'ok', service: 'global-api' });
    expect(fixture.instance.live()).toMatchObject({ status: 'ok', service: 'global-api' });
    expect(fixture.prisma.$queryRaw).not.toHaveBeenCalled();
    expect(fixture.readiness.check).not.toHaveBeenCalled();
  });

  it('keeps the legacy DB probe contract', async () => {
    const fixture = controller();
    await expect(fixture.instance.db()).resolves.toEqual({ db: 'ok' });
    expect(fixture.prisma.$queryRaw).toHaveBeenCalledOnce();
  });

  it('returns the exact non-sensitive build identity', () => {
    const build = {
      attested: true,
      schema_version: 'global-runtime-release-identity/v1',
      build_sha: 'a'.repeat(40),
      built_at: '2026-08-10T00:00:00.000Z',
      artifact_digest: `sha256:${'b'.repeat(64)}`,
      artifact_manifest_digest: `sha256:${'d'.repeat(64)}`,
      sbom_digest: `sha256:${'e'.repeat(64)}`,
      source_tree_digest: `sha256:${'f'.repeat(64)}`,
      renderer_digest: `sha256:${'1'.repeat(64)}`,
      image_digest: `sha256:${'2'.repeat(64)}`,
      migration_revision: '20260809010101_runtime_receipts',
      schema_digest: `sha256:${'c'.repeat(64)}`,
    };
    const fixture = controller({ build });
    expect(fixture.instance.build()).toEqual({ status: 'ok', service: 'global-api', build });
  });

  it('sets 503 for not_ready without changing the report body', async () => {
    const report = { status: 'not_ready', service: 'global-api', components: {} };
    const fixture = controller({ readiness: report });
    const response = { status: vi.fn(() => response) };
    await expect(fixture.instance.ready(response as never)).resolves.toBe(report);
    expect(response.status).toHaveBeenCalledWith(503);
  });
});
