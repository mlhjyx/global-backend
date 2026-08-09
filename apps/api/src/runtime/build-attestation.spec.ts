import { mkdtemp, mkdir, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  computeArtifactDigest,
  generateBuildAttestation,
  loadBuildIdentity,
  parseBuildAttestation,
} from './build-attestation';

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'global-build-attestation-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

const validAttestation = {
  schema_version: 'global-runtime-build-attestation/v1',
  build_sha: 'a'.repeat(40),
  built_at: '2026-08-10T00:00:00.000Z',
  artifact_digest: `sha256:${'b'.repeat(64)}`,
  migration_revision: '20260809010101_runtime_receipts',
  schema_digest: `sha256:${'c'.repeat(64)}`,
};

describe('build attestation', () => {
  it('accepts only the closed, non-sensitive v1 identity contract', () => {
    expect(parseBuildAttestation(validAttestation)).toEqual(validAttestation);
    expect(() =>
      parseBuildAttestation({ ...validAttestation, unexpected_field: 'must-not-pass' }),
    ).toThrow(
      /unexpected/i,
    );
    expect(() => parseBuildAttestation({ ...validAttestation, build_sha: 'dirty-tree' })).toThrow(
      /build_sha/i,
    );
    expect(() =>
      parseBuildAttestation({ ...validAttestation, artifact_digest: 'b'.repeat(64) }),
    ).toThrow(/artifact_digest/i);
  });

  it('allows an explicitly unattested development process but never pilot', async () => {
    const directory = await temporaryDirectory();
    const missing = join(directory, 'missing.json');

    await expect(loadBuildIdentity({ mode: 'development', path: missing })).resolves.toEqual({
      attested: false,
      schema_version: 'global-runtime-build-attestation/v1',
    });
    await expect(loadBuildIdentity({ mode: 'pilot', path: missing })).rejects.toThrow(
      /attestation.*required/i,
    );
  });

  it('fails closed on malformed files and final-component symlinks', async () => {
    const directory = await temporaryDirectory();
    const target = join(directory, 'target.json');
    const link = join(directory, 'attestation.json');
    await writeFile(target, JSON.stringify(validAttestation));
    await symlink(target, link);

    await expect(loadBuildIdentity({ mode: 'pilot', path: link })).rejects.toThrow(/symlink|nofollow/i);
    await writeFile(target, '{broken');
    await expect(loadBuildIdentity({ mode: 'development', path: target })).rejects.toThrow(/JSON/i);
  });

  it('computes a deterministic artifact tree digest and excludes only the receipt itself', async () => {
    const directory = await temporaryDirectory();
    await mkdir(join(directory, 'runtime'));
    await writeFile(join(directory, 'main.js'), 'main');
    await writeFile(join(directory, 'runtime', 'component.js'), 'component');
    await writeFile(join(directory, 'build-attestation.json'), 'first receipt');
    const first = await computeArtifactDigest(directory);
    await writeFile(join(directory, 'build-attestation.json'), 'second receipt');
    expect(await computeArtifactDigest(directory)).toBe(first);
    await writeFile(join(directory, 'main.js'), 'changed');
    expect(await computeArtifactDigest(directory)).not.toBe(first);
  });

  it('binds the loaded receipt to the emitted artifact bytes', async () => {
    const directory = await temporaryDirectory();
    await writeFile(join(directory, 'main.js'), 'emitted main');
    const artifactDigest = await computeArtifactDigest(directory);
    const path = join(directory, 'build-attestation.json');
    await writeFile(
      path,
      JSON.stringify({ ...validAttestation, artifact_digest: artifactDigest }),
    );

    await expect(loadBuildIdentity({ mode: 'pilot', path })).resolves.toMatchObject({
      attested: true,
      artifact_digest: artifactDigest,
    });
    await writeFile(join(directory, 'main.js'), 'different emitted main');
    await expect(loadBuildIdentity({ mode: 'pilot', path })).rejects.toThrow(
      /artifact.*digest.*mismatch/i,
    );
  });

  it('generates an atomic receipt only from explicit build inputs and current schema bytes', async () => {
    const directory = await temporaryDirectory();
    const distRoot = join(directory, 'dist');
    const migrationsRoot = join(directory, 'migrations');
    const schemaPath = join(directory, 'schema.prisma');
    await mkdir(distRoot);
    await mkdir(join(migrationsRoot, '20260809010101_runtime_receipts'), { recursive: true });
    await writeFile(join(distRoot, 'main.js'), 'compiled application');
    await writeFile(schemaPath, 'model RuntimeReceipt {}');
    await writeFile(
      join(migrationsRoot, '20260809010101_runtime_receipts', 'migration.sql'),
      'SELECT 1;',
    );

    await expect(
      generateBuildAttestation({
        distRoot,
        buildSha: '',
        builtAt: validAttestation.built_at,
        schemaPath,
        migrationsRoot,
      }),
    ).rejects.toThrow(/build_sha/i);

    const generated = await generateBuildAttestation({
      distRoot,
      buildSha: validAttestation.build_sha,
      builtAt: validAttestation.built_at,
      schemaPath,
      migrationsRoot,
    });
    expect(generated).toMatchObject({
      build_sha: validAttestation.build_sha,
      migration_revision: '20260809010101_runtime_receipts',
    });
    await expect(
      loadBuildIdentity({ mode: 'pilot', path: join(distRoot, 'build-attestation.json') }),
    ).resolves.toMatchObject({ attested: true, build_sha: validAttestation.build_sha });
    expect((await readdir(distRoot)).filter((name) => name.includes('.tmp-'))).toEqual([]);
  });
});
