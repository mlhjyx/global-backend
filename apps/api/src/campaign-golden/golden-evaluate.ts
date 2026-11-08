import type { GoldenBriefAsset } from "./golden-brief";

/**
 * Golden brief 的结构化断言层（设计 §4「契约合法、必含/禁含字段、预算上限约束」）。
 * 纯函数、零模型：对一份 CampaignPlan（或任意计划形状）求值一组闭集检查项，
 * 变异测试（§7-3）靠它对「被改坏的期望/产出」判红。
 */

export interface GoldenCheckResult {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface GoldenEvaluation {
  readonly passed: boolean;
  readonly checks: readonly GoldenCheckResult[];
}

const DEFAULT_CAP_MICROS_PATH = "budget.capMicros";
const DEFAULT_MAX_REPLANS = 2;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** 点分路径解析（数字段视为数组下标）；缺失返回 undefined。 */
export function resolvePlanPath(root: unknown, path: string): unknown {
  if (path === "") return root;
  let current: unknown = root;
  for (const segment of path.split(".")) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0) return undefined;
      current = current[index];
      continue;
    }
    if (!isRecord(current)) return undefined;
    current = current[segment];
  }
  return current;
}

function planText(plan: unknown): string {
  try {
    return JSON.stringify(plan) ?? "";
  } catch {
    return String(plan);
  }
}

export function evaluateGoldenPlan(asset: GoldenBriefAsset, plan: unknown): GoldenEvaluation {
  const checks: GoldenCheckResult[] = [];
  const expectations = asset.expectations;
  const push = (name: string, ok: boolean, detail: string): void => {
    checks.push({ name, ok, detail });
  };

  if (!isRecord(plan)) {
    push("plan_object", false, "plan is not a JSON object");
    return { passed: false, checks };
  }

  push(
    "plan_schema_version",
    plan["schemaVersion"] === expectations.planSchemaVersion,
    `expected ${expectations.planSchemaVersion}, got ${String(plan["schemaVersion"])}`,
  );

  const missing = expectations.requiredFields.filter(
    (path) => resolvePlanPath(plan, path) === undefined,
  );
  push(
    "required_fields",
    missing.length === 0,
    missing.length === 0 ? "all required fields present" : `missing: ${missing.join(", ")}`,
  );

  const present = expectations.forbiddenFields.filter(
    (path) => resolvePlanPath(plan, path) !== undefined,
  );
  push(
    "forbidden_fields",
    present.length === 0,
    present.length === 0 ? "no forbidden fields present" : `present: ${present.join(", ")}`,
  );

  const text = planText(plan);
  const hits = (expectations.forbiddenContent ?? []).filter((pattern) => new RegExp(pattern, "i").test(text));
  push(
    "forbidden_content",
    hits.length === 0,
    hits.length === 0 ? "no forbidden content" : `matched: ${hits.join(" | ")}`,
  );

  const capPath = expectations.budgetRespect?.capMicrosPath ?? DEFAULT_CAP_MICROS_PATH;
  const planCap = resolvePlanPath(plan, capPath);
  const budgetProblems: string[] = [];
  if (planCap !== undefined) {
    if (typeof planCap !== "number" || !Number.isInteger(planCap) || planCap < 0) {
      budgetProblems.push(`${capPath} must be a non-negative integer (USD micros)`);
    } else if (planCap > asset.brief.budgetCapMicros) {
      budgetProblems.push(`${capPath}=${planCap} exceeds brief cap ${asset.brief.budgetCapMicros}`);
    }
  }
  const currency = expectations.budgetRespect?.currency;
  if (currency !== undefined && resolvePlanPath(plan, "budget.currency") !== currency) {
    budgetProblems.push(`budget.currency must be ${currency}`);
  }
  push(
    "budget_respect",
    budgetProblems.length === 0,
    budgetProblems.length === 0 ? "budget within the brief cap" : budgetProblems.join("; "),
  );

  const maxReplansMax = expectations.decisionPolicy?.maxReplansMax ?? DEFAULT_MAX_REPLANS;
  const maxReplans = resolvePlanPath(plan, "decisionPolicy.maxReplans");
  push(
    "decision_policy",
    typeof maxReplans === "number" &&
      Number.isInteger(maxReplans) &&
      maxReplans >= 0 &&
      maxReplans <= maxReplansMax,
    `decisionPolicy.maxReplans=${String(maxReplans)} must be an integer in [0, ${maxReplansMax}]`,
  );

  const allowedTypes = expectations.motionTypes;
  if (allowedTypes !== undefined) {
    const motions = resolvePlanPath(plan, "motions");
    const problems: string[] = [];
    if (!Array.isArray(motions) || motions.length === 0) {
      problems.push("motions must be a non-empty array");
    } else {
      motions.forEach((motion, index) => {
        const type = isRecord(motion) ? motion["type"] : undefined;
        if (typeof type !== "string" || !allowedTypes.includes(type)) {
          problems.push(`motions.${String(index)}.type=${String(type)} is not in ${allowedTypes.join("|")}`);
        }
      });
    }
    push(
      "motion_types",
      problems.length === 0,
      problems.length === 0 ? `all motions in ${allowedTypes.join("|")}` : problems.join("; "),
    );
  }

  return { passed: checks.every((check) => check.ok), checks };
}
