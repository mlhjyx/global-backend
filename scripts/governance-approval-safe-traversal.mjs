import { deepFreeze } from './governance-approval-readback-common.mjs';

const FORBIDDEN_CONTENT_KEYS = new Set([
  'body', 'content', 'reviewbody', 'legalcontent', 'freeform', 'free_form',
]);

export const inspectApprovalValueGraph = (value, options = {}) => {
  const maxNodes = Number.isSafeInteger(options.maxNodes) ? options.maxNodes : 20_000;
  const maxDepth = Number.isSafeInteger(options.maxDepth) ? options.maxDepth : 128;
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
  };
  const walk = (current, depth) => {
    if (result.cycle || result.overflow || result.traversalError) return;
    if (typeof current === 'string') {
      if (checkNonce && /nonce-program-c-/i.test(current)) result.nonce = true;
      return;
    }
    if (current === null || typeof current !== 'object') return;
    if (depth > maxDepth || result.nodes >= maxNodes) {
      result.overflow = true;
      return;
    }
    if (ancestors.has(current)) {
      result.cycle = true;
      return;
    }
    result.nodes += 1;
    ancestors.add(current);
    let entries;
    try {
      entries = Object.entries(current);
    } catch {
      result.traversalError = true;
      ancestors.delete(current);
      return;
    }
    for (const [key, child] of entries) {
      const normalized = key.toLowerCase();
      if (checkForbiddenContent && FORBIDDEN_CONTENT_KEYS.has(normalized)) {
        result.forbiddenContent = true;
      }
      if (checkNonce && /nonce/i.test(key)) result.nonce = true;
      walk(child, depth + 1);
    }
    ancestors.delete(current);
  };
  walk(value, 0);
  return deepFreeze(result);
};

export const approvalGraphUnsafe = (inspection) => (
  inspection.cycle || inspection.overflow || inspection.traversalError
);
