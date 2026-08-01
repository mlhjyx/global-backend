import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { DESIGN_SPEC_TASK } from "../design/design-brief-producer";
import {
  SITE_BUILDER_MODEL_EVALUATION_HARNESS_ID,
  buildCanonicalModelEvaluationCase,
  buildTaskEvaluationPlan,
} from "./model-evaluation-harness";
import {
  modelEvaluationInitialPromptUtf8Bytes,
  modelEvaluationRepairPromptUtf8BytesUpperBound,
} from "./model-evaluation-executor";
import { sha256CanonicalJson } from "./eval-provenance";
import { writeRepositoryJsonCreateOnly } from "./create-only-json";
import {
  DESIGN_SPEC_EVAL_FIXTURES,
  designSpecFixtureFingerprint,
  prepareDesignSpecEvalFixture,
  selectDesignSpecDeterministicCandidate,
} from "./design-spec-eval";
import {
  attestCompiledContractsAfterSuiteImport,
  captureCompiledContractsSuiteImport,
  COMPILED_CONTRACTS_ATTESTATION_SCHEMA_VERSION,
  COMPILED_CONTRACTS_BUILD_COMMAND,
  COMPILED_CONTRACTS_BUILD_ID,
  COMPILED_CONTRACTS_RUNTIME_ENTRYPOINT,
  assertCompiledContractsAttestationStable,
  compiledContractsRuntimeBindingFromAttestation,
  compiledContractsRuntimeBindingMatches,
  isCompiledContractsAttestationBoundToSuiteImport,
  isTrustedCompiledContractsAttestation,
  type CompiledContractsBuildReceipt,
  type CompiledContractsAttestation,
} from "./compiled-contracts-attestation";

const DESIGN_SPEC_SUITE_REPOSITORY_ROOT = realpathSync(
  resolve(__dirname, "../../../../.."),
);
const DESIGN_SPEC_COMPILED_CONTRACTS_SUITE_IMPORT =
  captureCompiledContractsSuiteImport(DESIGN_SPEC_SUITE_REPOSITORY_ROOT);

export const DESIGN_SPEC_EVALUATION_SUITE_PREP_ID =
  "site-builder-design-spec-evaluation-suite-prep/2026-08-01-v13" as const;
export const DESIGN_SPEC_EVALUATION_SUITE_PREP_SCHEMA_VERSION =
  "site-builder-design-spec-evaluation-suite-prep/v2" as const;

export const DESIGN_SPEC_EVALUATION_STOP_CONDITIONS = Object.freeze([
  "fixed_commit_or_source_bundle_drift",
  "compiled_contracts_runtime_attestation_drift",
  "untrusted_compiled_contracts_build_attestation",
  "fixture_matrix_or_prompt_drift",
  "fixed_commit_not_reachable_after_merge",
  "candidate_alias_or_protocol_drift",
  "retired_or_deferred_alias_present",
  "execution_or_wire_call_manifest_exhausted",
  "missing_openox_price_or_price_drift",
  "missing_limited_credential_attestation",
  "missing_separate_real_cost_authorization",
  "unknown_or_over_budget_settlement",
] as const);

export interface DesignSpecEvaluationExecutionPlan {
  ordinal: number;
  executionKey: string;
  kind: "capability_probe" | "target";
  alias: string;
  protocol: "openai-responses" | "anthropic-messages";
  fixtureId: string;
  attempt: number;
  maximumWireCalls: 2;
  maximumRepairCalls: 1;
}

export interface DesignSpecDeterministicComparatorCase {
  ordinal: number;
  comparatorId: "deterministic-catalog-selection/v1";
  fixtureId: string;
  attempt: number;
  fixtureSha256: string;
  promptSha256: string;
  expectedCandidateId: string;
  actualCandidateId: string;
  assessment: "PASS";
  resultSha256: string;
  wireCalls: 0;
  costCents: 0;
}

export interface DesignSpecEvaluationSuitePrepManifest {
  schemaVersion: typeof DESIGN_SPEC_EVALUATION_SUITE_PREP_SCHEMA_VERSION;
  prepId: typeof DESIGN_SPEC_EVALUATION_SUITE_PREP_ID;
  harnessId: typeof SITE_BUILDER_MODEL_EVALUATION_HARNESS_ID;
  taskId: "site_builder.design_spec";
  fixedCommitSha: string;
  createOnly: true;
  dispatchAuthorization: "NOT_AUTHORIZED";
  actualNetworkCalls: 0;
  actualModelCostCents: 0;
  historyPreservationGate: {
    fixedCommitReachableFromPrepHead: true;
    requiredMergeMethod: "merge_commit";
    postMergeReachabilityRequiredBeforeEvidence: true;
    squashOrRebaseOutcome: "FAIL_CLOSED";
  };
  compiledContracts: CompiledContractsAttestation;
  suite: {
    suiteId: string;
    fixtureSetId: string;
    fixtureCount: 12;
    repeats: 2;
    candidateCount: 3;
    sourceBundleContractId: string;
    sourceBundleSha256: string;
    compiledContractsArtifactTreeSha256: string;
    sourceFiles: readonly {
      role: string;
      path: string;
      sha256: string;
    }[];
  };
  repair: {
    enabled: true;
    maximumRepairCallsPerExecution: 1;
    maximumWireCallsPerExecution: 2;
  };
  promptUtf8Bytes: {
    maximumCanonicalInitial: number;
    maximumCanonicalRepair: number;
  };
  executions: readonly DesignSpecEvaluationExecutionPlan[];
  executionCount: 73;
  maximumWireCallCount: 146;
  deterministicComparator: {
    comparatorId: "deterministic-catalog-selection/v1";
    modelAliases: readonly [];
    cases: readonly DesignSpecDeterministicComparatorCase[];
    caseCount: 24;
    wireCallCount: 0;
    costCents: 0;
  };
  planningHardUpperBound: {
    basis: "per_wire_call_task_hard_cap";
    perWireCallCents: 20;
    maximumWireCalls: 146;
    amountCents: 2_920;
    authorization: "NOT_GRANTED";
    expectedCost: "NOT_CALCULATED";
  };
  pricingGate: {
    amountBasis: "frozen_openox_public_price_snapshot_required";
    newApiPriceAllowed: false;
    status: "BLOCKED_UNTIL_SEPARATE_EVIDENCE_PR";
  };
  excludedAliases: readonly [
    "minimax-m3",
    "doubao-seed-2.0-pro",
    "doubao-seed-2.0-lite",
  ];
  deferredScope: readonly [
    "gemini_text",
    "image",
    "video",
    "other_five_text_tasks",
    "runtime_route_change",
    "promotion",
    "m2_publish",
  ];
  stopConditions: typeof DESIGN_SPEC_EVALUATION_STOP_CONDITIONS;
  manifestSha256: string;
}

export function attestDesignSpecCompiledContractsAfterSuiteImport(
  buildReceipt: CompiledContractsBuildReceipt,
): CompiledContractsAttestation {
  return attestCompiledContractsAfterSuiteImport(
    buildReceipt,
    DESIGN_SPEC_COMPILED_CONTRACTS_SUITE_IMPORT,
  );
}

function sourceFileAtFixedCommit(
  repositoryRoot: string,
  fixedCommitSha: string,
  path: string,
): Buffer {
  try {
    return execFileSync("git", ["show", `${fixedCommitSha}:${path}`], {
      cwd: repositoryRoot,
      encoding: null,
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch {
    throw new Error(`${path} must be tracked at the fixed commit`);
  }
}

export function assertDesignSpecSourceBundleAtFixedCommit(
  repositoryRoot: string,
  fixedCommitSha: string,
  sourceFiles: readonly { path: string; sha256: string }[],
): void {
  if (!/^[a-f0-9]{40}$/.test(fixedCommitSha)) {
    throw new Error("design_spec source bundle requires a 40-character commit");
  }
  const realRepositoryRoot = realpathSync(repositoryRoot);
  try {
    execFileSync(
      "git",
      ["merge-base", "--is-ancestor", fixedCommitSha, "HEAD"],
      {
        cwd: realRepositoryRoot,
        stdio: "ignore",
      },
    );
  } catch {
    throw new Error(
      "design_spec fixed commit must be reachable from the current history",
    );
  }
  const seen = new Set<string>();
  for (const source of sourceFiles) {
    if (
      source.path.length === 0 ||
      isAbsolute(source.path) ||
      source.path.includes("\\") ||
      source.path.split("/").includes("..") ||
      !/^[a-f0-9]{64}$/.test(source.sha256) ||
      seen.has(source.path)
    ) {
      throw new Error("design_spec source bundle contains an invalid path");
    }
    seen.add(source.path);
    const resolved = resolve(realRepositoryRoot, source.path);
    const repositoryRelative = relative(realRepositoryRoot, resolved);
    if (
      repositoryRelative.length === 0 ||
      repositoryRelative === ".." ||
      repositoryRelative.startsWith(`..${sep}`) ||
      isAbsolute(repositoryRelative)
    ) {
      throw new Error(`${source.path} escapes the repository`);
    }
    const realSource = realpathSync(resolved);
    const realRepositoryRelative = relative(realRepositoryRoot, realSource);
    if (
      realRepositoryRelative === ".." ||
      realRepositoryRelative.startsWith(`..${sep}`) ||
      isAbsolute(realRepositoryRelative)
    ) {
      throw new Error(`${source.path} resolves outside the repository`);
    }
    const committed = sourceFileAtFixedCommit(
      realRepositoryRoot,
      fixedCommitSha,
      source.path,
    );
    const working = readFileSync(realSource);
    if (!working.equals(committed)) {
      throw new Error(`${source.path} drifted from the fixed commit`);
    }
    const committedSha256 = createHash("sha256")
      .update(committed)
      .digest("hex");
    if (committedSha256 !== source.sha256) {
      throw new Error(
        `${source.path} does not match the fixed source bundle digest`,
      );
    }
  }
}

function executionKey(input: {
  kind: DesignSpecEvaluationExecutionPlan["kind"];
  alias: string;
  protocol: string;
  fixtureId: string;
  attempt: number;
}): string {
  return [
    input.kind,
    input.alias,
    input.protocol,
    input.fixtureId,
    input.attempt,
  ].join("/");
}

export function buildDesignSpecEvaluationSuitePrepManifest(
  fixedCommitSha: string,
  compiledContracts: CompiledContractsAttestation,
): DesignSpecEvaluationSuitePrepManifest {
  if (!/^[a-f0-9]{40}$/.test(fixedCommitSha)) {
    throw new Error("design_spec suite prep requires a 40-character commit");
  }
  if (
    compiledContracts.schemaVersion !==
      COMPILED_CONTRACTS_ATTESTATION_SCHEMA_VERSION ||
    compiledContracts.buildId !== COMPILED_CONTRACTS_BUILD_ID ||
    compiledContracts.buildCommand !== COMPILED_CONTRACTS_BUILD_COMMAND ||
    compiledContracts.fixedCommitSha !== fixedCommitSha ||
    compiledContracts.runtimeEntrypoint !==
      COMPILED_CONTRACTS_RUNTIME_ENTRYPOINT ||
    compiledContracts.staleOutputRemovedBeforeBuild !== true ||
    compiledContracts.suiteImportedAfterBuild !== true ||
    compiledContracts.trackedSourceFiles.length === 0 ||
    compiledContracts.compiledArtifacts.length === 0 ||
    compiledContracts.trackedSourceFiles.some(
      ({ path }, index, entries) =>
        (index > 0 && entries[index - 1]!.path >= path) ||
        path.includes("\\") ||
        path.split("/").includes(".."),
    ) ||
    compiledContracts.compiledArtifacts.some(
      ({ path }, index, entries) =>
        (index > 0 && entries[index - 1]!.path >= path) ||
        path.includes("\\") ||
        path.split("/").includes(".."),
    ) ||
    compiledContracts.trackedSourceFiles.some(
      ({ path, sha256 }) =>
        !path.startsWith("packages/contracts/") ||
        path.startsWith("packages/contracts/dist/") ||
        !/^[a-f0-9]{64}$/.test(sha256),
    ) ||
    compiledContracts.compiledArtifacts.some(
      ({ path, sha256 }) =>
        !path.startsWith("packages/contracts/dist/") ||
        !path.endsWith(".js") ||
        !/^[a-f0-9]{64}$/.test(sha256),
    ) ||
    !compiledContracts.compiledArtifacts.some(
      ({ path }) => path === COMPILED_CONTRACTS_RUNTIME_ENTRYPOINT,
    ) ||
    compiledContracts.trackedSourceTreeSha256 !==
      sha256CanonicalJson(compiledContracts.trackedSourceFiles) ||
    compiledContracts.compiledArtifactTreeSha256 !==
      sha256CanonicalJson(compiledContracts.compiledArtifacts)
  ) {
    throw new Error("trusted fixed-commit compiled contracts required");
  }
  const plan = buildTaskEvaluationPlan("site_builder.design_spec");
  const suite = plan.evaluationSuite;
  if (
    plan.dispatchAdmission !== "task_evaluation_ready" ||
    !suite ||
    suite.fixtureIds.length !== 12 ||
    suite.repeats !== 2 ||
    plan.candidates.length !== 3 ||
    plan.envelope.perCallCostCapCents !== 20
  ) {
    throw new Error("design_spec suite matrix is not canonical");
  }
  if (
    suite.compiledContractsRuntimeBinding === null ||
    !compiledContractsRuntimeBindingMatches(
      suite.compiledContractsRuntimeBinding,
      compiledContractsRuntimeBindingFromAttestation(compiledContracts),
    )
  ) {
    throw new Error(
      "design_spec suite is not bound to the rebuilt contracts runtime",
    );
  }
  const cases = suite.fixtureIds.map((fixtureId) =>
    buildCanonicalModelEvaluationCase(plan, fixtureId),
  );
  const sourceFiles = cases[0]!.payload.sourceFiles;
  if (
    cases.some(
      ({ payload }) =>
        sha256CanonicalJson(payload.sourceFiles) !==
        sha256CanonicalJson(sourceFiles),
    )
  ) {
    throw new Error("design_spec source bundle changes across fixtures");
  }
  const probeCandidate = plan.candidates.find(
    ({ preflight }) => preflight === "capability_probe",
  );
  if (
    !probeCandidate ||
    probeCandidate.alias !== "gpt-5.5" ||
    probeCandidate.expectedProtocol !== "openai-responses"
  ) {
    throw new Error("design_spec GPT-5.5 capability probe is not canonical");
  }
  const executions: DesignSpecEvaluationExecutionPlan[] = [
    {
      ordinal: 1,
      executionKey: executionKey({
        kind: "capability_probe",
        alias: probeCandidate.alias,
        protocol: probeCandidate.expectedProtocol,
        fixtureId: suite.fixtureIds[0]!,
        attempt: 1,
      }),
      kind: "capability_probe",
      alias: probeCandidate.alias,
      protocol: probeCandidate.expectedProtocol,
      fixtureId: suite.fixtureIds[0]!,
      attempt: 1,
      maximumWireCalls: 2,
      maximumRepairCalls: 1,
    },
  ];
  for (const candidate of plan.candidates) {
    if (
      candidate.expectedProtocol !== "openai-responses" &&
      candidate.expectedProtocol !== "anthropic-messages"
    ) {
      throw new Error(
        `design_spec target protocol is not admitted: ${candidate.expectedProtocol}`,
      );
    }
    for (const fixtureId of suite.fixtureIds) {
      for (let attempt = 1; attempt <= suite.repeats; attempt += 1) {
        executions.push({
          ordinal: executions.length + 1,
          executionKey: executionKey({
            kind: "target",
            alias: candidate.alias,
            protocol: candidate.expectedProtocol,
            fixtureId,
            attempt,
          }),
          kind: "target",
          alias: candidate.alias,
          protocol: candidate.expectedProtocol,
          fixtureId,
          attempt,
          maximumWireCalls: 2,
          maximumRepairCalls: 1,
        });
      }
    }
  }
  const deterministicCases: DesignSpecDeterministicComparatorCase[] = [];
  for (const fixtureId of suite.fixtureIds) {
    const fixture = DESIGN_SPEC_EVAL_FIXTURES.find(
      (candidate) => candidate.fixtureId === fixtureId,
    );
    if (!fixture) {
      throw new Error(`design_spec comparator fixture missing: ${fixtureId}`);
    }
    const prepared = prepareDesignSpecEvalFixture(fixture);
    const expectedCandidateId =
      prepared.fixture.assertions.deterministicCandidateId;
    const actualCandidateId = selectDesignSpecDeterministicCandidate(
      prepared.input,
    ).id;
    if (actualCandidateId !== expectedCandidateId) {
      throw new Error(
        `design_spec deterministic comparator mismatch: ${fixtureId}`,
      );
    }
    const fingerprints = designSpecFixtureFingerprint(fixture);
    for (let attempt = 1; attempt <= suite.repeats; attempt += 1) {
      const result = {
        fixtureId,
        attempt,
        expectedCandidateId,
        actualCandidateId,
        assessment: "PASS" as const,
      };
      deterministicCases.push({
        ordinal: deterministicCases.length + 1,
        comparatorId: "deterministic-catalog-selection/v1",
        fixtureId,
        attempt,
        ...fingerprints,
        expectedCandidateId,
        actualCandidateId,
        assessment: "PASS",
        resultSha256: sha256CanonicalJson(result),
        wireCalls: 0,
        costCents: 0,
      });
    }
  }
  if (executions.length !== 73 || deterministicCases.length !== 24) {
    throw new Error("design_spec suite execution matrix count drifted");
  }
  const promptUtf8Bytes = {
    maximumCanonicalInitial: Math.max(
      ...cases.map(({ payload }) =>
        modelEvaluationInitialPromptUtf8Bytes(
          payload.prompt,
          DESIGN_SPEC_TASK.outputSchema,
          "site_builder.design_spec",
        ),
      ),
    ),
    maximumCanonicalRepair: Math.max(
      ...cases.map(({ payload }) =>
        modelEvaluationRepairPromptUtf8BytesUpperBound(
          payload.prompt,
          DESIGN_SPEC_TASK.outputSchema,
          "site_builder.design_spec",
        ),
      ),
    ),
  };
  const withoutDigest = {
    schemaVersion: DESIGN_SPEC_EVALUATION_SUITE_PREP_SCHEMA_VERSION,
    prepId: DESIGN_SPEC_EVALUATION_SUITE_PREP_ID,
    harnessId: SITE_BUILDER_MODEL_EVALUATION_HARNESS_ID,
    taskId: "site_builder.design_spec",
    fixedCommitSha,
    createOnly: true,
    dispatchAuthorization: "NOT_AUTHORIZED",
    actualNetworkCalls: 0,
    actualModelCostCents: 0,
    historyPreservationGate: {
      fixedCommitReachableFromPrepHead: true,
      requiredMergeMethod: "merge_commit",
      postMergeReachabilityRequiredBeforeEvidence: true,
      squashOrRebaseOutcome: "FAIL_CLOSED",
    },
    compiledContracts,
    suite: {
      suiteId: suite.suiteId,
      fixtureSetId: suite.fixtureSetId,
      fixtureCount: 12,
      repeats: 2,
      candidateCount: 3,
      sourceBundleContractId: suite.sourceBundleContractId,
      sourceBundleSha256: cases[0]!.contract.sourceBundleSha256,
      compiledContractsArtifactTreeSha256:
        suite.compiledContractsRuntimeBinding.compiledArtifactTreeSha256,
      sourceFiles,
    },
    repair: {
      enabled: true,
      maximumRepairCallsPerExecution: 1,
      maximumWireCallsPerExecution: 2,
    },
    promptUtf8Bytes,
    executions,
    executionCount: 73,
    maximumWireCallCount: 146,
    deterministicComparator: {
      comparatorId: "deterministic-catalog-selection/v1",
      modelAliases: [] as const,
      cases: deterministicCases,
      caseCount: 24,
      wireCallCount: 0,
      costCents: 0,
    },
    planningHardUpperBound: {
      basis: "per_wire_call_task_hard_cap",
      perWireCallCents: 20,
      maximumWireCalls: 146,
      amountCents: 2_920,
      authorization: "NOT_GRANTED",
      expectedCost: "NOT_CALCULATED",
    },
    pricingGate: {
      amountBasis: "frozen_openox_public_price_snapshot_required",
      newApiPriceAllowed: false,
      status: "BLOCKED_UNTIL_SEPARATE_EVIDENCE_PR",
    },
    excludedAliases: [
      "minimax-m3",
      "doubao-seed-2.0-pro",
      "doubao-seed-2.0-lite",
    ] as const,
    deferredScope: [
      "gemini_text",
      "image",
      "video",
      "other_five_text_tasks",
      "runtime_route_change",
      "promotion",
      "m2_publish",
    ] as const,
    stopConditions: DESIGN_SPEC_EVALUATION_STOP_CONDITIONS,
  } as const;
  return Object.freeze({
    ...withoutDigest,
    manifestSha256: sha256CanonicalJson(withoutDigest),
  });
}

export async function writeDesignSpecEvaluationSuitePrepManifestCreateOnly(
  repositoryRoot: string,
  repositoryRelativePath: string,
  manifest: DesignSpecEvaluationSuitePrepManifest,
  compiledContracts: CompiledContractsAttestation,
): Promise<void> {
  if (
    manifest.compiledContracts !== compiledContracts ||
    !isTrustedCompiledContractsAttestation(compiledContracts) ||
    !isCompiledContractsAttestationBoundToSuiteImport(
      compiledContracts,
      DESIGN_SPEC_COMPILED_CONTRACTS_SUITE_IMPORT,
    ) ||
    manifest.manifestSha256 !==
      sha256CanonicalJson(
        Object.fromEntries(
          Object.entries(manifest).filter(([key]) => key !== "manifestSha256"),
        ),
      ) ||
    manifest.dispatchAuthorization !== "NOT_AUTHORIZED" ||
    manifest.actualNetworkCalls !== 0 ||
    manifest.actualModelCostCents !== 0
  ) {
    throw new Error("trusted zero-cost design_spec suite manifest required");
  }
  const canonicalManifest = buildDesignSpecEvaluationSuitePrepManifest(
    manifest.fixedCommitSha,
    compiledContracts,
  );
  if (
    canonicalManifest.manifestSha256 !== manifest.manifestSha256 ||
    sha256CanonicalJson(canonicalManifest) !== sha256CanonicalJson(manifest)
  ) {
    throw new Error("canonical zero-cost design_spec suite manifest required");
  }
  assertDesignSpecSourceBundleAtFixedCommit(
    repositoryRoot,
    manifest.fixedCommitSha,
    manifest.suite.sourceFiles,
  );
  assertCompiledContractsAttestationStable(repositoryRoot, compiledContracts);
  await writeRepositoryJsonCreateOnly(
    repositoryRoot,
    repositoryRelativePath,
    manifest,
  );
}
