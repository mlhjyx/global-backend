import assert from 'node:assert/strict';
import {
  access,
  chmod,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);

const repositoryFile = (path) =>
  readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('MinIO is pinned and provisioned by one idempotent deployment job', async () => {
  const [compose, bootstrap, lifecycle, artifactLifecycle] = await Promise.all([
    repositoryFile('docker-compose.yml'),
    repositoryFile('infra/minio/bootstrap.sh'),
    repositoryFile('infra/minio/site-builder-lifecycle.json'),
    repositoryFile('infra/minio/generic-operation-artifact-lifecycle.json'),
  ]);
  assert.match(compose, /minio:\n\s+image: quay\.io\/minio\/minio:RELEASE\./);
  assert.match(compose, /minio-bootstrap:/);
  assert.match(compose, /condition: service_healthy/);
  assert.match(compose, /restart: ["']no["']/);
  assert.match(bootstrap, /mc mb --ignore-existing/);
  assert.match(bootstrap, /mc ilm rule import/);
  assert.match(bootstrap, /mc ilm rule export/);
  assert.deepEqual(JSON.parse(lifecycle), {
    Rules: [
      {
        Expiration: { Days: 1 },
        ID: 'global-variant-attempt-ttl',
        Status: 'Enabled',
        Filter: {
          Tag: { Key: 'global-lifecycle', Value: 'variant-attempt' },
        },
      },
    ],
  });
  assert.deepEqual(JSON.parse(artifactLifecycle), {
    Rules: [
      {
        Expiration: { Days: 1, ExpiredObjectAllVersions: true },
        NoncurrentVersionExpiration: { NoncurrentDays: 1 },
        ID: 'generic-operation-artifact-staging-ttl',
        Status: 'Enabled',
        Filter: { Prefix: 'generic-operation-results/v1/staging/' },
      },
      {
        Expiration: { Days: 30, ExpiredObjectAllVersions: true },
        NoncurrentVersionExpiration: { NoncurrentDays: 30 },
        ID: 'generic-operation-artifact-public-organization-ttl',
        Status: 'Enabled',
        Filter: {
          Tag: {
            Key: 'artifact-privacy',
            Value: 'PUBLIC_ORGANIZATION',
          },
        },
      },
      {
        Expiration: { Days: 7, ExpiredObjectAllVersions: true },
        NoncurrentVersionExpiration: { NoncurrentDays: 7 },
        ID: 'generic-operation-artifact-confidential-tenant-ttl',
        Status: 'Enabled',
        Filter: {
          Tag: {
            Key: 'artifact-privacy',
            Value: 'CONFIDENTIAL_TENANT',
          },
        },
      },
      {
        Expiration: { Days: 1, ExpiredObjectAllVersions: true },
        NoncurrentVersionExpiration: { NoncurrentDays: 1 },
        ID: 'generic-operation-artifact-personal-data-ttl',
        Status: 'Enabled',
        Filter: {
          Tag: { Key: 'artifact-privacy', Value: 'PERSONAL_DATA' },
        },
      },
      {
        Expiration: { ExpiredObjectDeleteMarker: true },
        ID: 'generic-operation-artifact-staging-delete-markers',
        Status: 'Enabled',
        Filter: { Prefix: 'generic-operation-results/v1/staging/' },
      },
      {
        Expiration: { ExpiredObjectDeleteMarker: true },
        ID: 'generic-operation-artifact-final-delete-markers',
        Status: 'Enabled',
        Filter: { Prefix: 'generic-operation-results/v1/sha256/' },
      },
      {
        Expiration: { ExpiredObjectDeleteMarker: true },
        NoncurrentVersionExpiration: { NoncurrentDays: 1 },
        ID: 'generic-operation-artifact-readiness-cleanup',
        Status: 'Enabled',
        Filter: { Prefix: 'generic-operation-results/v1/readiness/' },
      },
    ],
  });
  assert.match(bootstrap, /GENERIC_OPERATION_ARTIFACT_S3_BUCKET/);
  assert.match(bootstrap, /mc version enable/);
  assert.match(bootstrap, /mc encrypt set SSE-S3/);
  assert.match(bootstrap, /generic-operation-artifact-lifecycle\.json/);
  assert.match(bootstrap, /mc admin policy create/);
  assert.match(bootstrap, /s3:ExistingObjectTag\/artifact-privacy/);
  assert.match(bootstrap, /s3:PutObjectTagging/);
  assert.match(bootstrap, /s3:AbortMultipartUpload/);
  assert.match(bootstrap, /s3:DeleteObjectVersion/);
  assert.match(
    bootstrap,
    /MINIO_ROOT_USER.*GENERIC_OPERATION_ARTIFACT_S3_ACCESS_KEY/s,
  );
  assert.match(bootstrap, /mc admin user info .* --json/);
  assert.match(bootstrap, /"policyName"/);
  assert.match(bootstrap, /"memberOf"/);
  assert.doesNotMatch(
    bootstrap,
    /"Action": \["s3:GetObject", "s3:GetObjectVersion"\]/,
  );
  assert.match(
    bootstrap,
    /GENERIC_OPERATION_ARTIFACT_PERSONAL_READ_ACCESS_KEY/,
  );
  assert.match(bootstrap, /GENERIC_OPERATION_ARTIFACT_CLEANUP_S3_ACCESS_KEY/);
  assert.match(bootstrap, /generic-operation-artifact-personal-cleanup/);
  assert.match(bootstrap, /"s3:GetObjectVersion"/);
  assert.match(bootstrap, /"s3:DeleteObjectVersion"/);
  assert.match(bootstrap, /"s3:GetBucketLocation"/);
  assert.match(compose, /GENERIC_OPERATION_ARTIFACT_CLEANUP_S3_ACCESS_KEY/);
  assert.match(compose, /GENERIC_OPERATION_ARTIFACT_CLEANUP_S3_SECRET_KEY/);
});

test('MinIO bootstrap rejects merged principals before the first mc mutation', async () => {
  const directory = await mkdtemp(
    join(tmpdir(), 'artifact-bootstrap-contract-'),
  );
  const marker = join(directory, 'mc-called');
  const fakeMc = join(directory, 'mc');
  await writeFile(fakeMc, '#!/bin/sh\n: > "$MC_MARKER"\nexit 0\n', 'utf8');
  await chmod(fakeMc, 0o700);
  try {
    await assert.rejects(
      execFileAsync('/bin/sh', ['infra/minio/bootstrap.sh'], {
        cwd: new URL('..', import.meta.url),
        env: {
          PATH: directory,
          MC_MARKER: marker,
          MINIO_ENDPOINT: 'http://minio:9000',
          MINIO_ROOT_USER: 'same-principal',
          MINIO_ROOT_PASSWORD: 'root-password-123',
          S3_BUCKET: 'site-assets-test',
          GENERIC_OPERATION_ARTIFACT_S3_BUCKET: 'operation-artifacts-test',
          GENERIC_OPERATION_ARTIFACT_S3_ACCESS_KEY: 'same-principal',
          GENERIC_OPERATION_ARTIFACT_S3_SECRET_KEY: 'runtime-password-123',
          GENERIC_OPERATION_ARTIFACT_PERSONAL_READ_ACCESS_KEY:
            'personal-reader',
          GENERIC_OPERATION_ARTIFACT_PERSONAL_READ_SECRET_KEY:
            'personal-password-123',
          GENERIC_OPERATION_ARTIFACT_CLEANUP_S3_ACCESS_KEY:
            'cleanup-writer',
          GENERIC_OPERATION_ARTIFACT_CLEANUP_S3_SECRET_KEY:
            'cleanup-password-123',
        },
      }),
      /artifact storage principals must be distinct/,
    );
    await assert.rejects(access(marker, fsConstants.F_OK), { code: 'ENOENT' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('development API and Worker use one immutable image reference and wait for storage provisioning', async () => {
  const compose = await repositoryFile('infra/backend-runtime.compose.yml');
  const immutableImageUses =
    compose.match(/image: \$\{GLOBAL_BACKEND_IMAGE:\?/g) ?? [];
  assert.equal(immutableImageUses.length, 1);
  assert.match(compose, /NODE_ENV: production/);
  assert.match(compose, /RUNTIME_IMAGE_REFERENCE: \$\{GLOBAL_BACKEND_IMAGE\}/);
  assert.doesNotMatch(compose, /GLOBAL_BACKEND_IMAGE_DIGEST/);
  assert.match(compose, /api:\n[\s\S]*command: \["api"\]/);
  assert.match(compose, /worker:\n[\s\S]*command: \["worker"\]/);
  assert.match(
    compose,
    /minio-bootstrap:\n\s+condition: service_completed_successfully/g,
  );
  for (const name of [
    'GENERIC_OPERATION_ARTIFACT_S3_ENDPOINT',
    'GENERIC_OPERATION_ARTIFACT_S3_BUCKET',
    'GENERIC_OPERATION_ARTIFACT_S3_REGION',
    'GENERIC_OPERATION_ARTIFACT_S3_ACCESS_KEY',
    'GENERIC_OPERATION_ARTIFACT_S3_SECRET_KEY',
    'GENERIC_OPERATION_ARTIFACT_S3_FORCE_PATH_STYLE',
  ]) {
    assert.match(compose, new RegExp(`${name}: \\$\\{${name}`));
  }
  for (const name of [
    'GENERIC_OPERATION_ARTIFACT_CLEANUP_S3_ACCESS_KEY',
    'GENERIC_OPERATION_ARTIFACT_CLEANUP_S3_SECRET_KEY',
  ]) {
    const apiService = compose.slice(
      compose.indexOf('\n  api:'),
      compose.indexOf('\n  worker:'),
    );
    const workerService = compose.slice(compose.indexOf('\n  worker:'));
    assert.match(workerService, new RegExp(`${name}: \\$\\{${name}`));
    assert.doesNotMatch(apiService, new RegExp(`${name}:`));
  }
  assert.doesNotMatch(
    compose,
    /GENERIC_OPERATION_ARTIFACT_S3_SECRET_KEY:\s+[^$\n]/,
  );
  assert.doesNotMatch(compose, /build:/);
  assert.doesNotMatch(compose, /node dist\//);
  assert.match(compose, /pids_limit: 256/);
  assert.match(compose, /mem_limit: \$\{GLOBAL_BACKEND_MEMORY_LIMIT:-4g\}/);
  assert.match(compose, /cpus: \$\{GLOBAL_BACKEND_CPU_LIMIT:-2\.0\}/);
  assert.match(compose, /nofile:\n\s+soft: 1024\n\s+hard: 1024/);
});

test('runtime lease principals are provisioned without embedded credentials and split by process', async () => {
  const [compose, provision, verify] = await Promise.all([
    repositoryFile('infra/backend-runtime.compose.yml'),
    repositoryFile('infra/postgres/provision-runtime-lease-principals.sh'),
    repositoryFile(
      'infra/postgres/verify-runtime-lease-principal-permissions.sh',
    ),
  ]);
  assert.match(compose, /backend-api-runtime\.env/);
  assert.match(compose, /backend-worker-runtime\.env/);
  assert.match(provision, /RUNTIME_API_LEASE_PASSWORD/);
  assert.match(provision, /\\getenv api_password RUNTIME_API_LEASE_PASSWORD/);
  assert.match(provision, /PGPASSWORD/);
  assert.match(provision, /runtime_connection="\$\(node/);
  assert.match(provision, /\|\|[\s\S]*exit 1/);
  assert.doesNotMatch(provision, /--set\s+api_password=/);
  assert.doesNotMatch(provision, /--set\s+worker_password=/);
  assert.doesNotMatch(provision, /--set\s+relay_password=/);
  assert.doesNotMatch(
    provision,
    /psql\s+"\$\{RUNTIME_LEASE_PROVISION_DATABASE_URL\}"/,
  );
  assert.match(
    provision,
    /REVOKE runtime_api, runtime_worker, runtime_outbox_relay/,
  );
  assert.match(provision, /GRANT runtime_api TO/);
  assert.match(provision, /GRANT runtime_worker TO/);
  assert.match(provision, /GRANT runtime_outbox_relay TO/);
  assert.doesNotMatch(provision, /PASSWORD\s+'[^']+'/i);
  assert.match(verify, /register_api_runtime_process_lease/);
  assert.match(verify, /register_worker_runtime_process_lease/);
  assert.match(verify, /register_outbox_relay_runtime_process_lease/);
  assert.match(verify, /psql_denied/);
});

test('legacy systemd units delegate to the immutable compose runtime instead of mutable checkout dist', async () => {
  const [api, worker] = await Promise.all([
    repositoryFile('infra/systemd/global-api.service'),
    repositoryFile('infra/systemd/global-worker.service'),
  ]);
  for (const unit of [api, worker]) {
    assert.doesNotMatch(unit, /node\s+dist\//);
    assert.match(unit, /docker compose/);
    assert.match(unit, /backend-runtime\.compose\.yml/);
  }
});

function assertGhcrPublicationContract(workflow) {
  assert.match(workflow, /^name: Publish immutable runtime image$/m);
  assert.match(workflow, /^on:\n  workflow_dispatch:\s*$/m);
  assert.doesNotMatch(workflow, /^  (push|pull_request|schedule):/m);
  assert.match(
    workflow,
    /^permissions:\n  contents: read\n  packages: write\n  id-token: write\n  attestations: write$/m,
  );
  assert.doesNotMatch(workflow, /^    permissions:/m);
  assert.match(workflow, /if: github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /environment: runtime-image-publication/);
  assert.match(workflow, /timeout-minutes: 60/);
  assert.match(
    workflow,
    /uses: actions\/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7/,
  );
  assert.match(
    workflow,
    /uses: actions\/attest@1e69f48acb82d1966a394da916b4c1698aa569d6 # v4\.2\.2/,
  );
  assert.equal(
    workflow.match(/uses: actions\/attest@1e69f48acb82d1966a394da916b4c1698aa569d6 # v4\.2\.2/g)?.length,
    2,
  );
  assert.match(workflow, /fetch-depth: 0/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /IMAGE_NAME: ghcr\.io\/mlhjyx\/global-backend/);
  assert.match(workflow, /SUBJECT_SHA: \$\{\{ github\.sha \}\}/);
  assert.match(workflow, /git rev-parse origin\/main/);
  assert.equal(
    workflow.match(/test "\$\{SUBJECT_SHA\}" = "\$\{MAIN_SHA\}"/g)?.length,
    2,
  );
  const publishStep = workflow.indexOf('      - id: publish');
  const secondMainCheck = workflow.lastIndexOf(
    'test "${SUBJECT_SHA}" = "${MAIN_SHA}"',
  );
  const push = workflow.indexOf('docker push "${IMAGE_TAG}"', publishStep);
  assert.ok(publishStep > 0 && secondMainCheck > publishStep && push > secondMainCheck);
  const configAttestation = workflow.indexOf(
    'name: Attest the local image config before publication',
  );
  assert.ok(configAttestation > 0 && configAttestation < push);
  assert.match(workflow, /docker login ghcr\.io[\s\S]*--password-stdin/);
  assert.match(workflow, /id: existing/);
  assert.match(
    workflow,
    /node scripts\/ghcr-runtime-publication\.mjs resolve[\s\S]*--github-output "\$\{GITHUB_OUTPUT\}"/,
  );
  assert.match(workflow, /if: steps\.existing\.outputs\.exists != 'true'/);
  assert.match(workflow, /--build-arg "BUILD_SHA=\$\{SUBJECT_SHA\}"/);
  assert.match(workflow, /--build-arg "BUILT_AT=\$\{BUILT_AT\}"/);
  assert.match(workflow, /docker push "\$\{IMAGE_TAG\}"/);
  assert.doesNotMatch(workflow, /PUSH_OUTPUT|digest: \(sha256:/);
  assert.match(workflow, /LOCAL_IMAGE_ID/);
  assert.match(workflow, /docker save/);
  assert.match(workflow, /manifest\.json/);
  assert.match(workflow, /sha256sum/);
  assert.match(
    workflow,
    /docker image inspect --format '\{\{\.Id\}\}' "\$\{IMAGE_REFERENCE\}"\)" = "\$\{LOCAL_IMAGE_ID\}"/,
  );
  assert.match(workflow, /docker pull "\$\{IMAGE_REFERENCE\}"/);
  assert.equal(
    workflow.match(/runtime-image-verifier\.mjs \/app/g)?.length,
    2,
  );
  assert.equal(workflow.match(/gh attestation verify/g)?.length, 3);
  assert.match(
    workflow,
    /steps\.existing_provenance\.outputs\.registry_attested != 'true'/,
  );
  assert.match(
    workflow,
    /subject-path: \$\{\{ steps\.build\.outputs\.config_path \}\}/,
  );
  assert.match(
    workflow,
    /subject-digest: \$\{\{ steps\.existing\.outputs\.image_digest \|\| steps\.publish\.outputs\.image_digest \}\}/,
  );
  for (const flag of [
    '--repo "${GITHUB_REPOSITORY}"',
    '--signer-workflow "${GITHUB_REPOSITORY}/.github/workflows/publish-runtime-image.yml"',
    '--signer-digest "${SUBJECT_SHA}"',
    '--source-ref refs/heads/main',
    '--source-digest "${SUBJECT_SHA}"',
    '--deny-self-hosted-runners',
  ]) {
    assert.equal(workflow.split(flag).length - 1, 3, `missing attestation flag ${flag}`);
  }
  assert.match(workflow, /org\.opencontainers\.image\.revision/);
  assert.match(workflow, /Config\.User/);
  assert.match(workflow, /Config\.Entrypoint/);
  assert.doesNotMatch(workflow, /(?:^|[:\s])latest(?:$|[\s"'])/m);
  assert.doesNotMatch(workflow, /secrets\.(?!GITHUB_TOKEN)/);
}

test('GHCR publication is manual, exact-main only, publish-once, digest read back, and minimally privileged', async () => {
  const workflow = await repositoryFile('.github/workflows/publish-runtime-image.yml');
  assertGhcrPublicationContract(workflow);
});

test('GHCR publication contract rejects removed main recheck and job-level permission widening', async () => {
  const workflow = await repositoryFile('.github/workflows/publish-runtime-image.yml');
  const equality = 'test "${SUBJECT_SHA}" = "${MAIN_SHA}"';
  const secondEqualityIndex = workflow.lastIndexOf(equality);
  const withoutSecondMainCheck =
    workflow.slice(0, secondEqualityIndex) +
    'true # removed exact-main comparison' +
    workflow.slice(secondEqualityIndex + equality.length);
  assert.throws(() => assertGhcrPublicationContract(withoutSecondMainCheck));

  const widenedJobPermissions = workflow.replace(
    '  publish:\n',
    '  publish:\n    permissions:\n      actions: write\n',
  );
  assert.throws(() => assertGhcrPublicationContract(widenedJobPermissions));

  const withoutProvenanceVerification = workflow.replace(
    'gh attestation verify',
    'true # removed provenance verification',
  );
  assert.throws(() => assertGhcrPublicationContract(withoutProvenanceVerification));

  const withoutPrepushConfigAttestation = workflow.replace(
    'name: Attest the local image config before publication',
    'name: Removed local config attestation',
  );
  assert.throws(() => assertGhcrPublicationContract(withoutPrepushConfigAttestation));
});
