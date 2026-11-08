import { runDeterministicEvals, type EvalRunResult } from "../evals/deterministic-executor";
import type { EvalCase, EvalManifest } from "../evals/eval-manifest";
import {
  DRAFT_FORBIDDEN_PHRASES,
  draftViolationCodes,
  findForbiddenPhrases,
  prepareDraftGrounding,
  validateOutreachDraft,
  type DraftGroundingContext,
  type OutreachDraft,
} from "../guardrails/draft-validation";
import {
  guardReplyClassification,
  replyGuardViolationCodes,
  type ReplyClassification,
} from "../guardrails/reply-classify";

/**
 * M2 步 13-1 两个 S2 触达技能的 Golden Set 执行层（零模型）。
 *
 * 每个用例的 `tier` 决定执行层：
 * - `deterministic`：用例自带 fixture（草稿 / 分类结果），直接跑技能的确定性守卫并断言，
 *   每个 PR 在 CI 里真实执行（本文件）；
 * - `model`：用例是模型场景，由 ops 触发的发布层评测经网关实跑并写 `eval_receipt`
 *   （`scripts/run-skill-model-evals.mts`），本文件只提供输出构建器，**不在 CI 调模型**。
 *
 * 两个技能的模型输出在断言前都先过同一套守卫（接地/页脚/长度/语言/夸大；闭集/低置信/
 * 自动回复），因此守卫本身的行为也被模型层用例间接覆盖。
 */

export const STEP13_GUARD_SKILLS = ["outreach.sequence_draft", "engage.reply_classify"] as const;
export type Step13GuardSkill = (typeof STEP13_GUARD_SKILLS)[number];

export function isStep13GuardSkill(skillKey: string): skillKey is Step13GuardSkill {
  return (STEP13_GUARD_SKILLS as readonly string[]).includes(skillKey);
}

export class Step13EvalInputError extends Error {
  readonly code = "STEP13_EVAL_INPUT_INVALID";
}

function record(value: unknown, what: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Step13EvalInputError(`${what} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringField(value: unknown, what: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Step13EvalInputError(`${what} must be a non-empty string`);
  }
  return value;
}

function stringArray(value: unknown, what: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Step13EvalInputError(`${what} must be a string array`);
  }
  return value as string[];
}

function idRows(value: unknown, what: string): { id: string }[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Step13EvalInputError(`${what} must be an array`);
  return value.map((item, index) => ({ id: stringField(record(item, `${what}[${index}]`)["id"], `${what}[${index}].id`) }));
}

export interface DraftEvalCaseInput {
  readonly request: {
    readonly jurisdiction: string;
    readonly language: string;
    readonly approvedClaims: readonly { id: string; statement?: string }[];
    readonly approvedOfferings: readonly { id: string; name?: string }[];
    readonly approvedEvidenceUrls: readonly string[];
    readonly [key: string]: unknown;
  };
  readonly guards: {
    readonly sender: { readonly legalName: string; readonly postalAddress: string };
    readonly nonApprovedClaims?: readonly { id: string; status: string }[];
    readonly nonApprovedOfferings?: readonly { id: string }[];
    readonly forbiddenPhrases?: readonly string[];
  };
  readonly draft?: OutreachDraft;
}

export function parseDraftCaseInput(input: unknown): DraftEvalCaseInput {
  const root = record(input, "input");
  const request = record(root["request"], "input.request");
  const guards = record(root["guards"], "input.guards");
  const sender = record(guards["sender"], "input.guards.sender");
  const nonApprovedClaims = guards["nonApprovedClaims"];
  if (
    nonApprovedClaims !== undefined &&
    (!Array.isArray(nonApprovedClaims) ||
      nonApprovedClaims.some(
        (item) =>
          typeof (item as Record<string, unknown>)?.["id"] !== "string" ||
          typeof (item as Record<string, unknown>)?.["status"] !== "string",
      ))
  ) {
    throw new Step13EvalInputError("input.guards.nonApprovedClaims must be {id,status}[]");
  }
  const draft = root["draft"];
  const nonApprovedOfferings = idRows(guards["nonApprovedOfferings"], "input.guards.nonApprovedOfferings");
  return {
    request: {
      ...request,
      jurisdiction: stringField(request["jurisdiction"], "input.request.jurisdiction"),
      language: stringField(request["language"], "input.request.language"),
      approvedClaims: idRows(request["approvedClaims"], "input.request.approvedClaims") as { id: string }[],
      approvedOfferings: idRows(request["approvedOfferings"], "input.request.approvedOfferings") as { id: string }[],
      approvedEvidenceUrls: stringArray(request["approvedEvidenceUrls"] ?? [], "input.request.approvedEvidenceUrls"),
    },
    guards: {
      sender: {
        legalName: stringField(sender["legalName"], "input.guards.sender.legalName"),
        postalAddress: stringField(sender["postalAddress"], "input.guards.sender.postalAddress"),
      },
      ...(Array.isArray(nonApprovedClaims)
        ? { nonApprovedClaims: nonApprovedClaims as { id: string; status: string }[] }
        : {}),
      ...(nonApprovedOfferings.length > 0 ? { nonApprovedOfferings } : {}),
      ...(guards["forbiddenPhrases"] !== undefined
        ? { forbiddenPhrases: stringArray(guards["forbiddenPhrases"], "input.guards.forbiddenPhrases") }
        : {}),
    },
    ...(draft !== undefined ? { draft: record(draft, "input.draft") as unknown as OutreachDraft } : {}),
  };
}

export function draftContextFromCase(input: DraftEvalCaseInput): DraftGroundingContext {
  return {
    jurisdiction: input.request.jurisdiction,
    language: input.request.language,
    sender: input.guards.sender,
    knowledge: {
      claims: [
        ...input.request.approvedClaims.map((claim) => ({ id: claim.id, status: "APPROVED" })),
        ...(input.guards.nonApprovedClaims ?? []),
      ],
      offerings: [
        ...input.request.approvedOfferings.map((offering) => ({ id: offering.id, approved: true })),
        ...(input.guards.nonApprovedOfferings ?? []).map((offering) => ({ id: offering.id, approved: false })),
      ],
      evidenceUrls: [...input.request.approvedEvidenceUrls],
    },
  };
}

export interface DraftPipelineOutput {
  readonly status: "DRAFT" | "REJECTED";
  readonly draft?: OutreachDraft;
  readonly reasonCode?: string;
  readonly issues: readonly string[];
  readonly validation?: { readonly ok: boolean; readonly issues: readonly string[] };
  readonly forbiddenHits?: readonly string[];
  /** 客户可见文本（subject+body+页脚）；editorNotes 是给审批人的，不算外发内容。 */
  readonly sendableText?: string;
}

function forbiddenHits(input: DraftEvalCaseInput, draft: OutreachDraft): string[] {
  // 默认禁用短语恒定生效；用例的 forbiddenPhrases 只做追加（防某条用例缩小检查面）。
  const phrases = [...new Set([...DRAFT_FORBIDDEN_PHRASES, ...(input.guards.forbiddenPhrases ?? [])])];
  return findForbiddenPhrases(`${draft.subject}\n${draft.body}\n${draft.jurisdictionFooter}`, phrases);
}

/**
 * 生成前接地检查 + 生成后硬校验的完整管线输出（模型层与确定性层共用）。
 * 不传 draft 时只跑接地预检：不通过返回 REJECTED（模型层据此在付费调用前短路）。
 */
export function buildDraftPipelineOutput(
  input: DraftEvalCaseInput,
  draft?: OutreachDraft,
): DraftPipelineOutput {
  const context = draftContextFromCase(input);
  const grounding = prepareDraftGrounding(context);
  if (!grounding.ok) {
    return {
      status: "REJECTED",
      reasonCode: grounding.issues[0]?.code,
      issues: draftViolationCodes(grounding),
    };
  }
  if (!draft) {
    throw new Step13EvalInputError("grounded draft pipeline needs a draft output to validate");
  }
  const validation = validateOutreachDraft(draft, context);
  return {
    status: "DRAFT",
    draft,
    issues: draftViolationCodes(validation),
    validation: { ok: validation.ok, issues: draftViolationCodes(validation) },
    forbiddenHits: forbiddenHits(input, draft),
    sendableText: `${draft.subject}\n${draft.body}\n${draft.jurisdictionFooter}`,
  };
}

export interface ReplyClassifyCaseInput {
  readonly replyText: string;
  readonly classification?: ReplyClassification;
}

export function parseReplyClassifyCaseInput(input: unknown): ReplyClassifyCaseInput {
  const root = record(input, "input");
  const request = root["request"];
  const replyText = stringField(
    request !== undefined ? record(request, "input.request")["replyText"] : root["replyText"],
    "input.replyText",
  );
  const classification = root["classification"];
  if (classification !== undefined) {
    const raw = record(classification, "input.classification");
    stringField(raw["intent"], "input.classification.intent");
    if (typeof raw["confidence"] !== "number") {
      throw new Step13EvalInputError("input.classification.confidence must be a number");
    }
  }
  return {
    replyText,
    ...(classification !== undefined ? { classification: classification as ReplyClassification } : {}),
  };
}

export interface ReplyClassifyOutput {
  readonly final: ReplyClassification;
  readonly violations: readonly string[];
}

export function buildReplyClassifyOutput(
  input: ReplyClassifyCaseInput,
  classification: ReplyClassification,
): ReplyClassifyOutput {
  const result = guardReplyClassification(classification, input.replyText);
  return { final: result.final, violations: replyGuardViolationCodes(result) };
}

function deterministicOutputForCase(skillKey: Step13GuardSkill, evalCase: EvalCase): unknown {
  if (skillKey === "outreach.sequence_draft") {
    const input = parseDraftCaseInput(evalCase.input);
    if (!input.draft) {
      throw new Step13EvalInputError(`deterministic draft case ${String(evalCase.id)} needs input.draft`);
    }
    return buildDraftPipelineOutput(input, input.draft);
  }
  const input = parseReplyClassifyCaseInput(evalCase.input);
  if (!input.classification) {
    throw new Step13EvalInputError(`deterministic classify case ${String(evalCase.id)} needs input.classification`);
  }
  return buildReplyClassifyOutput(input, input.classification);
}

export interface Step13DeterministicRun extends EvalRunResult {
  readonly executed: number;
}

/**
 * 零模型层：只跑 `tier=deterministic` 的用例，逐条真实执行技能守卫并断言。
 * 模型层用例在此跳过（它们由发布层回执覆盖）。
 */
export async function runStep13DeterministicEvals(
  skillKey: string,
  evalManifest: EvalManifest,
): Promise<Step13DeterministicRun> {
  if (!isStep13GuardSkill(skillKey)) {
    throw new Step13EvalInputError(`${skillKey} has no step-13 deterministic executor`);
  }
  const cases = evalManifest.evals.filter((evalCase) => evalCase.tier === "deterministic");
  const scoped: EvalManifest = { skillName: evalManifest.skillName, evals: cases };
  const result = await runDeterministicEvals(scoped, (evalCase) => ({
    output: deterministicOutputForCase(skillKey, evalCase),
  }));
  return { ...result, executed: cases.length };
}
