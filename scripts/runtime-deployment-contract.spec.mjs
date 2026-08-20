import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const repositoryFile = (path) =>
  readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('MinIO is pinned and provisioned by one idempotent deployment job', async () => {
  const [compose, bootstrap, lifecycle] = await Promise.all([
    repositoryFile('docker-compose.yml'),
    repositoryFile('infra/minio/bootstrap.sh'),
    repositoryFile('infra/minio/site-builder-lifecycle.json'),
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
});

test('development API and Worker use one immutable image reference and wait for storage provisioning', async () => {
  const compose = await repositoryFile('infra/backend-runtime.compose.yml');
  const immutableImageUses = compose.match(/image: \$\{GLOBAL_BACKEND_IMAGE:\?/g) ?? [];
  assert.equal(immutableImageUses.length, 1);
  assert.match(compose, /NODE_ENV: production/);
  assert.match(compose, /RUNTIME_IMAGE_REFERENCE: \$\{GLOBAL_BACKEND_IMAGE\}/);
  assert.doesNotMatch(compose, /GLOBAL_BACKEND_IMAGE_DIGEST/);
  assert.match(compose, /api:\n[\s\S]*command: \["api"\]/);
  assert.match(compose, /worker:\n[\s\S]*command: \["worker"\]/);
  assert.match(compose, /minio-bootstrap:\n\s+condition: service_completed_successfully/g);
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
    repositoryFile('infra/postgres/verify-runtime-lease-principal-permissions.sh'),
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
  assert.doesNotMatch(provision, /psql\s+"\$\{RUNTIME_LEASE_PROVISION_DATABASE_URL\}"/);
  assert.match(provision, /REVOKE runtime_api, runtime_worker, runtime_outbox_relay/);
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
