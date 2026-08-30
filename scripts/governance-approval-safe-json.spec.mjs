import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Worker } from 'node:worker_threads';

import {
  buildApprovalReceiptArtifact,
  parseApprovalJson,
  readApprovalJson,
  renderApprovalReceiptCore,
  sha256Prefixed,
} from './governance-approval-safe-json.mjs';

const MAX_BYTES = 1_048_576;

const digest = (character) => `sha256:${character.repeat(64)}`;

const approvalCore = (overrides = {}) => ({
  receipt_id: 'approval-receipt-0001',
  repository: { id: 1291151138, full_name: 'mlhjyx/global-backend' },
  authority_revision: 'approval-authorities/r1',
  authority_sha256: digest('a'),
  role: 'OWN-PRODUCT',
  actor_id: 42,
  actor_login: 'approval-owner',
  decision_adr: 'ADR-042',
  decision_revision: 'program-c/decision-r1',
  policy_revision: 'program-c/policy-r1',
  pr_number: 426,
  base_sha: 'b'.repeat(40),
  head_sha: 'c'.repeat(40),
  approved_at: '2026-08-30T12:34:56.789Z',
  trust_class: 'TRUSTED_BASE_VERIFIED',
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
    assert.throws(() => parseApprovalJson(text, 'approval'), /^APPROVAL_JSON_/);
  }
});

test('parseApprovalJson permits only valid JSON values with finite safe numbers', () => {
  assert.deepEqual(
    parseApprovalJson('{"array":[true,null,"ok",0,1.5e2]}', 'approval'),
    { array: [true, null, 'ok', 0, 150] },
  );
  assert.throws(
    () => parseApprovalJson('{"value":9007199254740992}', 'approval'),
    /^APPROVAL_JSON_NUMBER$/,
  );
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

test('readApprovalJson rejects an opened regular file whose identity changes during the read', async () => {
  await withTempDirectory(async (directory) => {
    const file = join(directory, 'changing.json');
    const prefix = Buffer.from('{"payload":"', 'utf8');
    const suffix = Buffer.from('"}', 'utf8');
    await writeFile(file, Buffer.concat([prefix, Buffer.alloc(MAX_BYTES - prefix.length - suffix.length, 0x61), suffix]));

    const worker = new Worker(
      `const { parentPort, workerData } = require('node:worker_threads');
       const { utimesSync } = require('node:fs');
       let running = true;
       parentPort.on('message', (message) => { if (message === 'stop') running = false; });
       parentPort.postMessage('ready');
       while (running) utimesSync(workerData, new Date(), new Date());`,
      { eval: true, workerData: file },
    );
    await new Promise((resolve, reject) => {
      worker.once('message', resolve);
      worker.once('error', reject);
    });
    try {
      await expectApprovalError(() => readApprovalJson(file, 'approval'), 'FILE_CHANGED');
    } finally {
      worker.postMessage('stop');
      await worker.terminate();
    }
  });
});

test('renderApprovalReceiptCore requires canonical ISO instants and renders schema field order', () => {
  assert.throws(
    () => renderApprovalReceiptCore(approvalCore({ approved_at: '2026-08-30T12:34:56Z' })),
    /^APPROVAL_JSON_CORE_INSTANT$/,
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
  for (const alternative of alternatives) {
    assert.throws(
      () => buildApprovalReceiptArtifact({ ...core, ...alternative }),
      /^APPROVAL_JSON_CORE_PROPERTY$/,
    );
  }
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
    driftedBytes[driftedBytes.length - 2] ^= 0x01;
    assert.notEqual(sha256Prefixed(driftedBytes), artifact.receiptRawSha256);
    await writeFile(receiptPath, driftedBytes);
    const reread = await readApprovalJson(receiptPath, 'receipt');
    assert.notEqual(sha256Prefixed(reread.bytes), artifact.receiptRawSha256);
  });
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
