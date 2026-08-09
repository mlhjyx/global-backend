import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateBuildAttestation } from '../src/runtime/build-attestation';

const scriptDirectory = fileURLToPath(new URL('.', import.meta.url));
const apiRoot = resolve(scriptDirectory, '..');
const repositoryRoot = resolve(apiRoot, '..', '..');
const buildSha = process.env.BUILD_SHA ?? '';
const builtAt = process.env.BUILT_AT ?? '';

const attestation = await generateBuildAttestation({
  distRoot: resolve(apiRoot, 'dist'),
  buildSha,
  builtAt,
  schemaPath: resolve(repositoryRoot, 'packages/db/prisma/schema.prisma'),
  migrationsRoot: resolve(repositoryRoot, 'packages/db/prisma/migrations'),
});

process.stdout.write(
  `${JSON.stringify({
    status: 'BUILD_ATTESTATION_WRITTEN',
    build_sha: attestation.build_sha,
    artifact_digest: attestation.artifact_digest,
    migration_revision: attestation.migration_revision,
  })}\n`,
);
