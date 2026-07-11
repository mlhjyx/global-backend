import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { evaluateDataRights } from './data-rights.engine';
import { seedJurisdictionPolicy } from './jurisdiction-policy.seed';
import {
  CURRENT_RULE_VERSION,
  DataRightsContext,
  DataRightsDecision,
  Jurisdiction,
  JurisdictionRule,
} from './data-rights.types';

/** policy_decision_log 留痕的引用元数据（🔴 只放引用/id，绝不嵌人名/邮箱明文）。 */
export interface PolicyDecisionMeta {
  subjectType?: string | null;
  subjectId?: string | null;
  lawfulBasisRef?: string | null;
  actorId?: string | null;
  correlationId?: string | null;
}

/**
 * 收口⑥ DataRightsService（ADR-010）：确定性存储侧合规判定 + 审计留痕。
 * - 规则来自 jurisdiction_policy（启动 seed，运行时只读加载）；判定走纯引擎 {@link evaluateDataRights}。
 * - **LLM 绝不参与权利判定**。规则未加载/为空 → 引擎对 red 数据 fail-closed（DENY）。
 */
@Injectable()
export class DataRightsService implements OnModuleInit {
  private readonly logger = new Logger(DataRightsService.name);
  private rules: JurisdictionRule[] = [];

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    // jurisdiction_policy 是平台表，app_user 只读 → 用 owner 连接播种（同 provider seed）。
    // seed 失败要**大声**：规则空则引擎对 red 数据 fail-closed（安全但会全拒），运维需知晓。
    const owner = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
    try {
      await seedJurisdictionPolicy(owner);
    } catch (err) {
      this.logger.error(`jurisdiction_policy seed FAILED — DataRights fail-closed until seeded: ${String(err)}`);
    } finally {
      await owner.$disconnect();
    }
    await this.loadRules();
  }

  /** 从 DB 加载当前版本规则到内存缓存（app_user SELECT，无 RLS 平台表）。 */
  async loadRules(): Promise<number> {
    const rows = await this.prisma.jurisdictionPolicy.findMany({
      where: { ruleVersion: CURRENT_RULE_VERSION },
      orderBy: { id: 'asc' },
    });
    this.rules = rows.map(toRule);
    return this.rules.length;
  }

  /** 已加载规则数（测试/健康检查用）。 */
  ruleCount(): number {
    return this.rules.length;
  }

  /** 纯判定（不写日志）——预检/无租户上下文场景。 */
  evaluate(ctx: DataRightsContext): DataRightsDecision {
    return evaluateDataRights(ctx, this.rules);
  }

  /** 判定 + 写 policy_decision_log（租户 RLS 事务，append-only）。 */
  async evaluateAndLog(
    workspaceId: string,
    ctx: DataRightsContext,
    meta?: PolicyDecisionMeta,
  ): Promise<DataRightsDecision> {
    const decision = this.evaluate(ctx);
    await this.prisma.withWorkspace(workspaceId, (tx) =>
      tx.policyDecisionLog.create({
        data: {
          workspaceId,
          action: ctx.action,
          dataClass: ctx.dataClass,
          subjectJurisdiction: ctx.subjectJurisdiction,
          processorJurisdiction: ctx.processorJurisdiction,
          effect: decision.effect,
          allowed: decision.allowed,
          reason: decision.reason,
          ruleId: decision.ruleId,
          ruleVersion: decision.ruleVersion,
          article14Required: decision.article14NoticeRequired,
          subjectType: meta?.subjectType ?? null,
          subjectId: meta?.subjectId ?? null,
          // 🔴 内容最小化：只存 basis 引用（ref），绝不嵌 note/人名/邮箱明文。
          lawfulBasisRef: meta?.lawfulBasisRef ?? ctx.lawfulBasis?.ref ?? null,
          actorId: meta?.actorId ?? null,
          correlationId: meta?.correlationId ?? null,
        },
      }),
    );
    return decision;
  }
}

/** DB 行 → 引擎规则（DB 值可信，做类型收敛）。 */
function toRule(r: {
  id: string;
  subjectJurisdiction: string;
  processorJurisdiction: string;
  dataClass: string;
  action: string;
  effect: string;
  requiresLawfulBasis: boolean;
  article14Required: boolean;
  retentionDays: number | null;
  ruleVersion: string;
  note: string | null;
}): JurisdictionRule {
  return {
    id: r.id,
    subjectJurisdiction: r.subjectJurisdiction as Jurisdiction | '*',
    processorJurisdiction: r.processorJurisdiction as Jurisdiction | '*',
    dataClass: r.dataClass as JurisdictionRule['dataClass'],
    action: r.action as JurisdictionRule['action'],
    effect: r.effect as JurisdictionRule['effect'],
    requiresLawfulBasis: r.requiresLawfulBasis,
    article14Required: r.article14Required,
    retentionDays: r.retentionDays,
    ruleVersion: r.ruleVersion,
    note: r.note,
  };
}
