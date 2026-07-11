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

/**
 * red 数据按主体法域的动作→effect 表。EU/UK=GDPR 严格；US=CCPA 较宽；OTHER=保守；
 * CN=PIPL（需合法性基础，跨境导出/触达人审——CN 主体作一等法域覆盖，避免 fail-closed 全拒的自相矛盾）。
 */
const RED_EFFECTS: Record<'EU' | 'UK' | 'US' | 'OTHER' | 'CN', Record<DataAction, PolicyEffect>> = {
  EU: { STORE: 'ALLOW', AI_PROCESS: 'ALLOW_WITH_BASIS', DERIVE: 'ALLOW_WITH_BASIS', RETAIN: 'ALLOW', EXPORT: 'ALLOW_WITH_BASIS', OUTREACH: 'ALLOW_WITH_BASIS', VIEW: 'ALLOW' },
  UK: { STORE: 'ALLOW', AI_PROCESS: 'ALLOW_WITH_BASIS', DERIVE: 'ALLOW_WITH_BASIS', RETAIN: 'ALLOW', EXPORT: 'ALLOW_WITH_BASIS', OUTREACH: 'ALLOW_WITH_BASIS', VIEW: 'ALLOW' },
  US: { STORE: 'ALLOW', AI_PROCESS: 'ALLOW', DERIVE: 'ALLOW', RETAIN: 'ALLOW', EXPORT: 'ALLOW', OUTREACH: 'ALLOW_WITH_BASIS', VIEW: 'ALLOW' },
  OTHER: { STORE: 'ALLOW', AI_PROCESS: 'ALLOW_WITH_BASIS', DERIVE: 'ALLOW_WITH_BASIS', RETAIN: 'ALLOW', EXPORT: 'ALLOW_WITH_BASIS', OUTREACH: 'REQUIRE_APPROVAL', VIEW: 'ALLOW' },
  CN: { STORE: 'ALLOW_WITH_BASIS', AI_PROCESS: 'ALLOW_WITH_BASIS', DERIVE: 'ALLOW_WITH_BASIS', RETAIN: 'ALLOW_WITH_BASIS', EXPORT: 'REQUIRE_APPROVAL', OUTREACH: 'REQUIRE_APPROVAL', VIEW: 'ALLOW_WITH_BASIS' },
};

/** red 保留期上限（天）——RETAIN 判定的元数据，供保留期 sweep 使用（本 PR 不接线）。 */
const RED_RETENTION_DAYS = 730;

function buildSeed(): SeedRow[] {
  const rows: SeedRow[] = [
    row('*', '*', 'green', '*', 'ALLOW', { note: '公司事实无限制（GLEIF/官方 CC0/CC BY）' }),
    row('*', '*', 'amber', '*', 'ALLOW', { note: '职能邮箱 info@/sales@（Recital 14 非个人数据，ePrivacy）' }),
  ];

  for (const subject of ['EU', 'UK', 'US', 'OTHER', 'CN'] as const) {
    for (const action of DATA_ACTIONS) {
      rows.push(
        row(subject, '*', 'red', action, RED_EFFECTS[subject][action], {
          retentionDays: action === 'RETAIN' ? RED_RETENTION_DAYS : null,
        }),
      );
    }
  }

  // PIPL/GDPR Chapter V 跨境：EU/UK 自然人数据→中国处理地——**全动作**人审（含 STORE/RETAIN/VIEW，
  // 存到/看在中国本身即受限转移）。通配 action 行特异度=3，与 (subj,*,red,action) 同分 → 引擎同分取更严
  // 使 REQUIRE_APPROVAL 压过 ALLOW；无逃逸动作。
  for (const subject of ['EU', 'UK'] as const) {
    rows.push(row(subject, 'CN', 'red', '*', 'REQUIRE_APPROVAL', { note: 'PIPL/GDPR 跨境：EU/UK 自然人数据→中国处理地，全动作人审' }));
  }

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
