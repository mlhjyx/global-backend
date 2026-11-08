import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AGENT_KEYS, BUILTIN_AGENTS } from "./agent-catalog";

/**
 * agent 注册表播种的静态契约（零容器）。真库幂等行为由
 * agent-orchestration.postgres.spec.ts 覆盖；这里钉住：
 *   - 代码侧定义与设计 §3.1 的结构；
 *   - seed 幂等（ON CONFLICT DO NOTHING）且**不覆盖** ops 手改的 status；
 *   - 两个进程入口都播种（worker 失败大声、relay 启动期播种），fast lane 不写 owner 平台表。
 */
const API = join(import.meta.dirname, "..", "..");
const SEED = readFileSync(join(import.meta.dirname, "agent-catalog.seed.ts"), "utf8");
const WORKER = readFileSync(join(API, "src/temporal/worker.ts"), "utf8");
const RELAY = readFileSync(join(API, "src/relay/outbox-relay.service.ts"), "utf8");
const FAST_LANE = readFileSync(join(API, "src/temporal/dev-fast-lane-worker.ts"), "utf8");

describe("agent catalog", () => {
  it("registers the two v0 roles with single-round loops and the contracted skill subsets", () => {
    const byKey = new Map(BUILTIN_AGENTS.map((agent) => [agent.agentKey, agent]));
    const scout = byKey.get(AGENT_KEYS.sourceScout);
    const qualifier = byKey.get(AGENT_KEYS.qualifier);
    expect(scout).toMatchObject({ memoryScope: "run", loopPolicy: { maxRounds: 1 } });
    expect(scout?.skillKeys).toEqual([]);
    expect(qualifier?.skillKeys).toEqual(["discovery.qualify_fit"]);
    expect(qualifier?.loopPolicy.maxRounds).toBe(1);
    for (const agent of BUILTIN_AGENTS) {
      expect(agent.agentKey).toMatch(/^discovery\./u);
      expect(agent.rolePromptVersion).toMatch(/^v\d+$/u);
    }
  });
});

describe("agent catalog seed", () => {
  it("inserts idempotently on the agent key", () => {
    expect(SEED).toContain('ON CONFLICT ("agent_key") DO NOTHING');
  });

  it("never overwrites the ops kill switch", () => {
    // 唯一一条 UPDATE 只同步代码侧定义字段，不含 status/status_reason。
    const update = SEED.slice(SEED.indexOf('UPDATE "agent_profile"'));
    const setClause = update.slice(0, update.indexOf('WHERE "agent_key"'));
    expect(setClause).not.toContain('"status"');
    expect(setClause).toContain('"role_prompt_version"');
    expect(setClause).toContain('"skill_keys"');
    expect(setClause).toContain('"loop_policy"');
  });

  it("is wired into both startup paths, loudly in the managed worker", () => {
    expect(WORKER).toContain("seedAgentCatalog(ownerDb)");
    expect(WORKER).toContain("AGENT_CATALOG_SEED_UNAVAILABLE");
    expect(RELAY).toContain("seedAgentCatalog(this.db)");
    expect(FAST_LANE).not.toContain("seedAgentCatalog");
  });
});
