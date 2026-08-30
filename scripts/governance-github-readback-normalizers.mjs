import {
  REPOSITORY_FULL_NAME,
  REPOSITORY_ID,
  REPOSITORY_SEGMENTS,
  ROLES,
  approvalError,
  arrayIsUnique,
  deepFreeze,
  isCanonicalInstant,
  isGitSha,
  isPlainObject,
  isSafePositiveInteger,
  isSafeString,
  isWorkflowPath,
  parseApprovalReviewCommand,
  requireCondition,
  sha256,
  stableJson,
} from './governance-github-readback-common.mjs';
import { apiUrl, fetchJson } from './governance-github-readback-rest.mjs';

export const normalizeRepository = (value) => {
  requireCondition(
    isPlainObject(value)
      && value.id === REPOSITORY_ID
      && value.full_name === REPOSITORY_FULL_NAME
      && value.default_branch === 'main',
    'APPROVAL_GITHUB_REPOSITORY_MISMATCH',
  );
  return { id: value.id, full_name: value.full_name, default_branch: value.default_branch };
};

export const normalizeActor = (value) => {
  requireCondition(
    isPlainObject(value)
      && isSafePositiveInteger(value.id)
      && isSafeString(value.node_id, 256)
      && isSafeString(value.login, 256)
      && value.type === 'User',
    'APPROVAL_REVIEW_ACTOR_MISMATCH',
  );
  return { id: value.id, node_id: value.node_id, login: value.login, type: value.type };
};

export const normalizePullRequest = (value, request) => {
  requireCondition(
    isPlainObject(value)
      && value.number === request.prNumber
      && ['open', 'closed'].includes(value.state)
      && typeof value.draft === 'boolean'
      && value.base?.sha === request.expectedBaseSha
      && value.base?.repo?.id === REPOSITORY_ID
      && value.head?.sha === request.expectedHeadSha,
    'APPROVAL_GITHUB_HEAD_DRIFT',
  );
  return {
    number: value.number,
    state: value.state.toUpperCase(),
    draft: value.draft,
    base_sha: value.base.sha,
    head_sha: value.head.sha,
    author: normalizeActor(value.user),
  };
};

const parsedReview = (review) => {
  try {
    return { review, command: parseApprovalReviewCommand(review?.body) };
  } catch {
    return { review, command: null };
  }
};
const reviewOrder = (left, right) => {
  const time = Date.parse(left.review?.submitted_at) - Date.parse(right.review?.submitted_at);
  return time === 0 ? (left.review?.id ?? 0) - (right.review?.id ?? 0) : time;
};

const normalizeRoleReview = (parsed, role, authority, request) => {
  const expected = authority.get(role);
  const actorEvents = parsed
    .filter(({ review }) => review?.user?.id === expected.actor_id)
    .sort(reviewOrder);
  if (actorEvents.length === 0) {
    const wrongActorClaim = parsed.some(({ command }) => command?.role === role);
    throw approvalError(wrongActorClaim ? 'APPROVAL_REVIEW_ACTOR_MISMATCH' : 'APPROVAL_REVIEW_REQUIRED');
  }
  const selected = actorEvents.at(-1);
  requireCondition(selected.command?.role === role, 'APPROVAL_REVIEW_COMMAND_INVALID');
  const review = selected.review;
  if (review.state === 'DISMISSED') throw approvalError('APPROVAL_REVIEW_DISMISSED');
  requireCondition(review.state === 'APPROVED', 'APPROVAL_REVIEW_STALE');
  requireCondition(
    isSafePositiveInteger(review.id)
      && isCanonicalInstant(review.submitted_at)
      && review.commit_id === request.expectedHeadSha,
    'APPROVAL_REVIEW_STALE',
  );
  const actor = normalizeActor(review.user);
  requireCondition(
    actor.id === expected.actor_id
      && actor.node_id === expected.actor_node_id
      && actor.login === expected.actor_login,
    'APPROVAL_REVIEW_ACTOR_MISMATCH',
  );
  requireCondition(
    selected.command.decision_adr === request.decisionId
      && selected.command.policy_revision === request.policyRevision
      && selected.command.decision_raw_sha256 === request.expectedDecisionRawSha256,
    'APPROVAL_REVIEW_COMMAND_INVALID',
  );
  return deepFreeze({
    role,
    review_id: review.id,
    review_state: review.state,
    review_commit_id: review.commit_id,
    submitted_at: review.submitted_at,
    actor,
    review_command_sha256: selected.command.command_sha256,
  });
};

const normalizeCodeownerReview = (reviews, request) => {
  const matches = reviews.filter((review) => review?.id === request.codeownerReviewId);
  requireCondition(matches.length === 1, 'APPROVAL_CODEOWNER_REVIEW_REQUIRED');
  const review = matches[0];
  requireCondition(
    review.state === 'APPROVED'
      && review.commit_id === request.expectedHeadSha
      && isCanonicalInstant(review.submitted_at),
    'APPROVAL_CODEOWNER_REVIEW_REQUIRED',
  );
  return deepFreeze({
    role: 'CODEOWNER',
    review_id: review.id,
    review_state: review.state,
    review_commit_id: review.commit_id,
    submitted_at: review.submitted_at,
    actor: normalizeActor(review.user),
    review_command_sha256: null,
  });
};

export const normalizeReviews = (reviews, authority, request) => {
  const parsed = reviews.map(parsedReview);
  const normalized = ROLES.map((role) => normalizeRoleReview(parsed, role, authority, request));
  const codeowner = normalizeCodeownerReview(reviews, request);
  const reviewIds = [...normalized.map(({ review_id }) => review_id), codeowner.review_id];
  requireCondition(arrayIsUnique(reviewIds), 'APPROVAL_EVIDENCE_SLOT_REUSE');
  return {
    product_review: normalized[0],
    privacy_review: normalized[1],
    qa_review: normalized[2],
    security_review: normalized[3],
    codeowner_review: codeowner,
    reviewIds,
  };
};

const getWorkflow = async (state, id, limits) => {
  const response = await fetchJson(
    state,
    apiUrl([...REPOSITORY_SEGMENTS, 'actions', 'workflows', id]),
    limits,
  );
  requireCondition(
    isPlainObject(response.value)
      && response.value.id === id
      && isWorkflowPath(response.value.path)
      && response.value.state === 'active',
    'APPROVAL_CHECK_WORKFLOW_MISMATCH',
  );
  return response.value;
};

export const normalizeMachineChecks = async (
  state,
  checks,
  runs,
  baseEntries,
  policy,
  request,
  limits,
) => {
  const output = [];
  for (const context of policy.allowedCheckContexts) {
    const contextIndex = policy.allowedCheckContexts.indexOf(context);
    const matches = checks.filter((check) => check?.name === context);
    requireCondition(matches.length <= 1, 'APPROVAL_CHECK_AMBIGUOUS');
    requireCondition(matches.length === 1, 'APPROVAL_CHECK_WORKFLOW_MISMATCH');
    const check = matches[0];
    requireCondition(
      isSafePositiveInteger(check.id)
        && check.head_sha === request.expectedHeadSha
        && check.status === 'completed'
        && check.conclusion === 'success'
        && isSafePositiveInteger(check.check_suite?.id)
        && isSafePositiveInteger(check.app?.id)
        && isSafeString(check.app?.slug, 128)
        && policy.allowedActionsAppIds[contextIndex] === check.app.id,
      'APPROVAL_CHECK_WORKFLOW_MISMATCH',
    );
    const suiteResponse = await fetchJson(
      state,
      apiUrl([...REPOSITORY_SEGMENTS, 'check-suites', check.check_suite.id]),
      limits,
    );
    const suite = suiteResponse.value;
    requireCondition(
      isPlainObject(suite)
        && suite.id === check.check_suite.id
        && suite.head_sha === request.expectedHeadSha
        && suite.status === 'completed'
        && suite.conclusion === 'success'
        && suite.app?.id === check.app.id
        && suite.app?.slug === check.app.slug
        && Array.isArray(suite.pull_requests)
        && suite.pull_requests.some((pull) => (
          pull?.number === request.prNumber && pull?.head?.sha === request.expectedHeadSha
        )),
      'APPROVAL_CHECK_WORKFLOW_MISMATCH',
    );
    const runMatches = runs.filter((run) => run?.check_suite_id === suite.id);
    requireCondition(runMatches.length === 1, 'APPROVAL_CHECK_WORKFLOW_MISMATCH');
    const run = runMatches[0];
    requireCondition(
      isSafePositiveInteger(run.id)
        && isSafePositiveInteger(run.run_attempt)
        && run.event === 'pull_request_target'
        && run.status === 'completed'
        && run.conclusion === 'success'
        && run.head_sha === request.expectedHeadSha
        && isSafePositiveInteger(run.workflow_id)
        && isWorkflowPath(run.path)
        && policy.allowedWorkflowIds[contextIndex] === run.workflow_id
        && policy.allowedWorkflowPaths[contextIndex] === run.path,
      'APPROVAL_CHECK_WORKFLOW_MISMATCH',
    );
    const workflow = await getWorkflow(state, run.workflow_id, limits);
    requireCondition(workflow.path === run.path, 'APPROVAL_CHECK_WORKFLOW_MISMATCH');
    const workflowEntry = baseEntries.get(run.path);
    requireCondition(workflowEntry !== undefined, 'APPROVAL_CHECK_WORKFLOW_MISMATCH');
    let reusableSigner = null;
    const references = run.referenced_workflows;
    if (policy.allowedReusableSignerWorkflowIds.length === 0) {
      requireCondition(Array.isArray(references) && references.length === 0, 'APPROVAL_CHECK_WORKFLOW_MISMATCH');
    } else {
      requireCondition(Array.isArray(references) && references.length === 1, 'APPROVAL_CHECK_WORKFLOW_MISMATCH');
      const reference = references[0];
      requireCondition(
        isSafePositiveInteger(reference?.workflow_id)
          && isWorkflowPath(reference?.path)
          && isGitSha(reference?.sha)
          && policy.allowedReusableSignerWorkflowIds[contextIndex] === reference.workflow_id
          && policy.allowedReusableSignerWorkflowPaths[contextIndex] === reference.path,
        'APPROVAL_CHECK_WORKFLOW_MISMATCH',
      );
      const signerWorkflow = await getWorkflow(state, reference.workflow_id, limits);
      const signerEntry = baseEntries.get(reference.path);
      requireCondition(
        signerWorkflow.path === reference.path
          && signerEntry !== undefined
          && signerEntry.sha === reference.sha,
        'APPROVAL_CHECK_WORKFLOW_MISMATCH',
      );
      reusableSigner = {
        workflow_id: reference.workflow_id,
        workflow_path: reference.path,
        workflow_sha: reference.sha,
      };
    }
    output.push({
      github_app_id: check.app.id,
      github_app_slug: check.app.slug,
      check_run_id: check.id,
      check_suite_id: suite.id,
      context,
      workflow_id: run.workflow_id,
      workflow_path: run.path,
      trusted_base_workflow_blob_sha: workflowEntry.sha,
      actions_run_id: run.id,
      actions_run_attempt: run.run_attempt,
      actions_run_event: run.event,
      actions_run_head_sha: run.head_sha,
      actions_run_conclusion: run.conclusion,
      reusable_signer: reusableSigner,
    });
  }
  const dynamicIds = output.flatMap((item) => [
    item.check_run_id, item.check_suite_id, item.actions_run_id,
  ]);
  requireCondition(arrayIsUnique(dynamicIds), 'APPROVAL_CHECK_AMBIGUOUS');
  return deepFreeze(output);
};

const rulesetFacts = (value) => {
  requireCondition(
    isPlainObject(value)
      && isSafePositiveInteger(value.id)
      && typeof value.source_type === 'string'
      && typeof value.source === 'string'
      && typeof value.enforcement === 'string'
      && Array.isArray(value.bypass_actors)
      && Array.isArray(value.rules),
    'APPROVAL_GITHUB_RULESET_MISMATCH',
  );
  const statusRules = value.rules.filter((rule) => rule?.type === 'required_status_checks');
  requireCondition(statusRules.length === 1, 'APPROVAL_GITHUB_RULESET_MISMATCH');
  const parameters = statusRules[0].parameters;
  requireCondition(
    isPlainObject(parameters) && Array.isArray(parameters.required_status_checks),
    'APPROVAL_GITHUB_RULESET_MISMATCH',
  );
  const required = parameters.required_status_checks.map((check) => ({
    context: check?.context,
    integration_id: check?.integration_id,
  })).sort((left, right) => left.context.localeCompare(right.context));
  return {
    id: value.id,
    source_type: value.source_type,
    source: value.source,
    enforcement: value.enforcement,
    bypass_actors: value.bypass_actors.map((entry) => ({
      actor_id: entry?.actor_id,
      actor_type: entry?.actor_type,
      bypass_mode: entry?.bypass_mode,
    })),
    default_branch_included: value.conditions?.ref_name?.include?.includes('~DEFAULT_BRANCH') === true,
    strict_required_status_checks_policy: parameters.strict_required_status_checks_policy,
    required_status_checks: required,
  };
};

export const normalizeRuleset = (value, policy, request, enforcePolicy) => {
  const facts = rulesetFacts(value);
  const contexts = facts.required_status_checks.map(({ context }) => context);
  if (enforcePolicy) {
    requireCondition(
      facts.id === request.rulesetId
        && facts.source_type === 'Repository'
        && facts.source === REPOSITORY_FULL_NAME
        && facts.enforcement === 'active'
        && facts.bypass_actors.length === 0
        && facts.default_branch_included
        && facts.strict_required_status_checks_policy === true
        && arrayIsUnique(contexts)
        && contexts.length === policy.allowedCheckContexts.length
        && contexts.every((context) => policy.allowedCheckContexts.includes(context))
        && facts.required_status_checks.every((check) => (
          isSafePositiveInteger(check.integration_id)
          && policy.allowedActionsAppIds.includes(check.integration_id)
        )),
      'APPROVAL_GITHUB_RULESET_MISMATCH',
    );
  }
  return deepFreeze({ ...facts, normalized_sha256: sha256(Buffer.from(stableJson(facts), 'utf8')) });
};
