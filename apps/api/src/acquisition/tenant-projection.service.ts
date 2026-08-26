import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { companyIdentity } from '../discovery/identity';
import { lockWorkspaceSuppressionPolicy } from '../discovery/suppression-policy-lock';
import { loadMaterializableCompanyState } from '../discovery/company-suppression-gate';
import {
  canonicalCompanyAttributesEqual,
  mergeCanonicalCompanyAttributes,
  sanitizeCanonicalCompanyAttributes,
} from '../discovery/canonical-company-attributes';
import {
  persistMonitoredSourceRawBridge,
  prepareMonitoredSourceRawBridge,
} from './monitored-source-raw-bridge';

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
 * 🔴 合规红线：**只投经过 Raw v2 closed-schema 验证的公司事实**。
 * source_entity 中所有邮箱（具名或职能）都与公司 Raw/Canonical 投影分离；联系人路径需独立授权。
 */
export class TenantProjectionService {
  constructor(private readonly deps: { prisma: PrismaService }) {}

  async projectSource(workspaceId: string, sourceId: string, opts?: { limit?: number }): Promise<ProjectResult> {
    const { prisma } = this.deps;

    const source = await prisma.monitoredSource.findUnique({ where: { id: sourceId },
    });
    if (!source) throw new Error(`monitored_source ${sourceId} not found`);

    // 平台级表无 RLS，直接读活跃实体
    const [entities, policies] = await Promise.all([
      prisma.sourceEntity.findMany({
        where: { sourceId, withdrawnAt: null },
        ...(opts?.limit ? { take: opts.limit } : {}),
      }),
      prisma.sourcePolicy.findMany({
        select: {
          id: true,
          domain: true,
          retentionDays: true,
          reviewStatus: true,
          allowedPurpose: true,
          updatedAt: true,
        },
      }),
    ]);
    if (!entities.length) {
      return {
        sourceId,
        sourceKey: source.sourceKey,
        entities: 0,
        projected: 0,
        suppressed: 0,
        personalContactsWithheld: 0,
        status: 'SKIPPED',
        reason: 'no active entities',
      };
    }
    const fetchIds = [...new Set(entities.flatMap((entity) => entity.lastSeenFetchId ? [entity.lastSeenFetchId] : []))];
    const fetches = fetchIds.length
      ? await prisma.sourceFetch.findMany({
          where: { id: { in: fetchIds }, sourceId },
          select: {
            id: true,
            sourceId: true,
            status: true,
            parserVersion: true,
            finishedAt: true,
          },
        })
      : [];
    const fetchById = new Map(fetches.map((fetch) => [fetch.id, fetch]));

    let projected = 0,
      suppressed = 0,
      personalWithheld = 0;

    for (let i = 0; i < entities.length; i += CHUNK) {
      const chunk = entities.slice(i, i + CHUNK);
      await prisma.withWorkspace(workspaceId, async (tx) => {
        // Authority fact + projection commit share one short workspace lock.
        // A suppression committed before this chunk admission is visible here;
        // no database transaction is held while the platform source is fetched.
        const policyLock = await lockWorkspaceSuppressionPolicy(tx, workspaceId);
        const suppressionRows = await tx.suppressionRecord.findMany({
          where: {
            type: { in: ['domain', 'company_name', 'email'] },
          },
          select: { type: true, value: true },
        });
        for (const e of chunk) {
          const cleaned = (e.cleaned ?? {}) as Record<string, unknown>;
          if (typeof cleaned.email === 'string') personalWithheld += 1;
          const fetch = e.lastSeenFetchId ? fetchById.get(e.lastSeenFetchId) : undefined;
          const preparedRaw = prepareMonitoredSourceRawBridge({
            workspaceId,
            source,
            entity: e,
            fetch: fetch ?? {
              id: '',
              sourceId,
              status: 'MISSING',
              parserVersion: null,
              finishedAt: null,
            },
            policies,
          });
          const preparedCompany = companyFromPreparedRaw(preparedRaw.row.payload);
          const identity = companyIdentity({
            name: preparedCompany.name,
            domain: preparedCompany.domain,
            country: preparedCompany.country,
          });
          const materialization = await loadMaterializableCompanyState(
            tx,
            workspaceId,
            identity.dedupeKey,
            { name: preparedCompany.name, domain: preparedCompany.domain },
            {
              knownSuppressions: suppressionRows,
              policyLock,
              sanitizeAttributes: sanitizeCanonicalCompanyAttributes,
            },
          );
          const { prior } = materialization;
          if (!materialization.allowed) {
            suppressed += 1;
            continue;
          }

          const attributes = sanitizeCanonicalCompanyAttributes(
            preparedCompany.attributes,
          );
          const raw = await persistMonitoredSourceRawBridge(tx, {
            workspaceId,
            prepared: preparedRaw,
          });

          const mergedAttributes = mergeCanonicalCompanyAttributes(
            prior?.attributes,
            attributes,
          );
          const attributesChanged = prior
            ? materialization.attributesRequireRepair ||
              !canonicalCompanyAttributesEqual(
                mergedAttributes,
                prior.attributes,
              )
            : true;
          const domainChanged = Boolean(
            prior &&
              preparedCompany.domain &&
              preparedCompany.domain !== prior.domain,
          );
          const countryChanged = Boolean(
            prior &&
              preparedCompany.country &&
              preparedCompany.country !== prior.country,
          );
          const canonicalChanged =
            !prior || attributesChanged || domainChanged || countryChanged;
          const existingLink = prior
            ? await tx.identityLink.findFirst({
                where: { canonicalId: prior.id, rawRecordId: raw.id },
                select: { id: true },
              })
            : null;
          if (existingLink && !canonicalChanged) continue;

          // 先查已有 canonical：存在则**合并 attributes**（不丢弃跨源 products/contact/富集命名空间），
          // 否则新建。（避免 upsert 的 update 分支覆盖/丢失 attributes —— 下游 fit 门从这里读 products）
          const canonical = prior
            ? canonicalChanged
              ? await tx.canonicalCompany.update({
                  where: { id: prior.id },
                  data: {
                    // 后到的源只补缺（domain/country），不覆盖已有
                    ...(domainChanged
                      ? { domain: { set: preparedCompany.domain } }
                      : {}),
                    ...(countryChanged
                      ? { country: { set: preparedCompany.country } }
                      : {}),
                    ...(attributesChanged
                      ? {
                          attributes:
                            mergedAttributes as Prisma.InputJsonValue,
                        }
                      : {}),
                    version: { increment: 1 },
                  },
                })
              : { id: prior.id }
            : await tx.canonicalCompany.create({
                data: {
                  workspaceId,
                  name: preparedCompany.name,
                  domain: preparedCompany.domain ?? null,
                  country: preparedCompany.country ?? null,
                  attributes: attributes as Prisma.InputJsonValue,
                  status: 'NEW',
                  dedupeKey: identity.dedupeKey,
                },
              });
          if (canonicalChanged) projected += 1;

          // Downstream facts reference the governed Raw receipt, never SourceEntity directly.
          const linkExists = existingLink;
          if (linkExists) {
            // The original Raw/IdentityLink/FieldEvidence transaction already
            // carries the provenance for this canonical repair. Do not append
            // a duplicate `(entity, field, raw)` row: the database enforces
            // that evidence identity as unique, and 2000 has already applied
            // the same full-path sanitizer to the retained evidence value.
            continue;
          }
          await tx.identityLink.create({
            data: {
              workspaceId,
              canonicalType: 'company',
              canonicalId: canonical.id,
              rawRecordId: raw.id,
              matchRule: identity.matchRule,
              confidence: identity.matchRule === 'domain_exact' ? 1 : 0.8,
            },
          });
          // 字段级 Evidence：展会公开名录 = public license
          const fields: [string, unknown][] = [
            ['name', preparedCompany.name],
            ['domain', preparedCompany.domain],
            ['country', preparedCompany.country],
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
                providerKey: preparedRaw.identityProviderKey,
                rawRecordId: raw.id,
                license: preparedRaw.license,
                allowedActions: ['display', 'match'] as unknown as Prisma.InputJsonValue,
              },
            });
          }
        }
      });
    }

    return {
      sourceId,
      sourceKey: source.sourceKey,
      entities: entities.length,
      projected,
      suppressed,
      personalContactsWithheld: personalWithheld,
      status: 'DONE',
    };
  }
}

function companyFromPreparedRaw(value: unknown): {
  name: string;
  domain?: string;
  country?: string;
  attributes: Record<string, unknown>;
} {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('MONITORED_SOURCE_PREPARED_RAW_INVALID');
  }
  const payload = value as Record<string, unknown>;
  const attributes = payload.attributes;
  if (
    typeof payload.name !== 'string' ||
    attributes === null ||
    typeof attributes !== 'object' ||
    Array.isArray(attributes)
  ) {
    throw new Error('MONITORED_SOURCE_PREPARED_RAW_INVALID');
  }
  return {
    name: payload.name,
    ...(typeof payload.domain === 'string' ? { domain: payload.domain } : {}),
    ...(typeof payload.country === 'string' ? { country: payload.country } : {}),
    attributes: attributes as Record<string, unknown>,
  };
}
