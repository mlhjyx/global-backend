import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { computeArtifactDigest } from './build-attestation';
import {
  loadRuntimeReleaseIdentity,
  RUNTIME_RELEASE_IDENTITY_SCHEMA,
} from './runtime-release-identity';

const temporaryDirectories: string[] = [];

async function fixtureRoot(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'global-release-identity-'));
  temporaryDirectories.push(directory);
  await writeFile(join(directory, 'main.js'), 'compiled runtime');
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function writeAttestation(directory: string): Promise<void> {
  await writeFile(
    join(directory, 'build-attestation.json'),
    JSON.stringify({
      schema_version: 'global-runtime-build-attestation/v1',
      build_sha: 'a'.repeat(40),
      built_at: '2026-08-16T00:00:00.000Z',
      artifact_digest: await computeArtifactDigest(directory),
      artifact_manifest_digest: `sha256:${'c'.repeat(64)}`,
      sbom_digest: `sha256:${'d'.repeat(64)}`,
      source_tree_digest: `sha256:${'e'.repeat(64)}`,
      renderer_digest: `sha256:${'f'.repeat(64)}`,
      migration_revision: '20260816000000_runtime_process_lease',
      schema_digest: `sha256:${'b'.repeat(64)}`,
    }),
  );
}

describe('loadRuntimeReleaseIdentity', () => {
  it('requires an attestation and canonical image digest in managed development', async () => {
    const directory = await fixtureRoot();

    await expect(
      loadRuntimeReleaseIdentity({
        mode: 'development',
        artifactRoot: directory,
        env: {},
      }),
    ).resolves.toEqual({
      attested: false,
      schema_version: RUNTIME_RELEASE_IDENTITY_SCHEMA,
      code: 'BUILD_ATTESTATION_REQUIRED',
    });

    await writeAttestation(directory);
    await expect(
      loadRuntimeReleaseIdentity({
        mode: 'development',
        artifactRoot: directory,
        env: {},
      }),
    ).resolves.toEqual({
      attested: false,
      schema_version: RUNTIME_RELEASE_IDENTITY_SCHEMA,
      code: 'IMAGE_REFERENCE_REQUIRED',
    });
  });

  it('binds a valid build receipt to the exact immutable OCI digest', async () => {
    const directory = await fixtureRoot();
    await writeAttestation(directory);

    await expect(
      loadRuntimeReleaseIdentity({
        mode: 'production',
        artifactRoot: directory,
        env: {
          RUNTIME_IMAGE_REFERENCE: `registry.example/global/backend@sha256:${'c'.repeat(64)}`,
        },
      }),
    ).resolves.toMatchObject({
      attested: true,
      schema_version: RUNTIME_RELEASE_IDENTITY_SCHEMA,
      build_sha: 'a'.repeat(40),
      image_digest: `sha256:${'c'.repeat(64)}`,
      migration_revision: '20260816000000_runtime_process_lease',
    });
  });

  it('keeps source-watch and test processes explicitly outside managed readiness', async () => {
    const directory = await fixtureRoot();

    await expect(
      loadRuntimeReleaseIdentity({
        mode: 'development',
        artifactRoot: directory,
        env: { RUNTIME_EXECUTION_PROFILE: 'source-watch' },
      }),
    ).resolves.toEqual({
      attested: false,
      schema_version: RUNTIME_RELEASE_IDENTITY_SCHEMA,
      code: 'SOURCE_WATCH_NOT_MANAGED',
    });
    await expect(
      loadRuntimeReleaseIdentity({
        mode: 'test',
        artifactRoot: directory,
        env: {},
      }),
    ).resolves.toEqual({
      attested: false,
      schema_version: RUNTIME_RELEASE_IDENTITY_SCHEMA,
      code: 'TEST_RUNTIME_UNATTESTED',
    });
  });

  it('returns a bounded failure code instead of exposing filesystem errors', async () => {
    const directory = await fixtureRoot();
    await writeFile(join(directory, 'build-attestation.json'), '{malformed');

    const identity = await loadRuntimeReleaseIdentity({
      mode: 'pilot',
      artifactRoot: directory,
      env: {
        RUNTIME_IMAGE_REFERENCE: `registry.example/global/backend@sha256:${'d'.repeat(64)}`,
      },
    });
    expect(identity).toEqual({
      attested: false,
      schema_version: RUNTIME_RELEASE_IDENTITY_SCHEMA,
      code: 'BUILD_ATTESTATION_INVALID',
    });
    expect(JSON.stringify(identity)).not.toContain(directory);
  });

  it('rejects an unbound digest or mutable tag as the deployment image identity', async () => {
    const directory = await fixtureRoot();
    await writeAttestation(directory);

    for (const reference of [`sha256:${'d'.repeat(64)}`, 'registry.example/backend:latest']) {
      await expect(
        loadRuntimeReleaseIdentity({
          mode: 'production',
          artifactRoot: directory,
          env: { RUNTIME_IMAGE_REFERENCE: reference },
        }),
      ).resolves.toMatchObject({
        attested: false,
        code: 'IMAGE_REFERENCE_INVALID',
      });
    }
  });
});
