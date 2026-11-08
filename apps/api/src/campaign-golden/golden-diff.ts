/**
 * 计划的叶子字段结构 diff（设计 §4「逐条 JSON diff」）。
 * 叶子 = 原始值（字符串/数字/布尔/null）；对象与数组按容器展开，数组以数字下标寻址。
 * 这是结构距离，不做语义相似度（与 D-M2.2-c 的结构化修改距离同口径）。
 */

export interface GoldenPlanDiff {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly changed: readonly string[];
}

function isContainer(value: unknown): value is Record<string, unknown> | readonly unknown[] {
  return Boolean(value) && typeof value === "object";
}

function collectLeaves(value: unknown, prefix: string, out: Map<string, unknown>): void {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      out.set(prefix, "[]");
      return;
    }
    value.forEach((item, index) => collectLeaves(item, prefix === "" ? String(index) : `${prefix}.${String(index)}`, out));
    return;
  }
  if (isContainer(value)) {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.length === 0) {
      out.set(prefix, "{}");
      return;
    }
    for (const key of keys.sort()) {
      collectLeaves(record[key], prefix === "" ? key : `${prefix}.${key}`, out);
    }
    return;
  }
  out.set(prefix, value);
}

export function diffPlanLeaves(baseline: unknown, current: unknown): GoldenPlanDiff {
  const left = new Map<string, unknown>();
  const right = new Map<string, unknown>();
  collectLeaves(baseline, "", left);
  collectLeaves(current, "", right);
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  for (const [path, value] of right) {
    if (!left.has(path)) {
      added.push(path);
    } else if (JSON.stringify(left.get(path)) !== JSON.stringify(value)) {
      changed.push(path);
    }
  }
  for (const path of left.keys()) {
    if (!right.has(path)) removed.push(path);
  }
  return { added: added.sort(), removed: removed.sort(), changed: changed.sort() };
}
