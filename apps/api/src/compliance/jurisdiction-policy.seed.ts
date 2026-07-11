import { PrismaClient } from '@prisma/client';
import { CURRENT_RULE_VERSION, DATA_ACTIONS, DataAction, JurisdictionRule, PolicyEffect } from './data-rights.types';

/**
 * jurisdiction_policy 系统种子（收口⑥，含 PIPL 法域对）。平台级规则数据行，
 * 随 API/worker 启动经 owner 连接 upsert（同 source_policy/data_provider seed 机制，幂等）。
 * DataRightsService 只读加载。**LLM 绝不参与**——这是确定性数据。
 */

type SeedRow = Omit<JurisdictionRule, 'id'>;
const V = CURRENT_RULE_VERSION;

function row(
  subjectJurisdiction: JurisdictionRule['subjectJurisdiction'],
  processorJurisdiction: JurisdictionRule['processorJurisdiction'],
  dataClass: JurisdictionRule['dataClass'],
  action: JurisdictionRule['action'],
  effect: PolicyEffect,
  opts?: { retentionDays?: number | null; article14Required?: boolean; note?: string },
): SeedRow {
  return {
    subjectJurisdiction,
    processorJurisdiction,
    dataClass,
    action,
    effect,
    requiresLawfulBasis: effect === 'ALLOW_WITH_BASIS',
    article14Required: opts?.article14Required ?? false,
    retentionDays: opts?.retentionDays ?? null,
    ruleVersion: V,
    note: opts?.note ?? null,
  };
}

/** red 数据按主体法域的动作→effect 表。EU/UK=GDPR 严格；US=CCPA 较宽；OTHER=保守。 */
const RED_EFFECTS: Record<'EU' | 'UK' | 'US' | 'OTHER', Record<DataAction, PolicyEffect>> = {
  EU: { STORE: 'ALLOW', AI_PROCESS: 'ALLOW_WITH_BASIS', DERIVE: 'ALLOW_WITH_BASIS', RETAIN: 'ALLOW', EXPORT: 'ALLOW_WITH_BASIS', OUTREACH: 'ALLOW_WITH_BASIS', VIEW: 'ALLOW' },
  UK: { STORE: 'ALLOW', AI_PROCESS: 'ALLOW_WITH_BASIS', DERIVE: 'ALLOW_WITH_BASIS', RETAIN: 'ALLOW', EXPORT: 'ALLOW_WITH_BASIS', OUTREACH: 'ALLOW_WITH_BASIS', VIEW: 'ALLOW' },
  US: { STORE: 'ALLOW', AI_PROCESS: 'ALLOW', DERIVE: 'ALLOW', RETAIN: 'ALLOW', EXPORT: 'ALLOW', OUTREACH: 'ALLOW_WITH_BASIS', VIEW: 'ALLOW' },
  OTHER: { STORE: 'ALLOW', AI_PROCESS: 'ALLOW_WITH_BASIS', DERIVE: 'ALLOW_WITH_BASIS', RETAIN: 'ALLOW', EXPORT: 'ALLOW_WITH_BASIS', OUTREACH: 'REQUIRE_APPROVAL', VIEW: 'ALLOW' },
};

/** red 保留期上限（天）——RETAIN 判定的元数据，供保留期 sweep 使用（本 PR 不接线）。 */
const RED_RETENTION_DAYS = 730;

/** PIPL 跨境：主体在 EU/UK、处理地在 CN 的高风险动作一律人审（比 (subj,*) 更具体，特异度胜出）。 */
const PIPL_ACTIONS: DataAction[] = ['AI_PROCESS', 'DERIVE', 'EXPORT', 'OUTREACH'];

function buildSeed(): SeedRow[] {
  const rows: SeedRow[] = [
    row('*', '*', 'green', '*', 'ALLOW', { note: '公司事实无限制（GLEIF/官方 CC0/CC BY）' }),
    row('*', '*', 'amber', '*', 'ALLOW', { note: '职能邮箱 info@/sales@（Recital 14 非个人数据，ePrivacy）' }),
  ];

  for (const subject of ['EU', 'UK', 'US', 'OTHER'] as const) {
    for (const action of DATA_ACTIONS) {
      rows.push(
        row(subject, '*', 'red', action, RED_EFFECTS[subject][action], {
          retentionDays: action === 'RETAIN' ? RED_RETENTION_DAYS : null,
        }),
      );
    }
  }

  for (const subject of ['EU', 'UK'] as const) {
    for (const action of PIPL_ACTIONS) {
      rows.push(row(subject, 'CN', 'red', action, 'REQUIRE_APPROVAL', { note: 'PIPL 跨境：EU/UK 自然人数据→中国处理地，人审' }));
    }
  }
  rows.push(row('CN', '*', 'red', 'OUTREACH', 'REQUIRE_APPROVAL', { note: 'PIPL：中国主体对外触达需人审' }));

  return rows;
}

export const JURISDICTION_POLICY_SEED: readonly SeedRow[] = buildSeed();

/** owner 连接可写 jurisdiction_policy 的最小面。 */
type JurisdictionPolicyDb = { jurisdictionPolicy: PrismaClient['jurisdictionPolicy'] };

/** 幂等 upsert 全部种子行。返回写入行数。 */
export async function seedJurisdictionPolicy(db: JurisdictionPolicyDb): Promise<number> {
  for (const r of JURISDICTION_POLICY_SEED) {
    await db.jurisdictionPolicy.upsert({
      where: {
        subjectJurisdiction_processorJurisdiction_dataClass_action_ruleVersion: {
          subjectJurisdiction: r.subjectJurisdiction,
          processorJurisdiction: r.processorJurisdiction,
          dataClass: r.dataClass,
          action: r.action,
          ruleVersion: r.ruleVersion,
        },
      },
      update: {
        effect: r.effect,
        requiresLawfulBasis: r.requiresLawfulBasis,
        article14Required: r.article14Required,
        retentionDays: r.retentionDays ?? null,
        note: r.note ?? null,
      },
      create: { ...r, retentionDays: r.retentionDays ?? null, note: r.note ?? null },
    });
  }
  return JURISDICTION_POLICY_SEED.length;
}
