import type { LawfulBasis } from '../discovery/provider-contract';

/**
 * 收口⑥ 存储侧合规词表与判定类型（ADR-010 COMPLIANCE-SCORING）。
 * 纯类型/常量，无运行时依赖——引擎、服务、种子、验证脚本共用。
 */

/** 7 动作词表（platform-top-level-design §11「动作词表从 3 扩到 7」）。 */
export const DATA_ACTIONS = ['STORE', 'AI_PROCESS', 'DERIVE', 'RETAIN', 'EXPORT', 'OUTREACH', 'VIEW'] as const;
export type DataAction = (typeof DATA_ACTIONS)[number];

/** 三色数据分级（green 公司事实 / amber 职能邮箱 ePrivacy / red 具名个人 GDPR Art.4）。 */
export const DATA_CLASSES = ['green', 'amber', 'red'] as const;
export type DataClass = (typeof DATA_CLASSES)[number];

/** 法域（数据主体 / 处理地），归一到有限集，其它落 OTHER。 */
export const JURISDICTIONS = ['EU', 'UK', 'US', 'CN', 'OTHER'] as const;
export type Jurisdiction = (typeof JURISDICTIONS)[number];

/** 判定效果（ALLOW_WITH_BASIS 视 lawfulBasis 存在性坍缩为 allow/deny）。 */
export type PolicyEffect = 'ALLOW' | 'ALLOW_WITH_BASIS' | 'REQUIRE_APPROVAL' | 'DENY';

/** 当前规则版本（seed 与引擎加载对齐）。 */
export const CURRENT_RULE_VERSION = 'v1';

/** jurisdiction_policy 一行（'*' = 通配，最具体优先匹配）。DB 行与种子共用此形。 */
export interface JurisdictionRule {
  id?: string;
  subjectJurisdiction: Jurisdiction | '*';
  processorJurisdiction: Jurisdiction | '*';
  dataClass: DataClass | '*';
  action: DataAction | '*';
  effect: PolicyEffect;
  requiresLawfulBasis: boolean;
  article14Required: boolean;
  retentionDays?: number | null;
  ruleVersion: string;
  note?: string | null;
}

/** evaluate() 输入。纯：不读时钟、不读 env、不触 DB。 */
export interface DataRightsContext {
  action: DataAction;
  dataClass: DataClass;
  subjectJurisdiction: Jurisdiction;
  processorJurisdiction: Jurisdiction;
  /** 现有 LIA/consent/contract（存在且有效才解锁 ALLOW_WITH_BASIS）。 */
  lawfulBasis?: LawfulBasis | null;
  /** 禁联命中（对外动作第一道检查，永远最先）。 */
  suppressed?: boolean;
  /** 证据先行红线：显式 false 时 DERIVE/EXPORT 拒（undefined=未断言，不拦）。 */
  hasEvidence?: boolean;
}

/** evaluate() 输出（确定性）。 */
export interface DataRightsDecision {
  effect: PolicyEffect;
  allowed: boolean;
  reason: string;
  ruleId: string | null;
  ruleVersion: string;
  requiresLawfulBasis: boolean;
  /** GDPR Art.14 间接收集主动告知义务判定（独立于 allow/deny）。 */
  article14NoticeRequired: boolean;
}
