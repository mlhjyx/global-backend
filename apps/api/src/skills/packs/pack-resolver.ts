import { canonicalDigest } from "../../model-runtime/context-engine";
import { BUILTIN_PACKS } from "./generated/builtin-pack-catalog";
import { mergeComplianceRules, type ComplianceMergeResult } from "./pack-merge";
import type { PackRegistryStore, PackVersionRow } from "./pack-registry.store";
import {
  packMatchesSelectors,
  renderStrategyBrief,
  strategyRulesDigest,
  type StrategyContentBlock,
  type StrategyContextSelectors,
} from "./strategy-brief";

/**
 * 策略解析 v1（设计 §5.4）：为某技能在给定选择器下选出生效 Pack、裁决冲突、
 * 渲染确定性策略简报，并写不可变策略快照。
 *
 * fail-closed：DB 中生效版本的摘要与当前构建的内置目录不一致（或包键错位）时
 * 抛 `PACK_VERSION_DRIFT`；快照写失败向上抛出（审计不断档）。解析结果按
 * (workspace, skillKey, selectors) 缓存 `ttlMs`（默认 30s）。
 */

export const STRATEGY_RESOLVER_VERSION = "strategy-resolver/v0";

export type PackUnavailableReason = "PACK_VERSION_DRIFT";

export class PackUnavailableError extends Error {
  constructor(
    readonly reason: PackUnavailableReason,
    detail: string,
  ) {
    super(`${reason}: ${detail}`);
    this.name = "PackUnavailableError";
  }
}

export interface StrategyPackRef {
  readonly packKey: string;
  readonly packType: string;
  readonly version: string;
  readonly manifestDigest: string;
  readonly contentDigest: string;
}

export interface StrategyDescriptor {
  readonly skillKey: string;
  readonly packs: readonly StrategyPackRef[];
  readonly selectors: {
    readonly industries: readonly string[];
    readonly markets: readonly string[];
    readonly motions: readonly string[];
  };
  readonly rulesDigest: string;
  readonly resolverVersion: string;
}

export interface ResolvedStrategy {
  readonly descriptor: StrategyDescriptor;
  readonly brief: string;
  readonly contents: readonly StrategyContentBlock[];
  readonly merge: ComplianceMergeResult;
}

export interface StrategyResolutionContext extends StrategyContextSelectors {
  readonly skillKey: string;
}

function normalizeSelectors(
  selectors: StrategyContextSelectors,
): StrategyDescriptor["selectors"] {
  return {
    industries: [...(selectors.industries ?? [])].sort(),
    markets: [...(selectors.markets ?? [])].sort(),
    motions: [...(selectors.motions ?? [])].sort(),
  };
}

export function buildStrategy(
  context: StrategyResolutionContext,
  versions: readonly PackVersionRow[],
): ResolvedStrategy {
  const selectors = normalizeSelectors(context);
  const selected = versions.filter((version) => packMatchesSelectors(version.manifest, selectors));
  const merge = mergeComplianceRules(selected.map((version) => version.manifest));
  const contents: StrategyContentBlock[] = selected.map((version) => ({
    packKey: version.manifest.packKey,
    packType: version.manifest.packType,
    version: version.version,
    contentDigest: version.contentDigest,
    content: version.content,
  }));
  const rulesDigest = strategyRulesDigest({
    effective: merge.effective,
    rejected: merge.rejected,
    contents,
  });
  const descriptor: StrategyDescriptor = {
    skillKey: context.skillKey,
    packs: selected.map((version) => ({
      packKey: version.manifest.packKey,
      packType: version.manifest.packType,
      version: version.version,
      manifestDigest: version.manifestDigest,
      contentDigest: version.contentDigest,
    })),
    selectors,
    rulesDigest,
    resolverVersion: STRATEGY_RESOLVER_VERSION,
  };
  return {
    descriptor,
    brief: renderStrategyBrief({
      skillKey: context.skillKey,
      selectors,
      merge,
      contents,
    }),
    contents,
    merge,
  };
}

export interface DbStrategyResolver {
  resolve(workspaceId: string, context: StrategyResolutionContext): Promise<ResolvedStrategy>;
  invalidate(skillKey?: string): void;
}

export interface DbStrategyResolverOptions {
  readonly ttlMs?: number;
  readonly now?: () => number;
}

function driftCheck(version: PackVersionRow, packKey: string): void {
  if (version.manifest.packKey !== packKey) {
    throw new PackUnavailableError(
      "PACK_VERSION_DRIFT",
      `package ${packKey} activated a version for ${version.manifest.packKey}`,
    );
  }
  const builtin = BUILTIN_PACKS.find((record) => record.packKey === packKey);
  // 内置目录只钉住它自己的版本（seed 行必须与构建一致）；Studio 发布的新版本
  // 由不可变版本行与发布门自证，不参与内置摘要比对。
  if (!builtin || version.version !== builtin.manifest.version) return;
  if (
    version.manifestDigest !== builtin.manifestDigest ||
    version.contentDigest !== builtin.contentDigest ||
    version.manifest.packType !== builtin.manifest.packType
  ) {
    throw new PackUnavailableError(
      "PACK_VERSION_DRIFT",
      `${packKey}@${version.version} does not match the built pack catalog`,
    );
  }
}

export function createDbStrategyResolver(
  store: PackRegistryStore,
  options: DbStrategyResolverOptions = {},
): DbStrategyResolver {
  const ttlMs = options.ttlMs ?? 30_000;
  const now = options.now ?? Date.now;
  const cache = new Map<string, { expiresAt: number; resolved: ResolvedStrategy }>();

  const cacheKey = (workspaceId: string, context: StrategyResolutionContext): string =>
    `${workspaceId}\u0000${context.skillKey}\u0000${canonicalDigest(normalizeSelectors(context))}`;

  async function resolve(
    workspaceId: string,
    context: StrategyResolutionContext,
  ): Promise<ResolvedStrategy> {
    const key = cacheKey(workspaceId, context);
    const cached = cache.get(key);
    if (cached && cached.expiresAt > now()) return cached.resolved;

    const packages = await store.listActivePackages(workspaceId);
    const versions: PackVersionRow[] = [];
    for (const pkg of packages) {
      const enabled = await store.loadEnablement(workspaceId, pkg.id);
      if (enabled === false) continue;
      const version = await store.loadEffectiveVersion(workspaceId, pkg.id);
      if (!version) continue;
      driftCheck(version, pkg.packKey);
      versions.push(version);
    }

    const resolved = buildStrategy(context, versions);
    await store.insertStrategySnapshot(workspaceId, {
      skillKey: context.skillKey,
      descriptor: resolved.descriptor,
      descriptorDigest: canonicalDigest(resolved.descriptor),
      resolverVersion: STRATEGY_RESOLVER_VERSION,
    });
    cache.set(key, { expiresAt: now() + ttlMs, resolved });
    return resolved;
  }

  return {
    resolve,
    invalidate(skillKey?: string): void {
      if (skillKey === undefined) {
        cache.clear();
        return;
      }
      for (const key of cache.keys()) {
        if (key.split("\u0000")[1] === skillKey) cache.delete(key);
      }
    },
  };
}
