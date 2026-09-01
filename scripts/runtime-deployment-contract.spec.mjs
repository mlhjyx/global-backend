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
  const [compose, bootstrap, cleanupAdapter, lifecycle, artifactLifecycle] = await Promise.all([
    repositoryFile('docker-compose.yml'),
    repositoryFile('infra/minio/bootstrap.sh'),
    repositoryFile(
      'apps/api/src/durable-results/artifact/personal-artifact-cleanup.store.ts',
    ),
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
        Filter: { Prefix: 'generic-operation-results/v1/final/' },
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
  assert.match(
    bootstrap,
    /generic-operation-results\/v1\/final\/personal-data\/\*/,
  );
  assert.match(bootstrap, /"s3:GetObjectVersion"/);
  assert.match(bootstrap, /"s3:GetObjectVersionTagging"/);
  assert.match(bootstrap, /"s3:GetObjectTagging"/);
  assert.match(bootstrap, /"s3:DeleteObjectVersion"/);
  const cleanupPolicy = bootstrap.slice(
    bootstrap.indexOf('cat > "$cleanup_policy"'),
    bootstrap.indexOf('cat > "$personal_policy"'),
  );
  assert.doesNotMatch(
    cleanupPolicy,
    /DeleteObjectVersion[\s\S]*ExistingObjectTag/u,
  );
  assert.match(cleanupAdapter, /GetObjectTaggingCommand/);
  assert.match(cleanupAdapter, /Value !== 'PERSONAL_DATA'/);
  const runtimePolicy = bootstrap.slice(
    bootstrap.indexOf('cat > "$runtime_policy"'),
    bootstrap.indexOf('cat > "$cleanup_policy"'),
  );
  for (const [prefix, privacyClass] of [
    ['public-organization', 'PUBLIC_ORGANIZATION'],
    ['confidential-tenant', 'CONFIDENTIAL_TENANT'],
    ['personal-data', 'PERSONAL_DATA'],
  ]) {
    for (const action of ['s3:PutObject', 's3:PutObjectTagging']) {
      expectPolicyMapping(runtimePolicy, action, prefix, privacyClass);
    }
  }
  assert.match(bootstrap, /"s3:GetBucketLocation"/);
  assert.match(compose, /GENERIC_OPERATION_ARTIFACT_CLEANUP_S3_ACCESS_KEY/);
  assert.match(compose, /GENERIC_OPERATION_ARTIFACT_CLEANUP_S3_SECRET_KEY/);
});

function expectPolicyMapping(policy, action, prefix, privacyClass) {
  const actionOffset = policy.indexOf(`"Action": ["${action}"]`);
  assert.notEqual(actionOffset, -1);
  const mapping = policy.slice(actionOffset);
  const prefixOffset = mapping.indexOf(
    `generic-operation-results/v1/final/${prefix}/*`,
  );
  assert.notEqual(prefixOffset, -1);
  const statement = mapping.slice(prefixOffset, prefixOffset + 700);
  assert.match(
    statement,
    new RegExp(`"s3:RequestObjectTag/artifact-privacy": "${privacyClass}"`),
  );
}

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

test('MinIO bootstrap rejects any predecessor-layout version before provisioning mutation', async () => {
  const directory = await mkdtemp(
    join(tmpdir(), 'artifact-layout-preflight-'),
  );
  const calls = join(directory, 'mc-calls');
  const fakeMc = join(directory, 'mc');
  await writeFile(
    fakeMc,
    `#!/bin/sh
printf '%s\\n' "$*" >> "$MC_CALLS"
case "$*" in
  'alias set '*) exit 0 ;;
  'ls deployment') printf '%s\\n' '[date] 0B operation-artifacts-test/'; exit 0 ;;
  'ls --recursive --versions '*) printf '%s\\n' '[old-version] DELETE sha256/aa/example'; exit 0 ;;
  *) exit 0 ;;
esac
`,
    'utf8',
  );
  await chmod(fakeMc, 0o700);
  try {
    await assert.rejects(
      execFileAsync('/bin/sh', ['infra/minio/bootstrap.sh'], {
        cwd: new URL('..', import.meta.url),
        env: {
          PATH: directory,
          MC_CALLS: calls,
          MINIO_ENDPOINT: 'http://minio:9000',
          MINIO_ROOT_USER: 'root-principal',
          MINIO_ROOT_PASSWORD: 'root-password-123',
          S3_BUCKET: 'site-assets-test',
          GENERIC_OPERATION_ARTIFACT_S3_BUCKET: 'operation-artifacts-test',
          GENERIC_OPERATION_ARTIFACT_S3_ACCESS_KEY: 'runtime-principal',
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
      /GENERIC_OPERATION_ARTIFACT_LAYOUT_MIGRATION_REQUIRED/,
    );
    const observed = await readFile(calls, 'utf8');
    assert.match(observed, /ls --recursive --versions/);
    assert.doesNotMatch(observed, /(^|\n)mb /);
    assert.doesNotMatch(observed, /(^|\n)ilm /);
    assert.doesNotMatch(observed, /(^|\n)admin /);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('MinIO bootstrap treats bucket or version inventory failure as unavailable before mutation', async () => {
  for (const failureMode of ['bucket-inventory', 'version-inventory']) {
    const directory = await mkdtemp(
      join(tmpdir(), `artifact-layout-${failureMode}-`),
    );
    const calls = join(directory, 'mc-calls');
    const fakeMc = join(directory, 'mc');
    await writeFile(
      fakeMc,
      `#!/bin/sh
printf '%s\\n' "$*" >> "$MC_CALLS"
case "$*" in
  'alias set '*) exit 0 ;;
  'ls deployment')
    if [ "$FAILURE_MODE" = bucket-inventory ]; then exit 7; fi
    printf '%s\\n' '[date] 0B operation-artifacts-test/'
    exit 0
    ;;
  'ls --recursive --versions '*)
    if [ "$FAILURE_MODE" = version-inventory ]; then exit 8; fi
    exit 0
    ;;
  *) exit 0 ;;
esac
`,
      'utf8',
    );
    await chmod(fakeMc, 0o700);
    try {
      await assert.rejects(
        execFileAsync('/bin/sh', ['infra/minio/bootstrap.sh'], {
          cwd: new URL('..', import.meta.url),
          env: minioBootstrapEnv(directory, calls, failureMode),
        }),
        /GENERIC_OPERATION_ARTIFACT_STORAGE_PREFLIGHT_UNAVAILABLE/,
      );
      const observed = await readFile(calls, 'utf8');
      assert.doesNotMatch(observed, /(^|\n)mb /);
      assert.doesNotMatch(observed, /(^|\n)ilm /);
      assert.doesNotMatch(observed, /(^|\n)encrypt /);
      assert.doesNotMatch(observed, /(^|\n)version /);
      assert.doesNotMatch(observed, /(^|\n)admin /);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

function minioBootstrapEnv(directory, calls, failureMode) {
  return {
    PATH: directory,
    MC_CALLS: calls,
    FAILURE_MODE: failureMode,
    MINIO_ENDPOINT: 'http://minio:9000',
    MINIO_ROOT_USER: 'root-principal',
    MINIO_ROOT_PASSWORD: 'root-password-123',
    S3_BUCKET: 'site-assets-test',
    GENERIC_OPERATION_ARTIFACT_S3_BUCKET: 'operation-artifacts-test',
    GENERIC_OPERATION_ARTIFACT_S3_ACCESS_KEY: 'runtime-principal',
    GENERIC_OPERATION_ARTIFACT_S3_SECRET_KEY: 'runtime-password-123',
    GENERIC_OPERATION_ARTIFACT_PERSONAL_READ_ACCESS_KEY: 'personal-reader',
    GENERIC_OPERATION_ARTIFACT_PERSONAL_READ_SECRET_KEY:
      'personal-password-123',
    GENERIC_OPERATION_ARTIFACT_CLEANUP_S3_ACCESS_KEY: 'cleanup-writer',
    GENERIC_OPERATION_ARTIFACT_CLEANUP_S3_SECRET_KEY:
      'cleanup-password-123',
  };
}

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
  for (const name of [
    'MINIO_ROOT_USER',
    'MINIO_ROOT_PASSWORD',
    'MINIO_KMS_SECRET_KEY',
    'GENERIC_OPERATION_ARTIFACT_PERSONAL_READ_ACCESS_KEY',
    'GENERIC_OPERATION_ARTIFACT_PERSONAL_READ_SECRET_KEY',
  ]) {
    assert.doesNotMatch(compose, new RegExp(`${name}:`));
  }
  const apiService = compose.slice(
    compose.indexOf('\n  api:'),
    compose.indexOf('\n  worker:'),
  );
  const workerService = compose.slice(compose.indexOf('\n  worker:'));
  const serviceEnvFiles = (section) =>
    [...section.matchAll(/^\s+- (\.secrets\/[A-Za-z0-9._-]+\.env)$/gm)].map(
      (match) => match[1],
    );
  assert.deepEqual(serviceEnvFiles(apiService), [
    '.secrets/backend-runtime.env',
    '.secrets/backend-api-runtime.env',
  ]);
  assert.deepEqual(serviceEnvFiles(workerService), [
    '.secrets/backend-runtime.env',
    '.secrets/backend-worker-runtime.env',
  ]);
  assert.doesNotMatch(
    compose,
    /GENERIC_OPERATION_ARTIFACT_S3_SECRET_KEY:\s+[^$\n]/,
  );
  assert.doesNotMatch(compose, /build:/);
  assert.doesNotMatch(compose, /node dist\//);
  assert.match(compose, /x-backend-runtime:[\s\S]*\n  init: true\n/);
  assert.equal(compose.match(/\n  init: true\n/g)?.length, 1);
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
  const [api, worker, readme, compose, main, temporalWorker] = await Promise.all([
    repositoryFile('infra/systemd/global-api.service'),
    repositoryFile('infra/systemd/global-worker.service'),
    repositoryFile('infra/systemd/README.md'),
    repositoryFile('infra/backend-runtime.compose.yml'),
    repositoryFile('apps/api/src/main.ts'),
    repositoryFile('apps/api/src/temporal/worker.ts'),
  ]);
  for (const unit of [api, worker]) {
    assert.doesNotMatch(unit, /node\s+dist\//);
    assert.match(unit, /docker compose/);
    assert.match(unit, /backend-runtime\.compose\.yml/);
    assert.equal(
      unit.match(
        /--env-file \/global\/backend\/\.secrets\/minio-bootstrap\.env/g,
      )?.length,
      3,
    );
    assert.equal(
      unit.match(
        /--env-file \/global\/backend\/\.secrets\/backend-runtime\.env/g,
      )?.length,
      3,
    );
    assert.doesNotMatch(unit, /EnvironmentFile=.*minio-bootstrap\.env/);
    for (const directive of ['ExecStartPre', 'ExecStart', 'ExecStop']) {
      const line = unit
        .split('\n')
        .find((candidate) => candidate.startsWith(`${directive}=`));
      assert.ok(line);
      assert.match(
        line,
        /docker compose --env-file \/global\/backend\/\.secrets\/minio-bootstrap\.env --env-file \/global\/backend\/\.secrets\/backend-runtime\.env/,
      );
    }
    assert.match(unit, /^TimeoutStopSec=120s$/m);
  }
  assert.match(compose, /^\s+stop_grace_period: 90s$/m);
  assert.match(
    main,
    /app\.enableShutdownHooks\(\['SIGTERM', 'SIGINT'\]\)/,
  );
  assert.match(
    temporalWorker,
    /Runtime\.install\(\{ shutdownSignals: \[\] \}\)/,
  );
  assert.match(temporalWorker, /startWorkerProcessSignalCoordinator/);
  assert.ok(
    temporalWorker.indexOf('Runtime.install({ shutdownSignals: [] })') <
      temporalWorker.indexOf('startWorkerProcessSignalCoordinator({'),
  );
  assert.match(
    temporalWorker,
    /await connection\.close\(\)\.catch\(\(\) => undefined\)/,
  );
  assert.match(
    readme,
    /docker compose \\\n+  --env-file \/global\/backend\/\.secrets\/minio-bootstrap\.env \\\n+  --env-file \/global\/backend\/\.secrets\/backend-runtime\.env/,
  );
  assert.match(readme, /http:\/\/127\.0\.0\.1:3000\/api\/v1\/health\/build/);
  assert.match(readme, /http:\/\/127\.0\.0\.1:3000\/api\/v1\/health\/ready/);
});

test('GrowthOS reaches the loopback backend only through an explicit Unix socket relay', async () => {
  const [socket, service, readme] = await Promise.all([
    repositoryFile('infra/systemd/global-backend-growthos-relay.socket'),
    repositoryFile('infra/systemd/global-backend-growthos-relay.service'),
    repositoryFile('infra/systemd/README.md'),
  ]);
  assert.match(
    socket,
    /ListenStream=\/run\/global-backend-growthos\/backend\.sock/,
  );
  assert.deepEqual(
    [...socket.matchAll(/^ListenStream=(.+)$/gm)].map((match) => match[1]),
    ['/run/global-backend-growthos/backend.sock'],
  );
  assert.match(socket, /SocketGroup=global-backend-growthos/);
  assert.match(socket, /SocketMode=0660/);
  assert.match(socket, /DirectoryMode=0711/);
  assert.match(socket, /RemoveOnStop=true/);
  assert.match(service, /Requires=global-api\.service/);
  assert.match(service, /After=global-api\.service/);
  assert.match(
    service,
    /ExecStart=\/usr\/lib\/systemd\/systemd-socket-proxyd 127\.0\.0\.1:3000/,
  );
  assert.match(service, /RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6/);
  assert.doesNotMatch(service, /0\.0\.0\.0|172\.|host\.docker\.internal/);
  assert.match(readme, /global-backend-growthos-relay\.socket/);
  assert.match(readme, /global-backend-growthos/);
  assert.match(readme, /AF_UNIX/);
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
  assert.equal(
    workflow.match(/node scripts\/docker-image-config-path\.mjs/g)?.length,
    2,
  );
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
  assert.equal(workflow.match(/--bundle-from-oci/g)?.length, 2);
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
