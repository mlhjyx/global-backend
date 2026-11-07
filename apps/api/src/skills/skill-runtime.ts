import type { AiContext, GenerateStructuredInput } from "../model-gateway/types";
import type { ModelGateway } from "../model-gateway/model-gateway";
import { canonicalDigest } from "../model-runtime/context-engine";
import {
  executeStructuredTaskWithRuntime,
  type RuntimeStructuredModelResult,
  type StructuredTaskRuntimeOptions,
} from "../model-runtime/structured-task-runtime-bridge";
import { BUILTIN_SKILLS } from "./generated/builtin-skill-catalog";
import type { BuiltinSkillRecord } from "./load-builtin-skills";
import type { SkillManifest } from "./skill-manifest";

/**
 * S0 技能运行时 v0：resolver 抽象 + 直通 adapter。
 *
 * 设计（docs/superpowers/plans/2026-11-08-skill-runtime-s0.md）要求零行为变化：
 * adapter 只做「解析 → 绑定校验 → 原样转发 `executeStructuredTaskWithRuntime`」，
 * 不改变任何 prompt/schema/model/预算/收据。解析失败（未登记/停用/漂移）时
 * fail-closed，抛 `SkillUnavailableError`（非重试）。
 */

export const SKILL_RESOLVER_VERSION = "skill-resolver/v0";

export type SkillUnavailableReason =
  | "SKILL_NOT_REGISTERED"
  | "SKILL_PLATFORM_DISABLED"
  | "SKILL_WORKSPACE_DISABLED"
  | "SKILL_VERSION_MISSING"
  | "SKILL_TENANT_NOT_ENABLED"
  | "SKILL_CONTRACT_DRIFT"
  | "SKILL_BINDING_UNAVAILABLE"
  | "SKILL_BINDING_MISMATCH";

export class SkillUnavailableError extends Error {
  constructor(
    readonly reason: SkillUnavailableReason,
    detail: string,
  ) {
    super(`${reason}: ${detail}`);
    this.name = "SkillUnavailableError";
  }
}

/** 解析结果的不可变描述子；内容寻址后写入 `skill_resolution_snapshot`。 */
export interface ResolvedSkillDescriptor {
  readonly skillKey: string;
  readonly version: string;
  readonly packType: string;
  readonly skillKind: "model_task" | "service";
  readonly tenantDefault: "enabled" | "disabled";
  readonly taskContractId?: string;
  readonly taskContractDigest?: string;
  readonly serviceHandler?: string;
  readonly manifestDigest: string;
  readonly modelPolicy: "contract-default";
  readonly effectiveModel?: string;
  readonly allowedTools: readonly string[];
  readonly maxCostCents: number | null;
  readonly risk?: "low" | "medium" | "high";
  readonly humanGate?: boolean;
  readonly resolverVersion: string;
}

export interface SkillResolutionHints {
  /** 调用点按 task 契约解析出的实际模型名；只用于审计快照，不影响执行。 */
  readonly effectiveModel?: string;
}

export interface SkillResolver {
  readonly kind: "static" | "db";
  resolve(
    skillKey: string,
    workspaceId: string,
    hints?: SkillResolutionHints,
  ): Promise<ResolvedSkillDescriptor>;
}

export function descriptorFromManifest(
  manifest: SkillManifest,
  effectiveModel?: string,
): ResolvedSkillDescriptor {
  return {
    skillKey: manifest.platform.skillKey,
    version: manifest.platform.version,
    packType: manifest.platform.packType,
    skillKind: manifest.platform.skillKind ?? "model_task",
    tenantDefault: manifest.platform.tenantDefault ?? "enabled",
    ...(manifest.platform.taskContractId
      ? {
          taskContractId: manifest.platform.taskContractId,
          taskContractDigest: manifest.platform.taskContractDigest,
        }
      : {}),
    ...(manifest.platform.serviceHandler
      ? { serviceHandler: manifest.platform.serviceHandler }
      : {}),
    manifestDigest: canonicalDigest(manifest),
    modelPolicy: "contract-default",
    ...(effectiveModel ? { effectiveModel } : {}),
    allowedTools: manifest.allowedTools,
    maxCostCents: manifest.platform.budgetCents ?? null,
    ...(manifest.platform.risk ? { risk: manifest.platform.risk } : {}),
    ...(manifest.platform.humanGate !== undefined ? { humanGate: manifest.platform.humanGate } : {}),
    resolverVersion: SKILL_RESOLVER_VERSION,
  };
}

/**
 * 测试与未接线上下文的缺省解析器：只查编译进二进制的内置目录，不读 DB、不写快照。
 * 生产 worker 必须注入 DB resolver（`createDbSkillResolver`），ops 启停才生效。
 */
export class StaticSkillResolver implements SkillResolver {
  readonly kind = "static" as const;

  constructor(private readonly records: readonly BuiltinSkillRecord[] = BUILTIN_SKILLS) {}

  async resolve(
    skillKey: string,
    _workspaceId: string,
    hints?: SkillResolutionHints,
  ): Promise<ResolvedSkillDescriptor> {
    const record = this.records.find((candidate) => candidate.skillKey === skillKey);
    if (!record) {
      throw new SkillUnavailableError("SKILL_NOT_REGISTERED", `${skillKey} is not a builtin skill`);
    }
    return descriptorFromManifest(record.manifest, hints?.effectiveModel);
  }
}

export const STATIC_SKILL_RESOLVER: SkillResolver = new StaticSkillResolver();

/**
 * 直通 adapter：解析 + 绑定校验后，把输入逐字段原样交给既有的结构化任务桥。
 * 调用点保留自己的 `getTask('<taskId>')`（执行权威的 callsite 锚点因此不消失）。
 */
export async function executeSkillWithRuntime<Output>(
  resolver: SkillResolver,
  gateway: ModelGateway,
  skillKey: string,
  input: GenerateStructuredInput,
  context: AiContext,
  options: StructuredTaskRuntimeOptions = {},
): Promise<RuntimeStructuredModelResult<Output>> {
  const descriptor = await resolver.resolve(skillKey, context.workspaceId, {
    ...(input.model !== undefined ? { effectiveModel: input.model } : {}),
  });
  if (
    descriptor.skillKind !== "model_task" ||
    descriptor.taskContractId === undefined ||
    descriptor.taskContractId !== input.task
  ) {
    throw new SkillUnavailableError(
      "SKILL_BINDING_MISMATCH",
      `${skillKey} binds ${descriptor.taskContractId ?? descriptor.serviceHandler ?? "nothing"}, but the model call requested ${input.task}`,
    );
  }
  return executeStructuredTaskWithRuntime<Output>(gateway, input, context, options);
}
