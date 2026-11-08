/**
 * Golden campaign brief 跑批器（M2.2-2，设计 `docs/superpowers/plans/2026-11-08-campaign-replan-m2-2.md` §4/§8）。
 *
 * 资产：`evals/golden-campaign-briefs/*.json`（brief + 结构化期望）。
 * 模式：
 *  - `--replay <dir>` 零模型：读取目录里的 `<brief-id>.plan.json` 逐条求值（CI / 变异测试）。
 *  - `--live` 实跑：POST 到 `CAMPAIGN_GOLDEN_PLANNER_URL`（M2.1 规划接口；金丝雀租户/ops 面），
 *    可选 `CAMPAIGN_GOLDEN_PLANNER_TOKEN`。
 * 输出：通过率 + 逐条检查项；`--baseline <上次结果.json>` 时附叶子字段 diff。
 * `--out` 写 JSON（含计划快照，供下次作 baseline）；`--format markdown`（默认）打印证据模板。
 * 退出码：任一条失败 / 资产或环境错误 → 1（变异测试依赖这一行为，设计 §7-3）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadGoldenBriefs, type GoldenBriefAsset } from "../apps/api/src/campaign-golden/golden-brief";
import {
  evaluateGoldenPlan,
  type GoldenCheckResult,
} from "../apps/api/src/campaign-golden/golden-evaluate";
import { diffPlanLeaves, type GoldenPlanDiff } from "../apps/api/src/campaign-golden/golden-diff";
import { canonicalDigest } from "../apps/api/src/model-runtime/context-engine";

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const defaultAssetsDir = join(repoRoot, "evals/golden-campaign-briefs");

interface ItemResult {
  readonly id: string;
  readonly passed: boolean;
  readonly plan: unknown;
  readonly planDigest: string | null;
  readonly checks: readonly GoldenCheckResult[];
  readonly error?: string;
  readonly diff?: GoldenPlanDiff;
}

interface RunResult {
  readonly generatedAt: string;
  readonly mode: "replay" | "live";
  readonly source: string;
  readonly assetsDir: string;
  readonly totals: { total: number; passed: number; passRate: number };
  readonly issues: readonly string[];
  readonly items: readonly ItemResult[];
}

function parseArgs(argv: readonly string[]): Map<string, string | true> {
  const args = new Map<string, string | true>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const name = token.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      args.set(name, next);
      index += 1;
    } else {
      args.set(name, true);
    }
  }
  return args;
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

async function plansFromReplay(directory: string, assets: readonly GoldenBriefAsset[]): Promise<Map<string, unknown>> {
  if (!existsSync(directory)) fail(`replay directory does not exist: ${directory}`);
  const plans = new Map<string, unknown>();
  for (const asset of assets) {
    const file = join(directory, `${asset.id}.plan.json`);
    if (!existsSync(file)) continue;
    try {
      plans.set(asset.id, JSON.parse(readFileSync(file, "utf8")));
    } catch (cause) {
      fail(`invalid replay plan JSON for ${asset.id}: ${String(cause)}`);
    }
  }
  return plans;
}

async function plansFromLive(assets: readonly GoldenBriefAsset[]): Promise<Map<string, unknown>> {
  const url = process.env["CAMPAIGN_GOLDEN_PLANNER_URL"];
  if (!url) {
    fail("CAMPAIGN_GOLDEN_PLANNER_URL is required for --live (M2.1 planner endpoint)");
  }
  const token = process.env["CAMPAIGN_GOLDEN_PLANNER_TOKEN"];
  const plans = new Map<string, unknown>();
  for (const asset of assets) {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ assetId: asset.id, brief: asset.brief }),
      signal: AbortSignal.timeout(180_000),
    });
    if (!response.ok) {
      throw new Error(`planner returned ${String(response.status)} for ${asset.id}`);
    }
    const payload = (await response.json()) as { plan?: unknown };
    plans.set(asset.id, payload.plan);
  }
  return plans;
}

function loadBaseline(path: string): Map<string, unknown> {
  if (!existsSync(path)) fail(`baseline file does not exist: ${path}`);
  const raw = JSON.parse(readFileSync(path, "utf8")) as { items?: { id?: unknown; plan?: unknown }[] };
  const plans = new Map<string, unknown>();
  for (const item of raw.items ?? []) {
    if (typeof item.id === "string") plans.set(item.id, item.plan);
  }
  return plans;
}

function renderMarkdown(result: RunResult): string {
  const lines: string[] = [];
  lines.push(`# Golden campaign brief 跑批（${result.generatedAt}）`, "");
  lines.push(`- 模式：${result.mode}（${result.source}）`);
  lines.push(`- 资产：${String(result.totals.total)} 条（\`${result.assetsDir}\`）`);
  lines.push(
    `- 通过：${String(result.totals.passed)}/${String(result.totals.total)}（${String(
      Math.round(result.totals.passRate * 1000) / 10,
    )}%）`,
    "",
  );
  if (result.issues.length > 0) {
    lines.push("## 资产问题", "");
    for (const issue of result.issues) lines.push(`- ${issue}`);
    lines.push("");
  }
  lines.push("| brief | 结果 | 失败检查 | diff vs baseline |", "| --- | --- | --- | --- |");
  for (const item of result.items) {
    const failed = item.checks.filter((check) => !check.ok).map((check) => check.name);
    const failedText = item.error ? `error: ${item.error}` : failed.length > 0 ? failed.join(", ") : "";
    const diffText = item.diff
      ? `+${String(item.diff.added.length)} / -${String(item.diff.removed.length)} / ~${String(item.diff.changed.length)}`
      : "—";
    lines.push(`| ${item.id} | ${item.passed ? "✅" : "❌"} | ${failedText} | ${diffText} |`);
  }
  lines.push("", "## 结论", "", "（待填：是否可作为本 PR 的 planner 回归证据；有 diff 时说明原因）", "");
  lines.push("## 逐条检查", "");
  for (const item of result.items) {
    lines.push(`### ${item.id}${item.error ? `（error: ${item.error}）` : ""}`, "");
    for (const check of item.checks) {
      lines.push(`- ${check.ok ? "✅" : "❌"} \`${check.name}\`: ${check.detail}`);
    }
    if (item.diff) {
      if (item.diff.added.length > 0) lines.push(`- added: ${item.diff.added.join(", ")}`);
      if (item.diff.removed.length > 0) lines.push(`- removed: ${item.diff.removed.join(", ")}`);
      if (item.diff.changed.length > 0) lines.push(`- changed: ${item.diff.changed.join(", ")}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const assetsDir = typeof args.get("assets") === "string" ? (args.get("assets") as string) : defaultAssetsDir;
  const replayDir = typeof args.get("replay") === "string" ? (args.get("replay") as string) : undefined;
  const live = args.get("live") === true;
  if (replayDir === undefined && !live) fail("one of --replay <dir> or --live is required");
  if (replayDir !== undefined && live) fail("--replay and --live are mutually exclusive");

  const { assets, issues } = loadGoldenBriefs(assetsDir);
  const issueTexts = issues.map((issue) => `${issue.file}: ${issue.message}`);
  if (assets.length === 0) {
    fail(`no golden brief assets found in ${assetsDir}${issueTexts.length > 0 ? `\n${issueTexts.join("\n")}` : ""}`);
  }

  const baselinePath = typeof args.get("baseline") === "string" ? (args.get("baseline") as string) : undefined;
  const baseline = baselinePath ? loadBaseline(baselinePath) : new Map<string, unknown>();

  const plans = replayDir !== undefined ? await plansFromReplay(replayDir, assets) : await plansFromLive(assets);

  const items: ItemResult[] = [];
  for (const asset of assets) {
    const plan = plans.get(asset.id);
    if (plan === undefined) {
      items.push({ id: asset.id, passed: false, plan: null, planDigest: null, checks: [], error: "no plan produced" });
      continue;
    }
    const evaluation = evaluateGoldenPlan(asset, plan);
    const diff = baseline.has(asset.id) ? diffPlanLeaves(baseline.get(asset.id), plan) : undefined;
    items.push({
      id: asset.id,
      passed: evaluation.passed,
      plan,
      planDigest: canonicalDigest(plan),
      checks: evaluation.checks,
      ...(diff !== undefined ? { diff } : {}),
    });
  }

  const passed = items.filter((item) => item.passed).length;
  const result: RunResult = {
    generatedAt: new Date().toISOString(),
    mode: replayDir !== undefined ? "replay" : "live",
    source: replayDir !== undefined ? replayDir : (process.env["CAMPAIGN_GOLDEN_PLANNER_URL"] ?? "live"),
    assetsDir,
    totals: {
      total: items.length,
      passed,
      passRate: items.length === 0 ? 0 : passed / items.length,
    },
    issues: issueTexts,
    items,
  };

  const outPath = typeof args.get("out") === "string" ? (args.get("out") as string) : undefined;
  if (outPath) {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`);
  }
  const format = args.get("format") === "json" ? "json" : "markdown";
  process.stdout.write(`${format === "json" ? JSON.stringify(result, null, 2) : renderMarkdown(result)}\n`);
  // json 模式下状态行只走 stderr，保证 stdout 是可直接解析的 JSON。

  const failed = items.filter((item) => !item.passed).length;
  if (failed > 0 || issueTexts.length > 0) {
    process.stderr.write(`campaign:golden FAILED (${String(failed)}/${String(items.length)} item(s) failed)\n`);
    process.exit(1);
  }
  process.stderr.write(`campaign:golden ok (${String(passed)}/${String(items.length)} passed)\n`);
}

void main().catch((cause: unknown) => {
  process.stderr.write(`campaign:golden error: ${String(cause)}\n`);
  process.exit(2);
});
