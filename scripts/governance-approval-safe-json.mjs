import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { scheduler } from 'node:timers/promises';
import { TextDecoder } from 'node:util';

const MAX_BYTES = 1_048_576;
const MAX_NESTING = 128;
const RECEIPT_SCHEMA_VERSION = 'product-privacy-approval-readback-receipt/v1';
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/;
const RECEIPT_ID_PATTERN = /^[a-z][a-z0-9-]{7,127}$/;
const CANONICAL_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const CANONICAL_NUMBER_PATTERN = /^-?(?:0|[1-9]\d*)(?:\.\d*[1-9])?(?:e-?[1-9]\d*)?$/;
const CORE_KEYS = Object.freeze([
  'receipt_id',
  'repository',
  'authority_revision',
  'authority_sha256',
  'role',
  'actor_id',
  'actor_login',
  'decision_adr',
  'decision_revision',
  'policy_revision',
  'pr_number',
  'base_sha',
  'head_sha',
  'approved_at',
  'trust_class',
]);
const MERGE_AUTHORIZATION_EVIDENCE_KEYS = Object.freeze([
  'stage',
  'grant_id',
  'grant_raw_sha256',
  'single_use_nonce',
  'consumption_id',
  'consumption_raw_sha256',
  'reserved_ledger_revision',
]);
const ROLES = new Set([
  'OWN-PRODUCT',
  'OWN-DATA-PRIVACY',
  'OWN-QA-EVIDENCE',
  'OWN-SECURITY',
  'LEGAL-REVIEW',
  'MERGE-AUTHORIZER',
]);

const approvalJsonError = (code) => new Error(`APPROVAL_JSON_${code}`);

const requireCondition = (condition, code) => {
  if (!condition) {
    throw approvalJsonError(code);
  }
};

const isJsonWhitespace = (character) => (
  character === ' ' || character === '\t' || character === '\n' || character === '\r'
);

const skipJsonWhitespace = (text, index) => {
  let next = index;
  while (next < text.length && isJsonWhitespace(text[next])) {
    next += 1;
  }
  return next;
};

const scanJsonString = (text, start) => {
  requireCondition(text[start] === '"', 'SYNTAX');
  let index = start + 1;
  while (index < text.length) {
    const codePoint = text.charCodeAt(index);
    if (text[index] === '"') {
      return index + 1;
    }
    requireCondition(codePoint >= 0x20, 'SYNTAX');
    if (text[index] === '\\') {
      const escape = text[index + 1];
      requireCondition(escape !== undefined, 'SYNTAX');
      if (escape === 'u') {
        requireCondition(/^[0-9a-fA-F]{4}$/.test(text.slice(index + 2, index + 6)), 'SYNTAX');
        index += 6;
        continue;
      }
      requireCondition('"\\/bfnrt'.includes(escape), 'SYNTAX');
      index += 2;
      continue;
    }
    index += 1;
  }
  throw approvalJsonError('SYNTAX');
};

const scanJsonNumber = (text, start) => {
  const match = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
  match.lastIndex = start;
  const token = match.exec(text);
  requireCondition(token !== null, 'SYNTAX');
  requireCondition(CANONICAL_NUMBER_PATTERN.test(token[0]), 'NUMBER_LEXEME');
  requireCondition(!token[0].includes('e') || Number(token[0].slice(0, token[0].indexOf('e'))) !== 0, 'NUMBER_LEXEME');
  return start + token[0].length;
};

const scanJsonValue = (text, start, depth) => {
  requireCondition(depth <= MAX_NESTING, 'NESTING');
  const index = skipJsonWhitespace(text, start);
  requireCondition(index < text.length, 'SYNTAX');
  const character = text[index];

  if (character === '"') {
    return scanJsonString(text, index);
  }
  if (character === '{') {
    const keys = new Set();
    let next = skipJsonWhitespace(text, index + 1);
    if (text[next] === '}') {
      return next + 1;
    }
    while (next < text.length) {
      requireCondition(text[next] === '"', 'SYNTAX');
      const keyStart = next;
      next = scanJsonString(text, next);
      const key = JSON.parse(text.slice(keyStart, next));
      requireCondition(!keys.has(key), 'DUPLICATE_KEY');
      keys.add(key);
      next = skipJsonWhitespace(text, next);
      requireCondition(text[next] === ':', 'SYNTAX');
      next = scanJsonValue(text, next + 1, depth + 1);
      next = skipJsonWhitespace(text, next);
      if (text[next] === '}') {
        return next + 1;
      }
      requireCondition(text[next] === ',', 'SYNTAX');
      next = skipJsonWhitespace(text, next + 1);
    }
    throw approvalJsonError('SYNTAX');
  }
  if (character === '[') {
    let next = skipJsonWhitespace(text, index + 1);
    if (text[next] === ']') {
      return next + 1;
    }
    while (next < text.length) {
      next = scanJsonValue(text, next, depth + 1);
      next = skipJsonWhitespace(text, next);
      if (text[next] === ']') {
        return next + 1;
      }
      requireCondition(text[next] === ',', 'SYNTAX');
      next = skipJsonWhitespace(text, next + 1);
    }
    throw approvalJsonError('SYNTAX');
  }
  if (character === '-' || (character >= '0' && character <= '9')) {
    return scanJsonNumber(text, index);
  }
  for (const literal of ['true', 'false', 'null']) {
    if (text.startsWith(literal, index)) {
      return index + literal.length;
    }
  }
  throw approvalJsonError('SYNTAX');
};

const assertSafeJsonNumbers = (value, depth = 0) => {
  requireCondition(depth <= MAX_NESTING, 'NESTING');
  if (typeof value === 'number') {
    requireCondition(Number.isFinite(value) && !Object.is(value, -0), 'NUMBER');
    requireCondition(!Number.isInteger(value) || Number.isSafeInteger(value), 'NUMBER');
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      assertSafeJsonNumbers(item, depth + 1);
    }
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) {
      assertSafeJsonNumbers(item, depth + 1);
    }
  }
};

const statIdentity = (stat) => Object.freeze({
  dev: stat.dev,
  ino: stat.ino,
  mode: stat.mode,
  size: stat.size,
  mtimeNs: stat.mtimeNs,
  ctimeNs: stat.ctimeNs,
});

const sameIdentity = (before, after) => (
  before.dev === after.dev
  && before.ino === after.ino
  && before.mode === after.mode
  && before.size === after.size
  && before.mtimeNs === after.mtimeNs
  && before.ctimeNs === after.ctimeNs
);

const readBoundedBytes = async (handle, expectedSize) => {
  const chunks = [];
  let offset = 0;
  while (offset < expectedSize) {
    const chunk = Buffer.allocUnsafe(Math.min(65_536, expectedSize - offset));
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, offset);
    requireCondition(bytesRead > 0, 'FILE_CHANGED');
    chunks.push(chunk.subarray(0, bytesRead));
    offset += bytesRead;
    await scheduler.yield();
  }
  const extra = Buffer.allocUnsafe(1);
  const { bytesRead: extraBytes } = await handle.read(extra, 0, 1, offset);
  requireCondition(extraBytes === 0, 'FILE_CHANGED');
  return Buffer.concat(chunks, offset);
};

const isPlainObject = (value) => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype
);

const requireClosedObject = (value, keys, code) => {
  requireCondition(isPlainObject(value), code);
  const actualKeys = Object.keys(value);
  requireCondition(
    actualKeys.length === keys.length && keys.every((key) => Object.hasOwn(value, key)),
    code,
  );
};

const requireString = (value, pattern, code) => {
  requireCondition(typeof value === 'string' && pattern.test(value), code);
  return value;
};

const requireCanonicalInstant = (value) => {
  requireCondition(typeof value === 'string' && CANONICAL_INSTANT_PATTERN.test(value), 'CORE_INSTANT');
  const time = Date.parse(value);
  requireCondition(Number.isFinite(time) && new Date(time).toISOString() === value, 'CORE_INSTANT');
  return value;
};

const unicodeCodePointLength = (value) => Array.from(value).length;

const normalizeApprovalReceiptCore = (core) => {
  const coreKeys = Object.hasOwn(core ?? {}, 'merge_authorization_evidence')
    ? [...CORE_KEYS, 'merge_authorization_evidence']
    : CORE_KEYS;
  requireClosedObject(core, coreKeys, 'CORE_PROPERTY');
  requireString(core.receipt_id, RECEIPT_ID_PATTERN, 'CORE_PROPERTY');
  requireClosedObject(core.repository, ['id', 'full_name'], 'CORE_PROPERTY');
  requireCondition(core.repository.id === 1291151138 && core.repository.full_name === 'mlhjyx/global-backend', 'CORE_PROPERTY');
  requireString(core.authority_revision, /^approval-authorities\/r[1-9][0-9]*$/, 'CORE_PROPERTY');
  requireString(core.authority_sha256, DIGEST_PATTERN, 'CORE_PROPERTY');
  requireCondition(ROLES.has(core.role), 'CORE_PROPERTY');
  requireCondition(Number.isSafeInteger(core.actor_id) && core.actor_id >= 1 && core.actor_id <= Number.MAX_SAFE_INTEGER, 'CORE_PROPERTY');
  requireCondition(
    typeof core.actor_login === 'string'
    && unicodeCodePointLength(core.actor_login) >= 1
    && unicodeCodePointLength(core.actor_login) <= 256,
    'CORE_PROPERTY',
  );
  requireCondition(core.decision_adr === 'ADR-042', 'CORE_PROPERTY');
  requireString(core.decision_revision, /^program-c\/decision-r[1-9][0-9]*$/, 'CORE_PROPERTY');
  requireString(core.policy_revision, /^program-c\/policy-r[1-9][0-9]*$/, 'CORE_PROPERTY');
  requireCondition(Number.isSafeInteger(core.pr_number) && core.pr_number >= 1, 'CORE_PROPERTY');
  requireString(core.base_sha, GIT_SHA_PATTERN, 'CORE_PROPERTY');
  requireString(core.head_sha, GIT_SHA_PATTERN, 'CORE_PROPERTY');
  requireCanonicalInstant(core.approved_at);
  requireCondition(core.trust_class === 'TRUSTED_BASE_VERIFIED', 'CORE_PROPERTY');

  const normalized = {
    receipt_id: core.receipt_id,
    repository: { id: core.repository.id, full_name: core.repository.full_name },
    authority_revision: core.authority_revision,
    authority_sha256: core.authority_sha256,
    role: core.role,
    actor_id: core.actor_id,
    actor_login: core.actor_login,
    decision_adr: core.decision_adr,
    decision_revision: core.decision_revision,
    policy_revision: core.policy_revision,
    pr_number: core.pr_number,
    base_sha: core.base_sha,
    head_sha: core.head_sha,
    approved_at: core.approved_at,
    trust_class: core.trust_class,
  };
  if (Object.hasOwn(core, 'merge_authorization_evidence')) {
    const evidence = core.merge_authorization_evidence;
    requireClosedObject(evidence, MERGE_AUTHORIZATION_EVIDENCE_KEYS, 'CORE_PROPERTY');
    requireCondition(['PROPOSAL_MERGE', 'ACCEPTANCE_MERGE'].includes(evidence.stage), 'CORE_PROPERTY');
    requireString(evidence.grant_id, RECEIPT_ID_PATTERN, 'CORE_PROPERTY');
    requireString(evidence.grant_raw_sha256, DIGEST_PATTERN, 'CORE_PROPERTY');
    requireString(evidence.single_use_nonce, /^nonce-program-c-[a-z0-9-]{4,96}$/, 'CORE_PROPERTY');
    requireString(evidence.consumption_id, RECEIPT_ID_PATTERN, 'CORE_PROPERTY');
    requireString(evidence.consumption_raw_sha256, DIGEST_PATTERN, 'CORE_PROPERTY');
    requireCondition(
      Number.isSafeInteger(evidence.reserved_ledger_revision)
      && evidence.reserved_ledger_revision >= 0,
      'CORE_PROPERTY',
    );
    normalized.merge_authorization_evidence = {
      stage: evidence.stage,
      grant_id: evidence.grant_id,
      grant_raw_sha256: evidence.grant_raw_sha256,
      single_use_nonce: evidence.single_use_nonce,
      consumption_id: evidence.consumption_id,
      consumption_raw_sha256: evidence.consumption_raw_sha256,
      reserved_ledger_revision: evidence.reserved_ledger_revision,
    };
  }
  return normalized;
};

const deepFreeze = (value) => {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
};

const immutableBytesResult = (value, bytes) => {
  const privateBytes = Buffer.from(bytes);
  return Object.freeze({
    value,
    get bytes() {
      return Buffer.from(privateBytes);
    },
  });
};

const renderApprovalReceiptEnvelope = (core, receiptCoreSha256) => Buffer.from(
  `${JSON.stringify({
    schema_version: RECEIPT_SCHEMA_VERSION,
    core,
    receipt_core_sha256: receiptCoreSha256,
  }, null, 2)}\n`,
  'utf8',
);

const normalizeParsedReceipt = (receipt, sourceBytes) => {
  requireClosedObject(receipt, ['schema_version', 'core', 'receipt_core_sha256'], 'RECEIPT_PROPERTY');
  requireCondition(receipt.schema_version === RECEIPT_SCHEMA_VERSION, 'RECEIPT_PROPERTY');
  const core = normalizeApprovalReceiptCore(receipt.core);
  requireString(receipt.receipt_core_sha256, DIGEST_PATTERN, 'RECEIPT_PROPERTY');
  const expectedCoreSha256 = sha256Prefixed(renderApprovalReceiptCore(core));
  requireCondition(receipt.receipt_core_sha256 === expectedCoreSha256, 'CORE_DIGEST');
  const canonical = {
    schema_version: RECEIPT_SCHEMA_VERSION,
    core,
    receipt_core_sha256: expectedCoreSha256,
  };
  requireCondition(sourceBytes.equals(renderApprovalReceiptEnvelope(core, expectedCoreSha256)), 'RECEIPT_RENDER');
  return deepFreeze(canonical);
};

export const sha256Prefixed = (bytes) => {
  requireCondition(Buffer.isBuffer(bytes) || bytes instanceof Uint8Array, 'DIGEST_INPUT');
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
};

export const verifyApprovalReceiptRawSha256 = (bytes, expectedReceiptRawSha256) => {
  requireCondition(Buffer.isBuffer(bytes) || bytes instanceof Uint8Array, 'RECEIPT_RAW_DIGEST_INPUT');
  requireString(expectedReceiptRawSha256, DIGEST_PATTERN, 'RECEIPT_RAW_DIGEST_INVALID');
  requireCondition(
    sha256Prefixed(bytes) === expectedReceiptRawSha256,
    'RECEIPT_RAW_DIGEST_MISMATCH',
  );
  return Object.freeze({ valid: true });
};

export const parseApprovalJson = (text, _label) => {
  requireCondition(typeof text === 'string' && Buffer.byteLength(text, 'utf8') <= MAX_BYTES, 'INPUT_TOO_LARGE');
  let end;
  try {
    end = scanJsonValue(text, 0, 0);
    requireCondition(skipJsonWhitespace(text, end) === text.length, 'SYNTAX');
  } catch (error) {
    if (error?.message?.startsWith('APPROVAL_JSON_')) {
      throw error;
    }
    throw approvalJsonError('SYNTAX');
  }
  try {
    const value = JSON.parse(text);
    assertSafeJsonNumbers(value);
    if (isPlainObject(value) && value.schema_version === RECEIPT_SCHEMA_VERSION) {
      return normalizeParsedReceipt(value, Buffer.from(text, 'utf8'));
    }
    return deepFreeze(value);
  } catch (error) {
    if (error?.message?.startsWith('APPROVAL_JSON_')) {
      throw error;
    }
    throw approvalJsonError('SYNTAX');
  }
};

export const readApprovalJson = async (path, _label) => {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await handle.stat({ bigint: true });
    requireCondition(before.isFile() && before.size <= BigInt(MAX_BYTES), before.size > BigInt(MAX_BYTES) ? 'FILE_TOO_LARGE' : 'UNSAFE_FILE');
    const bytes = await readBoundedBytes(handle, Number(before.size));
    const after = await handle.stat({ bigint: true });
    requireCondition(sameIdentity(statIdentity(before), statIdentity(after)), 'FILE_CHANGED');
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      throw approvalJsonError('UTF8');
    }
    const value = parseApprovalJson(text, _label);
    return immutableBytesResult(value, bytes);
  } catch (error) {
    if (error?.message?.startsWith('APPROVAL_JSON_')) {
      throw error;
    }
    if (error?.code === 'ELOOP' || error?.code === 'EISDIR') {
      throw approvalJsonError('UNSAFE_FILE');
    }
    throw approvalJsonError('READ_FAILED');
  } finally {
    if (handle !== undefined) {
      await handle.close();
    }
  }
};

export const renderApprovalReceiptCore = (core) => {
  const normalized = normalizeApprovalReceiptCore(core);
  return Buffer.from(`${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
};

export const buildApprovalReceiptArtifact = (core) => {
  const normalized = normalizeApprovalReceiptCore(core);
  const coreBytes = renderApprovalReceiptCore(normalized);
  const receiptCoreSha256 = sha256Prefixed(coreBytes);
  const envelope = deepFreeze({
    schema_version: RECEIPT_SCHEMA_VERSION,
    core: normalized,
    receipt_core_sha256: receiptCoreSha256,
  });
  const bytes = renderApprovalReceiptEnvelope(normalized, receiptCoreSha256);
  const receiptRawSha256 = sha256Prefixed(bytes);
  const privateBytes = Buffer.from(bytes);
  return Object.freeze({
    envelope,
    get bytes() {
      return Buffer.from(privateBytes);
    },
    receiptCoreSha256,
    receiptRawSha256,
  });
};
