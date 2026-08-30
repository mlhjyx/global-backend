import { TextDecoder } from 'node:util';

import {
  REPOSITORY_FULL_NAME,
  REPOSITORY_ID,
  REPOSITORY_SEGMENTS,
  ROLES,
  assertSafeParsedValue,
  deepFreeze,
  hasExactKeys,
  isGitSha,
  isPlainObject,
  isSafePositiveInteger,
  isSafeString,
  parseApprovalJson,
  requireCondition,
  sha256,
  stableJson,
} from './governance-github-readback-common.mjs';
import { apiUrl, fetchJson } from './governance-github-readback-rest.mjs';

const LFS_PREFIX = Buffer.from('version https://git-lfs.github.com/spec/v1', 'ascii');

export const readTree = async (state, commitSha, limits, budget) => {
  const response = await fetchJson(
    state,
    apiUrl([...REPOSITORY_SEGMENTS, 'git', 'trees', commitSha], { recursive: 1 }),
    limits,
  );
  requireCondition(
    isPlainObject(response.value)
      && isGitSha(response.value.sha)
      && response.value.truncated === false
      && Array.isArray(response.value.tree),
    'APPROVAL_GITHUB_TREE_ENTRY_INVALID',
  );
  budget.items += response.value.tree.length;
  requireCondition(budget.items <= limits.maxItems, 'APPROVAL_GITHUB_ITEM_LIMIT_EXCEEDED');
  return response.value.tree;
};

export const exactBlobEntry = (tree, path, code) => {
  const matches = tree.filter((entry) => entry?.path === path);
  requireCondition(
    matches.length === 1
      && matches[0].mode === '100644'
      && matches[0].type === 'blob'
      && isGitSha(matches[0].sha),
    code,
  );
  return { path, mode: '100644', type: 'blob', sha: matches[0].sha };
};

const strictBase64 = (value) => {
  requireCondition(typeof value === 'string', 'APPROVAL_GITHUB_BLOB_IDENTITY_MISMATCH');
  const compact = value.replace(/[\r\n]/g, '');
  requireCondition(
    !/[^A-Za-z0-9+/=]/.test(compact)
      && compact.length % 4 === 0
      && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(compact),
    'APPROVAL_GITHUB_BLOB_IDENTITY_MISMATCH',
  );
  const bytes = Buffer.from(compact, 'base64');
  requireCondition(bytes.toString('base64') === compact, 'APPROVAL_GITHUB_BLOB_IDENTITY_MISMATCH');
  return bytes;
};

export const readBlobBytes = async (state, entry, limits) => {
  const response = await fetchJson(
    state,
    apiUrl([...REPOSITORY_SEGMENTS, 'git', 'blobs', entry.sha]),
    limits,
  );
  requireCondition(
    isPlainObject(response.value)
      && response.value.sha === entry.sha
      && response.value.encoding === 'base64'
      && Number.isSafeInteger(response.value.size)
      && response.value.size >= 0,
    'APPROVAL_GITHUB_BLOB_IDENTITY_MISMATCH',
  );
  requireCondition(response.value.size <= limits.maxBlobBytes, 'APPROVAL_GITHUB_BLOB_TOO_LARGE');
  const bytes = strictBase64(response.value.content);
  requireCondition(bytes.length === response.value.size, 'APPROVAL_GITHUB_BLOB_IDENTITY_MISMATCH');
  requireCondition(bytes.length <= limits.maxBlobBytes, 'APPROVAL_GITHUB_BLOB_TOO_LARGE');
  const offset = bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) ? 3 : 0;
  requireCondition(
    !bytes.subarray(offset, offset + LFS_PREFIX.length).equals(LFS_PREFIX),
    'APPROVAL_GITHUB_LFS_POINTER_FORBIDDEN',
  );
  return bytes;
};

export const readJsonFile = async (state, entry, commitSha, limits) => {
  const bytes = await readBlobBytes(state, entry, limits);
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new Error('APPROVAL_GITHUB_BLOB_UTF8_INVALID');
  }
  const value = parseApprovalJson(text);
  assertSafeParsedValue(value);
  return deepFreeze({
    path: entry.path,
    commit_sha: commitSha,
    blob_sha: entry.sha,
    mode: entry.mode,
    size_bytes: bytes.length,
    raw_sha256: sha256(bytes),
    value,
  });
};

export const authorityActors = (authorityFile) => {
  const value = authorityFile.value;
  requireCondition(
    isPlainObject(value)
      && value.schema_version === 'approval-authorities/v1'
      && value.repository?.id === REPOSITORY_ID
      && value.repository?.full_name === REPOSITORY_FULL_NAME
      && isSafeString(value.revision, 128)
      && Array.isArray(value.roles),
    'APPROVAL_GITHUB_AUTHORITY_MISMATCH',
  );
  const result = new Map();
  const roles = [];
  for (const role of ROLES) {
    const matches = value.roles.filter((entry) => entry?.role === role);
    requireCondition(matches.length === 1 && matches[0].status === 'ASSIGNED', 'APPROVAL_GITHUB_AUTHORITY_MISMATCH');
    const entry = matches[0];
    requireCondition(
      isSafePositiveInteger(entry.actor_id)
        && isSafeString(entry.actor_node_id, 256)
        && isSafeString(entry.actor_login, 256),
      'APPROVAL_GITHUB_AUTHORITY_MISMATCH',
    );
    result.set(role, entry);
    roles.push({
      role,
      status: entry.status,
      actor_id: entry.actor_id,
      actor_node_id: entry.actor_node_id,
      actor_login: entry.actor_login,
    });
  }
  return {
    actors: result,
    file: deepFreeze({
      ...authorityFile,
      value: {
        schema_version: value.schema_version,
        repository: { id: value.repository.id, full_name: value.repository.full_name },
        revision: value.revision,
        roles,
      },
    }),
  };
};

export const assertProposalSubject = (files, request) => {
  const manifestFile = files.find(({ path }) => path === request.proposalManifestPath);
  const sidecarFile = files.find(({ path }) => path === request.proposalSidecarPath);
  const manifest = manifestFile?.value;
  const sidecar = sidecarFile?.value;
  const manifestKeys = [
    'schema_version',
    'decision_id',
    'policy_revision',
    'decision_raw_sha256',
    'decision_semantic_sha256',
    'sidecar_path',
  ];
  const sidecarKeys = [
    'schema_version',
    'decision_id',
    'policy_revision',
    'decision_raw_sha256',
    'decision_semantic_sha256',
  ];
  requireCondition(
    hasExactKeys(manifest, manifestKeys)
      && hasExactKeys(sidecar, sidecarKeys)
      && manifest.schema_version === 'approval-proposal-manifest/v1'
      && sidecar.schema_version === 'approval-proposal-sidecar/v1'
      && manifest.decision_id === request.decisionId
      && sidecar.decision_id === request.decisionId
      && manifest.policy_revision === request.policyRevision
      && sidecar.policy_revision === request.policyRevision
      && manifest.decision_raw_sha256 === request.expectedDecisionRawSha256
      && sidecar.decision_raw_sha256 === request.expectedDecisionRawSha256
      && manifest.decision_semantic_sha256 === request.expectedDecisionSemanticSha256
      && sidecar.decision_semantic_sha256 === request.expectedDecisionSemanticSha256
      && manifest.sidecar_path === request.proposalSidecarPath,
    'APPROVAL_GITHUB_PROPOSAL_MISMATCH',
  );
  return deepFreeze([
    projectProposalFile(manifestFile, manifestKeys),
    projectProposalFile(sidecarFile, sidecarKeys),
  ]);
};

const projectProposalFile = (file, keys) => {
  const subject = Object.fromEntries(keys.map((key) => [key, file.value[key]]));
  return {
    path: file.path,
    commit_sha: file.commit_sha,
    blob_sha: file.blob_sha,
    mode: file.mode,
    size_bytes: file.size_bytes,
    raw_sha256: file.raw_sha256,
    semantic_sha256: sha256(Buffer.from(stableJson(subject), 'utf8')),
    subject,
  };
};
