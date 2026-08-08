import { renameSync } from 'node:fs';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  computeArtifactDigest,
  generateRuntimeBuildReceipt,
  loadRuntimeBuildIdentity,
} from './build-receipt';
import { resolveRuntimeAdmission } from './runtime-admission';

const BUILD_INPUT = Object.freeze({
  buildSha: 'a'.repeat(40),
  buildTime: '2026-08-07T12:34:56.000Z',
});

const MIGRATION_ENTRIES = Object.freeze([
  Object.freeze({
    name: '20260801000000_first',
    checksum:
      'b4e0497804e46e0a0b0b8c31975b062152d551bac49c3c2e80932567b4085dcd',
  }),
  Object.freeze({
    name: '20260802000000_second',
    checksum:
      'a41109d24069b4822ddc5f367b25d484dc7e839bff338ce7a3e5da641caacda0',
  }),
]);
const MIGRATION_MANIFEST_DIGEST =
  'sha256:c660e88b31a56fb9e329705b41371e5b0d6c0a77d59c03c5a2596bc1b2713ea4';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function artifactRoot(
  order: 'forward' | 'reverse' = 'forward',
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'global-api-receipt-'));
  roots.push(root);
  const files = [
    ['main.js', 'console.log("api");\n'],
    ['nested/worker.js', 'export const worker = true;\n'],
  ] as const;
  for (const [path, contents] of order === 'forward'
    ? files
    : [...files].reverse()) {
    await mkdir(resolve(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), contents);
  }
  return root;
}

async function migrationRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'global-api-migrations-'));
  roots.push(root);
  await writeFile(join(root, 'migration_lock.toml'), 'provider = "postgresql"\n');
  await mkdir(join(root, MIGRATION_ENTRIES[1].name), { recursive: true });
  await writeFile(
    join(root, MIGRATION_ENTRIES[1].name, 'migration.sql'),
    'SELECT 2;\n',
  );
  await mkdir(join(root, MIGRATION_ENTRIES[0].name), { recursive: true });
  await writeFile(
    join(root, MIGRATION_ENTRIES[0].name, 'migration.sql'),
    'SELECT 1;\n',
  );
  return root;
}

describe('runtime build receipt', () => {
  it('hashes sorted relative paths and bytes deterministically, excluding the receipt itself', async () => {
    const first = await artifactRoot('forward');
    const second = await artifactRoot('reverse');
    expect(computeArtifactDigest(first)).toBe(computeArtifactDigest(second));
    expect(computeArtifactDigest(first)).toBe(
      'sha256:7ba6572a4fe52e8633ebb7093248d1fbda6e8cbeea4ce6e8d51b1b007f2e76d1',
    );

    await generateRuntimeBuildReceipt({
      artifactRoot: first,
      migrationRoot: await migrationRoot(),
      ...BUILD_INPUT,
    });
    expect(computeArtifactDigest(first)).toBe(computeArtifactDigest(second));
  });

  it('sorts the complete relative-path set globally rather than using directory DFS order', async () => {
    const root = await mkdtemp(join(tmpdir(), 'global-api-global-sort-'));
    roots.push(root);
    await mkdir(join(root, 'a'));
    await writeFile(join(root, 'a', 'z.txt'), 'nested\n');
    await writeFile(join(root, 'a.txt'), 'root\n');
    await writeFile(join(root, 'z.txt'), 'last\n');

    expect(computeArtifactDigest(root)).toBe(
      'sha256:0bae8701bd8e8130c33034f19fed9aa52f11563b41a27e74b23886c64d264368',
    );
  });

  it('writes a read-only receipt beside the artifact and loads only a byte-consistent identity', async () => {
    const root = await artifactRoot();
    const migrations = await migrationRoot();
    const receipt = await generateRuntimeBuildReceipt({
      artifactRoot: root,
      migrationRoot: migrations,
      ...BUILD_INPUT,
    });
    const receiptPath = join(root, 'runtime-build-receipt.json');
    const mode = (await import('node:fs/promises'))
      .stat(receiptPath)
      .then((stat) => stat.mode & 0o777);

    expect(await mode).toBe(0o444);
    expect(JSON.parse(await readFile(receiptPath, 'utf8'))).toEqual(receipt);
    expect(
      loadRuntimeBuildIdentity({ artifactRoot: root, env: {}, required: true }),
    ).toMatchObject({
      status: 'VERIFIED',
      buildSha: BUILD_INPUT.buildSha,
      buildTime: BUILD_INPUT.buildTime,
      migrationRevision: MIGRATION_ENTRIES.at(-1)?.name,
      migrationManifestDigest: MIGRATION_MANIFEST_DIGEST,
      migrationManifest: {
        schemaVersion: 'global-api-migration-manifest/v1',
        digest: MIGRATION_MANIFEST_DIGEST,
        entries: MIGRATION_ENTRIES,
      },
      artifactDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
    });
  });

  it('derives the ordered migration name and raw-byte checksum manifest from source migrations', async () => {
    const root = await artifactRoot();
    const receipt = await generateRuntimeBuildReceipt({
      artifactRoot: root,
      migrationRoot: await migrationRoot(),
      ...BUILD_INPUT,
    });

    expect(receipt.migrationManifest).toEqual({
      schemaVersion: 'global-api-migration-manifest/v1',
      digest: MIGRATION_MANIFEST_DIGEST,
      entries: MIGRATION_ENTRIES,
    });
    expect(receipt.migrationRevision).toBeUndefined();
  });

  it('fails closed if any receipt-excluded artifact byte changes', async () => {
    const root = await artifactRoot();
    await generateRuntimeBuildReceipt({
      artifactRoot: root,
      migrationRoot: await migrationRoot(),
      ...BUILD_INPUT,
    });
    await writeFile(join(root, 'main.js'), 'console.log("tampered");\n');

    expect(() =>
      loadRuntimeBuildIdentity({ artifactRoot: root, env: {}, required: true }),
    ).toThrow(/ARTIFACT_DIGEST/);
  });

  it('uses runtime env only as an exact complete attestation of the receipt', async () => {
    const root = await artifactRoot();
    const receipt = await generateRuntimeBuildReceipt({
      artifactRoot: root,
      migrationRoot: await migrationRoot(),
      ...BUILD_INPUT,
    });
    const exactEnv = {
      BUILD_SHA: receipt.buildSha,
      BUILD_TIME: receipt.buildTime,
      ARTIFACT_DIGEST: receipt.artifactDigest,
      MIGRATION_MANIFEST_DIGEST: receipt.migrationManifest.digest,
    };

    expect(
      loadRuntimeBuildIdentity({
        artifactRoot: root,
        env: exactEnv,
        required: true,
      }),
    ).toMatchObject({ status: 'VERIFIED' });
    expect(() =>
      loadRuntimeBuildIdentity({
        artifactRoot: root,
        env: { ...exactEnv, BUILD_SHA: 'c'.repeat(40) },
        required: true,
      }),
    ).toThrow(/attestation.*BUILD_SHA/i);
    expect(() =>
      loadRuntimeBuildIdentity({
        artifactRoot: root,
        env: { BUILD_SHA: receipt.buildSha },
        required: true,
      }),
    ).toThrow(/complete.*attestation/i);
  });

  it('admits pilot only from a verified receipt and exposes the receipt identity', async () => {
    const root = await artifactRoot();
    await generateRuntimeBuildReceipt({
      artifactRoot: root,
      migrationRoot: await migrationRoot(),
      ...BUILD_INPUT,
    });
    const admission = await resolveRuntimeAdmission(
      {
        DEPLOYMENT_STAGE: 'pilot',
        NODE_ENV: 'production',
        API_BIND_HOST: '127.0.0.1',
        CORS_ORIGINS: 'https://app.example.test',
        AUTH_JWKS_URI: 'https://identity.example.test/jwks.json',
        AUTH_ISSUER: 'https://identity.example.test',
        MODEL_GATEWAY_URL: 'https://models.example.test/v1',
        MODEL_GATEWAY_KEY: 'test-key',
        S3_ACCESS_KEY: 'test-access',
        S3_SECRET_KEY: 'test-secret',
        DATA_PROCESSOR_JURISDICTION: 'EU',
        SITE_RENDERER_BUILD_ID: 'site-renderer@1.0.0+sha.abc123',
      },
      { artifactRoot: root },
    );

    expect(admission.admission).toMatchObject({
      deploymentStage: 'pilot',
      apiBindHost: '127.0.0.1',
      buildIdentity: {
        status: 'VERIFIED',
        migrationRevision: MIGRATION_ENTRIES.at(-1)?.name,
        migrationManifestDigest: MIGRATION_MANIFEST_DIGEST,
      },
    });
  });

  it('rejects a writable or symlinked receipt', async () => {
    const root = await artifactRoot();
    await generateRuntimeBuildReceipt({
      artifactRoot: root,
      migrationRoot: await migrationRoot(),
      ...BUILD_INPUT,
    });
    const receiptPath = join(root, 'runtime-build-receipt.json');
    await chmod(receiptPath, 0o644);
    expect(() =>
      loadRuntimeBuildIdentity({ artifactRoot: root, env: {}, required: true }),
    ).toThrow(/read-only/);

    await rm(receiptPath);
    await (await import('node:fs/promises')).symlink('main.js', receiptPath);
    expect(() =>
      loadRuntimeBuildIdentity({ artifactRoot: root, env: {}, required: true }),
    ).toThrow(/regular file|symlink/i);
  });

  it('rejects malformed receipt identity field types before identity parsing', async () => {
    const root = await artifactRoot();
    await generateRuntimeBuildReceipt({
      artifactRoot: root,
      migrationRoot: await migrationRoot(),
      ...BUILD_INPUT,
    });
    const receiptPath = join(root, 'runtime-build-receipt.json');
    await chmod(receiptPath, 0o644);
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8')) as Record<
      string,
      unknown
    >;
    await writeFile(
      receiptPath,
      `${JSON.stringify({ ...receipt, buildSha: 42 }, null, 2)}\n`,
    );
    await chmod(receiptPath, 0o444);

    expect(() =>
      loadRuntimeBuildIdentity({ artifactRoot: root, env: {}, required: true }),
    ).toThrow(/identity fields must be strings/i);
  });

  it('rejects a symlinked artifact root and path replacement races', async () => {
    const root = await artifactRoot();
    const linkedRoot = `${root}-link`;
    roots.push(linkedRoot);
    await symlink(root, linkedRoot, 'dir');
    expect(() => computeArtifactDigest(linkedRoot)).toThrow(/root.*symlink/i);

    const artifactReplacementRoot = await artifactRoot();
    const artifactReplacement = join(
      await mkdtemp(join(tmpdir(), 'global-api-artifact-replacement-')),
      'main.js',
    );
    roots.push(resolve(artifactReplacement, '..'));
    await writeFile(artifactReplacement, 'console.log("api");\n');
    expect(() =>
      computeArtifactDigest(
        artifactReplacementRoot,
        undefined,
        {
          beforeFileOpenForTest: (relativePath) => {
            if (relativePath === 'main.js') {
              renameSync(
                artifactReplacement,
                join(artifactReplacementRoot, 'main.js'),
              );
            }
          },
        },
      ),
    ).toThrow(/artifact file.*identity changed/i);

    const rootReplacement = await artifactRoot();
    const replacementRoot = await artifactRoot();
    const displacedRoot = `${rootReplacement}-displaced`;
    roots.push(displacedRoot);
    expect(() =>
      computeArtifactDigest(rootReplacement, undefined, {
        beforeRootFinalizeForTest: () => {
          renameSync(rootReplacement, displacedRoot);
          renameSync(replacementRoot, rootReplacement);
        },
      }),
    ).toThrow(/artifact root identity changed/i);

    const receipt = await generateRuntimeBuildReceipt({
      artifactRoot: root,
      migrationRoot: await migrationRoot(),
      ...BUILD_INPUT,
    });
    const receiptPath = join(root, 'runtime-build-receipt.json');
    const receiptReplacementRoot = await mkdtemp(
      join(tmpdir(), 'global-api-receipt-replacement-'),
    );
    roots.push(receiptReplacementRoot);
    const replacement = join(receiptReplacementRoot, 'replacement.json');
    await writeFile(replacement, `${JSON.stringify(receipt)}\n`);
    await chmod(replacement, 0o444);

    expect(() =>
      loadRuntimeBuildIdentity({
        artifactRoot: root,
        env: {},
        required: true,
        beforeReceiptOpenForTest: () => {
          renameSync(replacement, receiptPath);
        },
      }),
    ).toThrow(/receipt.*changed|identity.*changed/i);
  });

  it('rejects receipt replacement after the artifact scan but before admission returns', async () => {
    const root = await artifactRoot();
    const receipt = await generateRuntimeBuildReceipt({
      artifactRoot: root,
      migrationRoot: await migrationRoot(),
      ...BUILD_INPUT,
    });
    const receiptPath = join(root, 'runtime-build-receipt.json');
    const replacementRoot = await mkdtemp(
      join(tmpdir(), 'global-api-late-receipt-replacement-'),
    );
    roots.push(replacementRoot);
    const replacement = join(replacementRoot, 'replacement.json');
    await writeFile(replacement, `${JSON.stringify(receipt, null, 2)}\n`);
    await chmod(replacement, 0o444);

    expect(() =>
      loadRuntimeBuildIdentity({
        artifactRoot: root,
        env: {},
        required: true,
        beforeReceiptFinalizeForTest: () => {
          renameSync(replacement, receiptPath);
        },
      }),
    ).toThrow(/receipt.*changed/i);
  });

  it('keeps the generator free of runtime Git derivation', async () => {
    const script = await readFile(
      resolve(process.cwd(), 'scripts/generate-runtime-build-receipt.mts'),
      'utf8',
    );
    expect(script).not.toMatch(
      /child_process|execSync|spawnSync|git\s+rev-parse/u,
    );
    expect(script).toContain('--source-sha');
    expect(script).toContain('--migration-root');
    expect(script).not.toContain('--migration-revision');
  });
});
