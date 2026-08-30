import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import * as safeJsonFacade from './governance-approval-safe-json.mjs';
import {
  buildApprovalReceiptArtifact,
  parseApprovalJson,
  readApprovalJson,
  renderApprovalReceiptCore,
  sha256Prefixed,
  verifyApprovalReceiptRawSha256,
} from './governance-approval-safe-json.mjs';

const MAX_BYTES = 1_048_576;
const INTERNAL_SEAM_VERSION = 'approval-safe-json-structural-test-seam/v1';

const digest = (character) => `sha256:${character.repeat(64)}`;

const machineCheckEvidence = () => [{
  github_app_id: 15368,
  github_app_slug: 'github-actions',
  check_run_id: 81001,
  check_suite_id: 71001,
  context: 'approval/readback',
  workflow_id: 61001,
  workflow_path: '.github/workflows/approval-readback.yml',
  trusted_base_workflow_blob_sha: 'd'.repeat(40),
  actions_run_id: 51001,
  actions_run_attempt: 1,
  actions_run_event: 'pull_request_target',
  actions_run_head_sha: 'c'.repeat(40),
  actions_run_conclusion: 'success',
  reusable_signer: null,
}];

const approvalCore = (overrides = {}) => ({
  receipt_id: 'approval-receipt-0001',
  repository: { id: 1291151138, full_name: 'mlhjyx/global-backend' },
  authority_revision: 'approval-authorities/r1',
  authority_sha256: digest('a'),
  role: 'OWN-PRODUCT',
  actor_id: 42,
  actor_login: 'approval-owner',
  decision_adr: 'ADR-027',
  decision_revision: 'program-c/decision-r1',
  policy_revision: 'program-c/policy-r1',
  pr_number: 426,
  base_sha: 'b'.repeat(40),
  head_sha: 'c'.repeat(40),
  approved_at: '2026-08-30T12:34:56.789Z',
  trust_class: 'TRUSTED_BASE_VERIFIED',
  machine_check_evidence: machineCheckEvidence(),
  ...overrides,
});

const withTempDirectory = async (callback) => {
  const directory = await mkdtemp(join(tmpdir(), 'approval-safe-json-'));
  try {
    await callback(directory);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
};

const expectApprovalError = async (callback, code) => {
  await assert.rejects(callback, (error) => {
    assert.match(error.message, new RegExp(`^APPROVAL_JSON_${code}$`));
    return true;
  });
};

const expectApprovalErrorSync = (callback, code) => {
  assert.throws(callback, (error) => error.message === `APPROVAL_JSON_${code}`);
};

test('parseApprovalJson rejects literal and escaped duplicate object keys without reflecting input', () => {
  for (const text of [
    '{"actor":"sensitive-approval-input","actor":"second"}',
    '{"actor":"sensitive-approval-input","\\u0061ctor":"second"}',
    '{"outer":{"id":1,"id":2}}',
  ]) {
    assert.throws(
      () => parseApprovalJson(text, 'approval'),
      (error) => {
        assert.equal(error.message, 'APPROVAL_JSON_DUPLICATE_KEY');
        assert.doesNotMatch(error.message, /sensitive-approval-input/);
        return true;
      },
    );
  }
});

test('parseApprovalJson rejects Unicode whitespace, negative zero, and non-finite numbers', () => {
  for (const text of ['{\u00a0"id":1}', '{"value":-0}', '{"value":1e400}']) {
    assert.throws(
      () => parseApprovalJson(text, 'approval'),
      (error) => error.message.startsWith('APPROVAL_JSON_'),
    );
  }
});

test('parseApprovalJson permits only valid JSON values with finite safe numbers', () => {
  assert.deepEqual(
    parseApprovalJson('{"array":[true,null,"ok",0,1.5e2]}', 'approval'),
    { array: [true, null, 'ok', 0, 150] },
  );
  expectApprovalErrorSync(() => parseApprovalJson('{"value":9007199254740992}', 'approval'), 'NUMBER');
});

test('parseApprovalJson rejects non-canonical number lexemes before numeric normalization', () => {
  for (const text of ['1.0', '1e0', '1E+0', '0.10', '1e+2', '1e02', '1e-0', '-0.1e+1']) {
    expectApprovalErrorSync(() => parseApprovalJson(`{"value":${text}}`, 'approval'), 'NUMBER_LEXEME');
  }
  for (const [text, value] of [['0', 0], ['-1', -1], ['0.1', 0.1], ['1e2', 100], ['1e-2', 0.01], ['1234567890123456', 1234567890123456]]) {
    assert.deepEqual(parseApprovalJson(`{"value":${text}}`, 'approval'), { value });
  }
});

test('readApprovalJson decodes UTF-8 fatally and preserves bounded raw bytes', async () => {
  await withTempDirectory(async (directory) => {
    const validPath = join(directory, 'valid.json');
    const invalidPath = join(directory, 'invalid.json');
    await writeFile(validPath, Buffer.from('{"approved":true}\n', 'utf8'));
    await writeFile(invalidPath, Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xc3, 0x7d]));

    const result = await readApprovalJson(validPath, 'approval');
    assert.deepEqual(result.value, { approved: true });
    assert.deepEqual(result.bytes, Buffer.from('{"approved":true}\n', 'utf8'));
    await expectApprovalError(() => readApprovalJson(invalidPath, 'approval'), 'UTF8');
  });
});

test('readApprovalJson rejects symlinks, directories, and FIFOs before parsing', async () => {
  await withTempDirectory(async (directory) => {
    const target = join(directory, 'target.json');
    const link = join(directory, 'link.json');
    const nestedDirectory = join(directory, 'directory');
    const fifo = join(directory, 'approval.fifo');
    await writeFile(target, '{"ok":true}\n');
    await symlink(target, link);
    await mkdir(nestedDirectory);
    execFileSync('/usr/bin/mkfifo', [fifo]);

    await expectApprovalError(() => readApprovalJson(link, 'approval'), 'UNSAFE_FILE');
    await expectApprovalError(() => readApprovalJson(nestedDirectory, 'approval'), 'UNSAFE_FILE');
    await expectApprovalError(() => readApprovalJson(fifo, 'approval'), 'UNSAFE_FILE');
  });
});

test('readApprovalJson accepts exactly 1 MiB and rejects one byte more', async () => {
  await withTempDirectory(async (directory) => {
    const atLimit = join(directory, 'at-limit.json');
    const overLimit = join(directory, 'over-limit.json');
    const prefix = Buffer.from('{"payload":"', 'utf8');
    const suffix = Buffer.from('"}', 'utf8');
    await writeFile(atLimit, Buffer.concat([prefix, Buffer.alloc(MAX_BYTES - prefix.length - suffix.length, 0x61), suffix]));
    await writeFile(overLimit, Buffer.alloc(MAX_BYTES + 1, 0x61));

    const result = await readApprovalJson(atLimit, 'approval');
    assert.equal(result.bytes.length, MAX_BYTES);
    await expectApprovalError(() => readApprovalJson(overLimit, 'approval'), 'FILE_TOO_LARGE');
  });
});

test('public facade exports only path-safe approval JSON operations', () => {
  assert.deepEqual(Object.keys(safeJsonFacade).sort(), [
    'buildApprovalReceiptArtifact',
    'parseApprovalJson',
    'readApprovalJson',
    'renderApprovalReceiptCore',
    'sha256Prefixed',
    'verifyApprovalReceiptRawSha256',
  ]);
});

test('internal structural seam is non-authoritative and not re-exported by facade or package', async () => {
  const facadeSource = await readFile(
    new URL('./governance-approval-safe-json.mjs', import.meta.url),
    'utf8',
  );
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.match(facadeSource, /from '\.\/governance-approval-safe-json-internal\.mjs'/u);
  assert.doesNotMatch(facadeSource, /export\s+(?:const|function|\{)[^\n]*StructuralTestSeam/iu);
  assert.equal(JSON.stringify(packageJson.exports ?? {}).includes('safe-json-internal'), false);

  const internal = await import('./governance-approval-safe-json-internal.mjs');
  assert.deepEqual(Object.keys(internal), ['readApprovalJsonBytesFromStructuralTestSeam']);
});

test('internal structural seam marks stable fake results as non-authoritative test evidence', async () => {
  const { readApprovalJsonBytesFromStructuralTestSeam } = await import(
    './governance-approval-safe-json-internal.mjs'
  );
  const bytes = Buffer.from('{"approved":true}\n', 'utf8');
  const stable = {
    dev: 2049n,
    ino: 427001n,
    mode: 33188n,
    size: BigInt(bytes.length),
    mtimeNs: 1788087600000000000n,
    ctimeNs: 1788087600000000000n,
    isFile: () => true,
  };
  const adapter = {
    schemaVersion: INTERNAL_SEAM_VERSION,
    stat: async () => stable,
    readAt: async (target, offset, length, position) => {
      if (position >= bytes.length) return { bytesRead: 0 };
      const bytesRead = Math.min(length, bytes.length - position);
      bytes.copy(target, offset, position, position + bytesRead);
      return { bytesRead };
    },
  };

  const result = await readApprovalJsonBytesFromStructuralTestSeam(adapter);
  assert.equal(result.seam, 'NON_AUTHORITATIVE_INTERNAL_STRUCTURAL_TEST_SEAM');
  assert.equal(result.identityStable, true);
  assert.deepEqual(result.bytes, bytes);
  assert.equal(Object.isFrozen(result), true);
});

test('internal structural seam deterministically rejects identity change after bounded read', async () => {
  const { readApprovalJsonBytesFromStructuralTestSeam } = await import(
    './governance-approval-safe-json-internal.mjs'
  );
  const bytes = Buffer.from('{"approved":true}\n', 'utf8');
  const stat = (mtimeNs) => ({
    dev: 2049n,
    ino: 427001n,
    mode: 33188n,
    size: BigInt(bytes.length),
    mtimeNs,
    ctimeNs: 1788087600000000000n,
    isFile: () => true,
  });
  const stats = [stat(1788087600000000000n), stat(1788087600000000001n)];
  let statReads = 0;
  let byteReads = 0;
  const handle = {
    schemaVersion: INTERNAL_SEAM_VERSION,
    stat: async ({ bigint }) => {
      assert.equal(bigint, true);
      return stats[statReads++];
    },
    readAt: async (target, offset, length, position) => {
      byteReads += 1;
      if (position >= bytes.length) return { bytesRead: 0, buffer: target };
      const bytesRead = Math.min(length, bytes.length - position);
      bytes.copy(target, offset, position, position + bytesRead);
      return { bytesRead, buffer: target };
    },
  };

  await expectApprovalError(
    () => readApprovalJsonBytesFromStructuralTestSeam(handle),
    'FILE_CHANGED',
  );
  assert.equal(statReads, 2);
  assert.equal(byteReads, 2);
});

test('renderApprovalReceiptCore requires canonical ISO instants and renders schema field order', () => {
  expectApprovalErrorSync(
    () => renderApprovalReceiptCore(approvalCore({ approved_at: '2026-08-30T12:34:56Z' })),
    'CORE_INSTANT',
  );
  const reordered = Object.fromEntries(Object.entries(approvalCore()).reverse());
  const bytes = renderApprovalReceiptCore(reordered);
  assert.equal(
    bytes.toString('utf8'),
    `${JSON.stringify(approvalCore(), null, 2)}\n`,
  );
  assert.equal(bytes[bytes.length - 1], 0x0a);
});

test('buildApprovalReceiptArtifact binds a closed envelope to its schema-ordered core and exact final bytes', () => {
  const core = approvalCore();
  const artifact = buildApprovalReceiptArtifact(core);
  const expectedCoreBytes = renderApprovalReceiptCore(core);
  const expectedCoreDigest = sha256Prefixed(expectedCoreBytes);
  const expectedEnvelope = {
    schema_version: 'product-privacy-approval-readback-receipt/v1',
    core: approvalCore(),
    receipt_core_sha256: expectedCoreDigest,
  };
  const expectedBytes = Buffer.from(`${JSON.stringify(expectedEnvelope, null, 2)}\n`, 'utf8');

  assert.deepEqual(artifact.envelope, expectedEnvelope);
  assert.deepEqual(artifact.bytes, expectedBytes);
  assert.equal(artifact.receiptCoreSha256, expectedCoreDigest);
  assert.equal(artifact.receiptRawSha256, sha256Prefixed(expectedBytes));
  assert.ok(Object.isFrozen(artifact));
  assert.ok(Object.isFrozen(artifact.envelope));
  assert.ok(Object.isFrozen(artifact.envelope.core));
  assert.ok(Object.isFrozen(artifact.envelope.core.repository));
  assert.equal(parseApprovalJson(artifact.bytes.toString('utf8'), 'receipt').receipt_core_sha256, expectedCoreDigest);
});

test('receipt byte accessors return fresh copies that cannot desynchronize retained digests', async () => {
  await withTempDirectory(async (directory) => {
    const artifact = buildApprovalReceiptArtifact(approvalCore());
    const originalArtifactBytes = artifact.bytes;
    const mutatedArtifactBytes = artifact.bytes;
    mutatedArtifactBytes[0] ^= 0x01;
    assert.notDeepEqual(mutatedArtifactBytes, originalArtifactBytes);
    assert.deepEqual(artifact.bytes, originalArtifactBytes);
    assert.equal(sha256Prefixed(artifact.bytes), artifact.receiptRawSha256);
    assert.equal(sha256Prefixed(renderApprovalReceiptCore(artifact.envelope.core)), artifact.receiptCoreSha256);

    const receiptPath = join(directory, 'receipt.json');
    await writeFile(receiptPath, originalArtifactBytes);
    const read = await readApprovalJson(receiptPath, 'receipt');
    const mutatedReadBytes = read.bytes;
    mutatedReadBytes[0] ^= 0x01;
    assert.deepEqual(read.bytes, originalArtifactBytes);
  });
});

test('buildApprovalReceiptArtifact rejects core-digest drift and every recursive raw-hash field alias', () => {
  const core = approvalCore();
  const artifact = buildApprovalReceiptArtifact(core);
  const driftedEnvelope = {
    ...artifact.envelope,
    receipt_core_sha256: digest('d'),
  };
  const alternatives = [
    { receipt_raw_sha256: artifact.receiptRawSha256 },
    { receipt_sha256: artifact.receiptRawSha256 },
    { core_digest: artifact.receiptCoreSha256 },
    { receipt_core_digest: artifact.receiptCoreSha256 },
  ];

  assert.notEqual(
    sha256Prefixed(renderApprovalReceiptCore(driftedEnvelope.core)),
    driftedEnvelope.receipt_core_sha256,
  );
  expectApprovalErrorSync(
    () => parseApprovalJson(`${JSON.stringify(driftedEnvelope, null, 2)}\n`, 'receipt'),
    'CORE_DIGEST',
  );
  for (const alternative of alternatives) {
    expectApprovalErrorSync(
      () => parseApprovalJson(
        `${JSON.stringify({ ...artifact.envelope, ...alternative }, null, 2)}\n`,
        'receipt',
      ),
      'RECEIPT_PROPERTY',
    );
  }
});

test('parseApprovalJson accepts only exact final receipt bytes after canonical rendering', () => {
  const artifact = buildApprovalReceiptArtifact(approvalCore());
  assert.deepEqual(
    parseApprovalJson(artifact.bytes.toString('utf8'), 'receipt'),
    artifact.envelope,
  );
  expectApprovalErrorSync(
    () => parseApprovalJson(JSON.stringify(artifact.envelope), 'receipt'),
    'RECEIPT_RENDER',
  );
});

test('external raw digest is derived from final bytes and detects one-byte receipt drift', async () => {
  await withTempDirectory(async (directory) => {
    const artifact = buildApprovalReceiptArtifact(approvalCore());
    const receiptPath = join(directory, 'receipt.json');
    await writeFile(receiptPath, artifact.bytes);
    const exactBytes = await readFile(receiptPath);
    const externalDigest = sha256Prefixed(exactBytes);
    assert.equal(externalDigest, artifact.receiptRawSha256);
    assert.equal(
      externalDigest,
      `sha256:${createHash('sha256').update(exactBytes).digest('hex')}`,
    );

    const driftedBytes = Buffer.from(exactBytes);
    const mutableOffset = driftedBytes.indexOf(Buffer.from('approval-owner', 'utf8'));
    assert.notEqual(mutableOffset, -1);
    driftedBytes[mutableOffset] = 0x78;
    assert.notEqual(sha256Prefixed(driftedBytes), artifact.receiptRawSha256);
    await writeFile(receiptPath, driftedBytes);
    await expectApprovalError(() => readApprovalJson(receiptPath, 'receipt'), 'CORE_DIGEST');
  });
});

test('verifyApprovalReceiptRawSha256 accepts only independently supplied exact lower-case final-byte SHA-256', () => {
  const artifact = buildApprovalReceiptArtifact(approvalCore());
  assert.deepEqual(verifyApprovalReceiptRawSha256(artifact.bytes, artifact.receiptRawSha256), { valid: true });

  const drifted = artifact.bytes;
  drifted[0] ^= 0x01;
  expectApprovalErrorSync(
    () => verifyApprovalReceiptRawSha256(drifted, artifact.receiptRawSha256),
    'RECEIPT_RAW_DIGEST_MISMATCH',
  );
  expectApprovalErrorSync(
    () => verifyApprovalReceiptRawSha256(artifact.bytes, artifact.receiptRawSha256.toUpperCase()),
    'RECEIPT_RAW_DIGEST_INVALID',
  );
  expectApprovalErrorSync(
    () => verifyApprovalReceiptRawSha256(artifact.bytes, 'sha256:not-a-digest'),
    'RECEIPT_RAW_DIGEST_INVALID',
  );
});

test('actor_login length follows Unicode code points and accepts one unpaired surrogate as one code point', () => {
  const atLimit = approvalCore({ actor_login: '😀'.repeat(256) });
  assert.doesNotThrow(() => buildApprovalReceiptArtifact(atLimit));
  expectApprovalErrorSync(
    () => buildApprovalReceiptArtifact(approvalCore({ actor_login: '😀'.repeat(257) })),
    'CORE_PROPERTY',
  );
  assert.doesNotThrow(() => buildApprovalReceiptArtifact(approvalCore({ actor_login: '\ud800' })));
});

test('buildApprovalReceiptArtifact does not retain mutable caller objects', () => {
  const core = approvalCore();
  const artifact = buildApprovalReceiptArtifact(core);
  core.repository.full_name = 'mutated/example';
  core.actor_login = 'mutated';
  assert.equal(artifact.envelope.core.repository.full_name, 'mlhjyx/global-backend');
  assert.equal(artifact.envelope.core.actor_login, 'approval-owner');
  assert.throws(() => {
    artifact.envelope.core.actor_login = 'attempted-mutation';
  }, TypeError);
});

test('approval receipt core renders optional merge authorization references in one schema order', () => {
  const mergeAuthorizationEvidence = {
    stage: 'PROPOSAL_MERGE',
    grant_id: 'program-c-grant-0001',
    grant_raw_sha256: digest('b'),
    single_use_nonce: 'nonce-program-c-0001',
    consumption_id: 'program-c-consumption-0001',
    consumption_raw_sha256: digest('c'),
    reserved_ledger_revision: 17,
  };
  const ordinary = buildApprovalReceiptArtifact(approvalCore());
  assert.equal(Object.hasOwn(ordinary.envelope.core, 'merge_authorization_evidence'), false);

  const merged = buildApprovalReceiptArtifact(approvalCore({ merge_authorization_evidence: mergeAuthorizationEvidence }));
  assert.deepEqual(merged.envelope.core.merge_authorization_evidence, mergeAuthorizationEvidence);
  assert.match(
    merged.bytes.toString('utf8'),
    /"merge_authorization_evidence": \{\n {6}"stage": "PROPOSAL_MERGE",\n {6}"grant_id":/,
  );
  assert.equal(Object.hasOwn(merged.envelope.core.merge_authorization_evidence, 'grant'), false);
  assert.equal(Object.hasOwn(merged.envelope.core.merge_authorization_evidence, 'consumption'), false);

  for (const mutate of [
    (value) => { delete value.consumption_id; },
    (value) => { value.status = 'CONSUMED'; },
    (value) => { value.grant_digest = value.grant_raw_sha256; },
    (value) => { value.grant = { grant_id: value.grant_id, status: 'CONSUMED' }; },
    (value) => { value.receipt_raw_sha256 = digest('d'); },
  ]) {
    const value = structuredClone(mergeAuthorizationEvidence);
    mutate(value);
    assert.throws(
      () => buildApprovalReceiptArtifact(approvalCore({ merge_authorization_evidence: value })),
      (error) => error.message === 'APPROVAL_JSON_CORE_PROPERTY',
    );
  }
});
