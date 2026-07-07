import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { companyIdentity } from '../discovery/identity';

const CHUNK = 100;

export interface ProjectResult {
  sourceId: string;
  sourceKey: string;
  entities: number;
  projected: number;
  suppressed: number;
  personalContactsWithheld: number;
  status: 'DONE' | 'SKIPPED';
  reason?: string;
}

/**
 * 租户投影：把**平台级共享**的 source_entity 投影进**某租户**的 canonical_company。
 * 平台采集一次服务所有租户；租户按 ICP 选源、把公司拉进自己的获客主线（走 RLS）。
 *
 * 复用 discovery 的确定性身份解析（companyIdentity：域名 > 名称+国家）→ 跨源自动去重
 * （同一家公司来自两个展会 = 一条 canonical），并写 identity_link + field_evidence 留痕。
 *
 * 🔴 合规红线：**只投公司事实**（名称/域名/国家/产品/展位——🟢法人公开信息）。
 * source_entity 里的**人名邮箱（personalData=true）不投**，留在平台层隔离，走 LIA 后另议。
 * 职能邮箱（role）是法人数据，随 attributes.contact_email 投。
 */
export class TenantProjectionService {
  constructor(private readonly deps: { prisma: PrismaService }) {}

  async projectSource(workspaceId: string, sourceId: string, opts?: { limit?: number }): Promise<ProjectResult> {
    const { prisma } = this.deps;

    const source = await prisma.monitoredSource.findUnique({ where: { id: sourceId } });
    if (!source) throw new Error(`monitored_source ${sourceId} not found`);

    // 平台级表无 RLS，直接读活跃实体
    const entities = await prisma.sourceEntity.findMany({
      where: { sourceId, withdrawnAt: null },
      ...(opts?.limit ? { take: opts.limit } : {}),
    });
    if (!entities.length) {
      return { sourceId, sourceKey: source.sourceKey, entities: 0, projected: 0, suppressed: 0, personalContactsWithheld: 0, status: 'SKIPPED', reason: 'no active entities' };
    }

    // Suppression 名单（RLS 内读一次）
    const { domains: suppressedDomains, names: suppressedNames } = await prisma.withWorkspace(workspaceId, async (tx) => {
      const s = await tx.suppressionRecord.findMany({ where: { type: { in: ['domain', 'company_name'] } } });
      return {
        domains: new Set(s.filter((x) => x.type === 'domain').map((x) => x.value.toLowerCase())),
        names: new Set(s.filter((x) => x.type === 'company_name').map((x) => x.value.toLowerCase())),
      };
    });

    let projected = 0, suppressed = 0, personalWithheld = 0;

    for (let i = 0; i < entities.length; i += CHUNK) {
      const chunk = entities.slice(i, i + CHUNK);
      await prisma.withWorkspace(workspaceId, async (tx) => {
        for (const e of chunk) {
          const cleaned = (e.cleaned ?? {}) as Record<string, unknown>;
          const identity = companyIdentity({ name: e.name, domain: e.domain, country: e.country });
          const isSuppressed =
            (!!e.domain && suppressedDomains.has(e.domain.toLowerCase())) || suppressedNames.has(e.name.toLowerCase());

          // 合规：人名邮箱不投；职能邮箱作为法人联系点随公司走
          const roleEmail = cleaned.email_kind === 'role' ? (cleaned.email as string) : undefined;
          if (cleaned.email_kind === 'personal') personalWithheld += 1;

          const attributes = pruneUndefined({
            products: Array.isArray(cleaned.products) ? cleaned.products : undefined,
            contact_email: roleEmail,
            source_fair: cleaned.source_fair,
            source_kind: cleaned.source_kind,
            stand: cleaned.stand,
            hall: cleaned.hall,
            acquired_via: source.providerKey,
            source_key: source.sourceKey,
          });

          const canonical = await tx.canonicalCompany.upsert({
            where: { workspaceId_dedupeKey: { workspaceId, dedupeKey: identity.dedupeKey } },
            update: {
              // 后到的源只补缺（domain/country），不覆盖已有；merge attributes
              ...(e.domain ? { domain: { set: e.domain } } : {}),
              ...(e.country ? { country: { set: e.country } } : {}),
              status: isSuppressed ? 'SUPPRESSED' : undefined,
              version: { increment: 1 },
            },
            create: {
              workspaceId,
              name: e.name,
              domain: e.domain ?? null,
              country: e.country ?? null,
              attributes: attributes as Prisma.InputJsonValue,
              status: isSuppressed ? 'SUPPRESSED' : 'NEW',
              dedupeKey: identity.dedupeKey,
            },
          });
          if (isSuppressed) suppressed += 1;
          projected += 1;

          // identity_link：canonical ↔ source_entity（rawRecordId=source_entity.id），去重
          const linkExists = await tx.identityLink.findFirst({
            where: { canonicalId: canonical.id, rawRecordId: e.id },
            select: { id: true },
          });
          if (linkExists) continue;
          await tx.identityLink.create({
            data: {
              workspaceId,
              canonicalType: 'company',
              canonicalId: canonical.id,
              rawRecordId: e.id,
              matchRule: identity.matchRule,
              confidence: identity.matchRule === 'domain_exact' ? 1 : 0.8,
            },
          });
          // 字段级 Evidence：展会公开名录 = public license
          const fields: [string, unknown][] = [
            ['name', e.name],
            ['domain', e.domain],
            ['country', e.country],
            ['attributes', attributes],
          ];
          for (const [field, value] of fields) {
            if (value == null) continue;
            await tx.fieldEvidence.create({
              data: {
                workspaceId,
                entityType: 'company',
                entityId: canonical.id,
                field,
                value: value as Prisma.InputJsonValue,
                providerKey: source.providerKey,
                rawRecordId: e.id,
                license: 'public',
                allowedActions: ['display', 'match'] as unknown as Prisma.InputJsonValue,
              },
            });
          }
        }
      });
    }

    return { sourceId, sourceKey: source.sourceKey, entities: entities.length, projected, suppressed, personalContactsWithheld: personalWithheld, status: 'DONE' };
  }
}

function pruneUndefined(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null));
}
