import Ajv from "ajv";
import type { EvalAssertion, EvalCase, EvalManifest } from "./eval-manifest";

/**
 * 零模型评测执行器：对确定性技能/内容包与固定 fixture 输出逐条断言。
 * 模型实测层不在此文件——它由 ops 触发的发布门运行并写回执（S1-3）。
 */

export interface EvalRunContext {
  readonly output: unknown;
  readonly toolCalls?: readonly string[];
  readonly approvalRequests?: readonly string[];
}

export type EvalHandler = (evalCase: EvalCase) => Promise<EvalRunContext> | EvalRunContext;

export interface EvalCaseResult {
  readonly id: string | number;
  readonly ok: boolean;
  readonly failures: readonly string[];
}

export interface EvalRunResult {
  readonly passed: boolean;
  readonly cases: readonly EvalCaseResult[];
}

const DEFAULT_VENDOR_PATTERNS = [
  "sponsored",
  "affiliate",
  "utm_source=",
  "newsletter",
  "subscribe",
  "promo code",
  "discount code",
] as const;

const ajv = new Ajv({ allErrors: true, strict: false });

export function resolveOutputPath(output: unknown, path: string | undefined): unknown {
  if (!path) return output;
  let current: unknown = output;
  for (const segment of path.split(".")) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const index = Number(segment);
      current = Number.isInteger(index) ? current[index] : undefined;
      continue;
    }
    if (typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) {
    return false;
  }
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, index) => deepEqual(item, right[index]));
  }
  const leftKeys = Object.keys(left as Record<string, unknown>).sort();
  const rightKeys = Object.keys(right as Record<string, unknown>).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] &&
        deepEqual(
          (left as Record<string, unknown>)[key],
          (right as Record<string, unknown>)[key],
        ),
    )
  );
}

function assertionFailure(
  assertion: EvalAssertion,
  context: EvalRunContext,
): string | null {
  const value = resolveOutputPath(context.output, assertion.path);
  switch (assertion.kind) {
    case "equals":
      return deepEqual(value, assertion.value)
        ? null
        : `equals failed at ${assertion.path ?? "output"}`;
    case "contains":
      return typeof value === "string" && value.includes(assertion.value)
        ? null
        : `contains failed at ${assertion.path ?? "output"}`;
    case "regex":
      return typeof value === "string" &&
        new RegExp(assertion.pattern, assertion.flags).test(value)
        ? null
        : `regex failed at ${assertion.path ?? "output"}`;
    case "json_schema": {
      const validate = ajv.compile(assertion.schema);
      return validate(value) ? null : `json_schema failed at ${assertion.path ?? "output"}`;
    }
    case "enum":
      return assertion.values.some((candidate) => deepEqual(candidate, value))
        ? null
        : `enum failed at ${assertion.path ?? "output"}`;
    case "gte":
      return typeof value === "number" && value >= assertion.value
        ? null
        : `gte failed at ${assertion.path ?? "output"}`;
    case "lte":
      return typeof value === "number" && value <= assertion.value
        ? null
        : `lte failed at ${assertion.path ?? "output"}`;
    case "source_count_gte":
      return Array.isArray(value) && value.length >= assertion.value
        ? null
        : `source_count_gte failed at ${assertion.path ?? "output"}`;
    case "no_vendor_marketing": {
      // undefined 路径必须红：JSON.stringify(undefined ?? "") === '""' 会让断言
      // 恒真——路径改名/输出返工时该检查会静默失效（其它字符串断言都 fail-closed）。
      if (value === undefined) {
        return `no_vendor_marketing path did not resolve at ${assertion.path ?? "output"}`;
      }
      const text = JSON.stringify(value).toLowerCase();
      const patterns = assertion.patterns ?? DEFAULT_VENDOR_PATTERNS;
      const hit = patterns.find((pattern) => text.includes(pattern.toLowerCase()));
      return hit === undefined ? null : `no_vendor_marketing hit "${hit}"`;
    }
    case "tool_not_called":
      return (context.toolCalls ?? []).includes(assertion.value)
        ? `tool_not_called failed: ${assertion.value}`
        : null;
    case "approval_required":
      return (context.approvalRequests ?? []).includes(assertion.value)
        ? null
        : `approval_required missing: ${assertion.value}`;
    default:
      return "unsupported assertion";
  }
}

export async function runDeterministicEvals(
  manifest: EvalManifest,
  handler: EvalHandler,
): Promise<EvalRunResult> {
  const cases: EvalCaseResult[] = [];
  for (const evalCase of manifest.evals) {
    const context = await handler(evalCase);
    const failures: string[] = [];
    for (const assertion of evalCase.assertions) {
      const failure = assertionFailure(assertion, context);
      if (failure !== null) failures.push(failure);
    }
    cases.push({ id: evalCase.id, ok: failures.length === 0, failures });
  }
  return { passed: cases.every((result) => result.ok), cases };
}
