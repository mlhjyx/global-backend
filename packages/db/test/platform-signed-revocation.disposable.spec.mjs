import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { after, before, beforeEach, afterEach, describe, it } from 'node:test';

// Self-owned, no-egress, no published ports/host volumes. Never accepts a DB URL.
const container = `codex-revocation-pg-${randomUUID()}`;
const migrations = fileURLToPath(new URL('../prisma/migrations/', import.meta.url));
const migrationName = '20260908130000_platform_egress_budget_policy_v2';
const login = 'revocation_test_writer';
const issuer = 'https://growthos.example';
const revision = 'b'.repeat(64);
const policyArtifact = 'c'.repeat(64);
const policyEnvelope = 'd'.repeat(64);
const quoteVectors = JSON.parse(readFileSync(new URL('../../contracts/fixtures/platform-authority/platform-execution-technical-quote-v1.json', import.meta.url), 'utf8')).vectors;
let created = false;
let database = 'revocation_test';
const docker = (args, input) => spawnSync('docker', args, { input, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 120000 });
const args = () => ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', database, '-X', '-qAt', '-v', 'ON_ERROR_STOP=1'];
function sql(source, rejects) {
  const result = docker(args(), source);
  if (rejects) {
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stderr, rejects);
  } else assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
function asyncSql(source) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args()); let out = ''; let err = '';
    child.stdout.on('data', value => { out += value; });
    child.stderr.on('data', value => { err += value; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(out.trim()) : reject(new Error(err)));
    child.stdin.end(source);
  });
}
const writer = source => `SET SESSION AUTHORIZATION ${login}; ${source}`;
const quote = value => `'${String(value).replaceAll("'", "''")}'`;
function command(target, overrides = {}) {
  return { issuer, revocationJti: randomUUID(), digest: 'a'.repeat(64), targetIssuer: issuer,
    targetJti: target.jti, schedule: target.schedule, run: target.run, sequence: '1', reason: 'POLICY_DISABLED',
    expiry: new Date(Date.now() + 240000).toISOString(), ...overrides };
}
function apply(c) {
  return `SELECT row_to_json(r)::text FROM apply_platform_revocation_fence_v1(
    ${quote(c.issuer)},${quote(c.revocationJti)}::uuid,${quote(c.digest)},${quote(c.targetIssuer)},
    ${quote(c.targetJti)}::uuid,${quote(c.schedule)},${quote(c.run)},${quote(c.sequence)}::bigint,
    ${quote(c.reason)},${quote(c.expiry)}::timestamptz) r;`;
}
function installPolicy(schedule, expected = 0, artifact = policyArtifact, envelope = policyEnvelope, cap = '100') {
  return `SELECT * FROM install_platform_egress_policy_v2(${quote(schedule)},${expected}::bigint,${quote(artifact)},${quote(envelope)},${cap}::bigint);`;
}
function owner(source) { return `SET SESSION AUTHORIZATION global; ${source}`; }
function target(schedule = 'acq-sweep', options = {}) {
  const vector = quoteVectors.find(row => row.id === schedule);
  const value = { jti: randomUUID(), run: randomUUID(), schedule, workflow: `test-${randomUUID()}`,
    request: vector.input.schedule_request_sha256, cap: options.cap ?? '100', reservations: new Map() };
  value.accountKey = `platform:${value.request}:${value.run}`;
  const admitted = JSON.parse(sql(writer(`SELECT row_to_json(r)::text FROM ingest_and_admit_platform_execution_budget_run_v2(
    ${quote(issuer)},'global-backend:execution-budget',${quote(value.jti)}::uuid,${quote(randomBytes(32).toString('hex'))},
    'execution-budget-grant/v1',${quote(vector.input.purpose)}::execution_budget_purpose,'schedule',${quote(schedule)},${quote(schedule)},
    ${quote(value.request)},${quote(value.workflow)},${quote(value.run)},${quote(revision)},'USD','microusd',
    ${value.cap}::bigint,${value.cap}::bigint,1::bigint,
    statement_timestamp()-interval '30 seconds',statement_timestamp()-interval '20 seconds',statement_timestamp()+interval '4 minutes',
    ${quote(vector.input.purpose)}::execution_budget_purpose,'schedule',${quote(schedule)},${quote(schedule)},
    ${quote(value.request)},${quote(value.workflow)},${quote(value.run)},${quote(revision)}) r;`)));
  value.id = admitted.authority_id; value.accountId = admitted.account_id;
  if (options.install !== false) sql(owner(installPolicy(schedule, Number(sql(`SELECT generation FROM platform_egress_schedule_fence WHERE schedule_id=${quote(schedule)}`)), policyArtifact, policyEnvelope, value.cap)));
  return value;
}
function reserve(t, operation, amount = '0') {
  const key = `budget-${operation}`;
  const row = JSON.parse(sql(writer(`SELECT row_to_json(r)::text FROM reserve_tool_budget('platform',${quote(t.accountKey)},${quote(key)},${amount}::bigint) r;`)));
  assert.equal(row.kind, 'EXECUTE');
  const reserved = { id: row.operation_id, key, amount: String(row.reserved_microusd) };
  t.reservations.set(operation, reserved); return reserved;
}
function v2args(t, operation, changes = {}) {
  const r = t.reservations.get(operation);
  assert.ok(r, 'test must really reserve before creating a fence argument');
  const args = { authority: t.id, schedule: t.schedule, workflow: t.workflow, run: t.run, operation,
    policy: revision, accountKey: t.accountKey, budgetId: r.id, budgetKey: r.key, reserved: r.amount,
    cap: t.cap, expected: r.amount, artifact: policyArtifact, envelope: policyEnvelope, ...changes };
  return `${quote(args.authority)}::uuid,${quote(args.schedule)},${quote(args.workflow)},${quote(args.run)},
    ${quote(args.operation)},${quote(args.policy)},${quote(args.accountKey)},${quote(args.budgetId)}::uuid,
    ${quote(args.budgetKey)},${args.reserved}::bigint,${args.cap}::bigint,${args.expected}::bigint,
    ${quote(args.artifact)},${quote(args.envelope)}`;
}
function authorize(t, operation, changes = {}) {
  if (!t.reservations.has(operation)) reserve(t, operation);
  return `SELECT attempt_id FROM authorize_platform_egress_v2(${v2args(t, operation, changes)});`;
}
function claim(t, id, operation, changes = {}) {
  return `SELECT attempt_id FROM claim_platform_egress_send_v2(${quote(id)}::uuid,${v2args(t, operation, changes)});`;
}
function ackCandidate(overrides = {}) {
  return { commandDigest: 'a'.repeat(64), ackDigest: randomBytes(32).toString('hex'),
    signingKid: 'ack-1', cipherKid: 'delivery-1', ciphertext: randomBytes(64).toString('hex'), ...overrides };
}
function storeAck(receiptId, candidate) {
  return `SELECT row_to_json(d)::text FROM store_platform_fence_ack_v1(${quote(receiptId)}::uuid,
    ${quote(candidate.commandDigest)},${quote(candidate.ackDigest)},${quote(candidate.signingKid)},
    ${quote(candidate.cipherKid)},decode(${quote(candidate.ciphertext)},'hex')) d;`;
}
const readAck = (receiptId, digest = 'a'.repeat(64)) =>
  `SELECT row_to_json(d)::text FROM read_platform_fence_ack_v1(${quote(receiptId)}::uuid,${quote(digest)}) d;`;
function receipt() {
  const t = target(); const c = command(t);
  return JSON.parse(sql(writer(apply(c)))).receipt_id;
}
async function waitSleeping(label) {
  for (let n = 0; n < 30; n++) {
    if (sql(`SELECT count(*) FROM pg_stat_activity WHERE application_name=${quote(label)} AND wait_event='PgSleep'`) === '1') return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail('transaction did not reach the deterministic lock-holding barrier');
}

describe('signed platform revocation on self-owned disposable PostgreSQL 16', () => {
  before(async () => {
    assert.equal(process.env.PLATFORM_REVOCATION_DISPOSABLE_TEST, '1', 'explicit disposable test opt-in required');
    const started = docker(['run', '--pull=never', '--rm', '-d', '--name', container, '--network=none',
      '--tmpfs', '/var/lib/postgresql/data', '-e', 'POSTGRES_HOST_AUTH_METHOD=trust',
      '-e', 'POSTGRES_DB=revocation_test', 'pgvector/pgvector:pg16']);
    assert.equal(started.status, 0, started.stderr); created = true;
    let ready = false;
    for (let n = 0; n < 100; n++) {
      if (docker(['exec', container, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres', '-d', 'revocation_test']).status === 0) { ready = true; break; }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(ready, 'disposable PostgreSQL did not start');
    sql('CREATE ROLE global LOGIN SUPERUSER;');
    const names = readdirSync(migrations).filter(name => name <= migrationName && existsSync(`${migrations}/${name}/migration.sql`)).sort();
    sql('SET ROLE global;\n' + names.map(name => {
      const source = readFileSync(`${migrations}/${name}/migration.sql`, 'utf8');
      // Match Prisma's atomic multi-statement execution for files without their own transaction.
      return /^BEGIN;/m.test(source) ? source : `BEGIN;\n${source}\nCOMMIT;`;
    }).join('\n'));
    sql(`CREATE ROLE ${login} LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
      GRANT execution_budget_platform_writer TO ${login};`);
  });
  after(() => {
    if (created) { const stopped = docker(['stop', container]); assert.equal(stopped.status, 0, stopped.stderr); }
  });
  beforeEach(() => {
    const name = `revocation_case_${randomUUID().replaceAll('-', '')}`;
    sql(`CREATE DATABASE ${name} TEMPLATE revocation_test`);
    database = name;
  });
  afterEach(() => {
    const previous = database; database = 'revocation_test';
    if (previous !== database) {
      assert.match(previous, /^revocation_case_[0-9a-f]{32}$/);
      sql(`DROP DATABASE ${previous}`);
    }
  });

  it('exposes only a writer function and a FORCE RLS immutable receipt', () => {
    const facts = JSON.parse(sql(`SELECT json_build_object(
      'public_execute',has_function_privilege('public','apply_platform_revocation_fence_v1(text,uuid,text,text,uuid,text,text,bigint,text,timestamptz)','EXECUTE'),
      'writer_execute',has_function_privilege('execution_budget_platform_writer','apply_platform_revocation_fence_v1(text,uuid,text,text,uuid,text,text,bigint,text,timestamptz)','EXECUTE'),
      'writer_insert',has_table_privilege('execution_budget_platform_writer','platform_revocation_receipt','INSERT'),
      'app_select',has_table_privilege('app_user','platform_revocation_receipt','SELECT'),
      'rls',(SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid='platform_revocation_receipt'::regclass))::text`));
    assert.deepEqual(facts, { public_execute: false, writer_execute: true, writer_insert: false, app_select: false, rls: true });
  });
  it('atomically revokes, blocks unsent attempts and preserves SENDING with stable replay facts', () => {
    const t = target(); const c = command(t);
    const blocked = sql(writer(authorize(t, 'unsent'))); const sending = sql(writer(authorize(t, 'wire')));
    sql(writer(claim(t, sending, 'wire')));
    const first = JSON.parse(sql(writer(apply(c)))); const replay = JSON.parse(sql(writer(apply(c))));
    assert.equal(first.replay, false); assert.equal(first.generation, 2); assert.equal(first.in_flight_attempts, 1);
    assert.deepEqual(replay, { ...first, replay: true });
    assert.equal(sql(`SELECT state FROM platform_egress_attempt WHERE id=${quote(blocked)}`), 'BLOCKED');
    assert.equal(sql(`SELECT state FROM platform_egress_attempt WHERE id=${quote(sending)}`), 'SENDING');
    assert.equal(sql(`SELECT revoked_at IS NOT NULL FROM execution_budget_authority WHERE id=${quote(t.id)}`), 't');
    sql(writer(claim(t, blocked, 'unsent')), /PLATFORM_EGRESS_SEND_CAS_REJECTED/);
    sql(`UPDATE platform_revocation_receipt SET token_sha256=repeat('f',64) WHERE id=${quote(first.receipt_id)}`, /PLATFORM_REVOCATION_RECEIPT_IMMUTABLE/);
    sql(`DELETE FROM platform_revocation_receipt WHERE id=${quote(first.receipt_id)}`, /PLATFORM_REVOCATION_RECEIPT_IMMUTABLE/);
  });
  it('rejects changed command identity, lower sequence, target mismatch and invalid principal', () => {
    const t = target('intent-sweep'); const c = command(t, { sequence: '2' });
    sql(writer(apply(c)));
    for (const mutation of [{ digest: 'f'.repeat(64) }, { targetJti: randomUUID() }, { reason: 'OPERATOR_HOLD' },
      { sequence: '3' }, { expiry: new Date(Date.now() + 180000).toISOString() }, { schedule: 'acq-sweep' }]) {
      sql(writer(apply({ ...c, ...mutation })), /PLATFORM_REVOCATION_REUSED/);
    }
    sql(writer(apply({ ...c, revocationJti: randomUUID() })), /PLATFORM_REVOCATION_SEQUENCE_CONFLICT/);
    sql(writer(apply({ ...c, revocationJti: randomUUID(), sequence: '1' })), /PLATFORM_REVOCATION_SEQUENCE_CONFLICT/);
    sql(writer(apply(command(t, { sequence: '3', run: randomUUID() }))), /PLATFORM_REVOCATION_SCOPE_MISMATCH/);
    sql(apply(c), /EXECUTION_BUDGET_PLATFORM_WRITER_PRINCIPAL_INVALID/);
    sql(`SET SESSION AUTHORIZATION app_user; ${apply(c)}`, /permission denied/);
  });
  it('rejects malformed command bindings at the SQL boundary', () => {
    const t = target(); const c = command(t);
    for (const mutation of [{ revocationJti: '00000000-0000-0000-0000-000000000000' },
      { digest: 'A'.repeat(64) }, { sequence: '0' }, { sequence: '-1' }, { reason: 'arbitrary' },
      { targetIssuer: 'https://other.example' }, { schedule: 'unknown' }, { run: 'invalid' }, { expiry: 'infinity' }]) {
      sql(writer(apply({ ...c, ...mutation })), /PLATFORM_REVOCATION_INVALID/);
    }
    assert.equal(sql('SELECT count(*) FROM platform_revocation_receipt'), '0');
  });
  it('advances control-plane sequence monotonically and replays the old immutable facts', () => {
    const t = target(); const firstCommand = command(t, { sequence: '12' });
    const first = JSON.parse(sql(writer(apply(firstCommand))));
    const second = JSON.parse(sql(writer(apply(command(t, { sequence: '15', reason: 'OPERATOR_HOLD' })))));
    assert.equal(second.generation, 3);
    assert.equal(sql(`SELECT fence_sequence FROM platform_egress_schedule_fence WHERE schedule_id='acq-sweep'`), '15');
    assert.deepEqual(JSON.parse(sql(writer(apply(firstCommand)))), { ...first, replay: true });
    sql(writer(apply(command(t, { sequence: '14' }))), /PLATFORM_REVOCATION_SEQUENCE_CONFLICT/);
    assert.equal(sql(`SELECT count(*) FROM execution_budget_authority_revocation WHERE authority_id=${quote(t.id)}`), '1');
  });
  it('allows expired exact receipt replay but never an expired first fence', async () => {
    const t = target('sanctions-refresh'); const c = command(t, { expiry: new Date(Date.now() + 1200).toISOString() });
    const first = JSON.parse(sql(writer(apply(c))));
    await new Promise(resolve => setTimeout(resolve, 1300));
    assert.deepEqual(JSON.parse(sql(writer(apply(c)))), { ...first, replay: true });
    sql(writer(apply({ ...c, revocationJti: randomUUID(), sequence: '2' })), /PLATFORM_REVOCATION_EXPIRED/);
  });
  it('rolls back receipt, generation and revocation together', () => {
    const t = target(); const c = command(t, { sequence: '100' });
    sql(writer(`BEGIN; ${apply(c)} ROLLBACK;`));
    assert.equal(sql(`SELECT count(*) FROM platform_revocation_receipt WHERE revocation_jti=${quote(c.revocationJti)}`), '0');
    assert.equal(sql(`SELECT generation || ':' || state FROM platform_egress_schedule_fence WHERE schedule_id='acq-sweep'`), '1:ACTIVE');
    assert.equal(sql(`SELECT revoked_at IS NULL FROM execution_budget_authority WHERE id=${quote(t.id)}`), 't');
  });
  it('serializes concurrent duplicate commands to one original receipt', async () => {
    const t = target(); const c = command(t, { sequence: '101' });
    const values = await Promise.all(Array.from({ length: 8 }, () => asyncSql(writer(apply(c)))));
    const rows = values.map(value => JSON.parse(value));
    assert.equal(new Set(rows.map(row => row.receipt_id)).size, 1);
    assert.equal(rows.filter(row => !row.replay).length, 1);
  });
  it('makes a committed send cut visible as in-flight without deadlocking the later fence', async () => {
    const t = target(); const c = command(t, { sequence: '102' }); const attempt = sql(writer(authorize(t, 'race-send')));
    const sender = asyncSql(writer(`SET application_name='revocation-send-first'; BEGIN; ${claim(t, attempt, 'race-send')} SELECT pg_sleep(1); COMMIT;`));
    await waitSleeping('revocation-send-first');
    const receipt = asyncSql(writer(apply(c))); await sender;
    assert.equal(JSON.parse(await receipt).in_flight_attempts, 1);
  });
  it('blocks a send whose final CAS occurs after the fence commit', async () => {
    const t = target(); const c = command(t, { sequence: '103' }); const attempt = sql(writer(authorize(t, 'race-fence')));
    const fence = asyncSql(writer(`SET application_name='revocation-fence-first'; BEGIN; ${apply(c)} SELECT pg_sleep(1); COMMIT;`));
    await waitSleeping('revocation-fence-first');
    const rejection = assert.rejects(asyncSql(writer(claim(t, attempt, 'race-fence'))), /PLATFORM_EGRESS_SEND_CAS_REJECTED/);
    await Promise.all([fence, rejection]);
  });
  it('rechecks expiry after waiting on the schedule row, not the statement start', async () => {
    const t = target(); const c = command(t, { expiry: new Date(Date.now() + 1200).toISOString() });
    const blocker = asyncSql(`SET application_name='revocation-expiry-barrier'; BEGIN;
      SELECT schedule_id FROM platform_egress_schedule_fence WHERE schedule_id='acq-sweep' FOR UPDATE;
      SELECT pg_sleep(1.6); COMMIT;`);
    await waitSleeping('revocation-expiry-barrier');
    const rejection = assert.rejects(asyncSql(writer(apply(c))), /PLATFORM_REVOCATION_EXPIRED/);
    await Promise.all([blocker, rejection]);
    assert.equal(sql('SELECT count(*) FROM platform_revocation_receipt'), '0');
    assert.equal(sql(`SELECT generation || ':' || state FROM platform_egress_schedule_fence WHERE schedule_id='acq-sweep'`), '1:ACTIVE');
  });
  for (const stage of ['authorize', 'claim']) {
    it(`rejects ${stage} when authority expires while waiting for the final locks`, async () => {
      const t = target();
      reserve(t, 'expiry-wire');
      const id = stage === 'claim' ? sql(writer(authorize(t, 'expiry-wire'))) : null;
      sql(`UPDATE execution_budget_authority SET expires_at=clock_timestamp()+interval '1.2 seconds' WHERE id=${quote(t.id)}`);
      const label = `revocation-${stage}-expiry`;
      const blocker = asyncSql(`SET application_name=${quote(label)}; BEGIN;
        SELECT schedule_id FROM platform_egress_schedule_fence WHERE schedule_id='acq-sweep' FOR UPDATE;
        SELECT pg_sleep(1.6); COMMIT;`);
      await waitSleeping(label);
      const operation = stage === 'claim' ? claim(t, id, 'expiry-wire') : authorize(t, 'expiry-wire');
      const rejection = assert.rejects(asyncSql(writer(operation)), /PLATFORM_EGRESS_NOT_AUTHORIZED|PLATFORM_EGRESS_SEND_CAS_REJECTED/);
      await Promise.all([blocker, rejection]);
      assert.equal(sql(`SELECT count(*) FROM platform_egress_attempt WHERE authority_id=${quote(t.id)} AND state='SENDING'`), '0');
    });
  }
  it('does not reverse the existing standalone fence and legacy revocation locks', async () => {
    const t = target();
    const oldFence = asyncSql(writer(`SET application_name='revocation-old-fence'; BEGIN;
      SELECT * FROM fence_platform_schedule_v1('acq-sweep','OPERATOR_HOLD'); SELECT pg_sleep(1); COMMIT;`));
    await waitSleeping('revocation-old-fence');
    const nextFence = asyncSql(writer(apply(command(t))));
    const [, output] = await Promise.all([oldFence, nextFence]);
    assert.equal(JSON.parse(output).generation, 3);

    const other = target('intent-sweep');
    const oldRevoke = asyncSql(writer(`SET application_name='revocation-old-revoke'; BEGIN;
      SELECT * FROM revoke_platform_execution_authority_v1(${quote(other.id)}::uuid,'OPERATOR_HOLD',clock_timestamp());
      SELECT pg_sleep(1); COMMIT;`));
    await waitSleeping('revocation-old-revoke');
    const nextRevoke = asyncSql(writer(apply(command(other))));
    const [, otherOutput] = await Promise.all([oldRevoke, nextRevoke]);
    assert.equal(JSON.parse(otherOutput).generation, 2);
  });
  it('ACK delivery is first-wins and read returns byte-identical encrypted facts', () => {
    const id = receipt(); const candidate = ackCandidate();
    assert.equal(sql(writer(readAck(id))), '');
    const first = JSON.parse(sql(writer(storeAck(id, candidate))));
    assert.deepEqual(first, { receipt_id: id, command_token_sha256: candidate.commandDigest,
      ack_token_sha256: candidate.ackDigest, signing_key_id: candidate.signingKid,
      cipher_key_id: candidate.cipherKid, ciphertext: `\\x${candidate.ciphertext}` });
    const different = ackCandidate({ signingKid: 'ack-rotated', cipherKid: 'delivery-rotated' });
    assert.deepEqual(JSON.parse(sql(writer(storeAck(id, different)))), first);
    assert.deepEqual(JSON.parse(sql(writer(readAck(id)))), first);
    assert.equal(sql('SELECT count(*) FROM platform_fence_ack_delivery'), '1');
  });
  it('ACK delivery serializes twenty different concurrent candidates to exactly one winner', async () => {
    const id = receipt();
    const candidates = Array.from({ length: 20 }, () => ackCandidate());
    const outputs = await Promise.all(candidates.map(candidate => asyncSql(writer(storeAck(id, candidate)))));
    const rows = outputs.map(output => JSON.parse(output));
    for (const row of rows) assert.deepEqual(row, rows[0]);
    assert.equal(candidates.filter(candidate => candidate.ackDigest === rows[0].ack_token_sha256
      && `\\x${candidate.ciphertext}` === rows[0].ciphertext).length, 1);
    assert.deepEqual(JSON.parse(sql(writer(readAck(id)))), rows[0]);
    assert.equal(sql('SELECT count(*) FROM platform_fence_ack_delivery'), '1');
  });
  it('ACK delivery rejects missing receipts and mismatched command digests before any replay', () => {
    const id = receipt(); const candidate = ackCandidate();
    for (const missing of [randomUUID()]) {
      sql(writer(readAck(missing)), /PLATFORM_FENCE_ACK_BINDING_INVALID/);
      sql(writer(storeAck(missing, candidate)), /PLATFORM_FENCE_ACK_BINDING_INVALID/);
    }
    const wrong = 'f'.repeat(64);
    sql(writer(readAck(id, wrong)), /PLATFORM_FENCE_ACK_BINDING_INVALID/);
    sql(writer(storeAck(id, { ...candidate, commandDigest: wrong })), /PLATFORM_FENCE_ACK_BINDING_INVALID/);
    sql(writer(storeAck(id, candidate)));
    sql(writer(storeAck(id, { ...candidate, commandDigest: wrong })), /PLATFORM_FENCE_ACK_BINDING_INVALID/);
    sql(writer(readAck(id, wrong)), /PLATFORM_FENCE_ACK_BINDING_INVALID/);
  });
  it('ACK delivery shape checks bound hashes, key ids and ciphertext without claiming cryptographic verification', () => {
    const id = receipt(); const candidate = ackCandidate();
    for (const mutation of [{ commandDigest: 'A'.repeat(64) }, { ackDigest: 'f'.repeat(63) },
      { signingKid: '' }, { signingKid: 'a'.repeat(65) }, { signingKid: 'key\n' }, { signingKid: '密钥' },
      { cipherKid: '' }, { cipherKid: '-key' }, { cipherKid: 'a'.repeat(65) },
      { ciphertext: 'ab'.repeat(28) }, { ciphertext: 'ab'.repeat(16413) }]) {
      sql(writer(storeAck(id, { ...candidate, ...mutation })), /PLATFORM_FENCE_ACK_INVALID/);
    }
    sql(writer(readAck(id, 'bad')), /PLATFORM_FENCE_ACK_INVALID/);
    sql(writer(storeAck(id, { ...candidate, ciphertext: 'ab'.repeat(29) })));
    sql(writer(`BEGIN; ${storeAck(id, { ...candidate, ciphertext: 'cd'.repeat(16412) })} ROLLBACK;`));
    assert.equal(sql('SELECT count(*) FROM platform_fence_ack_delivery'), '1');
  });
  it('ACK delivery has exact function ACLs, FORCE RLS, no direct DML and immutable rows', () => {
    const id = receipt(); const candidate = ackCandidate();
    sql(writer(storeAck(id, candidate)));
    const functions = ['read_platform_fence_ack_v1(uuid,text)', 'store_platform_fence_ack_v1(uuid,text,text,text,text,bytea)'];
    for (const signature of functions) {
      assert.equal(sql(`SELECT has_function_privilege('execution_budget_platform_writer',${quote(signature)},'EXECUTE')`), 't');
      for (const role of ['public', 'app_user', 'runtime_api', 'runtime_worker', 'runtime_outbox_relay']) {
        assert.equal(sql(`SELECT has_function_privilege(${quote(role)},${quote(signature)},'EXECUTE')`), 'f');
      }
    }
    assert.equal(sql(`SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid='platform_fence_ack_delivery'::regclass`), 't');
    for (const role of [login, 'app_user', 'runtime_api', 'runtime_worker', 'runtime_outbox_relay']) {
      assert.equal(sql(`SELECT has_table_privilege(${quote(role)},'platform_fence_ack_delivery','SELECT,INSERT,UPDATE,DELETE,TRUNCATE')`), 'f');
      sql(`SET SESSION AUTHORIZATION ${role}; SELECT * FROM platform_fence_ack_delivery`, /permission denied/);
    }
    sql(readAck(id), /EXECUTION_BUDGET_PLATFORM_WRITER_PRINCIPAL_INVALID/);
    sql(storeAck(id, candidate), /EXECUTION_BUDGET_PLATFORM_WRITER_PRINCIPAL_INVALID/);
    sql(`UPDATE platform_fence_ack_delivery SET ack_token_sha256=repeat('f',64) WHERE receipt_id=${quote(id)}`, /PLATFORM_FENCE_ACK_IMMUTABLE/);
    sql(`DELETE FROM platform_fence_ack_delivery WHERE receipt_id=${quote(id)}`, /PLATFORM_FENCE_ACK_IMMUTABLE/);
    sql('TRUNCATE platform_fence_ack_delivery', /PLATFORM_FENCE_ACK_IMMUTABLE/);
  });
  it('ACK delivery rolls back with its outer transaction and does not mutate original receipt facts', () => {
    const id = receipt(); const before = sql(`SELECT row_to_json(r)::text FROM platform_revocation_receipt r WHERE id=${quote(id)}`);
    sql(writer(`BEGIN; ${storeAck(id, ackCandidate())} ROLLBACK;`));
    assert.equal(sql(writer(readAck(id))), '');
    assert.equal(sql('SELECT count(*) FROM platform_fence_ack_delivery'), '0');
    assert.equal(sql(`SELECT row_to_json(r)::text FROM platform_revocation_receipt r WHERE id=${quote(id)}`), before);
  });

  it('v2 holds unbound policy, denies runtime policy installation and closes old weak send functions', () => {
    const t = target('acq-sweep', { install: false }); reserve(t, 'wire');
    const state = JSON.parse(sql(writer(`SELECT row_to_json(r)::text FROM inspect_platform_egress_policy_v2('acq-sweep') r`)));
    assert.equal(state.policy_artifact_sha256, null); assert.equal(state.execution_envelope_sha256, null);
    assert.equal(state.required_cap_microusd, null);
    sql(writer(authorize(t, 'wire')), /PLATFORM_EGRESS_POLICY_UNAVAILABLE/);
    sql(writer(installPolicy('acq-sweep')), /permission denied/);
    sql(installPolicy('acq-sweep'), /PLATFORM_EGRESS_POLICY_INSTALL_PRINCIPAL_INVALID/);
    for (const signature of ['authorize_platform_egress_v1(uuid,text,text,text,text,text)',
      'claim_platform_egress_send_v1(uuid,uuid,text,text,text,text,text)']) {
      assert.equal(sql(`SELECT has_function_privilege(${quote(login)},${quote(signature)},'EXECUTE')`), 'f');
    }
    sql(owner(installPolicy('acq-sweep')));
    const id = sql(writer(authorize(t, 'wire'))); assert.equal(sql(writer(claim(t, id, 'wire'))), id);
  });
  it('v2 binds a real zero reservation and permits spending exactly the remaining cap without double reservation', () => {
    const t = target(); reserve(t, 'all', '100');
    const id = sql(writer(authorize(t, 'all')));
    assert.equal(sql(writer(claim(t, id, 'all'))), id);
    const row = JSON.parse(sql(`SELECT row_to_json(a)::text FROM platform_egress_attempt a WHERE id=${quote(id)}`));
    assert.equal(row.account_id, t.accountId); assert.equal(row.account_generation, 1);
    assert.equal(row.budget_operation_id, t.reservations.get('all').id);
    assert.equal(row.budget_operation_key, 'budget-all'); assert.equal(row.reserved_microusd, 100);
  });
  it('v2 child sends independently share one parent reservation without reserving twice', () => {
    const t = target(); const parent = reserve(t, 'parent-pages', '100');
    const firstKey = '1'.repeat(64); const secondKey = '2'.repeat(64);
    const budgetFacts = `SELECT json_build_object('account',to_jsonb(a),'operation',to_jsonb(o))::text
      FROM tool_budget_account a JOIN tool_budget_operation o ON o.account_id=a.id
      WHERE a.id=${quote(t.accountId)} AND o.id=${quote(parent.id)}`;
    const originalBudget = sql(budgetFacts);

    const first = sql(writer(authorize(t, 'parent-pages', { operation: firstKey })));
    assert.equal(sql(writer(claim(t, first, 'parent-pages', { operation: firstKey }))), first);
    assert.equal(sql(writer(`SELECT acknowledge_platform_egress_v1(${quote(first)}::uuid,NULL)`)), 't');
    const firstFacts = sql(`SELECT row_to_json(a)::text FROM platform_egress_attempt a WHERE id=${quote(first)}`);
    const second = sql(writer(authorize(t, 'parent-pages', { operation: secondKey })));
    assert.notEqual(second, first);
    assert.equal(sql(writer(claim(t, second, 'parent-pages', { operation: secondKey }))), second);
    for (const [id, operation] of [[first, firstKey], [second, secondKey]]) {
      sql(writer(claim(t, id, 'parent-pages', { operation })), /PLATFORM_EGRESS_ATTEMPT_REUSED/);
    }
    const attempts = JSON.parse(sql(`SELECT json_agg(json_build_object('operation_key',operation_key,
      'budget_operation_id',budget_operation_id,'budget_operation_key',budget_operation_key,
      'reserved_microusd',reserved_microusd,'state',state) ORDER BY operation_key)::text
      FROM platform_egress_attempt WHERE authority_id=${quote(t.id)}`));
    assert.deepEqual(attempts, [
      { operation_key: firstKey, budget_operation_id: parent.id, budget_operation_key: parent.key, reserved_microusd: 100, state: 'ACKNOWLEDGED' },
      { operation_key: secondKey, budget_operation_id: parent.id, budget_operation_key: parent.key, reserved_microusd: 100, state: 'SENDING' },
    ]);
    assert.equal(sql(`SELECT count(*) FROM tool_budget_operation WHERE account_id=${quote(t.accountId)}`), '1');
    assert.equal(sql(budgetFacts), originalBudget);
    assert.equal(sql(`SELECT row_to_json(a)::text FROM platform_egress_attempt a WHERE id=${quote(first)}`), firstFacts);
  });
  it('v2 child sends retain the first ACK and parent reservation when signed revocation wins before the second send', () => {
    const t = target(); const parent = reserve(t, 'parent-pages', '100');
    const firstKey = '1'.repeat(64); const secondKey = '2'.repeat(64);
    const first = sql(writer(authorize(t, 'parent-pages', { operation: firstKey })));
    assert.equal(sql(writer(claim(t, first, 'parent-pages', { operation: firstKey }))), first);
    assert.equal(sql(writer(`SELECT acknowledge_platform_egress_v1(${quote(first)}::uuid,NULL)`)), 't');
    const firstFacts = sql(`SELECT row_to_json(a)::text FROM platform_egress_attempt a WHERE id=${quote(first)}`);
    const second = sql(writer(authorize(t, 'parent-pages', { operation: secondKey })));
    // Use the real signed-command persistence boundary, not the legacy unsigned kill switch.
    // Signature authentication is covered by receiver tests; this SQL fixture supplies its verified bindings.
    const revokeCommand = command(t);
    const revoked = JSON.parse(sql(writer(apply(revokeCommand))));
    assert.equal(revoked.replay, false); assert.equal(revoked.in_flight_attempts, 0);
    sql(writer(claim(t, second, 'parent-pages', { operation: secondKey })), /PLATFORM_EGRESS_SEND_CAS_REJECTED/);
    sql(writer(authorize(t, 'parent-pages', { operation: secondKey })), /PLATFORM_EGRESS_SEND_CAS_REJECTED/);
    assert.equal(sql(`SELECT state FROM platform_egress_attempt WHERE id=${quote(second)}`), 'BLOCKED');
    assert.equal(sql(`SELECT row_to_json(a)::text FROM platform_egress_attempt a WHERE id=${quote(first)}`), firstFacts);
    assert.equal(sql(`SELECT count(*) FROM tool_budget_operation WHERE account_id=${quote(t.accountId)}`), '1');
    assert.equal(sql(`SELECT status||':'||reserved_microusd FROM tool_budget_operation WHERE id=${quote(parent.id)}`), 'RESERVED:100');
    assert.equal(sql(`SELECT reserved_microusd||':'||charged_microusd FROM tool_budget_account WHERE id=${quote(t.accountId)}`), '100:0');
    assert.equal(sql(`SELECT count(*) FROM platform_egress_attempt WHERE authority_id=${quote(t.id)} AND state='SENDING'`), '0');
    assert.equal(sql(`SELECT count(*) FROM platform_revocation_receipt WHERE id=${quote(revoked.receipt_id)}
      AND target_jti=${quote(t.jti)} AND revocation_jti=${quote(revokeCommand.revocationJti)}
      AND token_sha256=${quote(revokeCommand.digest)}`), '1');
  });
  it('v2 rejects mismatched operation, account, run, policy and amount at both stages', () => {
    const t = target(); reserve(t, 'wire', '10'); const id = sql(writer(authorize(t, 'wire')));
    const other = target('intent-sweep'); const otherOp = reserve(other, 'other', '10');
    for (const mutation of [{ budgetId: randomUUID() }, { budgetId: otherOp.id }, { budgetKey: 'other-key' },
      { accountKey: other.accountKey }, { run: randomUUID() }, { workflow: 'different' },
      { reserved: '0' }, { reserved: '11' }, { expected: '9' }, { cap: '99' },
      { policy: 'a'.repeat(64) }, { artifact: 'a'.repeat(64) }, { envelope: 'a'.repeat(64) }]) {
      sql(writer(authorize(t, 'wire', mutation)), /PLATFORM_EGRESS_(BINDING_INVALID|NOT_AUTHORIZED|POLICY_DRIFT|BUDGET_NOT_AUTHORIZED|ATTEMPT_REUSED)/);
      sql(writer(claim(t, id, 'wire', mutation)), /PLATFORM_EGRESS_(BINDING_INVALID|NOT_AUTHORIZED|POLICY_DRIFT|BUDGET_NOT_AUTHORIZED|SEND_CAS_REJECTED)/);
    }
    assert.equal(sql(`SELECT state FROM platform_egress_attempt WHERE id=${quote(id)}`), 'AUTHORIZED');
  });
  for (const terminal of ['close', 'exhaust', 'release', 'settle', 'unknown', 'generation']) {
    it(`v2 rechecks ${terminal} after authorize and refuses the final send cut`, () => {
      const t = target(); const reserved = reserve(t, 'wire', '10'); const id = sql(writer(authorize(t, 'wire')));
      if (terminal === 'close') sql(writer(`SELECT close_tool_budget('platform',${quote(t.accountKey)},false)`));
      if (terminal === 'exhaust') sql(writer(`SELECT * FROM reserve_tool_budget('platform',${quote(t.accountKey)},'over-cap',101::bigint)`));
      if (terminal === 'release') sql(writer(`SELECT * FROM release_tool_budget('platform',${quote(reserved.id)}::uuid)`));
      if (terminal === 'settle') sql(writer(`SELECT * FROM settle_tool_budget('platform',${quote(reserved.id)}::uuid,10::bigint,NULL,NULL,NULL,NULL,NULL,NULL)`));
      if (terminal === 'unknown') sql(writer(`SELECT * FROM mark_tool_budget_result_unknown_v5('platform',${quote(reserved.id)}::uuid,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL)`));
      if (terminal === 'generation') {
        sql(`UPDATE tool_budget_account SET generation=generation+1 WHERE id=${quote(t.accountId)}`, /TOOL_BUDGET_UNSETTLED_OPERATIONS/);
        sql(writer(`SELECT * FROM release_tool_budget('platform',${quote(reserved.id)}::uuid)`));
        sql(`UPDATE tool_budget_account SET generation=generation+1 WHERE id=${quote(t.accountId)}`);
        reserve(t, 'wire', '10');
      }
      sql(writer(claim(t, id, 'wire')), /PLATFORM_EGRESS_(BUDGET_NOT_AUTHORIZED|SEND_CAS_REJECTED)/);
      assert.equal(sql(`SELECT state FROM platform_egress_attempt WHERE id=${quote(id)}`), 'AUTHORIZED');
    });
  }
  it('v2 policy shift blocks old authorized attempts but preserves sends and the revocation sequence', () => {
    const t = target(); const old = sql(writer(authorize(t, 'old'))); const sending = sql(writer(authorize(t, 'sending')));
    sql(writer(claim(t, sending, 'sending')));
    sql(owner(installPolicy('acq-sweep', 1, policyArtifact, 'e'.repeat(64))));
    sql(writer(claim(t, old, 'old')), /PLATFORM_EGRESS_(POLICY_DRIFT|SEND_CAS_REJECTED)/);
    assert.equal(sql(`SELECT state FROM platform_egress_attempt WHERE id=${quote(old)}`), 'BLOCKED');
    assert.equal(sql(`SELECT state FROM platform_egress_attempt WHERE id=${quote(sending)}`), 'SENDING');
    assert.equal(sql(`SELECT fence_sequence FROM platform_egress_schedule_fence WHERE schedule_id='acq-sweep'`), '0');
    sql(writer(apply(command(t, { sequence: '7' }))));
    sql(owner(installPolicy('acq-sweep', 3)), /PLATFORM_EGRESS_POLICY_DISABLED/);
    assert.equal(sql(`SELECT fence_sequence FROM platform_egress_schedule_fence WHERE schedule_id='acq-sweep'`), '7');
  });
  it('v2 never upgrades a legacy attempt by guessing missing budget bindings', () => {
    const t = target(); reserve(t, 'legacy'); const id = randomUUID();
    sql(`INSERT INTO platform_egress_attempt(id,authority_id,schedule_id,workflow_id,workflow_run_id,operation_key,policy_revision,generation)
      VALUES (${quote(id)},${quote(t.id)},${quote(t.schedule)},${quote(t.workflow)},${quote(t.run)},'legacy',${quote(revision)},1)`);
    sql(writer(authorize(t, 'legacy')), /PLATFORM_EGRESS_ATTEMPT_REUSED/);
    sql(writer(claim(t, id, 'legacy')), /PLATFORM_EGRESS_SEND_CAS_REJECTED/);
    assert.equal(sql(`SELECT account_id IS NULL AND budget_operation_id IS NULL FROM platform_egress_attempt WHERE id=${quote(id)}`), 't');
  });
  for (const transition of ['release', 'settle', 'unknown']) {
  it(`v2 takes the established budget advisory before account/operation locks during concurrent ${transition}`, async () => {
    const t = target(); const reserved = reserve(t, 'wire', '10'); const id = sql(writer(authorize(t, 'wire')));
    const statement = transition === 'release' ? `SELECT * FROM release_tool_budget('platform',${quote(reserved.id)}::uuid);`
      : transition === 'settle' ? `SELECT * FROM settle_tool_budget('platform',${quote(reserved.id)}::uuid,10::bigint,NULL,NULL,NULL,NULL,NULL,NULL);`
        : `SELECT * FROM mark_tool_budget_result_unknown_v5('platform',${quote(reserved.id)}::uuid,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL);`;
    const label = `v2-budget-${transition}`;
    const released = asyncSql(writer(`SET application_name=${quote(label)}; BEGIN;
      ${statement} SELECT pg_sleep(1); COMMIT;`));
    await waitSleeping(label);
    const rejected = assert.rejects(asyncSql(writer(claim(t, id, 'wire'))), /PLATFORM_EGRESS_(BUDGET_NOT_AUTHORIZED|SEND_CAS_REJECTED)/);
    await Promise.all([released, rejected]);
    assert.equal(sql(`SELECT state FROM platform_egress_attempt WHERE id=${quote(id)}`), 'AUTHORIZED');
  });
  }
  it('v2 rejects a legacy amount unit, changed authorized cap and broken account totals', () => {
    const t = target(); const reserved = reserve(t, 'wire', '10'); const id = sql(writer(authorize(t, 'wire')));
    for (const mutation of [
      `UPDATE tool_budget_operation SET amount_unit='cent',reserved_microusd=NULL WHERE id=${quote(reserved.id)}`,
      `UPDATE tool_budget_account SET authorized_cap_microusd=99 WHERE id=${quote(t.accountId)}`,
      `UPDATE tool_budget_account SET reserved_microusd=9 WHERE id=${quote(t.accountId)}`,
      `UPDATE tool_budget_account SET charged_microusd=91 WHERE id=${quote(t.accountId)}`,
    ]) {
      // Mutations obey table constraints, but not the locked cross-row contract.
      sql(`BEGIN; ${mutation}; SET SESSION AUTHORIZATION ${login}; ${claim(t, id, 'wire')}; ROLLBACK;`, /PLATFORM_EGRESS_BUDGET_NOT_AUTHORIZED/);
    }
    assert.equal(sql(`SELECT state FROM platform_egress_attempt WHERE id=${quote(id)}`), 'AUTHORIZED');
  });
  it('v2 policy installation is CAS-bound, idempotent, and rolls back its generation and blocked attempts', () => {
    const t = target(); const id = sql(writer(authorize(t, 'wire')));
    assert.equal(sql(owner(installPolicy(t.schedule, 1))), '1|t');
    sql(owner(installPolicy(t.schedule, 0, policyArtifact, 'e'.repeat(64))), /PLATFORM_EGRESS_POLICY_GENERATION_CONFLICT/);
    sql(owner(`BEGIN; ${installPolicy(t.schedule, 1, policyArtifact, 'e'.repeat(64))} ROLLBACK;`));
    assert.equal(sql(`SELECT generation FROM platform_egress_schedule_fence WHERE schedule_id='acq-sweep'`), '1');
    assert.equal(sql(`SELECT state FROM platform_egress_attempt WHERE id=${quote(id)}`), 'AUTHORIZED');
  });
});
