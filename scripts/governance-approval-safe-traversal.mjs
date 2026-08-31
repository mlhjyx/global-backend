import { deepFreeze } from './governance-approval-readback-common.mjs';

const FORBIDDEN_CONTENT_KEYS = new Set([
  'body', 'content', 'reviewbody', 'legalcontent', 'freeform', 'free_form',
]);

export const inspectApprovalValueGraph = (value, options = {}) => {
  const maxNodes = Number.isSafeInteger(options.maxNodes) ? options.maxNodes : 20_000;
  const maxDepth = Number.isSafeInteger(options.maxDepth) ? options.maxDepth : 128;
  const maxBytes = Number.isSafeInteger(options.maxBytes) ? options.maxBytes : null;
  const checkForbiddenContent = options.checkForbiddenContent === true;
  const checkNonce = options.checkNonce === true;
  const ancestors = new WeakSet();
  const result = {
    cycle: false,
    overflow: false,
    traversalError: false,
    forbiddenContent: false,
    nonce: false,
    nodes: 0,
    utf8Bytes: 0,
    byteOverflow: false,
  };
  const addBytes = (current) => {
    if (maxBytes === null || result.byteOverflow) return;
    try {
      result.utf8Bytes += Buffer.byteLength(current, 'utf8');
      if (result.utf8Bytes > maxBytes) result.byteOverflow = true;
    } catch {
      result.traversalError = true;
    }
  };
  const walk = (current, depth) => {
    if (result.cycle || result.overflow || result.traversalError || result.byteOverflow) return;
    if (depth > maxDepth || result.nodes >= maxNodes) {
      result.overflow = true;
      return;
    }
    result.nodes += 1;
    if (typeof current === 'string') {
      if (checkNonce && /nonce-program-c-/i.test(current)) result.nonce = true;
      addBytes(current);
      return;
    }
    if (current === null) {
      addBytes('null');
      return;
    }
    if (typeof current === 'number') {
      addBytes(Number.isFinite(current) ? `${current}` : 'non-finite-number');
      return;
    }
    if (typeof current === 'boolean') {
      addBytes(current ? 'true' : 'false');
      return;
    }
    if (typeof current !== 'object') {
      result.traversalError = true;
      return;
    }
    if (ancestors.has(current)) {
      result.cycle = true;
      return;
    }
    ancestors.add(current);
    try {
      for (const key in current) {
        if (!Object.hasOwn(current, key)) continue;
        addBytes(key);
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (descriptor === undefined
          || !Object.hasOwn(descriptor, 'value')
          || typeof descriptor.get === 'function'
          || typeof descriptor.set === 'function') {
          result.traversalError = true;
          break;
        }
        const normalized = key.toLowerCase();
        if (checkForbiddenContent && FORBIDDEN_CONTENT_KEYS.has(normalized)) {
          result.forbiddenContent = true;
        }
        if (checkNonce && /nonce/i.test(key)) result.nonce = true;
        walk(descriptor.value, depth + 1);
        if (result.cycle || result.overflow || result.traversalError || result.byteOverflow) break;
      }
    } catch {
      result.traversalError = true;
    }
    ancestors.delete(current);
  };
  walk(value, 0);
  return deepFreeze(result);
};

export const approvalGraphUnsafe = (inspection) => (
  inspection.cycle || inspection.overflow || inspection.traversalError
);
