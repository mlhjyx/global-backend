import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 进程入口没有单元 harness（worker / fast lane 直接起 Temporal Worker），
 * 源级守卫钉住 M2 步 9b 的接线：两个 worker 都注入 DB agent 解析器与轨迹 store，
 * 并把 agentRuntime 交给 discovery activities（源侦察员回合门 + source.route 轨迹）。
 */
const TEMPORAL = join(import.meta.dirname, "..", "temporal");
const read = (name: string): string => readFileSync(join(TEMPORAL, name), "utf8");

describe("agent runtime worker wiring", () => {
  const worker = read("worker.ts");
  const lane = read("dev-fast-lane-worker.ts");

  it("builds the DB-backed resolver and the trace store in both workers", () => {
    for (const source of [worker, lane]) {
      expect(source).toContain("createDbAgentResolver(new PrismaAgentRegistryStore(prisma))");
      expect(source).toContain("new PrismaAgentDecisionTraceStore(prisma)");
    }
  });

  it("hands the agent runtime to the discovery activities in both workers", () => {
    for (const source of [worker, lane]) {
      expect(source).toContain("agentRuntime: { agents: agentResolver, traces: agentTraces }");
    }
  });

  it("hands the agent runtime to the run2 activities in the managed worker", () => {
    const block = worker.slice(worker.indexOf("createRun2Activities({"));
    expect(block.slice(0, block.indexOf("})"))).toContain(
      "agentRuntime: { agents: agentResolver, traces: agentTraces }",
    );
  });
});
