import { createHash } from "node:crypto";
import { canonicalDigest } from "../model-runtime/context-engine";
import {
  SERVICE_SKILL_HANDLERS,
  isServiceSkillHandlerId,
} from "./service-skill-catalog";
import { parseSkillFrontmatter, SkillFrontmatterError } from "./skill-frontmatter";

/**
 * SKILL.md 包规范（标准：AAIF / agentskills.io；平台扩展在 `metadata.platform.*`）。
 * 本模块是纯函数，供生成脚本、CI 单测与 seed 共用；运行时不做 YAML 解析。
 *
 * v1.1（S1-2）：新增 `platform.skill-kind`（model_task | service）、
 * `platform.tenant-default`（enabled | disabled）与 `platform.service-handler`
 * （service 技能的闭集执行器 id）；service 技能不绑定 task contract、不声明工具。
 */

export const SKILL_PACK_TYPES = [
  "industry",
  "market",
  "growth_motion",
  "channel",
  "data_source",
  "content",
  "compliance",
  "expert_playbook",
] as const;

export type SkillPackType = (typeof SKILL_PACK_TYPES)[number];

export const SKILL_KINDS = ["model_task", "service"] as const;
export type SkillKind = (typeof SKILL_KINDS)[number];

export const SKILL_TENANT_DEFAULTS = ["enabled", "disabled"] as const;
export type SkillTenantDefault = (typeof SKILL_TENANT_DEFAULTS)[number];

export type SkillManifestIssueSeverity = "error" | "warning";

export interface SkillManifestIssue {
  readonly code: string;
  readonly severity: SkillManifestIssueSeverity;
  readonly message: string;
}

export interface SkillPlatformExtension {
  readonly skillKey: string;
  readonly version: string;
  readonly packType: SkillPackType;
  readonly skillKind: SkillKind;
  readonly tenantDefault: SkillTenantDefault;
  readonly taskContractId?: string;
  readonly taskContractDigest?: string;
  readonly serviceHandler?: string;
  readonly risk?: "low" | "medium" | "high";
  readonly humanGate?: boolean;
  readonly budgetCents?: number;
  readonly owner?: string;
}

export interface SkillManifest {
  readonly name: string;
  readonly description: string;
  readonly license: string;
  readonly compatibility?: string;
  readonly allowedTools: readonly string[];
  readonly metadata: Readonly<Record<string, string>>;
  readonly platform: SkillPlatformExtension;
}

export interface SkillArtifactInput {
  /** SKILL.md 原文。 */
  readonly raw: string;
  /** 技能目录名（标准要求等于 frontmatter `name`）。 */
  readonly directoryName: string;
  /**
   * `<pack_type>/` 目录名；`metadata.platform.pack-type` 必须与它一致。
   * 导入技能按 `<source>/<skill>/` 布局（来源溯源在目录上），不传此字段。
   */
  readonly packTypeDirectory?: string;
  /** 由 task id 解析代码内 AI Task 契约（`getTask`）；未登记返回 undefined。 */
  resolveContract: (taskId: string) => AiTaskContractLike | undefined;
}

/**
 * 本模块只需要契约的这些字段；用结构类型避免与 Nest 侧模块产生运行时依赖。
 * （`AiTaskContract` 结构上可赋值给该类型。）
 */
export interface AiTaskContractLike {
  readonly id: string;
  readonly description: string;
  readonly model: string;
  readonly outputSchema: Record<string, unknown>;
  readonly allowedTools?: readonly string[];
  readonly maxCostCents?: number;
  readonly maxOutputTokens: number;
  readonly timeoutMs?: number;
  readonly retry?: number;
  readonly concurrency?: number;
  readonly toolVersion?: string;
  readonly risk: "low" | "medium" | "high";
  readonly humanGate: boolean;
  readonly acceptsModelSubstitute?: true;
}

export interface ValidatedSkill {
  readonly manifest: SkillManifest;
  readonly body: string;
  readonly sourceDigest: string;
}

export interface SkillValidationResult {
  readonly skill?: ValidatedSkill;
  readonly issues: readonly SkillManifestIssue[];
}

const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const SKILL_KEY_PATTERN = /^[a-z0-9][a-z0-9_]*(?:\.[a-z0-9][a-z0-9_]*)+$/u;
const TOOL_ID_PATTERN = /^[a-z0-9][a-z0-9_]*(?:\.[a-z0-9][a-z0-9_]*)+$/u;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const INTEGER_PATTERN = /^\d+$/u;

const TOP_LEVEL_FIELDS = new Set([
  "name",
  "description",
  "license",
  "compatibility",
  "metadata",
  "allowed-tools",
]);

const PLATFORM_FIELDS = new Set([
  "platform.skill-key",
  "platform.version",
  "platform.pack-type",
  "platform.skill-kind",
  "platform.tenant-default",
  "platform.task-contract",
  "platform.task-contract-digest",
  "platform.service-handler",
  "platform.risk",
  "platform.human-gate",
  "platform.budget-cents",
  "platform.owner",
]);

const BASE_REQUIRED_PLATFORM_FIELDS = [
  "platform.skill-key",
  "platform.version",
  "platform.pack-type",
] as const;

const MODEL_TASK_REQUIRED_PLATFORM_FIELDS = [
  "platform.task-contract",
  "platform.task-contract-digest",
] as const;

/**
 * 钉住「技能版本 → 执行语义」的契约摘要。**不含 `model`**：模型属部署策略
 * （`MODEL_ACQUISITION_*` env 可换），实际生效值由解析快照记录（设计决策 D-h）。
 * `description` 必须纳入——理解管线把它当 system prompt 发给模型。
 */
export function computeTaskContractDigest(contract: AiTaskContractLike): string {
  return canonicalDigest({
    id: contract.id,
    description: contract.description,
    allowedTools: [...new Set(contract.allowedTools ?? [])].sort(),
    maxCostCents: contract.maxCostCents ?? null,
    maxOutputTokens: contract.maxOutputTokens,
    timeoutMs: contract.timeoutMs ?? null,
    retry: contract.retry ?? null,
    concurrency: contract.concurrency ?? null,
    toolVersion: contract.toolVersion ?? null,
    risk: contract.risk,
    humanGate: contract.humanGate,
    acceptsModelSubstitute: contract.acceptsModelSubstitute === true,
    outputSchema: contract.outputSchema,
  });
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  const a = [...new Set(left)].sort();
  const b = [...new Set(right)].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export function validateSkillArtifact(input: SkillArtifactInput): SkillValidationResult {
  const issues: SkillManifestIssue[] = [];
  const error = (code: string, message: string): void => {
    issues.push({ code, severity: "error", message });
  };
  const warning = (code: string, message: string): void => {
    issues.push({ code, severity: "warning", message });
  };

  let parsed;
  try {
    parsed = parseSkillFrontmatter(input.raw);
  } catch (cause) {
    if (cause instanceof SkillFrontmatterError) {
      error(cause.code, cause.message);
      return { issues };
    }
    throw cause;
  }
  const frontmatter = parsed.frontmatter;

  for (const key of Object.keys(frontmatter)) {
    if (!TOP_LEVEL_FIELDS.has(key)) {
      warning("SKILL_MANIFEST_UNKNOWN_FIELD", `unknown top-level field: ${key}`);
    }
  }

  const name = frontmatter["name"];
  if (typeof name !== "string" || name.length > 64 || !SKILL_NAME_PATTERN.test(name)) {
    error("SKILL_NAME_INVALID", "name must be <=64 chars of lowercase letters, digits and single hyphens");
  } else if (name !== input.directoryName) {
    error("SKILL_NAME_DIRECTORY_MISMATCH", `name "${name}" must equal its directory "${input.directoryName}"`);
  }

  const description = frontmatter["description"];
  if (typeof description !== "string" || description.length < 1 || description.length > 1_024) {
    error("SKILL_DESCRIPTION_INVALID", "description must be a 1-1024 character string");
  }

  const license = frontmatter["license"];
  if (typeof license !== "string" || license.trim() === "") {
    error("SKILL_LICENSE_MISSING", "license is required by platform policy");
  }

  const compatibility = frontmatter["compatibility"];
  if (
    compatibility !== undefined &&
    (typeof compatibility !== "string" || compatibility.length < 1 || compatibility.length > 500)
  ) {
    error("SKILL_COMPATIBILITY_INVALID", "compatibility must be a 1-500 character string");
  }

  const rawMetadata = frontmatter["metadata"] ?? {};
  const metadata: Record<string, string> = {};
  let metadataValid = typeof rawMetadata === "object" && rawMetadata !== null && !Array.isArray(rawMetadata);
  if (!metadataValid) {
    error("SKILL_METADATA_INVALID", "metadata must be a string-to-string map");
  } else {
    for (const [key, value] of Object.entries(rawMetadata as Record<string, unknown>)) {
      if (typeof value !== "string") {
        error("SKILL_METADATA_INVALID", `metadata value for ${key} must be a string`);
        metadataValid = false;
      } else {
        metadata[key] = value;
      }
    }
  }

  for (const key of Object.keys(metadata)) {
    if (key.startsWith("platform.") && !PLATFORM_FIELDS.has(key)) {
      warning("SKILL_PLATFORM_UNKNOWN_FIELD", `unknown platform metadata field: ${key}`);
    }
  }

  const skillKindRaw = metadata["platform.skill-kind"];
  const skillKind: SkillKind = skillKindRaw === "service" ? "service" : "model_task";
  if (skillKindRaw !== undefined && !SKILL_KINDS.includes(skillKindRaw as SkillKind)) {
    error("SKILL_PLATFORM_VALUE_INVALID", "platform.skill-kind must be model_task or service");
  }
  const tenantDefaultRaw = metadata["platform.tenant-default"];
  const tenantDefault: SkillTenantDefault = tenantDefaultRaw === "disabled" ? "disabled" : "enabled";
  if (
    tenantDefaultRaw !== undefined &&
    !SKILL_TENANT_DEFAULTS.includes(tenantDefaultRaw as SkillTenantDefault)
  ) {
    error("SKILL_PLATFORM_VALUE_INVALID", "platform.tenant-default must be enabled or disabled");
  }

  const missingPlatform = [
    ...BASE_REQUIRED_PLATFORM_FIELDS.filter((key) => metadata[key] === undefined),
    ...(skillKind === "model_task"
      ? MODEL_TASK_REQUIRED_PLATFORM_FIELDS.filter((key) => metadata[key] === undefined)
      : []),
  ];
  if (skillKind === "service" && metadata["platform.service-handler"] === undefined) {
    error("SKILL_SERVICE_HANDLER_INVALID", "service skills must declare platform.service-handler");
  }
  if (missingPlatform.length > 0) {
    error("SKILL_PLATFORM_FIELD_MISSING", `missing platform metadata: ${missingPlatform.join(", ")}`);
  }

  const platformSkillKey = metadata["platform.skill-key"];
  const platformVersion = metadata["platform.version"];
  const platformPackType = metadata["platform.pack-type"];
  const platformContractId = metadata["platform.task-contract"];
  const platformDigest = metadata["platform.task-contract-digest"];
  const serviceHandler = metadata["platform.service-handler"];

  let platformValuesValid = missingPlatform.length === 0;
  if (platformSkillKey !== undefined && !SKILL_KEY_PATTERN.test(platformSkillKey)) {
    error("SKILL_PLATFORM_VALUE_INVALID", "platform.skill-key must be a dotted lowercase key");
    platformValuesValid = false;
  }
  if (platformVersion !== undefined && !SEMVER_PATTERN.test(platformVersion)) {
    error("SKILL_PLATFORM_VALUE_INVALID", "platform.version must be a MAJOR.MINOR.PATCH version");
    platformValuesValid = false;
  }
  if (platformPackType !== undefined && !SKILL_PACK_TYPES.includes(platformPackType as SkillPackType)) {
    error("SKILL_PACK_TYPE_INVALID", `unknown pack type: ${platformPackType}`);
    platformValuesValid = false;
  } else if (
    platformPackType !== undefined &&
    input.packTypeDirectory !== undefined &&
    platformPackType !== input.packTypeDirectory
  ) {
    error(
      "SKILL_PACK_TYPE_DIRECTORY_MISMATCH",
      `pack-type "${platformPackType}" must equal its directory "${input.packTypeDirectory}"`,
    );
    platformValuesValid = false;
  }

  if (skillKind === "service") {
    if (serviceHandler !== undefined && !isServiceSkillHandlerId(serviceHandler)) {
      error("SKILL_SERVICE_HANDLER_INVALID", `unknown service handler: ${serviceHandler}`);
      platformValuesValid = false;
    }
    if (platformContractId !== undefined || platformDigest !== undefined) {
      error(
        "SKILL_SERVICE_BINDING_INVALID",
        "service skills must not declare task-contract or task-contract-digest",
      );
      platformValuesValid = false;
    }
  } else {
    if (serviceHandler !== undefined) {
      error(
        "SKILL_PLATFORM_VALUE_INVALID",
        "platform.service-handler is only valid for skill-kind=service",
      );
      platformValuesValid = false;
    }
    if (platformContractId !== undefined && platformContractId.trim() === "") {
      error("SKILL_PLATFORM_VALUE_INVALID", "platform.task-contract must not be empty");
      platformValuesValid = false;
    }
    if (platformDigest !== undefined && !SHA256_PATTERN.test(platformDigest)) {
      error("SKILL_PLATFORM_VALUE_INVALID", "platform.task-contract-digest must be a lowercase sha256 hex digest");
      platformValuesValid = false;
    }
  }

  const platformRisk = metadata["platform.risk"];
  if (platformRisk !== undefined && !["low", "medium", "high"].includes(platformRisk)) {
    error("SKILL_PLATFORM_VALUE_INVALID", "platform.risk must be low, medium or high");
  }
  const platformHumanGate = metadata["platform.human-gate"];
  if (platformHumanGate !== undefined && platformHumanGate !== "true" && platformHumanGate !== "false") {
    error("SKILL_PLATFORM_VALUE_INVALID", 'platform.human-gate must be "true" or "false"');
  }
  const platformBudget = metadata["platform.budget-cents"];
  if (platformBudget !== undefined && !INTEGER_PATTERN.test(platformBudget)) {
    error("SKILL_PLATFORM_VALUE_INVALID", "platform.budget-cents must be a non-negative integer");
  }

  const rawAllowedTools = frontmatter["allowed-tools"];
  let allowedTools: string[] = [];
  let allowedToolsValid = true;
  if (rawAllowedTools !== undefined) {
    if (typeof rawAllowedTools !== "string") {
      error("SKILL_ALLOWED_TOOLS_INVALID", "allowed-tools must be a space-separated string");
      allowedToolsValid = false;
    } else {
      const parts = rawAllowedTools.split(/\s+/u).filter((part) => part.length > 0);
      for (const part of parts) {
        if (!TOOL_ID_PATTERN.test(part)) {
          error("SKILL_ALLOWED_TOOLS_INVALID", `invalid tool id: ${part}`);
          allowedToolsValid = false;
        }
      }
      allowedTools = [...new Set(parts)].sort();
    }
  }

  if (skillKind === "service" && allowedTools.length > 0) {
    error("SKILL_SERVICE_TOOLS_INVALID", "service skills must not declare allowed-tools");
    allowedToolsValid = false;
  }

  if (skillKind === "service" && serviceHandler !== undefined && isServiceSkillHandlerId(serviceHandler)) {
    const handler = SERVICE_SKILL_HANDLERS[serviceHandler];
    if (platformRisk !== undefined && platformRisk !== handler.risk) {
      error("SKILL_SERVICE_HANDLER_MISMATCH", "platform.risk must equal the service handler risk");
    }
    if (
      platformHumanGate !== undefined &&
      (platformHumanGate === "true") !== handler.humanGate
    ) {
      error("SKILL_SERVICE_HANDLER_MISMATCH", "platform.human-gate must equal the service handler gate");
    }
  }

  let contract: AiTaskContractLike | undefined;
  if (skillKind === "model_task" && platformContractId !== undefined && platformContractId.trim() !== "") {
    contract = input.resolveContract(platformContractId);
    if (!contract) {
      error("SKILL_TASK_UNKNOWN", `unknown AI task contract: ${platformContractId}`);
    }
  }

  if (contract) {
    if (platformDigest !== undefined && platformDigest !== computeTaskContractDigest(contract)) {
      error(
        "SKILL_CONTRACT_DIGEST_MISMATCH",
        "platform.task-contract-digest does not match the current task contract (update SKILL.md and bump platform.version)",
      );
    }
    if (allowedToolsValid && !sameStringSet(allowedTools, contract.allowedTools ?? [])) {
      error(
        "SKILL_ALLOWED_TOOLS_CONTRACT_MISMATCH",
        "allowed-tools must equal the task contract allowedTools",
      );
    }
    if (platformRisk !== undefined && platformRisk !== contract.risk) {
      error("SKILL_RISK_CONTRACT_MISMATCH", "platform.risk must equal the task contract risk");
    }
    if (
      platformHumanGate !== undefined &&
      (platformHumanGate === "true") !== contract.humanGate
    ) {
      error("SKILL_HUMAN_GATE_CONTRACT_MISMATCH", "platform.human-gate must equal the task contract humanGate");
    }
    if (
      platformBudget !== undefined &&
      Number.parseInt(platformBudget, 10) !== contract.maxCostCents
    ) {
      error("SKILL_BUDGET_CONTRACT_MISMATCH", "platform.budget-cents must equal the task contract maxCostCents");
    }
  }

  const body = parsed.body;
  if (body.trim() === "") {
    error("SKILL_BODY_INVALID", "SKILL.md body must not be empty");
  } else if (body.split("\n").length > 500) {
    warning("SKILL_BODY_TOO_LONG", "SKILL.md body exceeds the 500-line recommendation");
  }

  if (!metadataValid || !platformValuesValid || !allowedToolsValid) {
    return { issues };
  }
  if (issues.some((issue) => issue.severity === "error")) {
    return { issues };
  }

  const manifest: SkillManifest = {
    name: name as string,
    description: description as string,
    license: license as string,
    ...(typeof compatibility === "string" ? { compatibility } : {}),
    allowedTools,
    metadata,
    platform: {
      skillKey: platformSkillKey as string,
      version: platformVersion as string,
      packType: platformPackType as SkillPackType,
      skillKind,
      tenantDefault,
      ...(skillKind === "model_task"
        ? {
            taskContractId: platformContractId as string,
            taskContractDigest: platformDigest as string,
          }
        : { serviceHandler: serviceHandler as string }),
      ...(platformRisk !== undefined ? { risk: platformRisk as "low" | "medium" | "high" } : {}),
      ...(platformHumanGate !== undefined ? { humanGate: platformHumanGate === "true" } : {}),
      ...(platformBudget !== undefined ? { budgetCents: Number.parseInt(platformBudget, 10) } : {}),
      ...(metadata["platform.owner"] !== undefined ? { owner: metadata["platform.owner"] } : {}),
    },
  };
  return {
    skill: {
      manifest,
      body,
      sourceDigest: createHash("sha256").update(input.raw, "utf8").digest("hex"),
    },
    issues,
  };
}
