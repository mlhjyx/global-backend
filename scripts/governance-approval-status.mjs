import { pathToFileURL } from 'node:url';
import { renderApprovalStatusReadModel } from './governance-approval-state.mjs';

const FORBIDDEN_KEYS = new Set([
  'body', 'content', 'reviewbody', 'legalcontent', 'freeform', 'free_form',
]);

const containsForbiddenContent = (value, seen = new Set()) => {
  if (value === null || typeof value !== 'object') return false;
  if (seen.has(value)) return true;
  seen.add(value);
  if (Array.isArray(value)) return value.some((entry) => containsForbiddenContent(entry, seen));
  return Object.entries(value).some(([key, child]) => (
    FORBIDDEN_KEYS.has(key.toLowerCase()) || containsForbiddenContent(child, seen)
  ));
};

const forceAcceptRequested = (argv) => {
  if (!Array.isArray(argv)) return false;
  const compact = argv.join('').toLowerCase().replace(/[^a-z]/g, '');
  return compact.includes('forceaccept')
    || compact.includes('acceptforce')
    || argv.some((value) => /^--?(?:force|accept)(?:[-_a-z]*)$/i.test(value));
};

const parseArgs = (argv) => {
  if (!Array.isArray(argv) || argv.length !== 4) return null;
  if (argv[0] !== '--decision' || argv[2] !== '--format') return null;
  if (argv[1] !== 'ADR-027' || !['json', 'text'].includes(argv[3])) return null;
  return { decisionId: argv[1], format: argv[3] };
};

const renderText = (model) => [
  `决策: ${model.decisionId}`,
  `状态: ${model.state}`,
  `信任: ${model.evidenceTrustState}`,
  `Legal: ${model.legalState}`,
  `阻塞: ${model.highestPriorityBlocker ?? 'NONE'}`,
  `说明: ${model.message}`,
  `下一步: ${model.recoveryAction}`,
  '安全语义: 不会重复合并或自动放行',
].join('\n').concat('\n');

const writeError = (dependencies, code) => {
  dependencies.writeStderr(`${code}\n`);
  return 1;
};

export const runApprovalStatusCli = async (argv, dependencies) => {
  if (typeof dependencies?.loadDecisionState !== 'function'
    || typeof dependencies?.writeStdout !== 'function'
    || typeof dependencies?.writeStderr !== 'function') return 1;
  if (forceAcceptRequested(argv)) return writeError(dependencies, 'APPROVAL_FORCE_ACCEPT_FORBIDDEN');
  const parsed = parseArgs(argv);
  if (!parsed) return writeError(dependencies, 'APPROVAL_STATUS_ARGUMENT_INVALID');
  let state;
  try {
    state = await dependencies.loadDecisionState(parsed.decisionId);
  } catch {
    return writeError(dependencies, 'APPROVAL_STATUS_EVIDENCE_REQUIRED');
  }
  if (state === null || state === undefined) return writeError(dependencies, 'APPROVAL_STATUS_EVIDENCE_REQUIRED');
  if (containsForbiddenContent(state)) return writeError(dependencies, 'APPROVAL_STATUS_FORBIDDEN_CONTENT');
  let model;
  try {
    model = renderApprovalStatusReadModel(state);
  } catch {
    return writeError(dependencies, 'APPROVAL_STATUS_EVIDENCE_REQUIRED');
  }
  if (model.decisionId !== parsed.decisionId) return writeError(dependencies, 'APPROVAL_STATUS_DECISION_MISMATCH');
  const output = parsed.format === 'json' ? `${JSON.stringify(model)}\n` : renderText(model);
  if (output.length > 32_768) return writeError(dependencies, 'APPROVAL_STATUS_OUTPUT_OVERFLOW');
  dependencies.writeStdout(output);
  return 0;
};

const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const code = await runApprovalStatusCli(process.argv.slice(2), {
    loadDecisionState: async () => null,
    writeStdout: (value) => process.stdout.write(value),
    writeStderr: (value) => process.stderr.write(value),
  });
  process.exitCode = code;
}
