import Ajv, { type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import { canonicalDigest } from "../../model-runtime/context-engine";
import commonSchema from "./schemas/common.schema.json";
import complianceSchema from "./schemas/compliance.schema.json";
import dataSourceSchema from "./schemas/data-source.schema.json";
import growthMotionSchema from "./schemas/growth-motion.schema.json";
import industrySchema from "./schemas/industry.schema.json";

/**
 * Pack v1（S1）规范：四类最小 Schema（Compliance / Data Source / Growth Motion / Industry）
 * 与平台语义校验。Pack 是**数据**，不是执行器：解析只产出有序规则与内容片段，执行边界
 * 仍由技能/工具白名单、审批链与工作流强制（设计 §3-A1）。
 */

export const PACK_TYPES = ["compliance", "data_source", "growth_motion", "industry"] as const;
export type PackType = (typeof PACK_TYPES)[number];

/**
 * 解析优先级（PRD §7.11.7 的九层序）。v1 只产出来源前七层中的四类类型，
 * Campaign / AI Recommendation 仅保留位置（校验与排序可接受，不产生真实来源）。
 */
export const PACK_PRIORITY_ORDER = [
  "hard_rules",
  "enterprise",
  "compliance",
  "market",
  "industry",
  "growth_motion",
  "channel_data_content_expert",
  "campaign",
  "ai_recommendation",
] as const;
export type PriorityClass = (typeof PACK_PRIORITY_ORDER)[number];

export interface PackSourceRef {
  readonly label: string;
  readonly url?: string;
  readonly retrievedAt?: string;
}

export interface PackTags {
  readonly industries?: readonly string[];
  readonly markets?: readonly string[];
  readonly motions?: readonly string[];
}

export interface ComplianceRule {
  readonly id: string;
  readonly effect: "forbid" | "require_approval" | "mask" | "limit";
  readonly appliesTo: {
    readonly skills?: readonly string[];
    readonly tools?: readonly string[];
    readonly phases?: readonly string[];
  };
  readonly condition?: {
    readonly field: string;
    readonly op: "eq" | "neq" | "in" | "not_in" | "contains" | "gte" | "lte";
    readonly value: string | number | boolean | readonly (string | number | boolean)[];
  };
  readonly rationale: string;
  readonly sources: readonly PackSourceRef[];
}

export interface DataSourceRule {
  readonly id: string;
  readonly sourceId: string;
  readonly category: string;
  readonly allowedUse: readonly ("discovery" | "enrichment" | "research")[];
  readonly license: string;
  readonly piiClass: "public_organization" | "personal_data" | "confidential_tenant";
  readonly rateLimit?: { readonly rps?: number; readonly perDomainDelayMs?: number };
  readonly approval: "none" | "ops";
}

export interface GrowthMotionRule {
  readonly id: string;
  readonly motion: string;
  readonly stage: string;
  readonly playbook: readonly { readonly step: string; readonly guidance: string }[];
  readonly kpis: readonly string[];
  readonly guardrails: readonly string[];
}

export interface IndustryRule {
  readonly id: string;
  readonly taxonomy: { readonly scheme: string; readonly codes: readonly string[] };
  readonly buyerRoles: readonly string[];
  readonly terminology: readonly string[];
  readonly regulations: readonly { readonly jurisdiction: string; readonly note: string }[];
}

export type PackRule = ComplianceRule | DataSourceRule | GrowthMotionRule | IndustryRule;

export interface PackManifest {
  readonly packKey: string;
  readonly packType: PackType;
  readonly version: string;
  readonly title: string;
  readonly description: string;
  readonly priorityClass: PriorityClass;
  readonly tags?: PackTags;
  readonly owner: string;
  readonly license: string;
  readonly notice?: string;
  readonly contentPath?: "PACK.md";
  readonly rules: readonly PackRule[];
  readonly sources: readonly PackSourceRef[];
  readonly exitPlan: string;
}

export type PackIssueSeverity = "error" | "warning";

export interface PackValidationIssue {
  readonly code: string;
  readonly severity: PackIssueSeverity;
  readonly message: string;
}

const ajv = new Ajv({ allErrors: true, strict: true, allowUnionTypes: true });
addFormats(ajv);
ajv.addSchema(commonSchema as object, "common.schema.json");

const SCHEMA_VALIDATORS: Readonly<Record<PackType, ValidateFunction>> = {
  compliance: ajv.compile(complianceSchema as object),
  data_source: ajv.compile(dataSourceSchema as object),
  growth_motion: ajv.compile(growthMotionSchema as object),
  industry: ajv.compile(industrySchema as object),
};

const PACK_KEY_PATTERN = /^[a-z0-9][a-z0-9_]*(?:\.[a-z0-9][a-z0-9_]*)+$/u;
const HTTP_URL = /^https?:\/\//u;

export interface PackValidationContext {
  /** `<pack_type>/` 目录名。 */
  readonly packType: string;
  /** `<pack-key-suffix>/` 目录名（packKey 去掉 `<packType>.` 前缀）。 */
  readonly directory: string;
}

export function validatePackManifest(
  candidate: unknown,
  context: PackValidationContext,
): readonly PackValidationIssue[] {
  const issues: PackValidationIssue[] = [];
  const error = (code: string, message: string): void => {
    issues.push({ code, severity: "error", message });
  };

  if (!PACK_TYPES.includes(context.packType as PackType)) {
    error("PACK_TYPE_INVALID", `unknown pack type directory: ${context.packType}`);
    return issues;
  }
  const packType = context.packType as PackType;
  const validator = SCHEMA_VALIDATORS[packType];
  if (!validator(candidate)) {
    for (const detail of validator.errors ?? []) {
      error(
        "PACK_SCHEMA_INVALID",
        `${detail.instancePath || "/"} ${detail.message ?? "invalid"}`,
      );
    }
    return issues;
  }

  const manifest = candidate as PackManifest;
  if (manifest.packType !== packType) {
    error("PACK_TYPE_MISMATCH", `packType ${manifest.packType} must equal directory type ${packType}`);
  }
  if (!PACK_KEY_PATTERN.test(manifest.packKey) || !manifest.packKey.startsWith(`${packType}.`)) {
    error("PACK_KEY_INVALID", `packKey must start with "${packType}." and be dotted lowercase`);
  } else if (manifest.packKey !== `${packType}.${context.directory}`) {
    error(
      "PACK_KEY_DIRECTORY_MISMATCH",
      `packKey ${manifest.packKey} must equal "${packType}.${context.directory}"`,
    );
  }
  if (manifest.license !== "Proprietary" && (manifest.notice ?? "").trim().length < 20) {
    error(
      "PACK_NOTICE_MISSING",
      "imported/content packs must carry a notice (>=20 chars) with source and changes",
    );
  }

  const ruleIds = new Set<string>();
  for (const rule of manifest.rules) {
    if (ruleIds.has(rule.id)) {
      error("PACK_RULE_ID_DUPLICATE", `duplicate rule id: ${rule.id}`);
    }
    ruleIds.add(rule.id);
  }

  for (const source of manifest.sources) {
    if (source.url !== undefined && !HTTP_URL.test(source.url)) {
      error("PACK_SOURCE_URL_INVALID", `source url must be http(s): ${source.url}`);
    }
  }

  if (manifest.rules.length === 0 && !manifest.tags) {
    issues.push({
      code: "PACK_CONTENT_ONLY_WITHOUT_TAGS",
      severity: "warning",
      message: "content-only pack without tags will never be selected by a strategy",
    });
  }

  return issues;
}

/** 版本的规范化摘要（不含内容正文；内容摘要见 loader 的 contentDigest）。 */
export function packManifestDigest(manifest: PackManifest): string {
  return canonicalDigest(manifest);
}
