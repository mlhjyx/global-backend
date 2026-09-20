import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const enabled = process.env.RUN_RUNTIME_WORKER_NAMESPACE_POSTGRES === '1';
const migrations = new URL('../packages/db/prisma/migrations/', import.meta.url);
const docker = (args, options = {}) => execFileSync('docker', ['--context', 'default', ...args], { encoding: 'utf8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'], ...options });

test('runtime Worker namespace leases enforce real PostgreSQL principal and identity boundaries', { skip: !enabled, timeout: 120000 }, async (t) => {
  const name = `parity-lease-v2-${randomUUID().slice(0, 8)}`;
  const image = docker(['image', 'inspect', 'postgres:16-alpine', '--format', '{{.Id}}']).trim();
  assert.match(image, /^sha256:[0-9a-f]{64}$/);
  docker(['run', '-d', '--rm', '--pull', 'never', '--name', name, '--network', 'none', '--cpus', '0.5', '--memory', '384m', '--label', `io.global.disposable-lease-test=${name}`, '--tmpfs', '/var/lib/postgresql/data:rw,nosuid,nodev', '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', image]);
  t.after(() => {
    const label = docker(['inspect', name, '--format', '{{index .Config.Labels "io.global.disposable-lease-test"}}']).trim();
    assert.equal(label, name);
    docker(['rm', '-f', name]);
  });
  const sql = (input) => docker(['exec', '-i', name, 'psql', '-h', '127.0.0.1', '-U', 'postgres', '-d', 'postgres', '-XAt', '-v', 'ON_ERROR_STOP=1'], { input });
  let ready = false;
  for (let index = 0; index < 80; index += 1) {
    const result = spawnSync('docker', ['--context', 'default', 'exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres'], { stdio: 'ignore' });
    if (result.status === 0) { ready = true; break; }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.equal(ready, true, 'disposable PostgreSQL startup');
  sql('CREATE ROLE app_user LOGIN;');
  const baseline = await readFile(new URL('20260816220000_production_parity_budget_runtime/migration.sql', migrations), 'utf8');
  // Apply the exact published runtime DDL and ACL statements, not a handwritten table substitute.
  sql(baseline.slice(0, baseline.indexOf('CREATE TABLE "site_build_budget_grant"')) + '\nCOMMIT;\n');
  sql(baseline.split('\n').filter((line) => /^(REVOKE|GRANT).*ON FUNCTION .*runtime_process_lease/.test(line)).join('\n'));
  sql(baseline.split('\n').filter((line) => /^(REVOKE|GRANT).*ON TABLE "runtime_process_lease" (FROM|TO) /.test(line)).join('\n'));
  sql(await readFile(new URL('20260901110000_runtime_process_lease_atomic_terminalization/migration.sql', migrations), 'utf8'));
  const legacy = randomUUID();
  sql(`SELECT public.register_runtime_process_lease('${legacy}','WORKER','understanding','${'a'.repeat(40)}','sha256:${'b'.repeat(64)}','sha256:${'c'.repeat(64)}','legacy','2026-09-01T00:00:00Z');`);
  for (const migration of ['20260919210000_runtime_platform_worker_role', '20260919210100_runtime_worker_namespace_leases']) {
    const source = await readFile(new URL(`${migration}/migration.sql`, migrations), 'utf8').catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (source) sql(source);
  }
  assert.equal(sql("SELECT to_regprocedure('public.register_worker_runtime_process_lease_v2(uuid,text,text,text,text,text,timestamptz,text,text,text,text)') IS NOT NULL;").trim(), 't');
  sql('CREATE ROLE lease_customer LOGIN; GRANT runtime_worker TO lease_customer; CREATE ROLE lease_platform LOGIN; GRANT runtime_platform_worker TO lease_platform; CREATE ROLE lease_api LOGIN; GRANT runtime_api TO lease_api;');
  const customer = '11111111-1111-4111-8111-111111111111';
  const platform = '22222222-2222-4222-8222-222222222222';
  const build = 'a'.repeat(40);
  const imageDigest = `sha256:${'b'.repeat(64)}`;
  const artifact = `sha256:${'c'.repeat(64)}`;
  const proof = `sha256:${'d'.repeat(64)}`;
  const base = (id) => `'${id}','understanding','${build}','${imageDigest}','${artifact}','revision','2026-09-01T00:00:00Z'::timestamptz`;
  const binding = (namespace, workload) => `'cluster-a','${namespace}','${workload}','${proof}'`;
  const as = (role, input) => sql(`SET SESSION AUTHORIZATION ${role}; ${input}`);
  const concurrent = (input) => new Promise((resolve, reject) => {
    const child = spawn('docker', ['--context', 'default', 'exec', '-i', name, 'psql', '-h', '127.0.0.1', '-U', 'postgres', '-d', 'postgres', '-XAt', '-v', 'ON_ERROR_STOP=1'], { timeout: 30000, stdio: ['pipe', 'ignore', 'pipe'] });
    let error = '';
    child.stderr.on('data', (chunk) => { error = (error + chunk.toString()).slice(0, 4096); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, error }));
    child.stdin.end(`SET SESSION AUTHORIZATION lease_customer; BEGIN; ${input}; SELECT pg_sleep(0.1); COMMIT;`);
  });
  const denied = (role, input, expected) => {
    try { as(role, input); assert.fail('forbidden lease operation succeeded'); }
    catch (error) {
      if (error.code === 'ERR_ASSERTION') throw error;
      assert.match(String(error.stderr), expected);
    }
  };
  as('lease_customer', `SELECT public.register_worker_runtime_process_lease_v2(${base(customer)},${binding('default', 'customer-worker')}); SELECT public.heartbeat_worker_runtime_process_lease('${customer}','READY',clock_timestamp());`);
  as('lease_platform', `SELECT public.register_platform_worker_runtime_process_lease_v2(${base(platform)},${binding('platform-automation', 'platform-worker')}); SELECT public.heartbeat_platform_worker_runtime_process_lease('${platform}','READY',clock_timestamp());`);
  assert.equal(sql("SELECT count(*) FROM public.runtime_process_lease WHERE state='READY' AND temporal_cluster_id='cluster-a' AND temporal_namespace IS NOT NULL;").trim(), '2');
  sql('CREATE ROLE lease_other LOGIN; GRANT runtime_worker TO lease_other;');
  await t.test('another login in the same role cannot renew or terminalize this instance', () => {
    denied('lease_other', `SELECT public.heartbeat_worker_runtime_process_lease('${customer}','READY',clock_timestamp());`, /ROLE_DENIED/);
    denied('lease_other', `SELECT public.terminalize_worker_runtime_process_lease_v2(${base(customer)},clock_timestamp(),${binding('default', 'customer-worker')});`, /ROLE_DENIED|IDENTITY_MISMATCH/);
  });
  await t.test('legacy terminalization cannot bypass the bound worker identity', () => {
    denied('lease_other', `SELECT public.terminalize_worker_runtime_process_lease(${base(customer)},clock_timestamp());`, /permission denied|ROLE_DENIED/);
  });
  await t.test('a missing terminal timestamp cannot create a running lease', () => {
    denied('lease_customer', `SELECT public.terminalize_worker_runtime_process_lease_v2(${base(randomUUID())},NULL,${binding('default', 'customer-worker')});`, /TIME_INVALID/);
  });
  denied('lease_customer', `SELECT public.register_platform_worker_runtime_process_lease_v2(${base(randomUUID())},${binding('platform-automation', 'platform-worker')});`, /permission denied|ROLE_DENIED/);
  denied('lease_platform', `SELECT public.heartbeat_worker_runtime_process_lease('${customer}','READY',clock_timestamp());`, /permission denied|ROLE_DENIED/);
  denied('lease_api', `SELECT public.register_worker_runtime_process_lease_v2(${base(randomUUID())},${binding('default', 'customer-worker')});`, /permission denied|ROLE_DENIED/);
  denied('app_user', `UPDATE public.runtime_process_lease SET state='READY';`, /permission denied/);
  denied('lease_customer', `SELECT public.register_worker_runtime_process_lease_v2(${base(randomUUID())},${binding('platform-automation', 'customer-worker')});`, /IDENTITY_INVALID/);
  denied('lease_customer', `SELECT public.register_worker_runtime_process_lease_v2(${base(customer)},'other-cluster','default','customer-worker','${proof}');`, /IDENTITY_MISMATCH/);
  denied('lease_customer', `SELECT public.register_worker_runtime_process_lease_v2(${base(randomUUID()).replace(imageDigest, `sha256:${'e'.repeat(64)}`)},${binding('default', 'customer-worker')});`, /MIXED_DIGEST/);
  denied('lease_customer', `SELECT public.register_worker_runtime_process_lease(${base(randomUUID())});`, /permission denied/);
  denied('lease_customer', `SELECT public.heartbeat_worker_runtime_process_lease('${legacy}','READY',clock_timestamp());`, /UNBOUND|ROLE_DENIED/);
  assert.equal(sql(`SELECT temporal_namespace IS NULL FROM public.runtime_process_lease WHERE instance_id='${legacy}';`).trim(), 't');
  as('lease_platform', `SELECT public.terminalize_platform_worker_runtime_process_lease_v2(${base(platform)},clock_timestamp(),${binding('platform-automation', 'platform-worker')});`);
  denied('lease_platform', `SELECT public.register_platform_worker_runtime_process_lease_v2(${base(platform)},${binding('platform-automation', 'platform-worker')});`, /STOPPED/);
  assert.equal(sql(`SELECT state FROM public.runtime_process_lease WHERE instance_id='${platform}';`).trim(), 'STOPPED');
  await t.test('concurrent different digests cannot both register in one fresh queue', async () => {
    const started = new Date().toISOString();
    const buildCall = (id, digest) => `SELECT public.register_worker_runtime_process_lease_v2('${id}','understanding','${build}','${digest}','${artifact}','revision','${started}','cluster-race','default','customer-worker','${proof}')`;
    const outcomes = await Promise.all([
      concurrent(buildCall(randomUUID(), imageDigest)),
      concurrent(buildCall(randomUUID(), `sha256:${'e'.repeat(64)}`)),
    ]);
    assert.equal(outcomes.filter((value) => value.code === 0).length, 1);
    assert.match(outcomes.find((value) => value.code !== 0).error, /MIXED_DIGEST/);
    assert.equal(sql("SELECT count(*) FROM public.runtime_process_lease WHERE temporal_cluster_id='cluster-race';").trim(), '1');
  });
  await t.test('concurrent replay of the same instance creates one immutable lease', async () => {
    const id = randomUUID();
    const call = `SELECT public.register_worker_runtime_process_lease_v2(${base(id)},${binding('default', 'customer-worker')})`;
    const outcomes = await Promise.all([concurrent(call), concurrent(call)]);
    assert.deepEqual(outcomes.map((value) => value.code), [0, 0]);
    assert.equal(sql(`SELECT count(*) FROM public.runtime_process_lease WHERE instance_id='${id}' AND writer_principal='lease_customer';`).trim(), '1');
  });
  await t.test('real provisioning and permission scripts cover all four exclusive logins atomically', async () => {
    const bin = await mkdtemp(join(tmpdir(), 'parity-lease-psql-'));
    t.after(() => rm(bin, { recursive: true, force: true }));
    await writeFile(join(bin, 'psql'), `#!/bin/sh\nexec docker --context default exec -i -e PGHOST -e PGPORT -e PGDATABASE -e PGUSER -e PGPASSWORD -e RUNTIME_API_LEASE_PASSWORD -e RUNTIME_WORKER_LEASE_PASSWORD -e RUNTIME_PLATFORM_WORKER_LEASE_PASSWORD -e RUNTIME_OUTBOX_RELAY_LEASE_PASSWORD ${name} psql "$@"\n`, { mode: 0o700 });
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, RUNTIME_LEASE_PROVISION_DATABASE_URL: 'postgresql://postgres:test-only@127.0.0.1:5432/postgres', APP_DATABASE_URL: 'postgresql://app_user:test-only@127.0.0.1:5432/postgres' };
    for (const [role, login] of [['API', 'provision_api'], ['WORKER', 'provision_customer'], ['PLATFORM_WORKER', 'provision_platform'], ['OUTBOX_RELAY', 'provision_relay']]) {
      const prefix = `RUNTIME_${role}_LEASE`;
      env[`${prefix}_LOGIN`] = login;
      env[`${prefix}_PASSWORD`] = randomUUID();
      env[`${prefix}_DATABASE_URL`] = `postgresql://${login}:test-only@127.0.0.1:5432/postgres`;
    }
    const provision = fileURLToPath(new URL('../infra/postgres/provision-runtime-lease-principals.sh', import.meta.url));
    const verify = fileURLToPath(new URL('../infra/postgres/verify-runtime-lease-principal-permissions.sh', import.meta.url));
    const run = (script, variables = env) => spawnSync('bash', [script], { env: variables, timeout: 30000, encoding: 'utf8' });
    assert.equal(run(provision).status, 0, 'four-principal provisioning');
    assert.equal(run(verify).status, 0, 'four-principal actual permission matrix');
    sql('CREATE ROLE extra_lease_role; CREATE ROLE bad_lease_login LOGIN NOINHERIT; GRANT runtime_api, extra_lease_role TO bad_lease_login;');
    const failed = run(provision, { ...env, RUNTIME_API_LEASE_LOGIN: 'rollback_api', RUNTIME_WORKER_LEASE_LOGIN: 'rollback_customer', RUNTIME_PLATFORM_WORKER_LEASE_LOGIN: 'bad_lease_login', RUNTIME_OUTBOX_RELAY_LEASE_LOGIN: 'rollback_relay' });
    assert.notEqual(failed.status, 0);
    assert.equal(sql("SELECT count(*) FROM pg_roles WHERE rolname IN ('rollback_api','rollback_customer','rollback_relay');").trim(), '0');
    assert.equal(sql("SELECT rolinherit FROM pg_roles WHERE rolname='bad_lease_login';").trim(), 'f');
    assert.equal(sql("SELECT pg_has_role('bad_lease_login','runtime_api','member') AND pg_has_role('bad_lease_login','extra_lease_role','member');").trim(), 't');
  });
});
