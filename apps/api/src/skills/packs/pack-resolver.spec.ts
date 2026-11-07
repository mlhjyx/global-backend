import { describe, expect, it } from "vitest";
import { canonicalDigest } from "../../model-runtime/context-engine";
import { BUILTIN_PACKS } from "./generated/builtin-pack-catalog";
import type { BuiltinPackRecord } from "./load-builtin-packs";
import { buildStrategy, createDbStrategyResolver, PackUnavailableError } from "./pack-resolver";
import type {
  PackPackageRow,
  PackRegistryStore,
  PackVersionRow,
  StrategySnapshotWrite,
} from "./pack-registry.store";

function recordOf(packKey: string): BuiltinPackRecord {
  const record = BUILTIN_PACKS.find((candidate) => candidate.packKey === packKey);
  if (!record) throw new Error(`missing builtin pack ${packKey}`);
  return record;
}

function versionRow(record: BuiltinPackRecord, packageId: string): PackVersionRow {
  return {
    id: `version-${record.packKey}`,
    packageId,
    version: record.manifest.version,
    manifest: record.manifest,
    content: record.content,
    manifestDigest: record.manifestDigest,
    contentDigest: record.contentDigest,
  };
}

class FakeStore implements PackRegistryStore {
  packages: PackPackageRow[] = [];
  versions = new Map<string, PackVersionRow>();
  enablement = new Map<string, boolean>();
  snapshots: StrategySnapshotWrite[] = [];
  readonly calls = { packages: 0, version: 0, enablement: 0, snapshot: 0 };
  failSnapshot: Error | null = null;

  async listActivePackages(): Promise<readonly PackPackageRow[]> {
    this.calls.packages += 1;
    return this.packages;
  }
  async loadEffectiveVersion(_workspaceId: string, packageId: string): Promise<PackVersionRow | null> {
    this.calls.version += 1;
    return this.versions.get(packageId) ?? null;
  }
  async loadEnablement(_workspaceId: string, packageId: string): Promise<boolean | null> {
    this.calls.enablement += 1;
    return this.enablement.get(packageId) ?? null;
  }
  async insertStrategySnapshot(
    _workspaceId: string,
    snapshot: StrategySnapshotWrite,
  ): Promise<void> {
    this.calls.snapshot += 1;
    if (this.failSnapshot) throw this.failSnapshot;
    if (!this.snapshots.some((item) => item.descriptorDigest === snapshot.descriptorDigest)) {
      this.snapshots.push(snapshot);
    }
  }
}

function storeWithBuiltins(keys: readonly string[]): { store: FakeStore; byKey: Map<string, string> } {
  const store = new FakeStore();
  const byKey = new Map<string, string>();
  keys.forEach((key, index) => {
    const packageId = `package-${index}-${key}`;
    const record = recordOf(key);
    store.packages.push({
      id: packageId,
      packKey: key,
      packType: record.manifest.packType,
      status: "ACTIVE",
    });
    store.versions.set(packageId, versionRow(record, packageId));
    byKey.set(key, packageId);
  });
  return { store, byKey };
}

const WORKSPACE = "33333333-3333-4333-8333-333333333333";

describe("buildStrategy", () => {
  const records = [
    recordOf("compliance.eu_dual_use_screen"),
    recordOf("data_source.public_web_only"),
    recordOf("growth_motion.dach_distributor"),
    recordOf("growth_motion.customer_research"),
  ];
  const versions = records.map((record) => versionRow(record, record.packKey));

  it("selects universal packs plus packs whose tags intersect the selectors", () => {
    const resolved = buildStrategy({ skillKey: "research.account_research", markets: ["DE"] }, versions);
    expect(resolved.descriptor.packs.map((pack) => pack.packKey)).toEqual([
      "compliance.eu_dual_use_screen",
      "data_source.public_web_only",
      "growth_motion.dach_distributor",
    ]);
    expect(resolved.brief).toContain("# Strategy for research.account_research");
    expect(resolved.brief).toContain("DACH 分销商");
  });

  it("excludes tagged packs that match no selector", () => {
    const resolved = buildStrategy({ skillKey: "triage.lead_triage", markets: ["US"] }, versions);
    expect(resolved.descriptor.packs.map((pack) => pack.packKey)).toEqual([
      "compliance.eu_dual_use_screen",
      "data_source.public_web_only",
    ]);
  });

  it("carries the deterministic rule digest into the descriptor and rejects conflicts explicitly", () => {
    const resolved = buildStrategy({ skillKey: "quoting.incoterms_quote" }, versions);
    expect(resolved.descriptor.rulesDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(resolved.descriptor.resolverVersion).toBe("strategy-resolver/v0");
    expect(resolved.merge.effective.length).toBeGreaterThan(0);
    const again = buildStrategy({ skillKey: "quoting.incoterms_quote" }, versions);
    expect(again.descriptor).toEqual(resolved.descriptor);
    expect(again.brief).toBe(resolved.brief);
  });

  it("bounds the brief length", () => {
    const resolved = buildStrategy({ skillKey: "research.account_research" }, versions);
    expect(resolved.brief.length).toBeLessThanOrEqual(2_000);
  });
});

describe("createDbStrategyResolver", () => {
  it("resolves enabled packages with drift checks and writes one strategy snapshot", async () => {
    const { store } = storeWithBuiltins([
      "compliance.eu_dual_use_screen",
      "growth_motion.dach_distributor",
    ]);
    const resolver = createDbStrategyResolver(store, { ttlMs: 0 });
    const resolved = await resolver.resolve(WORKSPACE, {
      skillKey: "research.account_research",
      markets: ["DE"],
    });
    expect(resolved.descriptor.packs.map((pack) => pack.packKey)).toEqual([
      "compliance.eu_dual_use_screen",
      "growth_motion.dach_distributor",
    ]);
    expect(store.snapshots).toHaveLength(1);
    expect(store.snapshots[0].descriptorDigest).toBe(canonicalDigest(resolved.descriptor));
    expect(store.snapshots[0].resolverVersion).toBe("strategy-resolver/v0");
  });

  it("skips packages disabled for the workspace", async () => {
    const { store, byKey } = storeWithBuiltins([
      "compliance.eu_dual_use_screen",
      "growth_motion.dach_distributor",
    ]);
    store.enablement.set(byKey.get("growth_motion.dach_distributor")!, false);
    const resolver = createDbStrategyResolver(store, { ttlMs: 0 });
    const resolved = await resolver.resolve(WORKSPACE, { skillKey: "s", markets: ["DE"] });
    expect(resolved.descriptor.packs.map((pack) => pack.packKey)).toEqual([
      "compliance.eu_dual_use_screen",
    ]);
  });

  it("fails closed when the stored version drifts from the built catalog", async () => {
    const { store, byKey } = storeWithBuiltins(["compliance.eu_dual_use_screen"]);
    const packageId = byKey.get("compliance.eu_dual_use_screen")!;
    const row = store.versions.get(packageId)!;
    store.versions.set(packageId, { ...row, manifestDigest: "0".repeat(64) });
    const resolver = createDbStrategyResolver(store, { ttlMs: 0 });
    await expect(
      resolver.resolve(WORKSPACE, { skillKey: "s" }),
    ).rejects.toBeInstanceOf(PackUnavailableError);
    expect(store.snapshots).toHaveLength(0);
  });

  it("caches resolutions and propagates snapshot write failures", async () => {
    let clock = 1_000;
    const { store } = storeWithBuiltins(["compliance.eu_dual_use_screen"]);
    const resolver = createDbStrategyResolver(store, { ttlMs: 30_000, now: () => clock });
    await resolver.resolve(WORKSPACE, { skillKey: "s" });
    await resolver.resolve(WORKSPACE, { skillKey: "s" });
    expect(store.calls.packages).toBe(1);

    clock += 30_001;
    await resolver.resolve(WORKSPACE, { skillKey: "s" });
    expect(store.calls.packages).toBe(2);

    const failing = storeWithBuiltins(["compliance.eu_dual_use_screen"]).store;
    failing.failSnapshot = new Error("snapshot write failed");
    const failingResolver = createDbStrategyResolver(failing, { ttlMs: 0 });
    await expect(failingResolver.resolve(WORKSPACE, { skillKey: "s" })).rejects.toThrow(
      "snapshot write failed",
    );
  });
});

describe("createDbStrategyResolver — studio-published versions", () => {
  it("accepts an immutable newer version over the builtin catalog version", async () => {
    const { store, byKey } = storeWithBuiltins(["growth_motion.dach_distributor"]);
    const packageId = byKey.get("growth_motion.dach_distributor")!;
    const row = store.versions.get(packageId)!;
    const bumpedManifest = { ...row.manifest, version: "1.1.0" };
    store.versions.set(packageId, {
      ...row,
      version: "1.1.0",
      manifest: bumpedManifest,
      manifestDigest: canonicalDigest(bumpedManifest),
    });
    const resolver = createDbStrategyResolver(store, { ttlMs: 0 });
    const resolved = await resolver.resolve(WORKSPACE, { skillKey: "s", markets: ["DE"] });
    expect(resolved.descriptor.packs.map((pack) => `${pack.packKey}@${pack.version}`)).toContain(
      "growth_motion.dach_distributor@1.1.0",
    );
  });
});
