import { describe, expect, it } from "vitest";
import { createDbAgentResolver } from "./agent-resolver";
import type { AgentProfileRow, AgentRegistryStore } from "./agent-registry.store";
import { AgentUnavailableError } from "./agent-runtime";

const WORKSPACE = "33333333-3333-4333-8333-333333333333";
const AGENT_KEY = "discovery.source_scout";

function profileRow(overrides: Partial<AgentProfileRow> = {}): AgentProfileRow {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    agentKey: AGENT_KEY,
    name: "源侦察员",
    rolePromptVersion: "v1",
    skillKeys: [],
    modelPolicy: {},
    memoryScope: "run",
    loopPolicy: { maxRounds: 1 },
    status: "ACTIVE",
    ...overrides,
  };
}

class FakeStore implements AgentRegistryStore {
  profile: AgentProfileRow | null = profileRow();
  readonly calls = { profile: 0 };

  async loadProfile(): Promise<AgentProfileRow | null> {
    this.calls.profile += 1;
    return this.profile;
  }
}

async function codeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    if (error instanceof AgentUnavailableError) return error.code;
    throw error;
  }
  throw new Error("expected AgentUnavailableError");
}

describe("createDbAgentResolver", () => {
  it("resolves a registered ACTIVE agent with its role, skills and loop policy", async () => {
    const store = new FakeStore();
    store.profile = profileRow({
      agentKey: "discovery.qualifier",
      name: "资格判定员",
      skillKeys: ["discovery.qualify_fit"],
    });
    const resolver = createDbAgentResolver(store, { ttlMs: 0 });

    const agent = await resolver.resolve("discovery.qualifier", WORKSPACE);

    expect(agent.agentKey).toBe("discovery.qualifier");
    expect(agent.name).toBe("资格判定员");
    expect(agent.rolePromptVersion).toBe("v1");
    expect(agent.skillKeys).toEqual(["discovery.qualify_fit"]);
    expect(agent.memoryScope).toBe("run");
    expect(agent.loopPolicy.maxRounds).toBe(1);
  });

  // 负向 1：未注册 agent key 不可运行。
  it("rejects an unregistered agent key with AGENT_NOT_REGISTERED", async () => {
    const store = new FakeStore();
    store.profile = null;
    const resolver = createDbAgentResolver(store, { ttlMs: 0 });

    expect(await codeOf(() => resolver.resolve("discovery.unknown", WORKSPACE))).toBe(
      "AGENT_NOT_REGISTERED",
    );
  });

  // 负向 2：agent 平台 DISABLED → 回合 fail-closed。
  it("rejects a platform-disabled agent with AGENT_DISABLED", async () => {
    const store = new FakeStore();
    store.profile = profileRow({ status: "DISABLED" });
    const resolver = createDbAgentResolver(store, { ttlMs: 0 });

    expect(await codeOf(() => resolver.resolve(AGENT_KEY, WORKSPACE))).toBe("AGENT_DISABLED");
  });

  it("never caches a failed resolution (kill switch applies as soon as the cache expires)", async () => {
    let clock = 1_000;
    const store = new FakeStore();
    store.profile = null;
    const resolver = createDbAgentResolver(store, { ttlMs: 30_000, now: () => clock });

    expect(await codeOf(() => resolver.resolve(AGENT_KEY, WORKSPACE))).toBe("AGENT_NOT_REGISTERED");
    store.profile = profileRow();
    clock += 1;
    // 失败不写缓存：注册行补建后下一次解析立即成功。
    await expect(resolver.resolve(AGENT_KEY, WORKSPACE)).resolves.toMatchObject({
      agentKey: AGENT_KEY,
    });
  });

  it("caches a resolved agent for the TTL and drops it on invalidate", async () => {
    let clock = 1_000;
    const store = new FakeStore();
    const resolver = createDbAgentResolver(store, { ttlMs: 30_000, now: () => clock });

    await resolver.resolve(AGENT_KEY, WORKSPACE);
    await resolver.resolve(AGENT_KEY, WORKSPACE);
    expect(store.calls.profile).toBe(1);

    store.profile = profileRow({ status: "DISABLED" });
    await resolver.resolve(AGENT_KEY, WORKSPACE); // 缓存内：ops 停用一个 TTL 内生效
    clock += 30_001;
    expect(await codeOf(() => resolver.resolve(AGENT_KEY, WORKSPACE))).toBe("AGENT_DISABLED");

    store.profile = profileRow();
    await resolver.resolve(AGENT_KEY, WORKSPACE);
    resolver.invalidate(AGENT_KEY);
    await resolver.resolve(AGENT_KEY, WORKSPACE);
    expect(store.calls.profile).toBe(4);
  });

  it("keeps resolutions isolated per workspace", async () => {
    const store = new FakeStore();
    const resolver = createDbAgentResolver(store, { ttlMs: 30_000 });

    await resolver.resolve(AGENT_KEY, WORKSPACE);
    await resolver.resolve(AGENT_KEY, "44444444-4444-4444-8444-444444444444");
    expect(store.calls.profile).toBe(2);
  });

  it("normalizes a missing or malformed loop policy to one round", async () => {
    const store = new FakeStore();
    store.profile = profileRow({ loopPolicy: { maxRounds: "many" } });
    const resolver = createDbAgentResolver(store, { ttlMs: 0 });

    const agent = await resolver.resolve(AGENT_KEY, WORKSPACE);
    expect(agent.loopPolicy.maxRounds).toBe(1);
  });
});
