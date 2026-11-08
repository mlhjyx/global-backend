import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadGoldenBriefs, type GoldenBriefAsset } from "./golden-brief";

/**
 * 跑批器端到端（真实 CLI）：replay 模式逐条求值、失败即非零退出、--out/--baseline 的
 * 结果文件与叶子 diff 生效。模型输出不在本层（--live 需 M2.1 规划接口）。
 */
const REPO_ROOT = join(import.meta.dirname, "../../../..");
const TSX = join(REPO_ROOT, "node_modules/.bin/tsx");
const SCRIPT = join(REPO_ROOT, "scripts/campaign-golden.mts");
const ASSETS_DIR = join(REPO_ROOT, "evals/golden-campaign-briefs");

const { assets } = loadGoldenBriefs(ASSETS_DIR);

function validPlan(asset: GoldenBriefAsset): Record<string, unknown> {
  return {
    schemaVersion: "campaign-plan/v0",
    goal: { objective: asset.brief.objective },
    audience: { icpIds: ["11111111-1111-4111-8111-111111111111"], sizeCap: 200 },
    motions: [{ type: "discovery", icpIds: ["11111111-1111-4111-8111-111111111111"] }],
    budget: { capMicros: Math.min(1_000_000, asset.brief.budgetCapMicros), currency: "USD" },
    approvalPolicy: { required: true },
    decisionPolicy: { maxReplans: 0 },
  };
}

function withReplayDir(run: (dir: string) => void, mutate?: (id: string, plan: Record<string, unknown>) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "golden-replay-"));
  try {
    for (const asset of assets) {
      const plan = validPlan(asset);
      mutate?.(asset.id, plan);
      writeFileSync(join(dir, `${asset.id}.plan.json`), JSON.stringify(plan, null, 2));
    }
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runCli(argv: string[]): { status: number | null; stdout: string; stderr: string } {
  expect(existsSync(TSX), `tsx binary missing at ${TSX}`).toBe(true);
  const result = spawnSync(TSX, [SCRIPT, ...argv], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 180_000,
    env: { ...process.env },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("campaign:golden runner (replay)", () => {
  it("passes all six briefs and writes a machine-readable result", () => {
    withReplayDir((dir) => {
      const out = join(dir, "result.json");
      const run = runCli(["--replay", dir, "--format", "json", "--out", out]);
      expect(run.status, run.stderr).toBe(0);
      const result = JSON.parse(readFileSync(out, "utf8")) as {
        totals: { total: number; passed: number };
        items: { id: string; passed: boolean; planDigest: string }[];
      };
      expect(result.totals).toEqual({ total: 6, passed: 6, passRate: 1 });
      expect(result.items.every((item) => item.passed)).toBe(true);
      expect(new Set(result.items.map((item) => item.planDigest)).size).toBe(6);
    });
  });

  it("turns red on a budget violation (mutation of the plan)", () => {
    withReplayDir(
      (dir) => {
        const run = runCli(["--replay", dir, "--format", "json"]);
        expect(run.status).toBe(1);
        expect(run.stderr).toContain("campaign:golden FAILED (1/6");
      },
      (id, plan) => {
        if (id === "03-us-electronics-ems") {
          (plan["budget"] as Record<string, unknown>)["capMicros"] = 999_999_999;
        }
      },
    );
  });

  it("diffs against a baseline result file", () => {
    withReplayDir((dir) => {
      const baseline = join(dir, "baseline.json");
      expect(runCli(["--replay", dir, "--out", baseline, "--format", "json"]).status).toBe(0);
      const planFile = join(dir, `${assets[0].id}.plan.json`);
      const plan = JSON.parse(readFileSync(planFile, "utf8")) as Record<string, unknown>;
      (plan["goal"] as Record<string, unknown>)["objective"] = "changed objective";
      writeFileSync(planFile, JSON.stringify(plan));
      const run = runCli(["--replay", dir, "--baseline", baseline, "--format", "json"]);
      const result = JSON.parse(run.stdout) as {
        items: { id: string; diff?: { added: string[]; removed: string[]; changed: string[] } }[];
      };
      const item = result.items.find((entry) => entry.id === assets[0].id);
      expect(item?.diff?.changed).toContain("goal.objective");
    });
  });

  it("fails with a stable error on a missing planner env or replay dir", () => {
    const noMode = runCli(["--format", "json"]);
    expect(noMode.status).toBe(2);
    expect(noMode.stderr).toContain("one of --replay <dir> or --live is required");
    const missingDir = runCli(["--replay", join(tmpdir(), "definitely-missing-replay-dir")]);
    expect(missingDir.status).toBe(2);
    expect(missingDir.stderr).toContain("replay directory does not exist");
  });
});
