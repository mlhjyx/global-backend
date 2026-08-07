import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
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
  migrationRevision: '202608070001_runtime_identity',
});

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

describe('runtime build receipt', () => {
  it('hashes sorted relative paths and bytes deterministically, excluding the receipt itself', async () => {
    const first = await artifactRoot('forward');
    const second = await artifactRoot('reverse');
    expect(computeArtifactDigest(first)).toBe(computeArtifactDigest(second));

    await generateRuntimeBuildReceipt({ artifactRoot: first, ...BUILD_INPUT });
    expect(computeArtifactDigest(first)).toBe(computeArtifactDigest(second));
  });

  it('writes a read-only receipt beside the artifact and loads only a byte-consistent identity', async () => {
    const root = await artifactRoot();
    const receipt = await generateRuntimeBuildReceipt({
      artifactRoot: root,
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
      migrationRevision: BUILD_INPUT.migrationRevision,
      artifactDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
    });
  });

  it('fails closed if any receipt-excluded artifact byte changes', async () => {
    const root = await artifactRoot();
    await generateRuntimeBuildReceipt({ artifactRoot: root, ...BUILD_INPUT });
    await writeFile(join(root, 'main.js'), 'console.log("tampered");\n');

    expect(() =>
      loadRuntimeBuildIdentity({ artifactRoot: root, env: {}, required: true }),
    ).toThrow(/ARTIFACT_DIGEST/);
  });

  it('uses runtime env only as an exact complete attestation of the receipt', async () => {
    const root = await artifactRoot();
    const receipt = await generateRuntimeBuildReceipt({
      artifactRoot: root,
      ...BUILD_INPUT,
    });
    const exactEnv = {
      BUILD_SHA: receipt.buildSha,
      BUILD_TIME: receipt.buildTime,
      ARTIFACT_DIGEST: receipt.artifactDigest,
      MIGRATION_REVISION: receipt.migrationRevision,
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
    await generateRuntimeBuildReceipt({ artifactRoot: root, ...BUILD_INPUT });
    const admission = await resolveRuntimeAdmission(
      {
        DEPLOYMENT_STAGE: 'pilot',
        API_BIND_HOST: '127.0.0.1',
        CORS_ORIGINS: 'https://app.example.test',
      },
      { artifactRoot: root },
    );

    expect(admission).toMatchObject({
      deploymentStage: 'pilot',
      apiBindHost: '127.0.0.1',
      buildIdentity: {
        status: 'VERIFIED',
        migrationRevision: BUILD_INPUT.migrationRevision,
      },
    });
  });

  it('rejects a writable or symlinked receipt', async () => {
    const root = await artifactRoot();
    await generateRuntimeBuildReceipt({ artifactRoot: root, ...BUILD_INPUT });
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
    await generateRuntimeBuildReceipt({ artifactRoot: root, ...BUILD_INPUT });
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

  it('keeps the generator free of runtime Git derivation', async () => {
    const script = await readFile(
      resolve(process.cwd(), 'scripts/generate-runtime-build-receipt.mts'),
      'utf8',
    );
    expect(script).not.toMatch(
      /child_process|execSync|spawnSync|git\s+rev-parse/u,
    );
    expect(script).toContain('--source-sha');
  });
});
