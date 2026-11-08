import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getTask } from "../../ai-tasks/task-registry";
import { BUILTIN_SKILLS } from "../generated/builtin-skill-catalog";
import type { EvalManifest } from "./eval-manifest";
import {
  modelCasesOf,
  runSkillModelEvals,
  SkillModelEvalInputError,
  type SkillModelEvalClient,
} from "./skill-model-evals";

/**
 * 模型层执行器的零网络测试：用假 client 返回夹具输出，验证
 * ① 守卫参与断言（低置信/自动回复会被升级，不会当作通过）；
 * ② schema 不合法的输出直接红；
 * ③ 确定性层用例不会被模型层执行；
 * ④ 未接入执行器的技能被拒绝。
 */

const BUILTIN_ROOT = join(import.meta.dirname, "..", "builtin");

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
    const onlyFirst: EvalManifest = {
      skillName: manifest.skillName,
      evals: [manifest.evals.find((evalCase) => evalCase.id === "us-first-touch")!],
    };
    const client: SkillModelEvalClient = {
      async generateStructured<T>() {
        return { data: GOOD_DRAFT as T, provider: "fake", model: "fake-model" };
      },
    };
    const result = await runSkillModelEvals(
      { manifest: record.manifest, evals: onlyFirst, contract },
      client,
      { workspaceId: "00000000-0000-0000-0000-000000000000" },
    );
    expect(result.passed).toBe(true);
    expect(result.casesTotal).toBe(1);
    expect(result.models).toEqual(["fake-model"]);
  });

  it("fails when the model output violates the deterministic guard", async () => {
    const record = draftRecord();
    const contract = getTask("outreach.sequence_draft")!;
    const manifest = draftManifest();
    const onlyFirst: EvalManifest = {
      skillName: manifest.skillName,
      evals: [manifest.evals.find((evalCase) => evalCase.id === "us-first-touch")!],
    };
    const client: SkillModelEvalClient = {
      async generateStructured<T>() {
        return {
          data: { ...GOOD_DRAFT, body: "We are guaranteed to double your output." } as T,
          provider: "fake",
          model: "fake-model",
        };
      },
    };
    const result = await runSkillModelEvals(
      { manifest: record.manifest, evals: onlyFirst, contract },
      client,
      { workspaceId: "00000000-0000-0000-0000-000000000000" },
    );
    expect(result.passed).toBe(false);
    expect(result.cases[0].failures.join("\n")).toContain("validation.ok");
  });

  it("escalates low-confidence classifications before asserting (NEEDS_HUMAN, not POSITIVE)", async () => {
    const record = classifyRecord();
    const contract = getTask("engage.reply_classify")!;
    const manifest = classifyManifest();
    const positiveCase = manifest.evals.find((evalCase) => evalCase.id === "positive-interest")!;
    const client: SkillModelEvalClient = {
      async generateStructured<T>() {
        return {
          data: {
            intent: "POSITIVE",
            confidence: 0.4,
            rationale: "low confidence",
            matchedSignals: [],
          } as T,
          provider: "fake",
          model: "fake-model",
        };
      },
    };
    const result = await runSkillModelEvals(
      { manifest: record.manifest, evals: { skillName: manifest.skillName, evals: [positiveCase] }, contract },
      client,
      { workspaceId: "00000000-0000-0000-0000-000000000000" },
    );
    expect(result.passed).toBe(false);
  });

  it("fails schema-invalid model output without throwing on the guard", async () => {
    const record = classifyRecord();
    const contract = getTask("engage.reply_classify")!;
    const manifest = classifyManifest();
    const positiveCase = manifest.evals.find((evalCase) => evalCase.id === "positive-interest")!;
    const client: SkillModelEvalClient = {
      async generateStructured<T>() {
        return { data: { nonsense: true } as T, provider: "fake", model: "fake-model" };
      },
    };
    const result = await runSkillModelEvals(
      { manifest: record.manifest, evals: { skillName: manifest.skillName, evals: [positiveCase] }, contract },
      client,
      { workspaceId: "00000000-0000-0000-0000-000000000000" },
    );
    expect(result.passed).toBe(false);
    expect(result.cases[0].failures.join("\n")).toContain("final.intent");
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
        { generateStructured: async <T>() => ({ data: {} as T, provider: "fake", model: "fake" }) },
        { workspaceId: "00000000-0000-0000-0000-000000000000" },
      ),
    ).rejects.toBeInstanceOf(SkillModelEvalInputError);
  });
});
