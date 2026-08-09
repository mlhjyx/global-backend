import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
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
    const missing = join(directory, 'build-attestation.json');

    await expect(
      loadBuildIdentity({ mode: 'development', path: missing, artifactRoot: directory }),
    ).resolves.toEqual({
      attested: false,
      schema_version: 'global-runtime-build-attestation/v1',
    });
    await expect(
      loadBuildIdentity({ mode: 'pilot', path: missing, artifactRoot: directory }),
    ).rejects.toThrow(
      /attestation.*required/i,
    );
  });

  it('fails closed on malformed files and final-component symlinks', async () => {
    const directory = await temporaryDirectory();
    const target = join(directory, 'target.json');
    const link = join(directory, 'build-attestation.json');
    await writeFile(target, JSON.stringify(validAttestation));
    await symlink(target, link);

    await expect(
      loadBuildIdentity({ mode: 'pilot', path: link, artifactRoot: directory }),
    ).rejects.toThrow(/symlink|nofollow/i);
    await rm(link);
    await writeFile(link, '{broken');
    await expect(
      loadBuildIdentity({ mode: 'development', path: link, artifactRoot: directory }),
    ).rejects.toThrow(/JSON/i);
  });

  it('rejects a symlinked artifact root and uses descriptor-anchored directory traversal', async () => {
    const directory = await temporaryDirectory();
    const target = join(directory, 'target');
    const link = join(directory, 'dist-link');
    await mkdir(target);
    await writeFile(join(target, 'main.js'), 'compiled application');
    await symlink(target, link);

    await expect(computeArtifactDigest(link)).rejects.toThrow(/symlink|nofollow/i);
    const source = readFileSync(join(import.meta.dirname, 'build-attestation.ts'), 'utf8');
    expect(source).toContain('/proc/self/fd/');
    expect(source).toContain('fsConstants.O_RDONLY | fsConstants.O_DIRECTORY');
    expect(source).toContain('flags | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK');
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

    await expect(
      loadBuildIdentity({ mode: 'pilot', path, artifactRoot: directory }),
    ).resolves.toMatchObject({
      attested: true,
      artifact_digest: artifactDigest,
    });
    await writeFile(join(directory, 'main.js'), 'different emitted main');
    await expect(
      loadBuildIdentity({ mode: 'pilot', path, artifactRoot: directory }),
    ).rejects.toThrow(
      /artifact.*digest.*mismatch/i,
    );
  });

  it('never lets a self-consistent side directory attest another executable root', async () => {
    const directory = await temporaryDirectory();
    const actualRoot = join(directory, 'actual-dist');
    const sideRoot = join(directory, 'old-release');
    await mkdir(actualRoot);
    await mkdir(sideRoot);
    await writeFile(join(actualRoot, 'main.js'), 'currently executing bytes');
    await writeFile(join(sideRoot, 'main.js'), 'old release bytes');
    const sideReceipt = join(sideRoot, 'build-attestation.json');
    await writeFile(
      sideReceipt,
      JSON.stringify({
        ...validAttestation,
        artifact_digest: await computeArtifactDigest(sideRoot),
      }),
    );

    await expect(
      loadBuildIdentity({ mode: 'pilot', path: sideReceipt, artifactRoot: actualRoot }),
    ).rejects.toThrow(/artifact root|receipt path/i);
  });

  it('reads schema provenance through the bounded no-follow regular-file guard', async () => {
    const directory = await temporaryDirectory();
    const distRoot = join(directory, 'dist');
    const migrationsRoot = join(directory, 'migrations');
    const schemaTarget = join(directory, 'schema-target.prisma');
    const schemaLink = join(directory, 'schema-link.prisma');
    const schemaFifo = join(directory, 'schema.fifo');
    await mkdir(distRoot);
    await mkdir(join(migrationsRoot, '20260809010101_runtime_receipts'), {
      recursive: true,
    });
    await writeFile(join(distRoot, 'main.js'), 'compiled application');
    await writeFile(schemaTarget, 'model RuntimeReceipt {}');
    await symlink(schemaTarget, schemaLink);
    execFileSync('mkfifo', [schemaFifo]);

    const build = (schemaPath: string) =>
      generateBuildAttestation({
        distRoot,
        buildSha: validAttestation.build_sha,
        builtAt: validAttestation.built_at,
        schemaPath,
        migrationsRoot,
      });

    await expect(build(schemaLink)).rejects.toThrow(/symlink|nofollow/i);
    await expect(build(schemaFifo)).rejects.toThrow(/regular file/i);
    const oversizedSchema = join(directory, 'oversized-schema.prisma');
    await writeFile(oversizedSchema, Buffer.alloc(16 * 1024 * 1024 + 1));
    await expect(build(oversizedSchema)).rejects.toThrow(/byte limit/i);
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
      loadBuildIdentity({
        mode: 'pilot',
        path: join(distRoot, 'build-attestation.json'),
        artifactRoot: distRoot,
      }),
    ).resolves.toMatchObject({ attested: true, build_sha: validAttestation.build_sha });
    expect((await readdir(distRoot)).filter((name) => name.includes('.tmp-'))).toEqual([]);
  });
});
