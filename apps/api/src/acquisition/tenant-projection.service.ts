import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { companyIdentity } from '../discovery/identity';
import { canonicalizeSuppressionValue, canonicalizeSuppressionValues } from '../discovery/suppression-value';
import { lockWorkspaceSuppressionPolicy } from '../discovery/suppression-policy-lock';
import { lockWorkspaceOrganizationIdentity } from '../discovery/organization-identity-root';
import { loadMaterializableCompanyState } from '../discovery/company-suppression-gate';
import { resolveOrganizationIdentityForRaw } from '../discovery/organization-identity-resolver';
import {
  MonitoredSourceRawBridgeError,
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
 * SourceEntity 先桥接成租户级不可变 RawSourceRecord，再复用 Identity v2 resolver 跨源归一；
 * SourceEntity.id 永远不能冒充 raw_record_id。
 *
 * 🔴 合规红线：**只投公司事实**（名称/域名/国家/产品/展位——🟢法人公开信息）。
 * source_entity 里的**人名邮箱（personalData=true）不投**，留在平台层隔离，走 LIA 后另议。
 * 职能邮箱（role）是法人数据，随 attributes.contact_email 投。
 */
export class TenantProjectionService {
  constructor(private readonly deps: { prisma: PrismaService }) {}

  async projectSource(workspaceId: string, sourceId: string, opts?: { limit?: number }): Promise<ProjectResult> {
    const { prisma } = this.deps;

    const source = await prisma.monitoredSource.findUnique({ where: { id: sourceId },
    });
    if (!source) throw new Error(`monitored_source ${sourceId} not found`);
    if (source.status !== 'ACTIVE') {
      return {
        sourceId,
        sourceKey: source.sourceKey,
        entities: 0,
        projected: 0,
        suppressed: 0,
        personalContactsWithheld: 0,
        status: 'SKIPPED',
        reason: `status=${source.status}`,
      };
    }

    // 平台级表无 RLS，直接读活跃实体
    const entities = await prisma.sourceEntity.findMany({
      where: { sourceId, withdrawnAt: null, entityKind: 'company' },
      ...(opts?.limit ? { take: opts.limit } : {}),
    });
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

    const sourceFetchIds = [...new Set(entities.flatMap((entity) => entity.lastSeenFetchId ? [entity.lastSeenFetchId] : []))];
    const sourceFetches = await prisma.sourceFetch.findMany({
      where: {
        sourceId,
        id: { in: sourceFetchIds },
        status: { in: ['DONE', 'PARTIAL'] },
        parserVersion: { not: null },
        finishedAt: { not: null },
      },
      select: { id: true, status: true, parserVersion: true, finishedAt: true },
    });
    const fetchById = new Map(sourceFetches.map((fetch) => [fetch.id, fetch]));
    const missingProvenance = entities.find(
      (entity) => !entity.lastSeenFetchId || !fetchById.has(entity.lastSeenFetchId),
    );
    if (missingProvenance) {
      throw new MonitoredSourceRawBridgeError(
        'MONITORED_SOURCE_FETCH_PROVENANCE_MISSING',
        `completed fetch provenance is required for source entity ${missingProvenance.id}`,
      );
    }
    const sourcePolicies = await prisma.sourcePolicy.findMany({
      select: {
        id: true,
        domain: true,
        retentionDays: true,
        reviewStatus: true,
        allowedPurpose: true,
        updatedAt: true,
      },
    });

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
        await lockWorkspaceOrganizationIdentity(tx, workspaceId);
        const suppressionRows = await tx.suppressionRecord.findMany({
          where: {
            type: { in: ['domain', 'company_name', 'email'] },
          },
          select: { type: true, value: true },
        });
        const suppressedDomains = canonicalizeSuppressionValues(
          'domain',
          suppressionRows.filter((row) => row.type === 'domain').map((row) => row.value),
        );
        const suppressedEmails = canonicalizeSuppressionValues(
          'email',
          suppressionRows.filter((row) => row.type === 'email').map((row) => row.value),
        );
        for (const e of chunk) {
          const entityFetch = fetchById.get(e.lastSeenFetchId!);
          if (!entityFetch) {
            throw new MonitoredSourceRawBridgeError(
              'MONITORED_SOURCE_FETCH_PROVENANCE_MISSING',
              `completed fetch provenance is required for source entity ${e.id}`,
            );
          }
          const cleaned = (e.cleaned ?? {}) as Record<string, unknown>;
          const identity = companyIdentity({
            name: e.name,
            domain: e.domain,
            country: e.country,
          });
          const materialization = await loadMaterializableCompanyState(
            tx,
            workspaceId,
            identity.dedupeKey,
            { name: e.name, domain: e.domain },
            { knownSuppressions: suppressionRows, policyLock },
          );
          if (!materialization.allowed) {
            suppressed += 1;
            continue;
          }

          // 合规：人名邮箱不投；职能邮箱作为法人联系点随公司走
          const roleEmailKey =
            cleaned.email_kind === 'role' && typeof cleaned.email === 'string'
              ? canonicalizeSuppressionValue('email', cleaned.email)
              : null;
          const roleEmailDomain = roleEmailKey
            ? canonicalizeSuppressionValue('domain', roleEmailKey.split('@')[1])
            : null;
          const roleEmail =
            roleEmailKey &&
            !suppressedEmails.has(roleEmailKey) &&
            (!roleEmailDomain || !suppressedDomains.has(roleEmailDomain))
              ? roleEmailKey
              : undefined;
          if (cleaned.email_kind === 'personal') personalWithheld += 1;

          // Raw contains only immutable source facts. Whether a role mailbox is
          // currently suppressed is a tenant projection decision and must never
          // alter the Raw receipt for the same source observation.
          const rawAttributes = pruneUndefined({
            products: Array.isArray(cleaned.products) ? cleaned.products : undefined,
            source_fair: cleaned.source_fair,
            source_kind: cleaned.source_kind,
            stand: cleaned.stand,
            hall: cleaned.hall,
            acquired_via: source.providerKey,
            source_key: source.sourceKey,
          });
          const canonicalAttributes = pruneUndefined({ ...rawAttributes, contact_email: roleEmail });

          const preparedBridge = prepareMonitoredSourceRawBridge({
            workspaceId,
            source,
            entity: e,
            fetch: entityFetch,
            policies: sourcePolicies,
            attributes: rawAttributes,
          });
          const raw = await persistMonitoredSourceRawBridge(tx, {
            workspaceId,
            prepared: preparedBridge,
          });
          const resolution = await resolveOrganizationIdentityForRaw(tx, {
            workspaceId,
            rawRecordId: raw.id,
            providerKey: preparedBridge.identityProviderKey,
            record: preparedBridge.record,
          });
          if (resolution.kind === 'conflict') continue;
          projected += 1;

          // Share the canonical-company linearization point with enrichment.
          // Without this lock, both paths can read a null domain and the later
          // update silently overwrite the other provider's just-promoted value.
          await tx.$queryRaw`SELECT id FROM canonical_company WHERE workspace_id = ${workspaceId}::uuid AND id = ${resolution.companyId}::uuid FOR UPDATE`;
          const canonical = await tx.canonicalCompany.findUnique({
            where: { id: resolution.companyId },
            select: { id: true, domain: true, country: true, attributes: true },
          });
          if (!canonical) {
            throw new Error('IDENTITY_V2_CANONICAL_NOT_FOUND');
          }
          await tx.canonicalCompany.update({
            where: { id: canonical.id },
            data: {
              ...(!canonical.domain && e.domain ? { domain: { set: e.domain } } : {}),
              ...(!canonical.country && e.country ? { country: { set: e.country } } : {}),
              attributes: mergeAttributes(
                withoutSuppressedContactEmail(
                  (canonical.attributes ?? {}) as Record<string, unknown>,
                  suppressedEmails,
                  suppressedDomains,
                  false,
                ),
                canonicalAttributes,
              ) as Prisma.InputJsonValue,
            },
          });

          // 字段级 Evidence 只引用真实 RawSourceRecord；数据库唯一键让 active-link replay
          // 能修复缺失投影，同时不会产生重复 Evidence。
          const fields: [string, unknown][] = [
            ['name', e.name],
            ['domain', e.domain],
            ['country', e.country],
            ['attributes', rawAttributes],
          ];
          const evidenceRows = fields.flatMap(([field, value]) =>
            value == null
              ? []
              : [{
                workspaceId,
                entityType: 'company',
                entityId: canonical.id,
                field,
                value: value as Prisma.InputJsonValue,
                providerKey: preparedBridge.identityProviderKey,
                rawRecordId: raw.id,
                license: preparedBridge.license,
                allowedActions: ['display', 'match'] as unknown as Prisma.InputJsonValue,
                fetchedAt: preparedBridge.row.fetchedAt ?? undefined,
              }],
          );
          if (evidenceRows.length) {
            await tx.fieldEvidence.createMany({ data: evidenceRows, skipDuplicates: true });
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

function withoutSuppressedContactEmail(
  attributes: Record<string, unknown>,
  suppressedEmails: ReadonlySet<string>,
  suppressedDomains: ReadonlySet<string>,
  suppressCompany: boolean,
): Record<string, unknown> {
  const current =
    typeof attributes.contact_email === 'string'
      ? canonicalizeSuppressionValue('email', attributes.contact_email)
      : null;
  const currentDomain = current ? canonicalizeSuppressionValue('domain', current.split('@')[1]) : null;
  if (
    !suppressCompany &&
    (!current || (!suppressedEmails.has(current) && (!currentDomain || !suppressedDomains.has(currentDomain))))
  )
    return attributes;
  const { contact_email: _removed, ...safe } = attributes;
  return safe;
}

function pruneUndefined(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null));
}

/** 合并已有 canonical.attributes 与新源属性：新源覆盖同名标量、**并集 products**，
 *  保留 prev 里其它键（含 gleif/wikidata/digital_footprint 等富集命名空间）。 */
function mergeAttributes(prev: Record<string, unknown>, next: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...prev, ...next };
  const prods = [
    ...(Array.isArray(prev.products) ? (prev.products as unknown[]) : []),
    ...(Array.isArray(next.products) ? (next.products as unknown[]) : []),
  ].map(String);
  if (prods.length) merged.products = [...new Set(prods)];
  return merged;
}
