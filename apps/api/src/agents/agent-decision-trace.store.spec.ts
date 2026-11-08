import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PrismaAgentDecisionTraceStore } from "./agent-decision-trace.store";

/**
 * 决策轨迹 store 的静态契约（零容器）：
 *   负向 4：没有 UPDATE/DELETE 路径（源码断言 + 实现类只有 record 一个方法）；
 *   负向 6：写入以 (workspace, run, step_type, discriminator) 唯一键幂等
 *           （真库行为由 agent-orchestration.postgres.spec.ts 覆盖）。
 */
const SOURCE = readFileSync(join(import.meta.dirname, "agent-decision-trace.store.ts"), "utf8");

describe("agent decision trace store", () => {
  it("exposes exactly one write method: record (no update, no delete)", () => {
    const methods = Object.getOwnPropertyNames(PrismaAgentDecisionTraceStore.prototype).filter(
      (name) => name !== "constructor",
    );
    expect(methods).toEqual(["record"]);
  });

  it("is append-only in source: no UPDATE or DELETE statement touches the trace table", () => {
    expect(SOURCE).not.toMatch(/UPDATE\s+"agent_decision_trace"/iu);
    expect(SOURCE).not.toMatch(/DELETE\s+FROM\s+"agent_decision_trace"/iu);
    expect(SOURCE).not.toMatch(/\$executeRawUnsafe|queryRawUnsafe/u);
  });

  it("writes through withWorkspace so the tenant RLS context always applies", () => {
    expect(SOURCE).toContain("withWorkspace(trace.workspaceId");
  });

  it("replays idempotently on the (workspace, run, step, discriminator) key", () => {
    expect(SOURCE).toContain(
      'ON CONFLICT ("workspace_id", "run_id", "step_type", "discriminator") DO NOTHING',
    );
  });
});
