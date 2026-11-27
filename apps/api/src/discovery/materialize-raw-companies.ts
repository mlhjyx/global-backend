import { Prisma } from '@prisma/client';
import { ApplicationFailure } from '@temporalio/activity';
import { companyIdentity } from './identity';
import { isProductDiscoveryRawRecord, resolveEvidenceLicense } from './evidence-license';
import { loadMaterializableCompanyState } from './company-suppression-gate';
import { lockWorkspaceSuppressionPolicy } from './suppression-policy-lock';
import { partitionGovernedRawRecords } from './raw-source-governance';
import {
  canonicalCompanyAttributesEqual, mergeCanonicalCompanyAttributes,
  sanitizeCanonicalCompanyAttributes, sanitizeStoredCompanyFieldEvidence,
} from './canonical-company-attributes';

async function lockCompanyRawIdentity(
  transaction: Prisma.TransactionClient,
  workspaceId: string,
  rawRecordId: string,
): Promise<void> {
  // Prisma cannot deserialize PostgreSQL void; cast only the result, not the lock key.
  await transaction.$queryRaw(
    Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(
      ${`discovery-company-raw-identity:${workspaceId}:${rawRecordId}`}, 0
    ))::text AS locked`,
  );
}

function isPrismaUniqueCollision(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}

export async function materializeRawCompanies(
  tx: Prisma.TransactionClient,
  args: { workspaceId: string; runId: string; rawRecordIds?: string[] },
): Promise<{ companies: number; suppressed: number }> {
  // Canonical materialization participates in the same linearization
  // protocol as suppression creation and downstream PII commits. This
  // stage performs no network I/O, so the transaction-scoped lock covers
  // the authoritative suppression read and every canonical write.
  const policyLock = await lockWorkspaceSuppressionPolicy(tx, args.workspaceId);
  const candidates = await tx.rawSourceRecord.findMany({
    where: {
      runId: args.runId,
      ingestStatus: 'ACCEPTED',
      ingestVersion: 'raw-source/v2',
      ...(args.rawRecordIds ? { id: { in: args.rawRecordIds } } : {}),
    },
  });
  const restricted = candidates.length
    ? await tx.rawSourceGovernanceDisposition.findMany({
        where: {
          rawRecordId: { in: candidates.map((raw) => raw.id) },
          effect: 'RESTRICT_PROCESSING',
        },
        select: { rawRecordId: true },
      })
    : [];
  const { consumable: raws } = partitionGovernedRawRecords(
    candidates,
    new Set(restricted.map((row) => row.rawRecordId)),
  );
  const suppressions = await tx.suppressionRecord.findMany({
    where: { type: { in: ['domain', 'company_name'] } },
  });
  let companies = 0;
  let suppressed = 0;
  for (const raw of raws) {
    if (!isProductDiscoveryRawRecord(raw)) continue;
    const rec = raw.payload as unknown as {
      name?: string;
      domain?: string;
      country?: string;
      region?: string;
      industry?: string;
      employeeCount?: number;
      revenueUsd?: number;
      attributes?: Record<string, unknown>;
      identifier?: { scheme: string; value: string }; // §8.4 provider 标识（税号/注册号）
      license?: string; // §8.5 记录声明许可（绿事实源署名义务，如 TED CC BY 4.0）
    };
    if (!rec.name) continue;
    const identity = companyIdentity({
      name: rec.name,
      domain: rec.domain,
      country: rec.country,
      identifier: rec.identifier, // §8.4：无域名时按税号消歧，防同名同国不同实体误并
    });
    await lockCompanyRawIdentity(tx, args.workspaceId, raw.id);
    const materialization = await loadMaterializableCompanyState(
      tx,
      args.workspaceId,
      identity.dedupeKey,
      { name: rec.name, domain: rec.domain },
      { knownSuppressions: suppressions, policyLock },
    );
    if (!materialization.allowed) {
      suppressed += 1;
      continue;
    }

    const prior = materialization.prior;
    const existingLink = await tx.identityLink.findFirst({
      where: {
        workspaceId: args.workspaceId,
        canonicalType: 'company',
        rawRecordId: raw.id,
      },
      select: { id: true, canonicalId: true },
    });
    // Suppression admission remains first; a linked Raw observation then
    // wins before stale contribution bytes are merged into Canonical.
    if (existingLink) {
      if (prior && existingLink.canonicalId === prior.id) continue;
      throw ApplicationFailure.nonRetryable(
        'DOMAIN_ACK_DISCOVERY_COMPANY_IDENTITY_CONFLICT',
        'DOMAIN_ACK_DISCOVERY_COMPANY_IDENTITY_CONFLICT',
      );
    }

    const currentAttributes = sanitizeCanonicalCompanyAttributes(
      rec.attributes,
    );
    const canonicalAttributes = mergeCanonicalCompanyAttributes(
      prior?.attributes,
      currentAttributes,
    );
    const attributesChanged = prior
      ? materialization.attributesRequireRepair ||
        !canonicalCompanyAttributesEqual(
          canonicalAttributes,
          prior.attributes,
        )
      : true;
    const regionChanged = Boolean(
      prior &&
        typeof rec.region === 'string' &&
        rec.region !== prior.region,
    );
    const canonicalChanged = !prior || attributesChanged || regionChanged;
    const canonical = canonicalChanged
      ? await tx.canonicalCompany.upsert({
          where: {
            workspaceId_dedupeKey: {
              workspaceId: args.workspaceId,
              dedupeKey: identity.dedupeKey,
            },
          },
          update: {
            // 后到的源只补缺，不覆盖已有值（冲突留在 field_evidence 里可见）
            ...(regionChanged ? { region: { set: rec.region } } : {}),
            ...(attributesChanged
              ? {
                  attributes:
                    canonicalAttributes as Prisma.InputJsonValue,
                }
              : {}),
            version: { increment: 1 },
          },
          create: {
            workspaceId: args.workspaceId,
            name: rec.name,
            domain: rec.domain ?? null,
            country: rec.country ?? null,
            region: rec.region ?? null,
            industry: rec.industry ?? null,
            employeeCount: rec.employeeCount ?? null,
            revenueUsd: rec.revenueUsd ?? null,
            attributes: canonicalAttributes as Prisma.InputJsonValue,
            status: 'NEW',
            dedupeKey: identity.dedupeKey,
          },
        })
      : { id: prior!.id };
    if (canonicalChanged) companies += 1;

    try {
      await tx.identityLink.create({
        data: {
          workspaceId: args.workspaceId,
          canonicalType: 'company',
          canonicalId: canonical.id,
          rawRecordId: raw.id,
          matchRule: identity.matchRule,
          confidence: identity.matchRule === 'name_country' ? 0.8 : 1, // §8.4：identifier_exact 同 domain_exact=1
        },
      });
    } catch (error) {
      if (!isPrismaUniqueCollision(error)) throw error;
      // Every compliant company writer shares the advisory lock above.
      // A post-read P2002 therefore proves a non-compliant or conflicting
      // writer, and the aborted transaction must not attempt a readback.
      throw ApplicationFailure.nonRetryable(
        'DOMAIN_ACK_DISCOVERY_COMPANY_IDENTITY_CONFLICT',
        'DOMAIN_ACK_DISCOVERY_COMPANY_IDENTITY_CONFLICT',
      );
    }
    // 字段级 Evidence：该 raw 记录贡献的每个非空字段留痕
    const fields: [string, unknown][] = [
      ['name', rec.name],
      ['domain', rec.domain],
      ['country', rec.country],
      ['region', rec.region],
      ['industry', rec.industry],
      ['employee_count', rec.employeeCount],
      ['revenue_usd', rec.revenueUsd],
      ['attributes', currentAttributes],
    ];
    for (const [field, value] of fields) {
      if (value == null) continue;
      const governedValue = sanitizeStoredCompanyFieldEvidence(field, value);
      if (governedValue === undefined) continue;
      await tx.fieldEvidence.create({
        data: {
          workspaceId: args.workspaceId,
          entityType: 'company',
          entityId: canonical.id,
          field,
          value: governedValue as Prisma.InputJsonValue,
          providerKey: raw.providerKey,
          rawRecordId: raw.id,
          license: resolveEvidenceLicense(rec.license, raw.providerKey), // §8.5：记录声明许可优先（TED CC BY 4.0），否则回退不变
          allowedActions: ['display', 'match'] as unknown as Prisma.InputJsonValue,
        },
      });
    }
  }
  return { companies, suppressed };
}
