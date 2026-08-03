import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

import type { ModelCandidateProtocol } from "../agents/model-candidate-baseline";
import { COPY_TASK } from "../agents/copy";
import {
  ASSEMBLE_TASK,
  ASSEMBLY_FIX_TASK,
} from "../agents/controlled-assembly";
import type { SiteBuilderTaskId } from "../agents/task-route-bindings";
import {
  QA_SUMMARIZE_TASK,
  SEO_REVIEW_TASK,
} from "../quality/quality-narrative";
import {
  settlementOpenOxPrice,
  type OpenOxPricingCatalog,
} from "../site-builder-model-settlement";
import { sha256CanonicalJson } from "./eval-provenance";
import {
  buildRemainingTextEvaluationPrepManifest,
  type RemainingTextEvaluationManifestPrepManifest,
  type RemainingTextEvaluationManifestTask,
} from "./remaining-text-evaluation-manifest-prep";
import {
  buildCanonicalModelEvaluationCase,
  buildTaskEvaluationPlan,
} from "./model-evaluation-harness";
import {
  modelEvaluationInitialPromptUtf8Bytes,
  modelEvaluationRepairPromptUtf8BytesUpperBound,
} from "./model-evaluation-executor";
import { MODEL_EVALUATION_PROTOCOL_FRAMING_TOKEN_UPPER_BOUND } from "./model-evaluation-cost-safety";

export const REMAINING_TEXT_NATIVE_FEE_CARD_ID_PREFIX =
  "site-builder-remaining-text-native-fee-card/2026-08-04-v2" as const;
export const REMAINING_TEXT_NATIVE_FEE_CARD_SCHEMA_VERSION =
  "site-builder-remaining-text-native-fee-card/v2" as const;

const REQUIRED_FIXED_SOURCE_COMMIT_SHA =
  "0891b374321961b8aad13c8b215985ca623a4c0c" as const;
const SHA256 = /^[a-f0-9]{64}$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const NATIVE_PER_WIRE_COST_CAP_PICO_UNITS = 200_000_000_000n;

export const REMAINING_TEXT_NATIVE_FEE_CARD_TASK_IDS = Object.freeze([
  "site_builder.copy",
  "site_builder.assemble",
  "site_builder.assembly_fix",
  "site_builder.qa_summarize",
  "site_builder.seo_review",
] as const);

export type RemainingTextNativeFeeCardTaskId =
  (typeof REMAINING_TEXT_NATIVE_FEE_CARD_TASK_IDS)[number];
type NativeCurrency = "CNY" | "USD";

interface NativeAmount {
  nativePicoUnits: string;
  formatted: string;
}

export interface RemainingTextNativeFeeCardInput {
  repositoryRoot: string;
  manifest: unknown;
  taskId: RemainingTextNativeFeeCardTaskId;
  catalog: OpenOxPricingCatalog;
  capturedAt: string;
  catalogResponseSha256: string;
}

export interface RemainingTextNativeFeeCard {
  schemaVersion: typeof REMAINING_TEXT_NATIVE_FEE_CARD_SCHEMA_VERSION;
  feeCardId: string;
  status:
    | "READY_FOR_CREDENTIAL_ATTESTATION"
    | "BLOCKED_PER_WIRE_COST_CAP";
  dispatchAuthorization: "NOT_AUTHORIZED";
  taskId: RemainingTextNativeFeeCardTaskId;
  fixedSourceCommitSha: string;
  manifestSha256: string;
  suite: {
    suiteId: string;
    sourceBundleContractId: string;
    sourceBundleSha256: string;
  };
  pricing: {
    authority: "openox_model_marketplace";
    catalogEndpoint: "https://openox.tech/api/public/pricing-catalog";
    capturedAt: string;
    catalogResponseSha256: string;
  };
  tokenEnvelope: {
    initialInputTokens: number;
    repairInputTokens: number;
    outputTokensPerWireCall: number;
  };
  entries: readonly {
    alias: string;
    protocol: Extract<
      ModelCandidateProtocol,
      "openai-responses" | "anthropic-messages"
    >;
    groupName: "gpt-unified" | "special";
    currency: NativeCurrency;
    executionCount: number;
    maximumWireCalls: number;
    pricingVersion: string;
    effectiveInputRateMicrounitsPerMillionTokens: number;
    effectiveOutputRateMicrounitsPerMillionTokens: number;
    initialCallMaximum: NativeAmount;
    repairCallMaximum: NativeAmount;
    maximumCost: NativeAmount;
    exceedsPerWireCostCap: boolean;
  }[];
  perWireCostCap: {
    nativePicoUnits: string;
    formatted: string;
    interpretation: "per_currency_without_foreign_exchange";
  };
  totalsByCurrency: Readonly<Record<NativeCurrency, NativeAmount>>;
  expectedCost: "not_known_before_usage";
  mechanicalPolicyCeiling: {
    amountCents: number;
    meaning: "mechanical_only_not_a_native_currency_budget";
  };
  noForeignExchangeConversion: true;
  cardSha256: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function canonicalInstant(value: unknown): value is string {
  return (
    typeof value === "string" &&
    ISO_INSTANT.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(Date.parse(value)).toISOString() === value
  );
}

function taskOutputSchema(taskId: RemainingTextNativeFeeCardTaskId) {
  if (taskId === "site_builder.copy") return COPY_TASK.outputSchema;
  if (taskId === "site_builder.assemble") return ASSEMBLE_TASK.outputSchema;
  if (taskId === "site_builder.assembly_fix") {
    return ASSEMBLY_FIX_TASK.outputSchema;
  }
  if (taskId === "site_builder.qa_summarize") {
    return QA_SUMMARIZE_TASK.outputSchema;
  }
  return SEO_REVIEW_TASK.outputSchema;
}

function aliasPricing(alias: string): {
  groupName: "gpt-unified" | "special";
  currency: NativeCurrency;
} {
  if (alias === "claude-sonnet-5") {
    return { groupName: "special", currency: "USD" };
  }
  if (
    alias === "gpt-5.4-mini" ||
    alias === "gpt-5.5" ||
    alias === "gpt-5.6-luna" ||
    alias === "gpt-5.6-terra"
  ) {
    return { groupName: "gpt-unified", currency: "CNY" };
  }
  throw new Error(`remaining text task candidate has no public pricing rule: ${alias}`);
}

function nativePicoUnits(
  inputTokens: number,
  outputTokens: number,
  inputRateMicrounitsPerMillionTokens: number,
  outputRateMicrounitsPerMillionTokens: number,
): bigint {
  for (const value of [
    inputTokens,
    outputTokens,
    inputRateMicrounitsPerMillionTokens,
    outputRateMicrounitsPerMillionTokens,
  ]) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error("remaining text task native fee amount is invalid");
    }
  }
  return (
    BigInt(inputTokens) * BigInt(inputRateMicrounitsPerMillionTokens) +
    BigInt(outputTokens) * BigInt(outputRateMicrounitsPerMillionTokens)
  );
}

function amount(value: bigint): NativeAmount {
  if (value < 0n) throw new Error("remaining text task native fee is negative");
  const scale = 1_000_000_000_000n;
  const whole = value / scale;
  const fraction = (value % scale)
    .toString()
    .padStart(12, "0")
    .replace(/0+$/, "");
  return {
    nativePicoUnits: value.toString(),
    formatted: fraction.length > 0 ? `${whole}.${fraction}` : whole.toString(),
  };
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

function isShallowRepository(repositoryRoot: string): boolean {
  return (
    execFileSync("git", ["rev-parse", "--is-shallow-repository"], {
      cwd: repositoryRoot,
      encoding: "utf8",
    }).trim() === "true"
  );
}

function assertFixedSourceCommitAvailable(
  repositoryRoot: string,
  fixedCommitSha: string,
): "full_history" | "shallow_history" {
  if (!/^[a-f0-9]{40}$/.test(fixedCommitSha)) {
    throw new Error("remaining text task source commit requires a 40-character SHA");
  }
  const revisions = ["HEAD", "refs/remotes/origin/main"] as const;
  try {
    for (const revision of revisions) {
      execFileSync("git", ["merge-base", "--is-ancestor", fixedCommitSha, revision], {
        cwd: repositoryRoot,
        stdio: "ignore",
      });
    }
    return "full_history";
  } catch {
    if (!isShallowRepository(repositoryRoot)) {
      throw new Error("remaining text task fixed source commit must be reachable from prep history and origin/main");
    }
    // GitHub's depth-limited test checkout may omit the fixed commit object.
    // This mode is only used to reconstruct a zero-call card: every listed
    // source file must still exactly match the manifest's fixed-source digest.
    return "shallow_history";
  }
}

function assertSourceBundleAtFixedCommit(
  repositoryRoot: string,
  fixedCommitSha: string,
  sourceFiles: readonly { path: string; sha256: string }[],
  history: "full_history" | "shallow_history",
): void {
  const seen = new Set<string>();
  for (const source of sourceFiles) {
    if (
      source.path.length === 0 ||
      isAbsolute(source.path) ||
      source.path.includes("\\") ||
      source.path.split("/").includes("..") ||
      !SHA256.test(source.sha256) ||
      seen.has(source.path)
    ) {
      throw new Error("remaining text task source bundle contains an invalid path");
    }
    seen.add(source.path);
    const resolved = resolve(repositoryRoot, source.path);
    const repositoryRelative = relative(repositoryRoot, resolved);
    if (
      repositoryRelative.length === 0 ||
      repositoryRelative === ".." ||
      repositoryRelative.startsWith(`..${sep}`) ||
      isAbsolute(repositoryRelative)
    ) {
      throw new Error(`${source.path} escapes the repository`);
    }
    const realSource = realpathSync(resolved);
    const realRelative = relative(repositoryRoot, realSource);
    if (
      realRelative === ".." ||
      realRelative.startsWith(`..${sep}`) ||
      isAbsolute(realRelative)
    ) {
      throw new Error(`${source.path} resolves outside the repository`);
    }
    const working = readFileSync(realSource);
    if (createHash("sha256").update(working).digest("hex") !== source.sha256) {
      throw new Error(`${source.path} does not match the fixed source bundle digest`);
    }
    if (history === "full_history") {
      const committed = sourceFileAtFixedCommit(
        repositoryRoot,
        fixedCommitSha,
        source.path,
      );
      if (!working.equals(committed)) {
        throw new Error(`${source.path} drifted from the fixed commit`);
      }
    }
  }
}

function assertManifest(
  repositoryRoot: string,
  value: unknown,
): RemainingTextEvaluationManifestPrepManifest {
  if (!isRecord(value)) {
    throw new Error("remaining text task manifest must be an object");
  }
  if (
    value.fixedCommitSha !== REQUIRED_FIXED_SOURCE_COMMIT_SHA ||
    value.createOnly !== true ||
    value.dispatchAuthorization !== "NOT_AUTHORIZED" ||
    value.actualNetworkCalls !== 0 ||
    value.actualModelCostCents !== 0 ||
    typeof value.manifestSha256 !== "string" ||
    !SHA256.test(value.manifestSha256)
  ) {
    throw new Error("remaining text task manifest identity is invalid");
  }
  const manifest = value as unknown as RemainingTextEvaluationManifestPrepManifest;
  const { manifestSha256, ...withoutDigest } = manifest;
  if (sha256CanonicalJson(withoutDigest) !== manifestSha256) {
    throw new Error("remaining text task manifest digest drifted");
  }
  const realRepositoryRoot = realpathSync(repositoryRoot);
  const history = assertFixedSourceCommitAvailable(
    realRepositoryRoot,
    REQUIRED_FIXED_SOURCE_COMMIT_SHA,
  );
  for (const task of manifest.tasks) {
    assertSourceBundleAtFixedCommit(
      realRepositoryRoot,
      REQUIRED_FIXED_SOURCE_COMMIT_SHA,
      task.sourceFiles,
      history,
    );
  }
  const canonical = buildRemainingTextEvaluationPrepManifest(
    REQUIRED_FIXED_SOURCE_COMMIT_SHA,
  );
  if (sha256CanonicalJson(canonical) !== sha256CanonicalJson(manifest)) {
    throw new Error("remaining text task manifest is not the canonical fixed-source manifest");
  }
  return manifest;
}

function taskManifest(
  manifest: RemainingTextEvaluationManifestPrepManifest,
  taskId: RemainingTextNativeFeeCardTaskId,
): RemainingTextEvaluationManifestTask {
  const task = manifest.tasks.find((entry) => entry.taskId === taskId);
  if (!task || task.executionCount * 2 !== task.maximumWireCallCount) {
    throw new Error("remaining text task execution matrix is invalid");
  }
  if (
    task.candidates.some(
      (candidate) =>
        candidate.protocol !== "openai-responses" &&
        candidate.protocol !== "anthropic-messages",
    )
  ) {
    throw new Error("remaining text task protocol is invalid");
  }
  return task;
}

function promptEnvelope(task: RemainingTextEvaluationManifestTask): {
  initialInputTokens: number;
  repairInputTokens: number;
  outputTokensPerWireCall: number;
} {
  const plan = buildTaskEvaluationPlan(task.taskId as SiteBuilderTaskId);
  const suite = plan.evaluationSuite;
  if (!suite || plan.dispatchAdmission !== "task_evaluation_ready") {
    throw new Error(`remaining text task has no canonical suite: ${task.taskId}`);
  }
  const schema = taskOutputSchema(task.taskId);
  const initial = suite.fixtureIds.map((fixtureId) => {
    const evaluationCase = buildCanonicalModelEvaluationCase(plan, fixtureId);
    return modelEvaluationInitialPromptUtf8Bytes(
      evaluationCase.payload.prompt,
      schema,
      task.taskId,
    );
  });
  const repair = suite.fixtureIds.map((fixtureId) => {
    const evaluationCase = buildCanonicalModelEvaluationCase(plan, fixtureId);
    return modelEvaluationRepairPromptUtf8BytesUpperBound(
      evaluationCase.payload.prompt,
      schema,
      task.taskId,
    );
  });
  return {
    initialInputTokens:
      Math.max(...initial) + MODEL_EVALUATION_PROTOCOL_FRAMING_TOKEN_UPPER_BOUND,
    repairInputTokens:
      Math.max(...repair) + MODEL_EVALUATION_PROTOCOL_FRAMING_TOKEN_UPPER_BOUND,
    outputTokensPerWireCall: plan.envelope.maxTokens,
  };
}

/** Validates the fixed source and exact task matrix before any public price read. */
export function assertRemainingTextNativeFeeCardManifest(
  repositoryRoot: string,
  manifest: unknown,
  taskId: RemainingTextNativeFeeCardTaskId,
): void {
  if (!REMAINING_TEXT_NATIVE_FEE_CARD_TASK_IDS.includes(taskId)) {
    throw new Error("remaining text task fee-card task is invalid");
  }
  taskManifest(assertManifest(repositoryRoot, manifest), taskId);
}

export function buildRemainingTextNativeFeeCard(
  input: RemainingTextNativeFeeCardInput,
): RemainingTextNativeFeeCard {
  if (!canonicalInstant(input.capturedAt) || !SHA256.test(input.catalogResponseSha256)) {
    throw new Error("remaining text task fee-card capture binding is invalid");
  }
  assertRemainingTextNativeFeeCardManifest(
    input.repositoryRoot,
    input.manifest,
    input.taskId,
  );
  const manifest = input.manifest as RemainingTextEvaluationManifestPrepManifest;
  const task = taskManifest(manifest, input.taskId);
  const tokenEnvelope = promptEnvelope(task);
  const executionCounts = new Map<string, number>();
  for (const execution of task.executions) {
    const key = `${execution.alias}:${execution.protocol}`;
    executionCounts.set(key, (executionCounts.get(key) ?? 0) + 1);
  }
  const totals = new Map<NativeCurrency, bigint>([
    ["CNY", 0n],
    ["USD", 0n],
  ]);
  const entries = task.candidates
    .map((candidate) => {
      const pricing = aliasPricing(candidate.alias);
      const price = settlementOpenOxPrice(
        input.catalog,
        candidate.alias,
        pricing.groupName,
      );
      if (!price || price.currency !== pricing.currency) {
        throw new Error(`OpenOx price is missing or unpublished: ${candidate.alias}`);
      }
      const executionCount = executionCounts.get(
        `${candidate.alias}:${candidate.protocol}`,
      );
      if (!executionCount || executionCount < 1) {
        throw new Error("remaining text task execution matrix drifted");
      }
      const initial = nativePicoUnits(
        tokenEnvelope.initialInputTokens,
        tokenEnvelope.outputTokensPerWireCall,
        price.inputPriceMicrounitsPerMillionTokens,
        price.outputPriceMicrounitsPerMillionTokens,
      );
      const repair = nativePicoUnits(
        tokenEnvelope.repairInputTokens,
        tokenEnvelope.outputTokensPerWireCall,
        price.inputPriceMicrounitsPerMillionTokens,
        price.outputPriceMicrounitsPerMillionTokens,
      );
      const maximum = BigInt(executionCount) * (initial + repair);
      const exceedsPerWireCostCap =
        initial > NATIVE_PER_WIRE_COST_CAP_PICO_UNITS ||
        repair > NATIVE_PER_WIRE_COST_CAP_PICO_UNITS;
      totals.set(pricing.currency, (totals.get(pricing.currency) ?? 0n) + maximum);
      return Object.freeze({
        alias: candidate.alias,
        protocol: candidate.protocol,
        groupName: pricing.groupName,
        currency: pricing.currency,
        executionCount,
        maximumWireCalls: executionCount * 2,
        pricingVersion: price.pricingVersion,
        effectiveInputRateMicrounitsPerMillionTokens:
          price.inputPriceMicrounitsPerMillionTokens,
        effectiveOutputRateMicrounitsPerMillionTokens:
          price.outputPriceMicrounitsPerMillionTokens,
        initialCallMaximum: amount(initial),
        repairCallMaximum: amount(repair),
        maximumCost: amount(maximum),
        exceedsPerWireCostCap,
      });
    })
    .sort((left, right) => left.alias.localeCompare(right.alias));
  if (
    entries.reduce((total, entry) => total + entry.executionCount, 0) !==
      task.executionCount ||
    entries.reduce((total, entry) => total + entry.maximumWireCalls, 0) !==
      task.maximumWireCallCount
  ) {
    throw new Error("remaining text task execution capacity drifted");
  }
  const withoutDigest = {
    schemaVersion: REMAINING_TEXT_NATIVE_FEE_CARD_SCHEMA_VERSION,
    feeCardId: `${REMAINING_TEXT_NATIVE_FEE_CARD_ID_PREFIX}/${input.taskId}`,
    status: entries.some((entry) => entry.exceedsPerWireCostCap)
      ? ("BLOCKED_PER_WIRE_COST_CAP" as const)
      : ("READY_FOR_CREDENTIAL_ATTESTATION" as const),
    dispatchAuthorization: "NOT_AUTHORIZED" as const,
    taskId: input.taskId,
    fixedSourceCommitSha: manifest.fixedCommitSha,
    manifestSha256: manifest.manifestSha256,
    suite: {
      suiteId: task.suiteId,
      sourceBundleContractId: task.sourceBundleContractId,
      sourceBundleSha256: task.sourceBundleSha256,
    },
    pricing: {
      authority: "openox_model_marketplace" as const,
      catalogEndpoint: "https://openox.tech/api/public/pricing-catalog" as const,
      capturedAt: input.capturedAt,
      catalogResponseSha256: input.catalogResponseSha256,
    },
    tokenEnvelope,
    entries,
    perWireCostCap: {
      ...amount(NATIVE_PER_WIRE_COST_CAP_PICO_UNITS),
      interpretation: "per_currency_without_foreign_exchange" as const,
    },
    totalsByCurrency: {
      CNY: amount(totals.get("CNY")!),
      USD: amount(totals.get("USD")!),
    },
    expectedCost: "not_known_before_usage" as const,
    mechanicalPolicyCeiling: {
      amountCents: task.maximumWireCallCount * 20,
      meaning: "mechanical_only_not_a_native_currency_budget" as const,
    },
    noForeignExchangeConversion: true as const,
  };
  return Object.freeze({
    ...withoutDigest,
    cardSha256: sha256CanonicalJson(withoutDigest),
  });
}
