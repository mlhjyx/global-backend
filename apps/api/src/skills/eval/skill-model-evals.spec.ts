import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getTask } from "../../ai-tasks/task-registry";
import type { GenerateStructuredInput } from "../../model-gateway/types";
import { BUILTIN_SKILLS } from "../generated/builtin-skill-catalog";
import type { EvalCase, EvalManifest } from "../evals/eval-manifest";
import {
  modelCasesOf,
  promptForCase,
  runSkillModelEvals,
  SkillModelEvalInputError,
  type SkillModelEvalInvoke,
} from "./skill-model-evals";

/**
 * 模型层执行器的零网络测试：用假 callModel 返回夹具输出，验证
 * ① 守卫参与断言（低置信/自动回复会被升级，不会当作通过）；
 * ② schema 不合法的输出直接红且失败信息带 AJV 错误；
 * ③ 确定性层用例不会被模型层执行；
 * ④ 未接入执行器的技能被拒绝；
 * ⑤ 起草接地预检发生在付费调用之前（不接地不调用模型）；
 * ⑥ prompt 含 sender 身份、不含 guards 专属数据（禁用短语）。
 */

const BUILTIN_ROOT = join(import.meta.dirname, "..", "builtin");
const WORKSPACE_ID = "00000000-0000-0000-0000-000000000000";

function draftManifest(): EvalManifest {
  return JSON.parse(
    readFileSync(
      join(BUILTIN_ROOT, "growth_motion", "outreach-sequence-draft", "evals/evals.json"),
      "utf8",
    ),
  ) as EvalManifest;
}

function classifyManifest(): EvalManifest {
  return JSON.parse(
    readFileSync(
      join(BUILTIN_ROOT, "growth_motion", "engage-reply-classify", "evals/evals.json"),
      "utf8",
    ),
  ) as EvalManifest;
}

function draftRecord() {
  const record = BUILTIN_SKILLS.find((candidate) => candidate.skillKey === "outreach.sequence_draft");
  if (!record) throw new Error("missing outreach.sequence_draft");
  return record;
}

function classifyRecord() {
  const record = BUILTIN_SKILLS.find((candidate) => candidate.skillKey === "engage.reply_classify");
  if (!record) throw new Error("missing engage.reply_classify");
  return record;
}

function invokeReturning(data: unknown, captured?: GenerateStructuredInput[]): SkillModelEvalInvoke {
  return async (input) => {
    captured?.push(input);
    return { data, provider: "fake", model: "fake-model" };
  };
}

function caseOf(manifest: EvalManifest, id: string): EvalCase {
  const evalCase = manifest.evals.find((candidate) => String(candidate.id) === id);
  if (!evalCase) throw new Error(`missing case ${id}`);
  return evalCase;
}

const GOOD_DRAFT = {
  subject: "Fiber laser cutting for Great Lakes Metal Supply",
  body: "Hello John, we build fiber laser cutting systems and would like to discuss your sourcing plans.",
  language: "en",
  groundedOn: [{ claimId: "claim-iso" }, { offeringId: "off-laser" }],
  jurisdictionFooter:
    "Nordwind Maschinenbau GmbH, Industriestraße 12, 80333 Munich, Germany. Unsubscribe: reply STOP.",
};

describe("runSkillModelEvals", () => {
  it("passes a model case whose output survives the guards and assertions", async () => {
    const record = draftRecord();
    const contract = getTask("outreach.sequence_draft")!;
    const manifest = draftManifest();
    const result = await runSkillModelEvals(
      {
        manifest: record.manifest,
        evals: { skillName: manifest.skillName, evals: [caseOf(manifest, "us-first-touch")] },
        contract,
      },
      { workspaceId: WORKSPACE_ID, callModel: invokeReturning(GOOD_DRAFT) },
    );
    expect(result.passed).toBe(true);
    expect(result.casesTotal).toBe(1);
    expect(result.models).toEqual(["fake-model"]);
  });

  it("fails when the model output violates the deterministic guard", async () => {
    const record = draftRecord();
    const contract = getTask("outreach.sequence_draft")!;
    const manifest = draftManifest();
    const result = await runSkillModelEvals(
      {
        manifest: record.manifest,
        evals: { skillName: manifest.skillName, evals: [caseOf(manifest, "us-first-touch")] },
        contract,
      },
      {
        workspaceId: WORKSPACE_ID,
        callModel: invokeReturning({ ...GOOD_DRAFT, body: "We are guaranteed to double your output." }),
      },
    );
    expect(result.passed).toBe(false);
    expect(result.cases[0].failures.join("\n")).toContain("validation.ok");
  });

  it("escalates low-confidence classifications before asserting (NEEDS_HUMAN, not POSITIVE)", async () => {
    const record = classifyRecord();
    const contract = getTask("engage.reply_classify")!;
    const manifest = classifyManifest();
    const result = await runSkillModelEvals(
      {
        manifest: record.manifest,
        evals: { skillName: manifest.skillName, evals: [caseOf(manifest, "positive-interest")] },
        contract,
      },
      {
        workspaceId: WORKSPACE_ID,
        callModel: invokeReturning({
          intent: "POSITIVE",
          confidence: 0.4,
          rationale: "low confidence",
          matchedSignals: [],
        }),
      },
    );
    expect(result.passed).toBe(false);
    // 守卫把 POSITIVE 升级成 NEEDS_HUMAN 才会让 final.intent 断言失败；
    // 断言确切路径可区分「守卫升级」与「置信度断言顺带失败」。
    expect(result.cases[0].failures.join("\n")).toContain("final.intent");
  });

  it("fails schema-invalid model output with the AJV errors in the failure list", async () => {
    const record = classifyRecord();
    const contract = getTask("engage.reply_classify")!;
    const manifest = classifyManifest();
    const result = await runSkillModelEvals(
      {
        manifest: record.manifest,
        evals: { skillName: manifest.skillName, evals: [caseOf(manifest, "positive-interest")] },
        contract,
      },
      { workspaceId: WORKSPACE_ID, callModel: invokeReturning({ nonsense: true }) },
    );
    expect(result.passed).toBe(false);
    expect(result.cases[0].failures.join("\n")).toContain("MODEL_OUTPUT_SCHEMA");
  });

  it("runs the grounding precheck before the paid call and never invokes the model", async () => {
    const record = draftRecord();
    const contract = getTask("outreach.sequence_draft")!;
    const manifest = draftManifest();
    const groundingCase = caseOf(manifest, "grounding-required");
    const captured: GenerateStructuredInput[] = [];
    const result = await runSkillModelEvals(
      {
        manifest: record.manifest,
        evals: {
          skillName: manifest.skillName,
          evals: [{ ...groundingCase, tier: "model" }],
        },
        contract,
      },
      { workspaceId: WORKSPACE_ID, callModel: invokeReturning(GOOD_DRAFT, captured) },
    );
    expect(captured).toHaveLength(0);
    expect(result.passed).toBe(true);
    expect(result.cases[0].model).toBeUndefined();
  });

  it("stops paying once the run cost cap is reached", async () => {
    const record = classifyRecord();
    const contract = getTask("engage.reply_classify")!;
    const manifest = classifyManifest();
    const cases = [caseOf(manifest, "positive-interest"), caseOf(manifest, "negative-not-interested")];
    let calls = 0;
    const result = await runSkillModelEvals(
      {
        manifest: record.manifest,
        evals: { skillName: manifest.skillName, evals: cases },
        contract,
      },
      {
        workspaceId: WORKSPACE_ID,
        maxCostMicros: 1,
        callModel: async () => {
          calls += 1;
          return {
            data: { intent: "POSITIVE", confidence: 0.9, rationale: "ok", matchedSignals: [] },
            provider: "fake",
            model: "fake-model",
            usage: { inputTokens: 1_000_000, outputTokens: 0 },
          };
        },
      },
    );
    expect(calls).toBe(1); // 第二条用例在付费前被成本上限拦下
    expect(result.cases[1].failures.join("\n")).toContain("SKILL_EVAL_COST_CAP_REACHED");
  });

  it("builds a draft prompt that carries sender identity but not guard-only fields", () => {
    const manifest = draftManifest();
    const prompt = promptForCase("outreach.sequence_draft", caseOf(manifest, "injection-ungrounded-claim"));
    expect(prompt).toContain("Nordwind Maschinenbau GmbH");
    expect(prompt).toContain("Industriestraße 12, 80333 Munich");
    // guards 的检查清单（禁用短语/未批准 id）只留给确定性层，不发给模型。
    expect(prompt).not.toContain("forbiddenPhrases");
    expect(prompt).not.toContain("nonApprovedClaims");
  });

  it("keeps deterministic-tier cases out of the model layer", () => {
    const cases = modelCasesOf(draftManifest());
    expect(cases.some((evalCase) => String(evalCase.id) === "grounding-required")).toBe(false);
    expect(cases.length).toBeGreaterThanOrEqual(8);
  });

  it("refuses skills without a model-tier pipeline", async () => {
    const record = BUILTIN_SKILLS.find((candidate) => candidate.skillKey === "discovery.qualify_fit")!;
    const contract = getTask("discovery.qualify_fit")!;
    await expect(
      runSkillModelEvals(
        { manifest: record.manifest, evals: { skillName: "x", evals: [] }, contract },
        { workspaceId: WORKSPACE_ID, callModel: invokeReturning({}) },
      ),
    ).rejects.toBeInstanceOf(SkillModelEvalInputError);
  });
});
