import { describe, expect, it } from "vitest";
import { canonicalDigest } from "../model-runtime/context-engine";
import { BUILTIN_SKILLS } from "./generated/builtin-skill-catalog";
import { createDbSkillResolver } from "./skill-resolver";
import { canonicalDigest as digestOf } from "../model-runtime/context-engine";
import type {
  SkillPackageRow,
  SkillRegistryStore,
  SkillSnapshotWrite,
  SkillVersionRow,
} from "./skill-registry.store";
import { SkillUnavailableError, StaticSkillResolver } from "./skill-runtime";

const RECORD = BUILTIN_SKILLS.find((record) => record.skillKey === "discovery.qualify_fit")!;
const MANIFEST = RECORD.manifest;

function packageRow(overrides: Partial<SkillPackageRow> = {}): SkillPackageRow {
  return { id: "11111111-1111-4111-8111-111111111111", status: "ACTIVE", packType: "growth_motion", ...overrides };
}

function versionRow(overrides: Partial<SkillVersionRow> = {}): SkillVersionRow {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    version: MANIFEST.platform.version,
    manifest: MANIFEST,
    manifestDigest: canonicalDigest(MANIFEST),
    taskContractId: MANIFEST.platform.taskContractId,
    taskContractDigest: MANIFEST.platform.taskContractDigest,
    ...overrides,
  };
}

class FakeStore implements SkillRegistryStore {
  pkg: SkillPackageRow | null = packageRow();
  version: SkillVersionRow | null = versionRow();
  enabled: boolean | null = null;
  snapshots: SkillSnapshotWrite[] = [];
  failSnapshot: Error | null = null;
  readonly calls = { package: 0, version: 0, enablement: 0, snapshot: 0 };

  async loadPlatformPackage(): Promise<SkillPackageRow | null> {
    this.calls.package += 1;
    return this.pkg;
  }

  async loadCurrentVersion(): Promise<SkillVersionRow | null> {
    this.calls.version += 1;
    return this.version;
  }

  async loadEnablement(): Promise<boolean | null> {
    this.calls.enablement += 1;
    return this.enabled;
  }

  async insertSnapshot(_workspaceId: string, snapshot: SkillSnapshotWrite): Promise<void> {
    this.calls.snapshot += 1;
    if (this.failSnapshot) throw this.failSnapshot;
    if (!this.snapshots.some((item) => item.descriptorDigest === snapshot.descriptorDigest)) {
      this.snapshots.push(snapshot);
    }
  }
}

const WORKSPACE = "33333333-3333-4333-8333-333333333333";

async function reasonOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    if (error instanceof SkillUnavailableError) return error.reason;
    throw error;
  }
  throw new Error("expected SkillUnavailableError");
}

describe("createDbSkillResolver", () => {
  it("resolves the seeded skill and writes an immutable snapshot descriptor", async () => {
    const store = new FakeStore();
    const resolver = createDbSkillResolver(store, { ttlMs: 0 });
    const descriptor = await resolver.resolve("discovery.qualify_fit", WORKSPACE, {
      effectiveModel: "deepseek-v4-pro",
    });

    expect(descriptor.skillKey).toBe("discovery.qualify_fit");
    expect(descriptor.taskContractId).toBe("discovery.qualify_fit");
    expect(descriptor.effectiveModel).toBe("deepseek-v4-pro");
    expect(descriptor.resolverVersion).toBe("skill-resolver/v0");
    expect(store.snapshots).toHaveLength(1);
    expect(store.snapshots[0].descriptorDigest).toBe(canonicalDigest(descriptor));
  });

  it("fails closed when the skill is not registered", async () => {
    const store = new FakeStore();
    store.pkg = null;
    const resolver = createDbSkillResolver(store, { ttlMs: 0 });
    expect(await reasonOf(() => resolver.resolve("discovery.qualify_fit", WORKSPACE))).toBe(
      "SKILL_NOT_REGISTERED",
    );
    expect(store.calls.snapshot).toBe(0);
  });

  it("fails closed when the platform kill switch is on", async () => {
    const store = new FakeStore();
    store.pkg = packageRow({ status: "DISABLED" });
    const resolver = createDbSkillResolver(store, { ttlMs: 0 });
    expect(await reasonOf(() => resolver.resolve("discovery.qualify_fit", WORKSPACE))).toBe(
      "SKILL_PLATFORM_DISABLED",
    );
  });

  it("fails closed when no version is registered", async () => {
    const store = new FakeStore();
    store.version = null;
    const resolver = createDbSkillResolver(store, { ttlMs: 0 });
    expect(await reasonOf(() => resolver.resolve("discovery.qualify_fit", WORKSPACE))).toBe(
      "SKILL_VERSION_MISSING",
    );
  });

  it("honours workspace enablement overrides and defaults to enabled without a row", async () => {
    const disabled = new FakeStore();
    disabled.enabled = false;
    const resolver = createDbSkillResolver(disabled, { ttlMs: 0 });
    expect(await reasonOf(() => resolver.resolve("discovery.qualify_fit", WORKSPACE))).toBe(
      "SKILL_WORKSPACE_DISABLED",
    );

    const followDefault = new FakeStore();
    const defaultResolver = createDbSkillResolver(followDefault, { ttlMs: 0 });
    await expect(defaultResolver.resolve("discovery.qualify_fit", WORKSPACE)).resolves.toBeTruthy();
  });

  it("fails closed when this build has no code binding for a registered skill", async () => {
    const store = new FakeStore();
    const resolver = createDbSkillResolver(store, { ttlMs: 0 });
    expect(await reasonOf(() => resolver.resolve("tenant.custom_skill", WORKSPACE))).toBe(
      "SKILL_BINDING_UNAVAILABLE",
    );
  });

  it("fails closed when the seeded version drifts from the built catalog", async () => {
    const store = new FakeStore();
    store.version = versionRow({ manifestDigest: "0".repeat(64) });
    const resolver = createDbSkillResolver(store, { ttlMs: 0 });
    expect(await reasonOf(() => resolver.resolve("discovery.qualify_fit", WORKSPACE))).toBe(
      "SKILL_CONTRACT_DRIFT",
    );

    const taskDrift = new FakeStore();
    taskDrift.version = versionRow({ taskContractDigest: "f".repeat(64) });
    const taskResolver = createDbSkillResolver(taskDrift, { ttlMs: 0 });
    expect(await reasonOf(() => taskResolver.resolve("discovery.qualify_fit", WORKSPACE))).toBe(
      "SKILL_CONTRACT_DRIFT",
    );
  });

  it("caches resolutions per workspace/skill/model until the TTL expires or invalidation", async () => {
    let clock = 1_000;
    const store = new FakeStore();
    const resolver = createDbSkillResolver(store, { ttlMs: 30_000, now: () => clock });

    await resolver.resolve("discovery.qualify_fit", WORKSPACE, { effectiveModel: "m1" });
    await resolver.resolve("discovery.qualify_fit", WORKSPACE, { effectiveModel: "m1" });
    expect(store.calls.package).toBe(1);

    await resolver.resolve("discovery.qualify_fit", WORKSPACE, { effectiveModel: "m2" });
    expect(store.calls.package).toBe(2);

    clock += 30_001;
    await resolver.resolve("discovery.qualify_fit", WORKSPACE, { effectiveModel: "m1" });
    expect(store.calls.package).toBe(3);

    resolver.invalidate("discovery.qualify_fit");
    await resolver.resolve("discovery.qualify_fit", WORKSPACE, { effectiveModel: "m1" });
    expect(store.calls.package).toBe(4);
  });

  it("propagates snapshot write failures (audit stays fail-closed)", async () => {
    const store = new FakeStore();
    store.failSnapshot = new Error("snapshot write failed");
    const resolver = createDbSkillResolver(store, { ttlMs: 0 });
    await expect(resolver.resolve("discovery.qualify_fit", WORKSPACE)).rejects.toThrow(
      "snapshot write failed",
    );
  });
});

describe("StaticSkillResolver", () => {
  it("resolves every enabled builtin skill without touching a store", async () => {
    const resolver = new StaticSkillResolver();
    for (const record of BUILTIN_SKILLS) {
      if (record.manifest.platform.tenantDefault === "disabled") continue;
      const descriptor = await resolver.resolve(record.skillKey, WORKSPACE, { effectiveModel: "m" });
      expect(descriptor.taskContractId).toBe(record.manifest.platform.taskContractId);
      expect(descriptor.effectiveModel).toBe("m");
    }
  });

  it("refuses tenant-default disabled skills (no per-tenant enablement without a store)", async () => {
    const resolver = new StaticSkillResolver();
    expect(await reasonOf(() => resolver.resolve("research.account_research", WORKSPACE))).toBe(
      "SKILL_TENANT_NOT_ENABLED",
    );
  });

  it("rejects unknown skill keys", async () => {
    const resolver = new StaticSkillResolver();
    expect(await reasonOf(() => resolver.resolve("nope", WORKSPACE))).toBe("SKILL_NOT_REGISTERED");
  });
});

describe("createDbSkillResolver — tenant-default disabled skills", () => {
  const RECORD = BUILTIN_SKILLS.find((record) => record.skillKey === "discovery.qualify_fit")!;
  const disabledManifest = {
    ...RECORD.manifest,
    platform: { ...RECORD.manifest.platform, tenantDefault: "disabled" as const },
  };
  const disabledRecord = { ...RECORD, manifest: disabledManifest };

  function storeWith(): FakeStore {
    const store = new FakeStore();
    store.version = {
      id: "22222222-2222-4222-8222-222222222222",
      version: disabledManifest.platform.version,
      manifest: disabledManifest,
      manifestDigest: digestOf(disabledManifest),
      taskContractId: disabledManifest.platform.taskContractId ?? null,
      taskContractDigest: disabledManifest.platform.taskContractDigest ?? null,
      serviceHandler: null,
    };
    return store;
  }

  it("requires an explicit workspace opt-in when the tenant default is disabled", async () => {
    const store = storeWith();
    const resolver = createDbSkillResolver(store, { ttlMs: 0, records: [disabledRecord] });
    expect(await reasonOf(() => resolver.resolve("discovery.qualify_fit", WORKSPACE))).toBe(
      "SKILL_TENANT_NOT_ENABLED",
    );
    expect(store.calls.snapshot).toBe(0);
  });

  it("lets an explicit enablement override opt the workspace in", async () => {
    const store = storeWith();
    store.enabled = true;
    const resolver = createDbSkillResolver(store, { ttlMs: 0, records: [disabledRecord] });
    const descriptor = await resolver.resolve("discovery.qualify_fit", WORKSPACE);
    expect(descriptor.tenantDefault).toBe("disabled");
    expect(descriptor.skillKind).toBe("model_task");
  });

  it("keeps explicit disablement authoritative", async () => {
    const store = storeWith();
    store.enabled = false;
    const resolver = createDbSkillResolver(store, { ttlMs: 0, records: [disabledRecord] });
    expect(await reasonOf(() => resolver.resolve("discovery.qualify_fit", WORKSPACE))).toBe(
      "SKILL_WORKSPACE_DISABLED",
    );
  });
});

describe("createDbSkillResolver — imported skills ship tenant-default disabled", () => {
  const IMPORTED = BUILTIN_SKILLS.find(
    (record) => record.skillKey === "research.account_research",
  )!;

  function importedStore(): FakeStore {
    const store = new FakeStore();
    store.pkg = packageRow({ packType: IMPORTED.manifest.platform.packType });
    store.version = versionRow({
      version: IMPORTED.manifest.platform.version,
      manifest: IMPORTED.manifest,
      manifestDigest: digestOf(IMPORTED.manifest),
      taskContractId: IMPORTED.manifest.platform.taskContractId ?? null,
      taskContractDigest: IMPORTED.manifest.platform.taskContractDigest ?? null,
      serviceHandler: null,
    });
    return store;
  }

  it("blocks resolution until the workspace opts in, then resolves with the imported descriptor", async () => {
    const store = importedStore();
    const resolver = createDbSkillResolver(store, { ttlMs: 0, records: [IMPORTED] });
    expect(await reasonOf(() => resolver.resolve("research.account_research", WORKSPACE))).toBe(
      "SKILL_TENANT_NOT_ENABLED",
    );
    store.enabled = true;
    const descriptor = await resolver.resolve("research.account_research", WORKSPACE);
    expect(descriptor.skillKey).toBe("research.account_research");
    expect(descriptor.taskContractId).toBe("research.account_research");
    expect(descriptor.allowedTools).toEqual(["crawl4ai.fetch", "searxng.search"]);
  });
});

describe("createDbSkillResolver — service skills", () => {
  const SERVICE = BUILTIN_SKILLS.find(
    (record) => record.skillKey === "quoting.incoterms_quote",
  )!;

  function serviceStore(handler: string | null): FakeStore {
    const store = new FakeStore();
    store.pkg = packageRow({ packType: SERVICE.manifest.platform.packType });
    store.version = versionRow({
      version: SERVICE.manifest.platform.version,
      manifest: SERVICE.manifest,
      manifestDigest: digestOf(SERVICE.manifest),
      taskContractId: null,
      taskContractDigest: null,
      serviceHandler: handler,
    });
    return store;
  }

  it("resolves with the handler binding and no task contract", async () => {
    const store = serviceStore("quoting.incoterms.v1");
    const resolver = createDbSkillResolver(store, { ttlMs: 0, records: [SERVICE] });
    const descriptor = await resolver.resolve("quoting.incoterms_quote", WORKSPACE);
    expect(descriptor.skillKind).toBe("service");
    expect(descriptor.serviceHandler).toBe("quoting.incoterms.v1");
    expect(descriptor.taskContractId).toBeUndefined();
    expect(descriptor.humanGate).toBe(true);
  });

  it("fails closed when the registered handler no longer matches the build", async () => {
    const store = serviceStore("sanctions.screen.v1");
    const resolver = createDbSkillResolver(store, { ttlMs: 0, records: [SERVICE] });
    expect(await reasonOf(() => resolver.resolve("quoting.incoterms_quote", WORKSPACE))).toBe(
      "SKILL_CONTRACT_DRIFT",
    );
  });
});
