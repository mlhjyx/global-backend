/**
 * NON-AUTHORITATIVE INTERNAL STRUCTURAL TEST SEAM.
 *
 * This module only checks bounded reads and same-handle structural identity.
 * It does not open paths, parse approval JSON, establish filesystem authority,
 * or produce trusted evidence. Product consumers must use the public
 * readApprovalJson(path) facade and must never import this module directly.
 */
import { scheduler } from 'node:timers/promises';

const MAX_BYTES = 1_048_576;
const SEAM_VERSION = 'approval-safe-json-structural-test-seam/v1';
const ADAPTER_KEYS = Object.freeze(['schemaVersion', 'stat', 'readAt']);

const approvalJsonError = (code) => new Error(`APPROVAL_JSON_${code}`);
const requireCondition = (condition, code) => {
  if (!condition) throw approvalJsonError(code);
};
const isPlainObject = (value) => (
  value !== null
  && typeof value === 'object'
  && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype
);
const hasExactKeys = (value, keys) => (
  isPlainObject(value)
  && Object.keys(value).length === keys.length
  && keys.every((key) => Object.hasOwn(value, key))
);
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

const readBoundedBytes = async (adapter, expectedSize) => {
  const chunks = [];
  let offset = 0;
  while (offset < expectedSize) {
    const chunk = Buffer.allocUnsafe(Math.min(65_536, expectedSize - offset));
    const result = await adapter.readAt(chunk, 0, chunk.length, offset);
    requireCondition(
      isPlainObject(result)
        && Object.keys(result).length === 1
        && Number.isSafeInteger(result.bytesRead)
        && result.bytesRead > 0
        && result.bytesRead <= chunk.length,
      'FILE_CHANGED',
    );
    chunks.push(chunk.subarray(0, result.bytesRead));
    offset += result.bytesRead;
    await scheduler.yield();
  }
  const extra = Buffer.allocUnsafe(1);
  const result = await adapter.readAt(extra, 0, 1, offset);
  requireCondition(
    hasExactKeys(result, ['bytesRead']) && result.bytesRead === 0,
    'FILE_CHANGED',
  );
  return Buffer.concat(chunks, offset);
};

export const readApprovalJsonBytesFromStructuralTestSeam = async (adapter) => {
  try {
    requireCondition(
      hasExactKeys(adapter, ADAPTER_KEYS)
        && adapter.schemaVersion === SEAM_VERSION
        && typeof adapter.stat === 'function'
        && typeof adapter.readAt === 'function',
      'UNSAFE_FILE',
    );
    const before = await adapter.stat({ bigint: true });
    requireCondition(
      before !== null
        && typeof before === 'object'
        && typeof before.isFile === 'function'
        && before.isFile()
        && typeof before.size === 'bigint'
        && before.size <= BigInt(MAX_BYTES),
      typeof before?.size === 'bigint' && before.size > BigInt(MAX_BYTES)
        ? 'FILE_TOO_LARGE'
        : 'UNSAFE_FILE',
    );
    const bytes = await readBoundedBytes(adapter, Number(before.size));
    const after = await adapter.stat({ bigint: true });
    requireCondition(sameIdentity(statIdentity(before), statIdentity(after)), 'FILE_CHANGED');
    const privateBytes = Buffer.from(bytes);
    return Object.freeze({
      seam: 'NON_AUTHORITATIVE_INTERNAL_STRUCTURAL_TEST_SEAM',
      identityStable: true,
      get bytes() {
        return Buffer.from(privateBytes);
      },
    });
  } catch (error) {
    if (error?.message?.startsWith('APPROVAL_JSON_')) throw error;
    throw approvalJsonError('READ_FAILED');
  }
};
