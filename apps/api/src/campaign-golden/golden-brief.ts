import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Golden campaign brief 资产（M2.2-2，设计 `docs/superpowers/plans/2026-11-08-campaign-replan-m2-2.md` §4）：
 * 测试资产存 backend 仓 `evals/golden-campaign-briefs/*.json`，只含行业/国家级描述，不含租户 PII。
 * 资产 = 规划意图 brief + 对产出的结构化期望（必含/禁含字段、预算上限、决策策略、动作类型）。
 * 本模块只做装载与结构校验；断言求值在 `golden-evaluate.ts`。
 */

export const GOLDEN_BRIEF_SCHEMA_VERSION = "campaign-golden-brief/v1" as const;
const ASSET_ID_PATTERN = /^\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export interface GoldenBriefSpec {
  /** 行业（英文小写短语，供规划器输入与检索）。 */
  readonly industry: string;
  /** 目标市场（ISO 3166-1 alpha-2）。 */
  readonly country: string;
  /** 一句话规划目标（中文，人读）。 */
  readonly objective: string;
  /** ICP 摘要（目标角色/规模/条件；不含具体公司或个人）。 */
  readonly icpSummary: string;
  /** 本 brief 的预算上限（USD micros，整数）。 */
  readonly budgetCapMicros: number;
  /** 期望计划使用的输出语言（BCP-47 主标签，如 de/en）。 */
  readonly language: string;
}

export interface GoldenBudgetRespect {
  /** 计划内预算上限字段路径；缺省 `budget.capMicros`。 */
  readonly capMicrosPath?: string;
  /** 计划预算币种必须等于它（如 `USD`）。 */
  readonly currency?: string;
}

export interface GoldenDecisionPolicy {
  /** `decisionPolicy.maxReplans` 的允许上界（M2.2 起为 2；旧计划 0 仍合法）。 */
  readonly maxReplansMax?: number;
}

export interface GoldenBriefExpectations {
  /** 计划契约版本（如 `campaign-plan/v0`）。 */
  readonly planSchemaVersion: string;
  /** 必须存在（非 undefined）的叶子字段路径。 */
  readonly requiredFields: readonly string[];
  /** 必须不存在（undefined）的字段路径（例如发送类动作、单证字段）。 */
  readonly forbiddenFields: readonly string[];
  /** 序列化后的计划不得命中这些正则（大小写不敏感；不允许的语义：单证/发送等）。 */
  readonly forbiddenContent?: readonly string[];
  readonly budgetRespect?: GoldenBudgetRespect;
  readonly decisionPolicy?: GoldenDecisionPolicy;
  /** 计划的动作类型白名单（v0 仅 discovery）。 */
  readonly motionTypes?: readonly string[];
}

export interface GoldenBriefAsset {
  readonly schemaVersion: typeof GOLDEN_BRIEF_SCHEMA_VERSION;
  readonly id: string;
  readonly brief: GoldenBriefSpec;
  readonly expectations: GoldenBriefExpectations;
  readonly notes?: string;
}

export interface GoldenBriefIssue {
  readonly file: string;
  readonly message: string;
}

export interface GoldenBriefLoadResult {
  readonly assets: readonly GoldenBriefAsset[];
  readonly issues: readonly GoldenBriefIssue[];
}

const ASSET_TOP_FIELDS = new Set(["schemaVersion", "id", "brief", "expectations", "notes"]);
const BRIEF_FIELDS = new Set([
  "industry",
  "country",
  "objective",
  "icpSummary",
  "budgetCapMicros",
  "language",
]);
const EXPECTATION_FIELDS = new Set([
  "planSchemaVersion",
  "requiredFields",
  "forbiddenFields",
  "forbiddenContent",
  "budgetRespect",
  "decisionPolicy",
  "motionTypes",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function checkStringArray(value: unknown, field: string, allowEmpty: boolean): string[] {
  const issues: string[] = [];
  if (!Array.isArray(value)) {
    issues.push(`${field} must be an array of strings`);
    return issues;
  }
  if (!allowEmpty && value.length === 0) issues.push(`${field} must not be empty`);
  for (const item of value) {
    if (!isNonEmptyString(item)) issues.push(`${field} items must be non-empty strings`);
  }
  return issues;
}

/** 结构校验单个资产；`file` 仅用于问题定位。 */
export function parseGoldenBriefAsset(
  raw: unknown,
  file = "<memory>",
): { asset?: GoldenBriefAsset; issues: readonly GoldenBriefIssue[] } {
  const issues: GoldenBriefIssue[] = [];
  const fail = (message: string): void => {
    issues.push({ file, message });
  };
  if (!isRecord(raw)) {
    fail("asset must be a JSON object");
    return { issues };
  }
  for (const key of Object.keys(raw)) {
    if (!ASSET_TOP_FIELDS.has(key)) fail(`unknown field: ${key}`);
  }
  if (raw["schemaVersion"] !== GOLDEN_BRIEF_SCHEMA_VERSION) {
    fail(`schemaVersion must be ${GOLDEN_BRIEF_SCHEMA_VERSION}`);
  }
  const id = raw["id"];
  if (typeof id !== "string" || !ASSET_ID_PATTERN.test(id)) {
    fail("id must match NN-kebab-case (e.g. 01-de-thermoforming-1)");
  }
  const brief = raw["brief"];
  if (!isRecord(brief)) {
    fail("brief must be an object");
  } else {
    for (const key of Object.keys(brief)) {
      if (!BRIEF_FIELDS.has(key)) fail(`unknown brief field: ${key}`);
    }
    if (!isNonEmptyString(brief["industry"])) fail("brief.industry must be a non-empty string");
    const country = brief["country"];
    if (typeof country !== "string" || !/^[A-Z]{2}$/u.test(country)) {
      fail("brief.country must be a two-letter ISO country code");
    }
    if (!isNonEmptyString(brief["objective"])) fail("brief.objective must be a non-empty string");
    if (!isNonEmptyString(brief["icpSummary"])) fail("brief.icpSummary must be a non-empty string");
    const cap = brief["budgetCapMicros"];
    if (typeof cap !== "number" || !Number.isInteger(cap) || cap <= 0) {
      fail("brief.budgetCapMicros must be a positive integer (USD micros)");
    }
    if (typeof brief["language"] !== "string" || !/^[a-z]{2}(?:-[A-Z]{2})?$/u.test(brief["language"] as string)) {
      fail("brief.language must be a language tag like de or en-US");
    }
  }
  const expectations = raw["expectations"];
  if (!isRecord(expectations)) {
    fail("expectations must be an object");
  } else {
    for (const key of Object.keys(expectations)) {
      if (!EXPECTATION_FIELDS.has(key)) fail(`unknown expectations field: ${key}`);
    }
    if (!isNonEmptyString(expectations["planSchemaVersion"])) {
      fail("expectations.planSchemaVersion must be a non-empty string");
    }
    issues.push(
      ...checkStringArray(expectations["requiredFields"], "expectations.requiredFields", false).map(
        (message) => ({ file, message }),
      ),
      ...checkStringArray(expectations["forbiddenFields"], "expectations.forbiddenFields", true).map(
        (message) => ({ file, message }),
      ),
    );
    if (expectations["forbiddenContent"] !== undefined) {
      issues.push(
        ...checkStringArray(expectations["forbiddenContent"], "expectations.forbiddenContent", true).map(
          (message) => ({ file, message }),
        ),
      );
      for (const pattern of expectations["forbiddenContent"] as unknown[]) {
        if (typeof pattern !== "string") continue;
        try {
          new RegExp(pattern, "i");
        } catch {
          fail(`expectations.forbiddenContent has an invalid regex: ${pattern}`);
        }
      }
    }
    const budgetRespect = expectations["budgetRespect"];
    if (budgetRespect !== undefined) {
      if (!isRecord(budgetRespect)) {
        fail("expectations.budgetRespect must be an object");
      } else {
        for (const key of Object.keys(budgetRespect)) {
          if (key !== "capMicrosPath" && key !== "currency") {
            fail(`unknown budgetRespect field: ${key}`);
          }
        }
        if (budgetRespect["capMicrosPath"] !== undefined && !isNonEmptyString(budgetRespect["capMicrosPath"])) {
          fail("budgetRespect.capMicrosPath must be a non-empty string");
        }
        if (budgetRespect["currency"] !== undefined && !/^[A-Z]{3}$/u.test(String(budgetRespect["currency"]))) {
          fail("budgetRespect.currency must be an ISO 4217 code");
        }
      }
    }
    const decisionPolicy = expectations["decisionPolicy"];
    if (decisionPolicy !== undefined) {
      if (!isRecord(decisionPolicy)) {
        fail("expectations.decisionPolicy must be an object");
      } else {
        for (const key of Object.keys(decisionPolicy)) {
          if (key !== "maxReplansMax") fail(`unknown decisionPolicy field: ${key}`);
        }
        const max = decisionPolicy["maxReplansMax"];
        if (max !== undefined && (typeof max !== "number" || !Number.isInteger(max) || max < 0)) {
          fail("decisionPolicy.maxReplansMax must be a non-negative integer");
        }
      }
    }
    if (expectations["motionTypes"] !== undefined) {
      issues.push(
        ...checkStringArray(expectations["motionTypes"], "expectations.motionTypes", false).map(
          (message) => ({ file, message }),
        ),
      );
    }
  }
  if (raw["notes"] !== undefined && typeof raw["notes"] !== "string") {
    fail("notes must be a string");
  }
  if (issues.length > 0) return { issues };
  return { asset: raw as unknown as GoldenBriefAsset, issues };
}

/** 从目录装载全部 golden brief 资产（`*.json`，按文件名排序）。 */
export function loadGoldenBriefs(directory: string): GoldenBriefLoadResult {
  const assets: GoldenBriefAsset[] = [];
  const issues: GoldenBriefIssue[] = [];
  if (!existsSync(directory)) {
    issues.push({ file: directory, message: "golden briefs directory does not exist" });
    return { assets, issues };
  }
  for (const entry of readdirSync(directory).sort()) {
    if (!entry.endsWith(".json")) continue;
    const file = join(directory, entry);
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(file, "utf8"));
    } catch (cause) {
      issues.push({ file, message: `invalid JSON: ${String(cause)}` });
      continue;
    }
    const parsed = parseGoldenBriefAsset(raw, file);
    issues.push(...parsed.issues);
    if (parsed.asset) assets.push(parsed.asset);
  }
  const ids = new Set<string>();
  for (const asset of assets) {
    if (ids.has(asset.id)) issues.push({ file: directory, message: `duplicate golden brief id: ${asset.id}` });
    ids.add(asset.id);
  }
  return { assets, issues };
}
