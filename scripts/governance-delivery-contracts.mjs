import {
  DELIVERY_STATES,
  EVIDENCE_ENVIRONMENTS,
  IDENTIFIER,
  PROMOTION_STATES,
  RELEASE_STATUSES,
  SHA_40,
  asArray,
  containsTemplateToken,
  isIsoInstant,
  isNonEmptyString,
  isObject,
  issue,
  jsonBlock,
  markdownList,
  normalizedRepoPath,
  pushRequiredString,
  result,
  sameStringSet,
  uniqueStrings,
  validateRuntimeEvidence,
} from "./governance-evidence-provider-contracts.mjs";

function validateTraceIdentifierList(
  issues,
  values,
  allowed,
  code,
  chainId,
) {
  if (!Array.isArray(values) || values.length === 0) {
    issues.push(issue(code, `${chainId} must contain at least one reference`));
    return;
  }
  for (const value of values) {
    if (!allowed.has(value)) {
      issues.push(issue(code, `${chainId} references missing ${value}`));
    }
  }
}

export function validateTraceability(traceability, context = {}) {
  const issues = [];
  if (
    !isObject(traceability) ||
    traceability.schema_version !== "delivery-traceability/v1"
  ) {
    issues.push(
      issue(
        "TRACE_SCHEMA_INVALID",
        "schema_version must equal delivery-traceability/v1",
      ),
    );
  }
  const chains = asArray(traceability?.chains);
  if (chains.length === 0) {
    issues.push(issue("TRACE_CHAINS_EMPTY", "chains must not be empty"));
  }
  const chainIds = chains.map((chain) => chain?.chain_id);
  if (!uniqueStrings(chainIds)) {
    issues.push(issue("TRACE_CHAIN_DUPLICATE", "chain_id values must be unique"));
  }

  for (const [index, chain] of chains.entries()) {
    const chainId = chain?.chain_id ?? `chains[${index}]`;
    if (!isObject(chain) || !isNonEmptyString(chain.chain_id)) {
      issues.push(issue("TRACE_CHAIN_ID_INVALID", `${chainId} has no chain_id`));
      continue;
    }
    if (!context.capability_ids?.has(chain.capability_id)) {
      issues.push(
        issue(
          "TRACE_CAPABILITY_MISSING",
          `${chainId} references missing capability ${chain.capability_id}`,
        ),
      );
    }
    validateTraceIdentifierList(
      issues,
      chain.object_ids,
      context.object_ids ?? new Set(),
      "TRACE_OBJECT_MISSING",
      chainId,
    );
    validateTraceIdentifierList(
      issues,
      chain.operation_ids,
      context.operation_ids ?? new Set(),
      "TRACE_OPERATION_MISSING",
      chainId,
    );
    validateTraceIdentifierList(
      issues,
      chain.scenario_ids,
      context.scenario_ids ?? new Set(),
      "TRACE_SCENARIO_MISSING",
      chainId,
    );
    if (!DELIVERY_STATES.has(chain.delivery_state)) {
      issues.push(
        issue("TRACE_DELIVERY_STATE_INVALID", `${chainId} delivery_state is invalid`),
      );
    }
    const requiredEvidenceKinds = asArray(chain.required_evidence_kinds);
    if (
      requiredEvidenceKinds.length === 0 ||
      requiredEvidenceKinds.some((kind) => !isNonEmptyString(kind)) ||
      !uniqueStrings(requiredEvidenceKinds)
    ) {
      issues.push(
        issue(
          "TRACE_EVIDENCE_KINDS_INVALID",
          `${chainId} must declare unique required_evidence_kinds`,
        ),
      );
    }

    for (const codePath of asArray(chain.code_paths)) {
      const normalized = normalizedRepoPath(codePath);
      if (!normalized || !context.existing_paths?.has(normalized)) {
        issues.push(
          issue("TRACE_CODE_MISSING", `${chainId} code path is missing: ${codePath}`),
        );
      }
    }
    if (asArray(chain.code_paths).length === 0) {
      issues.push(issue("TRACE_CODE_MISSING", `${chainId} has no code path`));
    }
    for (const testPath of asArray(chain.test_paths)) {
      const normalized = normalizedRepoPath(testPath);
      if (
        !normalized ||
        !/(?:^|\/)[^/]*(?:spec|test)\.[cm]?[jt]sx?$/.test(normalized) ||
        !context.existing_paths?.has(normalized)
      ) {
        issues.push(
          issue("TRACE_TEST_MISSING", `${chainId} test path is missing: ${testPath}`),
        );
      }
    }
    if (asArray(chain.test_paths).length === 0) {
      issues.push(issue("TRACE_TEST_MISSING", `${chainId} has no test path`));
    }

    const freshPassingEvidenceKinds = new Set();
    for (const evidenceId of asArray(chain.evidence_ids)) {
      const evidence = context.evidence_by_id?.get(evidenceId);
      if (!evidence) {
        issues.push(
          issue(
            "TRACE_EVIDENCE_MISSING",
            `${chainId} references missing evidence ${evidenceId}`,
          ),
        );
        continue;
      }
      const evidenceResult = validateRuntimeEvidence(evidence, {
        now: context.now,
      });
      if (!requiredEvidenceKinds.includes(evidence.evidence_kind)) {
        issues.push(
          issue(
            "TRACE_EVIDENCE_KIND_UNEXPECTED",
            `${chainId}/${evidenceId} has unexpected kind ${evidence.evidence_kind}`,
          ),
        );
      } else if (evidenceResult.eligible_for_promotion) {
        freshPassingEvidenceKinds.add(evidence.evidence_kind);
      }
      for (const evidenceIssue of evidenceResult.issues) {
        issues.push(
          issue(
            "TRACE_EVIDENCE_INVALID",
            `${chainId}/${evidenceId}: ${evidenceIssue.message}`,
          ),
        );
      }
    }

    if (PROMOTION_STATES.has(chain.delivery_state)) {
      const missingEvidenceKinds = requiredEvidenceKinds.filter(
        (kind) => !freshPassingEvidenceKinds.has(kind),
      );
      if (missingEvidenceKinds.length > 0) {
        issues.push(
          issue(
            "TRACE_FRESH_EVIDENCE_REQUIRED",
            `${chainId} cannot enter ${chain.delivery_state} without fresh PASS evidence for ${missingEvidenceKinds.join(", ")}`,
          ),
        );
      }
      const bundles =
        context.release_bundles_by_capability?.get(chain.capability_id) ?? [];
      const hasBoundReleaseBundle = bundles.some((bundle) =>
        asArray(bundle.traceability_bindings).some(
          (binding) =>
            binding?.chain_id === chain.chain_id &&
            binding?.capability_id === chain.capability_id &&
            sameStringSet(binding?.evidence_ids, chain.evidence_ids),
        ),
      );
      if (!hasBoundReleaseBundle) {
        issues.push(
          issue(
            "TRACE_RELEASE_BUNDLE_REQUIRED",
            `${chainId} cannot enter ${chain.delivery_state} without a Release Bundle bound to the same chain and evidence set`,
          ),
        );
      }
    }
  }
  return result(issues, { chain_count: chains.length });
}

export function validateDecisionGateSeparation(approval) {
  const issues = [];
  if (!isObject(approval)) {
    return result([
      issue("DECISION_GATES_REQUIRED", "approval must contain three decision gates"),
    ]);
  }
  const machine = approval.machine;
  const reviewer = approval.reviewer;
  const userAuthorization = approval.user_authorization;
  if (!isObject(machine) || machine.status !== "PASS") {
    issues.push(issue("MACHINE_GATE_NOT_PASS", "machine gate must be PASS"));
  }
  if (!isObject(reviewer) || reviewer.status !== "APPROVED") {
    issues.push(issue("REVIEWER_GATE_NOT_APPROVED", "reviewer gate must be APPROVED"));
  }
  if (!isObject(userAuthorization) || userAuthorization.status !== "AUTHORIZED") {
    issues.push(
      issue("USER_AUTHORIZATION_MISSING", "user authorization must be AUTHORIZED"),
    );
  }
  if (machine?.provenance !== "CHECK_RUN") {
    issues.push(
      issue("MACHINE_PROVENANCE_UNTRUSTED", "machine provenance must be CHECK_RUN"),
    );
  }
  if (reviewer?.provenance !== "GITHUB_REVIEW") {
    issues.push(
      issue(
        "REVIEWER_PROVENANCE_UNTRUSTED",
        "reviewer provenance must be GITHUB_REVIEW",
      ),
    );
  }
  if (userAuthorization?.provenance !== "SIGNED_AUTHORIZATION") {
    issues.push(
      issue(
        "AUTHORIZATION_PROVENANCE_UNTRUSTED",
        "user authorization must use SIGNED_AUTHORIZATION, never PR body text",
      ),
    );
  }
  const refs = [
    machine?.evidence_ref,
    reviewer?.evidence_ref,
    userAuthorization?.evidence_ref,
  ];
  if (refs.some((ref) => !isNonEmptyString(ref))) {
    issues.push(
      issue("DECISION_GATE_EVIDENCE_MISSING", "each gate needs its own evidence_ref"),
    );
  } else if (!uniqueStrings(refs)) {
    issues.push(
      issue(
        "DECISION_GATE_EVIDENCE_CONFLATED",
        "machine, reviewer, and user authorization must not reuse one artifact",
      ),
    );
  }
  if (!isIsoInstant(machine?.verified_at)) {
    issues.push(issue("MACHINE_GATE_TIME_INVALID", "machine verified_at is invalid"));
  }
  if (!isNonEmptyString(reviewer?.actor) || !isIsoInstant(reviewer?.reviewed_at)) {
    issues.push(
      issue("REVIEWER_GATE_IDENTITY_INVALID", "reviewer actor or reviewed_at is invalid"),
    );
  }
  if (
    !isNonEmptyString(userAuthorization?.actor) ||
    !isIsoInstant(userAuthorization?.authorized_at)
  ) {
    issues.push(
      issue(
        "USER_AUTHORIZATION_IDENTITY_INVALID",
        "user authorization actor or authorized_at is invalid",
      ),
    );
  }
  return result(issues);
}

export function validateMergeEvidence(mergeEvidence) {
  const issues = [];
  if (!isObject(mergeEvidence)) {
    return result([issue("MERGE_EVIDENCE_REQUIRED", "merge_evidence is required")]);
  }
  for (const field of ["base_commit", "source_head", "result_commit"]) {
    if (!SHA_40.test(mergeEvidence[field] ?? "")) {
      issues.push(issue("MERGE_SHA_INVALID", `${field} must be a full Git SHA`));
    }
  }
  if (!isIsoInstant(mergeEvidence.merged_at)) {
    issues.push(issue("MERGE_TIME_INVALID", "merged_at must be an ISO instant"));
  }
  const parents = asArray(mergeEvidence.parent_commits);
  if (parents.some((parent) => !SHA_40.test(parent))) {
    issues.push(issue("MERGE_PARENT_SHA_INVALID", "parent_commits contain invalid SHA"));
  }
  if (mergeEvidence.method === "MERGE_COMMIT") {
    if (
      parents.length !== 2 ||
      parents[0] !== mergeEvidence.base_commit ||
      parents[1] !== mergeEvidence.source_head ||
      mergeEvidence.result_commit === mergeEvidence.source_head
    ) {
      issues.push(
        issue(
          "MERGE_COMMIT_PARENTS_INVALID",
          "MERGE_COMMIT needs ordered base/source parents and a distinct result",
        ),
      );
    }
  } else if (mergeEvidence.method === "SQUASH") {
    if (
      parents.length !== 1 ||
      parents[0] !== mergeEvidence.base_commit ||
      mergeEvidence.result_commit === mergeEvidence.source_head ||
      mergeEvidence.result_commit === mergeEvidence.base_commit
    ) {
      issues.push(
        issue(
          "SQUASH_EVIDENCE_INVALID",
          "SQUASH needs the base parent and a distinct result/source head",
        ),
      );
    }
  } else if (mergeEvidence.method === "REBASE") {
    const sourceCommits = asArray(mergeEvidence.source_commits);
    const rebasedCommits = asArray(mergeEvidence.rebased_commits);
    if (
      parents.length !== 1 ||
      parents[0] !== mergeEvidence.base_commit ||
      sourceCommits.length === 0 ||
      sourceCommits.length !== rebasedCommits.length ||
      sourceCommits.some((sha) => !SHA_40.test(sha)) ||
      rebasedCommits.some((sha) => !SHA_40.test(sha)) ||
      rebasedCommits.at(-1) !== mergeEvidence.result_commit
    ) {
      issues.push(
        issue(
          "REBASE_EVIDENCE_INVALID",
          "REBASE needs a base parent and a complete source-to-rebased commit mapping",
        ),
      );
    }
  } else {
    issues.push(
      issue("MERGE_METHOD_INVALID", "method must be MERGE_COMMIT, SQUASH, or REBASE"),
    );
  }
  return result(issues);
}

export function validateReleaseBundle(bundle, context = {}) {
  const issues = [];
  if (!isObject(bundle) || bundle.schema_version !== "release-bundle/v1") {
    issues.push(
      issue(
        "RELEASE_SCHEMA_INVALID",
        "schema_version must equal release-bundle/v1",
      ),
    );
  }
  if (containsTemplateToken(bundle)) {
    issues.push(
      issue(
        "RELEASE_PLACEHOLDER_PRESENT",
        "a real Release Bundle cannot contain template placeholders",
      ),
    );
  }
  if (!isNonEmptyString(bundle?.release_id) || !IDENTIFIER.test(bundle.release_id)) {
    issues.push(issue("RELEASE_ID_INVALID", "release_id is invalid"));
  }
  if (!RELEASE_STATUSES.has(bundle?.release_status)) {
    issues.push(issue("RELEASE_STATUS_INVALID", "release_status is invalid"));
  }
  if (!EVIDENCE_ENVIRONMENTS.has(bundle?.environment)) {
    issues.push(issue("RELEASE_ENVIRONMENT_INVALID", "environment is invalid"));
  }
  pushRequiredString(issues, bundle, "release_owner", "RELEASE_OWNER_INVALID");
  if (!SHA_40.test(bundle?.implementation_commit ?? "")) {
    issues.push(
      issue("RELEASE_IMPLEMENTATION_SHA_INVALID", "implementation_commit is invalid"),
    );
  }
  if (!isIsoInstant(bundle?.released_at)) {
    issues.push(issue("RELEASE_TIME_INVALID", "released_at is invalid"));
  }
  if (!Array.isArray(bundle?.capability_ids) || bundle.capability_ids.length === 0) {
    issues.push(
      issue("RELEASE_CAPABILITIES_EMPTY", "capability_ids must not be empty"),
    );
  }
  const traceabilityBindings = asArray(bundle?.traceability_bindings);
  if (!Array.isArray(bundle?.traceability_bindings)) {
    issues.push(
      issue(
        "RELEASE_TRACEABILITY_INVALID",
        "traceability_bindings must be an array",
      ),
    );
  }
  const bindingChainIds = traceabilityBindings.map((binding) => binding?.chain_id);
  if (!uniqueStrings(bindingChainIds)) {
    issues.push(
      issue(
        "RELEASE_TRACEABILITY_DUPLICATE",
        "traceability_bindings must contain unique chain_id values",
      ),
    );
  }
  const boundCapabilityIds = new Set();
  const boundEvidenceIds = new Set();
  for (const [index, binding] of traceabilityBindings.entries()) {
    if (
      !isObject(binding) ||
      !isNonEmptyString(binding.chain_id) ||
      !isNonEmptyString(binding.capability_id) ||
      !Array.isArray(binding.evidence_ids) ||
      binding.evidence_ids.length === 0 ||
      binding.evidence_ids.some((id) => !isNonEmptyString(id)) ||
      !uniqueStrings(binding.evidence_ids)
    ) {
      issues.push(
        issue(
          "RELEASE_TRACEABILITY_INVALID",
          `traceability_bindings[${index}] is invalid`,
        ),
      );
      continue;
    }
    if (!asArray(bundle?.capability_ids).includes(binding.capability_id)) {
      issues.push(
        issue(
          "RELEASE_TRACEABILITY_CAPABILITY_UNBOUND",
          `${binding.chain_id} references capability outside this release`,
        ),
      );
    } else {
      boundCapabilityIds.add(binding.capability_id);
    }
    const registeredChain = context.traceability_by_id?.get(binding.chain_id);
    if (!registeredChain) {
      issues.push(
        issue(
          "RELEASE_TRACEABILITY_CHAIN_MISSING",
          `${binding.chain_id} is not present in delivery traceability`,
        ),
      );
    } else {
      if (
        registeredChain.capability_id !== binding.capability_id ||
        !sameStringSet(registeredChain.evidence_ids, binding.evidence_ids)
      ) {
        issues.push(
          issue(
            "RELEASE_TRACEABILITY_BINDING_MISMATCH",
            `${binding.chain_id} must bind the registered capability and exact evidence set`,
          ),
        );
      }
      if (
        PROMOTION_STATES.has(bundle?.release_status) &&
        registeredChain.delivery_state !== bundle.release_status
      ) {
        issues.push(
          issue(
            "RELEASE_TRACEABILITY_STATE_MISMATCH",
            `${binding.chain_id} is ${registeredChain.delivery_state}, not ${bundle.release_status}`,
          ),
        );
      }
    }
    for (const evidenceId of binding.evidence_ids) {
      if (!asArray(bundle?.evidence_ids).includes(evidenceId)) {
        issues.push(
          issue(
            "RELEASE_TRACEABILITY_EVIDENCE_UNBOUND",
            `${binding.chain_id} references evidence outside this release: ${evidenceId}`,
          ),
        );
      } else {
        boundEvidenceIds.add(evidenceId);
      }
    }
  }
  for (const section of [
    "scope",
    "promise",
    "source",
    "operations",
    "data",
    "rollback_and_exit",
    "learning",
  ]) {
    if (!isObject(bundle?.[section]) || Object.keys(bundle[section]).length === 0) {
      issues.push(
        issue("RELEASE_SECTION_EMPTY", `${section} must be a non-empty object`),
      );
    }
  }
  if (!Array.isArray(bundle?.guides) || bundle.guides.length === 0) {
    issues.push(issue("RELEASE_GUIDES_EMPTY", "guides must not be empty"));
  }

  let hasFreshPassingEvidence = false;
  for (const evidenceId of asArray(bundle?.evidence_ids)) {
    const evidence = context.evidence_by_id?.get(evidenceId);
    if (!evidence) {
      issues.push(
        issue("RELEASE_EVIDENCE_MISSING", `evidence ${evidenceId} is missing`),
      );
      continue;
    }
    const evidenceResult = validateRuntimeEvidence(evidence, { now: context.now });
    const identityMatches =
      evidence.commit === bundle.implementation_commit &&
      evidence.environment === bundle.environment;
    if (!identityMatches) {
      issues.push(
        issue(
          "RELEASE_EVIDENCE_IDENTITY_MISMATCH",
          `${evidenceId} must bind implementation_commit and release environment`,
        ),
      );
    }
    if (
      evidenceResult.eligible_for_promotion &&
      identityMatches &&
      isIsoInstant(bundle.released_at) &&
      Date.parse(evidence.verified_at) <= Date.parse(bundle.released_at)
    ) {
      hasFreshPassingEvidence = true;
    } else if (
      evidenceResult.eligible_for_promotion &&
      identityMatches &&
      isIsoInstant(bundle.released_at)
    ) {
      issues.push(
        issue(
          "RELEASE_EVIDENCE_TIME_INVALID",
          `${evidenceId} was verified after released_at`,
        ),
      );
    }
    for (const evidenceIssue of evidenceResult.issues) {
      issues.push(
        issue(
          "RELEASE_EVIDENCE_INVALID",
          `${evidenceId}: ${evidenceIssue.message}`,
        ),
      );
    }
  }

  if (PROMOTION_STATES.has(bundle?.release_status)) {
    if (traceabilityBindings.length === 0) {
      issues.push(
        issue(
          "RELEASE_TRACEABILITY_REQUIRED",
          `${bundle.release_status} requires at least one traceability binding`,
        ),
      );
    }
    for (const capabilityId of asArray(bundle?.capability_ids)) {
      if (!boundCapabilityIds.has(capabilityId)) {
        issues.push(
          issue(
            "RELEASE_TRACEABILITY_CAPABILITY_UNBOUND",
            `${capabilityId} has no traceability binding`,
          ),
        );
      }
    }
    for (const evidenceId of asArray(bundle?.evidence_ids)) {
      if (!boundEvidenceIds.has(evidenceId)) {
        issues.push(
          issue(
            "RELEASE_TRACEABILITY_EVIDENCE_UNBOUND",
            `${evidenceId} is not bound to a traceability chain`,
          ),
        );
      }
    }
    if (!hasFreshPassingEvidence) {
      issues.push(
        issue(
          "RELEASE_FRESH_EVIDENCE_REQUIRED",
          `${bundle.release_status} requires current PASS evidence`,
        ),
      );
    }
    issues.push(...validateDecisionGateSeparation(bundle.approval).issues);
    const mergeValidation = validateMergeEvidence(bundle.merge_evidence);
    issues.push(...mergeValidation.issues);
    if (
      mergeValidation.issues.length === 0 &&
      (bundle.implementation_commit !== bundle.merge_evidence.result_commit ||
        bundle.source?.base_commit !== bundle.merge_evidence.base_commit ||
        bundle.source?.source_head !== bundle.merge_evidence.source_head)
    ) {
      issues.push(
        issue(
          "RELEASE_IMPLEMENTATION_MERGE_MISMATCH",
          "implementation/source identity must match the verified merge result",
        ),
      );
    }
    if (
      mergeValidation.issues.length === 0 &&
      isIsoInstant(bundle.released_at) &&
      Date.parse(bundle.released_at) < Date.parse(bundle.merge_evidence.merged_at)
    ) {
      issues.push(
        issue(
          "RELEASE_BEFORE_MERGE",
          "released_at cannot be earlier than the verified merge",
        ),
      );
    }
    for (const evidenceId of asArray(bundle.evidence_ids)) {
      const evidence = context.evidence_by_id?.get(evidenceId);
      if (
        evidence &&
        mergeValidation.issues.length === 0 &&
        isIsoInstant(evidence.verified_at) &&
        Date.parse(evidence.verified_at) < Date.parse(bundle.merge_evidence.merged_at)
      ) {
        issues.push(
          issue(
            "RELEASE_EVIDENCE_BEFORE_MERGE",
            `${evidenceId} predates the merge result it claims to verify`,
          ),
        );
      }
    }
  }
  return result(issues);
}

export function renderReleaseBundle(bundle) {
  const capabilities = markdownList(bundle.capability_ids?.map((id) => `\`${id}\``));
  const traceabilityBindings = markdownList(
    bundle.traceability_bindings?.map(
      (binding) =>
        `\`${binding.chain_id}\` → \`${binding.capability_id}\` → ${binding.evidence_ids.map((id) => `\`${id}\``).join(", ")}`,
    ),
  );
  const evidence = markdownList(bundle.evidence_ids?.map((id) => `\`${id}\``));
  const guides = markdownList(bundle.guides);
  return `# Release Bundle — ${bundle.release_id}

> Release ID：\`${bundle.release_id}\`
> 状态：\`${bundle.release_status}\`
> 环境：\`${bundle.environment}\`
> Release Owner：\`${bundle.release_owner}\`
> 实现提交：\`${bundle.implementation_commit}\`
> 发布时间：\`${bundle.released_at}\`

## Identity

${capabilities}

### Traceability bindings

${traceabilityBindings}

## Scope

${jsonBlock(bundle.scope)}

## Promise

${jsonBlock(bundle.promise)}

## Source

${jsonBlock(bundle.source)}

## Evidence

${evidence}

## Operations

${jsonBlock(bundle.operations)}

## Data

${jsonBlock(bundle.data)}

## Rollback and exit

${jsonBlock(bundle.rollback_and_exit)}

## Guides

${guides}

## Approval

${jsonBlock(bundle.approval)}

### Merge evidence

${jsonBlock(bundle.merge_evidence)}

## Learning

${jsonBlock(bundle.learning)}
`;
}
