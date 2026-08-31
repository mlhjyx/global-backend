import {
  API_VERSION,
  MAX_OUTPUT_BYTES,
  REPOSITORY_ID,
  REPOSITORY_SEGMENTS,
  arrayIsUnique,
  deepFreeze,
  isFixedApprovalError,
  isGitSha,
  requireCondition,
  sameJson,
  snapshotGitHubReadbackInputs,
} from './governance-github-readback-common.mjs';
import {
  assertProposalSubject,
  authorityActors,
  exactBlobEntry,
  readBlobBytes,
  readJsonFile,
  readTree,
} from './governance-github-readback-git.mjs';
import {
  normalizeMachineChecks,
  normalizePullRequest,
  normalizeRepository,
  normalizeReviews,
  normalizeRuleset,
} from './governance-github-readback-normalizers.mjs';
import {
  apiUrl,
  createRestClient,
  fetchJson,
  getRestState,
  paginate,
} from './governance-github-readback-rest.mjs';

const collectImpl = async (client, requestValue, limitValue, policyValue) => {
  const state = getRestState(client);
  const { request, limits, policy } = snapshotGitHubReadbackInputs(
    requestValue,
    limitValue,
    policyValue,
  );
  const budget = { items: 0, pages: 0 };

  const repositoryResponse = await fetchJson(
    state,
    apiUrl(['repositories', REPOSITORY_ID]),
    limits,
  );
  const repository = normalizeRepository(repositoryResponse.value);
  const pullUrl = apiUrl([...REPOSITORY_SEGMENTS, 'pulls', request.prNumber]);
  const prePullResponse = await fetchJson(state, pullUrl, limits);
  const prePull = normalizePullRequest(prePullResponse.value, request);
  const compareResponse = await fetchJson(
    state,
    apiUrl([...REPOSITORY_SEGMENTS, 'compare', `${request.expectedBaseSha}...${request.expectedHeadSha}`]),
    limits,
  );
  requireCondition(
    isGitSha(compareResponse.value?.merge_base_commit?.sha),
    'APPROVAL_GITHUB_PR_ASSOCIATION_MISMATCH',
  );
  const pullRequest = { ...prePull, merge_base_sha: compareResponse.value.merge_base_commit.sha };

  const headTree = await readTree(state, request.expectedHeadSha, limits, budget);
  const baseTree = await readTree(state, request.expectedBaseSha, limits, budget);
  const proposalEntries = [request.proposalManifestPath, request.proposalSidecarPath]
    .map((path) => exactBlobEntry(headTree, path, 'APPROVAL_GITHUB_TREE_ENTRY_INVALID'));
  const authorityEntry = exactBlobEntry(baseTree, request.authorityPath, 'APPROVAL_GITHUB_TREE_ENTRY_INVALID');
  const machinePaths = [...policy.allowedWorkflowPaths, ...policy.allowedReusableSignerWorkflowPaths];
  const machineEntries = machinePaths.map((path) => (
    exactBlobEntry(baseTree, path, 'APPROVAL_CHECK_WORKFLOW_MISMATCH')
  ));
  const baseEntryMap = new Map(machineEntries.map((entry) => [entry.path, entry]));

  const rawAuthorityFile = await readJsonFile(state, authorityEntry, request.expectedBaseSha, limits);
  const { actors: authority, file: authorityFile } = authorityActors(rawAuthorityFile);
  const rawProposalFiles = [];
  for (const entry of proposalEntries) {
    rawProposalFiles.push(await readJsonFile(state, entry, request.expectedHeadSha, limits));
  }
  const proposalFiles = assertProposalSubject(rawProposalFiles, request);
  for (const entry of machineEntries) await readBlobBytes(state, entry, limits);

  const reviews = await paginate(
    state,
    apiUrl([...REPOSITORY_SEGMENTS, 'pulls', request.prNumber, 'reviews'], { per_page: 100, page: 1 }),
    limits,
    budget,
    (value) => value,
    null,
    { itemId: (review) => review?.id, rejectDuplicatePage: true },
  );
  const reviewEvidence = normalizeReviews(reviews, authority, request);
  const associatedPulls = await paginate(
    state,
    apiUrl([...REPOSITORY_SEGMENTS, 'commits', request.expectedHeadSha, 'pulls'], { per_page: 100, page: 1 }),
    limits,
    budget,
    (value) => value,
  );
  requireCondition(
    associatedPulls.filter((pull) => (
      pull?.number === request.prNumber
      && pull?.head?.sha === request.expectedHeadSha
      && pull?.base?.sha === request.expectedBaseSha
    )).length === 1,
    'APPROVAL_GITHUB_PR_ASSOCIATION_MISMATCH',
  );

  const runs = await paginate(
    state,
    apiUrl([...REPOSITORY_SEGMENTS, 'actions', 'runs'], {
      event: 'pull_request_target',
      per_page: 100,
      page: 1,
    }),
    limits,
    budget,
    (value) => value?.workflow_runs,
    'total_count',
  );
  const machineChecks = await normalizeMachineChecks(
    state,
    runs,
    baseEntryMap,
    policy,
    request,
    limits,
    budget,
  );
  const allEvidenceIds = [
    ...reviewEvidence.reviewIds,
    ...machineChecks.flatMap((check) => [
      check.check_run_id, check.check_suite_id, check.actions_run_id,
    ]),
  ];
  requireCondition(arrayIsUnique(allEvidenceIds), 'APPROVAL_EVIDENCE_SLOT_REUSE');

  const rulesetUrl = apiUrl([...REPOSITORY_SEGMENTS, 'rulesets', request.rulesetId]);
  const preRulesetResponse = await fetchJson(state, rulesetUrl, limits);
  const ruleset = normalizeRuleset(preRulesetResponse.value, policy, request, true);
  const postPullResponse = await fetchJson(state, pullUrl, limits);
  const postPull = normalizePullRequest(postPullResponse.value, request);
  const postHeadTree = await readTree(state, request.expectedHeadSha, limits, budget);
  const postBaseTree = await readTree(state, request.expectedBaseSha, limits, budget);
  const postProposalEntries = [request.proposalManifestPath, request.proposalSidecarPath]
    .map((path) => exactBlobEntry(postHeadTree, path, 'APPROVAL_GITHUB_TREE_ENTRY_INVALID'));
  const postAuthorityEntry = exactBlobEntry(
    postBaseTree,
    request.authorityPath,
    'APPROVAL_GITHUB_TREE_ENTRY_INVALID',
  );
  const postMachineEntries = machinePaths.map((path) => (
    exactBlobEntry(postBaseTree, path, 'APPROVAL_CHECK_WORKFLOW_MISMATCH')
  ));
  const postRulesetResponse = await fetchJson(state, rulesetUrl, limits);
  const postRuleset = normalizeRuleset(postRulesetResponse.value, policy, request, false);
  requireCondition(
    sameJson(prePull, postPull)
      && sameJson(proposalEntries, postProposalEntries)
      && sameJson(authorityEntry, postAuthorityEntry)
      && sameJson(machineEntries, postMachineEntries)
      && ruleset.normalized_sha256 === postRuleset.normalized_sha256,
    'APPROVAL_GITHUB_HEAD_DRIFT',
  );

  const readbackIdentity = {
    base_sha: request.expectedBaseSha,
    head_sha: request.expectedHeadSha,
    authority_blob_sha: authorityEntry.sha,
    ruleset_sha256: ruleset.normalized_sha256,
  };
  const output = {
    schema_version: 'github-approval-evidence/v1',
    assembly_state: 'HOLD_LOCAL_CONTEXT_REQUIRED',
    repository,
    pull_request: pullRequest,
    review_pagination_complete: true,
    product_review: reviewEvidence.product_review,
    privacy_review: reviewEvidence.privacy_review,
    qa_review: reviewEvidence.qa_review,
    security_review: reviewEvidence.security_review,
    codeowner_review: reviewEvidence.codeowner_review,
    machine_checks: machineChecks,
    ruleset,
    authority_file: authorityFile,
    proposal_files: proposalFiles,
    readback: { pre: { ...readbackIdentity }, post: { ...readbackIdentity } },
    observed_at: request.observedAt,
    api_version: API_VERSION,
  };
  requireCondition(
    Buffer.byteLength(JSON.stringify(output), 'utf8') <= MAX_OUTPUT_BYTES,
    'APPROVAL_GITHUB_OUTPUT_TOO_LARGE',
  );
  return deepFreeze(output);
};

export const createGitHubReadbackClient = (options) => createRestClient(options);

export const collectGitHubApprovalEvidence = async (client, request, limits, trustedPolicy) => {
  try {
    return await collectImpl(client, request, limits, trustedPolicy);
  } catch (error) {
    if (isFixedApprovalError(error)) throw error;
    // Security boundary: an injected transport error may retain credentials or raw response data.
    // eslint-disable-next-line preserve-caught-error
    throw new Error('APPROVAL_GITHUB_RESPONSE_INVALID');
  }
};
