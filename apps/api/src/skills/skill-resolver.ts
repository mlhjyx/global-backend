import { canonicalDigest } from "../model-runtime/context-engine";
import { BUILTIN_SKILLS } from "./generated/builtin-skill-catalog";
import type { SkillRegistryStore } from "./skill-registry.store";
import {
  descriptorFromManifest,
  SkillUnavailableError,
  type ResolvedSkillDescriptor,
  type SkillResolutionHints,
  type SkillResolver,
} from "./skill-runtime";

/**
 * DB 驱动的解析器（生产）。语义（设计 §5.5）：
 *   1. 平台目录行不存在            → SKILL_NOT_REGISTERED
 *   2. status=DISABLED             → SKILL_PLATFORM_DISABLED
 *   3. 无版本行                    → SKILL_VERSION_MISSING
 *   4. workspace 覆盖 enabled=false → SKILL_WORKSPACE_DISABLED
 *   5. 本构建无对应代码绑定         → SKILL_BINDING_UNAVAILABLE
 *   6. DB 版本与当前构建目录不一致   → SKILL_CONTRACT_DRIFT（fail-closed）
 * 解析成功即写不可变快照（内容寻址、ON CONFLICT DO NOTHING）。
 * 解析结果按 (workspace, skillKey, effectiveModel) 缓存 `ttlMs`（默认 30s）：
 * ops 启停在新解析时立即生效，worker 内最迟一个 TTL。
 */

export interface DbSkillResolver extends SkillResolver {
  readonly kind: "db";
  invalidate(skillKey?: string): void;
}

export interface DbSkillResolverOptions {
  readonly ttlMs?: number;
  readonly now?: () => number;
}

export function createDbSkillResolver(
  store: SkillRegistryStore,
  options: DbSkillResolverOptions = {},
): DbSkillResolver {
  const ttlMs = options.ttlMs ?? 30_000;
  const now = options.now ?? Date.now;
  const cache = new Map<string, { expiresAt: number; descriptor: ResolvedSkillDescriptor }>();

  const cacheKey = (workspaceId: string, skillKey: string, model: string | undefined): string =>
    `${workspaceId}\u0000${skillKey}\u0000${model ?? ""}`;

  async function resolve(
    skillKey: string,
    workspaceId: string,
    hints?: SkillResolutionHints,
  ): Promise<ResolvedSkillDescriptor> {
    const key = cacheKey(workspaceId, skillKey, hints?.effectiveModel);
    const cached = cache.get(key);
    if (cached && cached.expiresAt > now()) return cached.descriptor;

    const pkg = await store.loadPlatformPackage(workspaceId, skillKey);
    if (!pkg) {
      throw new SkillUnavailableError("SKILL_NOT_REGISTERED", `${skillKey} is not registered`);
    }
    if (pkg.status !== "ACTIVE") {
      throw new SkillUnavailableError("SKILL_PLATFORM_DISABLED", `${skillKey} is disabled for the platform`);
    }
    const version = await store.loadCurrentVersion(workspaceId, pkg.id);
    if (!version) {
      throw new SkillUnavailableError("SKILL_VERSION_MISSING", `${skillKey} has no registered version`);
    }
    const enabled = await store.loadEnablement(workspaceId, pkg.id);
    if (enabled === false) {
      throw new SkillUnavailableError("SKILL_WORKSPACE_DISABLED", `${skillKey} is disabled for this workspace`);
    }

    const builtin = BUILTIN_SKILLS.find((record) => record.skillKey === skillKey);
    if (!builtin) {
      throw new SkillUnavailableError(
        "SKILL_BINDING_UNAVAILABLE",
        `${skillKey} is registered but this build has no code binding for it`,
      );
    }
    const manifest = builtin.manifest;
    const manifestDigest = canonicalDigest(manifest);
    if (
      version.manifestDigest !== manifestDigest ||
      version.taskContractId !== manifest.platform.taskContractId ||
      version.taskContractDigest !== manifest.platform.taskContractDigest ||
      pkg.packType !== manifest.platform.packType
    ) {
      throw new SkillUnavailableError(
        "SKILL_CONTRACT_DRIFT",
        `${skillKey}@${version.version} does not match the contracted skill manifest of this build`,
      );
    }

    const descriptor = descriptorFromManifest(manifest, hints?.effectiveModel);
    const descriptorDigest = canonicalDigest(descriptor);
    await store.insertSnapshot(workspaceId, {
      skillKey,
      packageId: pkg.id,
      versionId: version.id,
      descriptor,
      descriptorDigest,
    });
    cache.set(key, { expiresAt: now() + ttlMs, descriptor });
    return descriptor;
  }

  return {
    kind: "db",
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
