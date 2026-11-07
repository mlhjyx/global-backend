/**
 * Golden Set 评测清单（S1）：沿用第三方目录 GOV-TPS-003 的 evals.json 形态，
 * 断言收敛到闭集词汇（不允许自由脚本）。本模块只做结构与词汇校验；执行器在
 * `deterministic-executor.ts`（零模型层），模型实测层由 ops 触发并写回执（S1-3）。
 */

export const EVAL_ASSERTION_KINDS = [
  "equals",
  "contains",
  "regex",
  "json_schema",
  "enum",
  "gte",
  "lte",
  "source_count_gte",
  "no_vendor_marketing",
  "tool_not_called",
  "approval_required",
] as const;
export type EvalAssertionKind = (typeof EVAL_ASSERTION_KINDS)[number];

interface EvalAssertionBase {
  readonly kind: EvalAssertionKind;
  /** 点分路径（如 `summary` / `signals.0.label`）；缺省为整个输出。 */
  readonly path?: string;
  readonly message?: string;
}

export interface EvalEqualsAssertion extends EvalAssertionBase {
  readonly kind: "equals";
  readonly value: unknown;
}
export interface EvalContainsAssertion extends EvalAssertionBase {
  readonly kind: "contains";
  readonly value: string;
}
export interface EvalRegexAssertion extends EvalAssertionBase {
  readonly kind: "regex";
  readonly pattern: string;
  readonly flags?: string;
}
export interface EvalJsonSchemaAssertion extends EvalAssertionBase {
  readonly kind: "json_schema";
  readonly schema: Record<string, unknown>;
}
export interface EvalEnumAssertion extends EvalAssertionBase {
  readonly kind: "enum";
  readonly values: readonly unknown[];
}
export interface EvalNumericAssertion extends EvalAssertionBase {
  readonly kind: "gte" | "lte";
  readonly value: number;
}
export interface EvalSourceCountAssertion extends EvalAssertionBase {
  readonly kind: "source_count_gte";
  readonly value: number;
}
export interface EvalNoVendorMarketingAssertion extends EvalAssertionBase {
  readonly kind: "no_vendor_marketing";
  readonly patterns?: readonly string[];
}
export interface EvalToolNotCalledAssertion extends EvalAssertionBase {
  readonly kind: "tool_not_called";
  readonly value: string;
}
export interface EvalApprovalRequiredAssertion extends EvalAssertionBase {
  readonly kind: "approval_required";
  readonly value: string;
}

export type EvalAssertion =
  | EvalEqualsAssertion
  | EvalContainsAssertion
  | EvalRegexAssertion
  | EvalJsonSchemaAssertion
  | EvalEnumAssertion
  | EvalNumericAssertion
  | EvalSourceCountAssertion
  | EvalNoVendorMarketingAssertion
  | EvalToolNotCalledAssertion
  | EvalApprovalRequiredAssertion;

export interface EvalCase {
  readonly id: string | number;
  readonly prompt?: string;
  readonly input?: unknown;
  readonly expectedOutput?: string;
  readonly files?: readonly string[];
  readonly assertions: readonly EvalAssertion[];
}

export interface EvalManifest {
  readonly skillName: string;
  readonly evals: readonly EvalCase[];
}

export type EvalIssueSeverity = "error" | "warning";

export interface EvalValidationIssue {
  readonly code: string;
  readonly severity: EvalIssueSeverity;
  readonly message: string;
  readonly caseId?: string | number;
}

const ASSERTION_FIELDS: Readonly<Record<EvalAssertionKind, readonly string[]>> = {
  equals: ["kind", "path", "message", "value"],
  contains: ["kind", "path", "message", "value"],
  regex: ["kind", "path", "message", "pattern", "flags"],
  json_schema: ["kind", "path", "message", "schema"],
  enum: ["kind", "path", "message", "values"],
  gte: ["kind", "path", "message", "value"],
  lte: ["kind", "path", "message", "value"],
  source_count_gte: ["kind", "path", "message", "value"],
  no_vendor_marketing: ["kind", "path", "message", "patterns"],
  tool_not_called: ["kind", "path", "message", "value"],
  approval_required: ["kind", "path", "message", "value"],
};

const FORBIDDEN_CASE_FIELDS = ["command", "script", "shell", "exec"] as const;

export interface EvalValidationOptions {
  readonly minCases?: number;
}

export function validateEvalManifest(
  candidate: unknown,
  options: EvalValidationOptions = {},
): readonly EvalValidationIssue[] {
  const minCases = options.minCases ?? 5;
  const issues: EvalValidationIssue[] = [];
  const error = (code: string, message: string, caseId?: string | number): void => {
    issues.push({ code, severity: "error", message, ...(caseId !== undefined ? { caseId } : {}) });
  };

  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    error("EVAL_MANIFEST_INVALID", "manifest must be an object");
    return issues;
  }
  const manifest = candidate as Partial<EvalManifest> & Record<string, unknown>;
  if (typeof manifest.skillName !== "string" || manifest.skillName.trim() === "") {
    error("EVAL_SKILL_NAME_INVALID", "skillName must be a non-empty string");
  }
  if (!Array.isArray(manifest.evals)) {
    error("EVAL_CASES_MISSING", "evals must be an array");
    return issues;
  }
  if (manifest.evals.length < minCases) {
    error("EVAL_CASES_TOO_FEW", `at least ${minCases} cases are required, got ${manifest.evals.length}`);
  }

  const ids = new Set<string>();
  manifest.evals.forEach((rawCase, index) => {
    const caseId =
      rawCase && typeof rawCase === "object" && "id" in rawCase
        ? (rawCase as EvalCase).id
        : index;
    if (!rawCase || typeof rawCase !== "object" || Array.isArray(rawCase)) {
      error("EVAL_CASE_INVALID", "case must be an object", caseId);
      return;
    }
    const evalCase = rawCase as Partial<EvalCase> & Record<string, unknown>;
    for (const forbidden of FORBIDDEN_CASE_FIELDS) {
      if (forbidden in evalCase) {
        error("EVAL_CASE_FIELD_FORBIDDEN", `case field "${forbidden}" is not allowed`, caseId);
      }
    }
    if (
      (typeof evalCase.id !== "string" && typeof evalCase.id !== "number") ||
      String(evalCase.id).trim() === ""
    ) {
      error("EVAL_CASE_ID_INVALID", "case id must be a string or number", caseId);
    } else if (ids.has(String(evalCase.id))) {
      error("EVAL_CASE_ID_DUPLICATE", `duplicate case id: ${String(evalCase.id)}`, caseId);
    } else {
      ids.add(String(evalCase.id));
    }
    const hasPrompt = typeof evalCase.prompt === "string" && evalCase.prompt.trim() !== "";
    const hasInput = evalCase.input !== undefined;
    if (!hasPrompt && !hasInput) {
      error("EVAL_CASE_INPUT_MISSING", "case needs prompt or input", caseId);
    }
    if (!Array.isArray(evalCase.assertions) || evalCase.assertions.length === 0) {
      error("EVAL_ASSERTIONS_MISSING", "case needs at least one assertion", caseId);
      return;
    }
    for (const assertion of evalCase.assertions as unknown[]) {
      validateAssertion(assertion, caseId, error);
    }
  });

  return issues;
}

function validateAssertion(
  assertion: unknown,
  caseId: string | number,
  error: (code: string, message: string, caseId?: string | number) => void,
): void {
  if (!assertion || typeof assertion !== "object" || Array.isArray(assertion)) {
    error("EVAL_ASSERTION_INVALID", "assertion must be an object", caseId);
    return;
  }
  const record = assertion as Record<string, unknown>;
  const kind = record["kind"];
  if (typeof kind !== "string" || !EVAL_ASSERTION_KINDS.includes(kind as EvalAssertionKind)) {
    error("EVAL_ASSERTION_KIND_INVALID", `unknown assertion kind: ${String(kind)}`, caseId);
    return;
  }
  const allowed = ASSERTION_FIELDS[kind as EvalAssertionKind];
  for (const field of Object.keys(record)) {
    if (!allowed.includes(field)) {
      error("EVAL_ASSERTION_FIELD_FORBIDDEN", `assertion field "${field}" is not allowed for ${kind}`, caseId);
    }
  }
  switch (kind) {
    case "equals": {
      if (!("value" in record)) error("EVAL_ASSERTION_VALUE_MISSING", "equals needs value", caseId);
      break;
    }
    case "contains":
    case "tool_not_called":
    case "approval_required": {
      if (typeof record["value"] !== "string" || (record["value"] as string).trim() === "") {
        error("EVAL_ASSERTION_VALUE_MISSING", `${kind} needs a non-empty string value`, caseId);
      }
      break;
    }
    case "regex": {
      if (typeof record["pattern"] !== "string" || (record["pattern"] as string).length === 0) {
        error("EVAL_ASSERTION_PATTERN_MISSING", "regex needs pattern", caseId);
      } else {
        try {
          new RegExp(record["pattern"] as string, typeof record["flags"] === "string" ? (record["flags"] as string) : undefined);
        } catch {
          error("EVAL_ASSERTION_PATTERN_INVALID", `invalid regex: ${String(record["pattern"])}`, caseId);
        }
      }
      break;
    }
    case "json_schema": {
      const schema = record["schema"];
      if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
        error("EVAL_ASSERTION_SCHEMA_MISSING", "json_schema needs a schema object", caseId);
      }
      break;
    }
    case "enum": {
      const values = record["values"];
      if (!Array.isArray(values) || values.length === 0) {
        error("EVAL_ASSERTION_VALUES_MISSING", "enum needs a non-empty values array", caseId);
      }
      break;
    }
    case "gte":
    case "lte":
    case "source_count_gte": {
      if (typeof record["value"] !== "number" || !Number.isFinite(record["value"] as number)) {
        error("EVAL_ASSERTION_VALUE_MISSING", `${kind} needs a finite number`, caseId);
      }
      break;
    }
    case "no_vendor_marketing": {
      const patterns = record["patterns"];
      if (
        patterns !== undefined &&
        (!Array.isArray(patterns) ||
          patterns.length === 0 ||
          patterns.some((item) => typeof item !== "string" || item.trim() === ""))
      ) {
        error("EVAL_ASSERTION_PATTERNS_INVALID", "patterns must be a non-empty string array", caseId);
      }
      break;
    }
  }
}
