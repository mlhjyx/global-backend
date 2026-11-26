import { Prisma, type PrismaClient } from '@prisma/client';
import {
  blindContactKey,
  blindContactKeyCandidates,
  blindPlatformKey,
  decryptPii,
  decryptPlatformPii,
  encryptPii,
  getActivePiiKeyId,
  isBlindedContactKey,
  needsBlindReindex,
  needsPiiReencryption,
  PII_PURPOSE,
  reencryptPii,
  reencryptPlatformPii,
} from './pii-crypto';
import { emailDomainOfAddress } from '../discovery/contact-point-verification-state';
import {
  mergeOrReparentContactPoint,
  rekeyContactPointPii,
} from '../discovery/contact-point-writer';
import { contactIdentity, declinedContactIdentity } from '../discovery/identity';
import { foldedPersonNameKey } from '../discovery/person-name';
import {
  assertScopedDatabasePrincipal,
  EXECUTION_BUDGET_PLATFORM_WRITER_ROLE,
} from '../runtime/scoped-database-principal';

const PII_TYPES = ['email', 'phone', 'linkedin'];
const STATUS_RANK: Record<string, number> = {
  VALID: 3,
  RISKY: 2,
  INVALID: 1,
  UNVERIFIED: 0,
};

export interface WorkspaceReencryptionCounts {
  workspaceId: string;
  names: number;
  dedupeKeys: number;
  unmatchedDedupeKeys: number;
  merges: number;
  points: number;
  domainBlindKeys: number;
  dedup: number;
  evidence: number;
}

export interface PlatformReencryptionCounts {
  patentCacheNames: number;
  patentCacheKeys: number;
  patentCacheDedup: number;
  channelRecords: number;
}

export interface ReencryptionRunSummary {
  dryRun: boolean;
  activeKeyId: string;
  workspacesScanned: number;
  workspaceCounts: WorkspaceReencryptionCounts[];
  platformCounts: PlatformReencryptionCounts;
}

function strongerVerification(
  kept: { status: string; verifiedAt: Date | null },
  incoming: { status: string; verifiedAt: Date | null },
): { status: string; verifiedAt: Date | null } | null {
  const rk = STATUS_RANK[kept.status] ?? 0;
  const ri = STATUS_RANK[incoming.status] ?? 0;
  if (ri > rk) return { status: incoming.status, verifiedAt: incoming.verifiedAt };
  if (ri === rk) {
    const iv = incoming.verifiedAt?.getTime() ?? -1;
    const kv = kept.verifiedAt?.getTime() ?? -1;
    if (iv > kv) return { status: kept.status, verifiedAt: incoming.verifiedAt };
  }
  return null;
}

function pointNormKey(
  pt: { type: string; value: string },
  workspaceId: string,
): string {
  if (!PII_TYPES.includes(pt.type)) return `${pt.type} ${pt.value}`;
  const plaintext = decryptPii(pt.value, {
    workspaceId,
    purpose: PII_PURPOSE.CONTACT_POINT_VALUE,
    allowLegacyPlaintext: true,
  });
  const canonical = encryptPii(plaintext, {
    workspaceId,
    purpose: PII_PURPOSE.CONTACT_POINT_VALUE,
  });
  return `${pt.type} ${canonical}`;
}

async function mergeContactInto(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  fromId: string,
  toId: string,
): Promise<void> {
  const [fromPoints, toPoints, from, to] = await Promise.all([
    tx.contactPoint.findMany({ where: { contactId: fromId } }),
    tx.contactPoint.findMany({ where: { contactId: toId } }),
    tx.canonicalContact.findUnique({
      where: { id: fromId },
      select: { title: true, seniority: true, department: true },
    }),
    tx.canonicalContact.findUnique({
      where: { id: toId },
      select: { title: true, seniority: true, department: true },
    }),
  ]);
  const toByKey = new Map(toPoints.map((pt) => [pointNormKey(pt, workspaceId), pt]));
  for (const fp of fromPoints) {
    const key = pointNormKey(fp, workspaceId);
    const match = toByKey.get(key);
    if (match) {
      const upd = strongerVerification(match, fp);
      await mergeOrReparentContactPoint(tx, {
        kind: 'deduplicate',
        survivorPointId: match.id,
        duplicatePointId: fp.id,
        promotedVerification: upd,
      });
      if (upd) {
        toByKey.set(key, { ...match, status: upd.status, verifiedAt: upd.verifiedAt });
      }
    } else {
      await mergeOrReparentContactPoint(tx, {
        kind: 'reparent',
        pointId: fp.id,
        targetContactId: toId,
      });
      toByKey.set(key, { ...fp, contactId: toId });
    }
  }
  const patch: { title?: string; seniority?: string; department?: string } = {};
  if (from?.title && !to?.title) patch.title = from.title;
  if (from?.seniority && !to?.seniority) patch.seniority = from.seniority;
  if (from?.department && !to?.department) patch.department = from.department;
  if (Object.keys(patch).length > 0) {
    await tx.canonicalContact.update({ where: { id: toId }, data: patch });
  }
  await tx.fieldEvidence.updateMany({
    where: { entityType: 'contact', entityId: fromId },
    data: { entityId: toId },
  });
  await tx.canonicalContact.delete({ where: { id: fromId } });
}

function candidateRawContactKeys(input: {
  fullName: string;
  companyKey: string;
  emails: string[];
  externalIds: Array<{ scheme: string; value: string }>;
}): string[] {
  const rawKeys = new Set<string>();
  rawKeys.add(contactIdentity({ fullName: input.fullName }, input.companyKey));
  rawKeys.add(
    declinedContactIdentity(
      { fullName: input.fullName, externalIds: input.externalIds },
      input.companyKey,
    ),
  );
  rawKeys.add(declinedContactIdentity({ fullName: input.fullName }, input.companyKey));
  for (const email of input.emails) {
    rawKeys.add(contactIdentity({ fullName: input.fullName, email }, input.companyKey));
    rawKeys.add(
      declinedContactIdentity(
        { fullName: input.fullName, email, externalIds: input.externalIds },
        input.companyKey,
      ),
    );
    rawKeys.add(declinedContactIdentity({ fullName: input.fullName, email }, input.companyKey));
  }
  return [...rawKeys];
}

function resolveUpgradedDedupeKey(input: {
  workspaceId: string;
  storedDedupeKey: string;
  fullNamePlain: string;
  companyKey: string;
  points: Array<{ type: string; value: string }>;
}): string | null {
  if (!isBlindedContactKey(input.storedDedupeKey)) {
    return blindContactKey(input.storedDedupeKey, {
      workspaceId: input.workspaceId,
      purpose: PII_PURPOSE.CONTACT_DEDUPE_KEY,
    });
  }
  const emails: string[] = [];
  const externalIds: Array<{ scheme: string; value: string }> = [];
  for (const pt of input.points) {
    if (pt.type === 'email') {
      try {
        emails.push(
          decryptPii(pt.value, {
            workspaceId: input.workspaceId,
            purpose: PII_PURPOSE.CONTACT_POINT_VALUE,
            allowLegacyPlaintext: true,
          }),
        );
      } catch {
        // Ignore undecryptable point when matching historical dedupeKey.
      }
    } else if (pt.type === 'external_id') {
      const idx = pt.value.indexOf(':');
      if (idx > 0) {
        externalIds.push({
          scheme: pt.value.slice(0, idx),
          value: pt.value.slice(idx + 1),
        });
      }
    }
  }
  const rawCandidates = candidateRawContactKeys({
    fullName: input.fullNamePlain,
    companyKey: input.companyKey,
    emails,
    externalIds,
  });
  for (const raw of rawCandidates) {
    const candidates = blindContactKeyCandidates(raw, {
      workspaceId: input.workspaceId,
      purpose: PII_PURPOSE.CONTACT_DEDUPE_KEY,
    });
    if (candidates.some((c) => c === input.storedDedupeKey)) {
      return blindContactKey(raw, {
        workspaceId: input.workspaceId,
        purpose: PII_PURPOSE.CONTACT_DEDUPE_KEY,
      });
    }
  }
  return null;
}

/**
 * Enumerates workspace IDs via the M4-hardened `list_platform_workspace_ids_v1()` RPC
 * (requires `execution_budget_platform_writer` principal).
 */
export async function listPlatformWorkspaceIds(
  platformWriter: PrismaClient,
): Promise<string[]> {
  await assertScopedDatabasePrincipal(
    platformWriter,
    EXECUTION_BUDGET_PLATFORM_WRITER_ROLE,
    'PiiReencryption',
  );
  const rows = await platformWriter.$queryRaw<Array<{ id: string }>>(
    Prisma.sql`SELECT id::text AS id FROM public.list_platform_workspace_ids_v1()`,
  );
  return rows.map((row) => row.id);
}

/**
 * Re-encrypts & upgrades blind indexes for one workspace using a raw (un-extended)
 * `app_user` PrismaClient inside an RLS-scoped transaction (`set_config('app.current_workspace_id')`).
 */
export async function reencryptWorkspacePiiBatch(
  appDb: PrismaClient,
  workspaceId: string,
  options: { dryRun?: boolean; activeKeyId?: string } = {},
): Promise<WorkspaceReencryptionCounts> {
  const dryRun = options.dryRun ?? false;
  const activeKeyId = options.activeKeyId ?? getActivePiiKeyId();
  const counts: WorkspaceReencryptionCounts = {
    workspaceId,
    names: 0,
    dedupeKeys: 0,
    unmatchedDedupeKeys: 0,
    merges: 0,
    points: 0,
    domainBlindKeys: 0,
    dedup: 0,
    evidence: 0,
  };

  await appDb.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_workspace_id', ${workspaceId}, true)`;

      const contacts = await tx.canonicalContact.findMany({
        select: {
          id: true,
          fullName: true,
          dedupeKey: true,
          company: { select: { dedupeKey: true } },
          contactPoints: { select: { type: true, value: true } },
        },
        orderBy: { id: 'asc' },
      });

      for (const c of contacts) {
        const needName = needsPiiReencryption(c.fullName, activeKeyId);
        const needKey = needsBlindReindex(c.dedupeKey, activeKeyId);
        if (!needName && !needKey) continue;

        const fullNamePlain = decryptPii(c.fullName, {
          workspaceId,
          purpose: PII_PURPOSE.CANONICAL_CONTACT_FULL_NAME,
          allowLegacyPlaintext: true,
        });

        let targetKey: string | null = null;
        if (needKey) {
          targetKey = resolveUpgradedDedupeKey({
            workspaceId,
            storedDedupeKey: c.dedupeKey,
            fullNamePlain,
            companyKey: c.company.dedupeKey,
            points: c.contactPoints,
          });
          if (!targetKey) {
            counts.unmatchedDedupeKeys += 1;
          } else if (targetKey !== c.dedupeKey) {
            const survivor = await tx.canonicalContact.findFirst({
              where: {
                workspaceId,
                dedupeKey: targetKey,
                NOT: { id: c.id },
              },
              select: { id: true },
            });
            if (survivor) {
              if (!dryRun) {
                await mergeContactInto(tx, workspaceId, c.id, survivor.id);
              }
              counts.merges += 1;
              continue;
            }
          }
        }

        const data: { fullName?: string; dedupeKey?: string } = {};
        if (needName) {
          data.fullName = encryptPii(fullNamePlain, {
            workspaceId,
            purpose: PII_PURPOSE.CANONICAL_CONTACT_FULL_NAME,
          });
          counts.names += 1;
        }
        if (targetKey && targetKey !== c.dedupeKey) {
          data.dedupeKey = targetKey;
          counts.dedupeKeys += 1;
        }
        if (!dryRun && (data.fullName !== undefined || data.dedupeKey !== undefined)) {
          await tx.canonicalContact.update({ where: { id: c.id }, data });
        }
      }

      const points = await tx.contactPoint.findMany({
        where: { type: { in: PII_TYPES } },
        select: {
          id: true,
          contactId: true,
          type: true,
          value: true,
          status: true,
          verifiedAt: true,
          domainBlindKey: true,
        },
        orderBy: { id: 'asc' },
      });

      for (const p of points) {
        const needValue = needsPiiReencryption(p.value, activeKeyId);
        const needDomainBlind =
          p.type === 'email' &&
          p.domainBlindKey !== null &&
          needsBlindReindex(p.domainBlindKey, activeKeyId);
        if (!needValue && !needDomainBlind) continue;

        const plaintext = decryptPii(p.value, {
          workspaceId,
          purpose: PII_PURPOSE.CONTACT_POINT_VALUE,
          allowLegacyPlaintext: true,
        });
        const targetValue = needValue
          ? encryptPii(plaintext, {
              workspaceId,
              purpose: PII_PURPOSE.CONTACT_POINT_VALUE,
            })
          : p.value;

        let targetDomainBlind: string | undefined;
        if (needDomainBlind) {
          const domain = emailDomainOfAddress(plaintext);
          if (domain) {
            targetDomainBlind = blindContactKey(`domain:${domain}`, {
              workspaceId,
              purpose: PII_PURPOSE.DOMAIN_BLIND_KEY,
            });
          }
        }

        if (needValue) {
          const existing = await tx.contactPoint.findFirst({
            where: {
              contactId: p.contactId,
              type: p.type,
              value: targetValue,
              NOT: { id: p.id },
            },
            select: { id: true, status: true, verifiedAt: true },
          });
          if (existing) {
            if (!dryRun) {
              const upd = strongerVerification(existing, p);
              await mergeOrReparentContactPoint(tx, {
                kind: 'deduplicate',
                survivorPointId: existing.id,
                duplicatePointId: p.id,
                promotedVerification: upd,
              });
            }
            counts.dedup += 1;
            continue;
          }
        }

        const updateData: { value?: string; domainBlindKey?: string } = {};
        if (needValue) {
          updateData.value = targetValue;
          counts.points += 1;
        }
        if (targetDomainBlind !== undefined) {
          updateData.domainBlindKey = targetDomainBlind;
          counts.domainBlindKeys += 1;
        }
        if (!dryRun && (updateData.value !== undefined || updateData.domainBlindKey !== undefined)) {
          await rekeyContactPointPii(tx, {
            pointId: p.id,
            ...updateData,
          });
        }
      }

      const scalars = await tx.fieldEvidence.findMany({
        where: { field: { in: PII_TYPES } },
        select: { id: true, value: true },
      });
      for (const e of scalars) {
        if (typeof e.value === 'string' && needsPiiReencryption(e.value, activeKeyId)) {
          const upgraded = reencryptPii(e.value, {
            workspaceId,
            purpose: PII_PURPOSE.FIELD_EVIDENCE_VALUE,
            allowLegacyPlaintext: true,
          });
          if (!dryRun) {
            await tx.fieldEvidence.update({
              where: { id: e.id },
              data: { value: upgraded },
            });
          }
          counts.evidence += 1;
        }
      }

      const guesses = await tx.fieldEvidence.findMany({
        where: { field: 'email.guess' },
        select: { id: true, value: true },
      });
      for (const g of guesses) {
        const v = g.value as { email?: unknown } | null;
        if (v && typeof v.email === 'string' && needsPiiReencryption(v.email, activeKeyId)) {
          const upgraded = reencryptPii(v.email, {
            workspaceId,
            purpose: PII_PURPOSE.FIELD_EVIDENCE_VALUE,
            allowLegacyPlaintext: true,
          });
          if (!dryRun) {
            await tx.fieldEvidence.update({
              where: { id: g.id },
              data: { value: { ...v, email: upgraded } },
            });
          }
          counts.evidence += 1;
        }
      }
    },
    { maxWait: 10_000, timeout: 60_000 },
  );

  return counts;
}

/**
 * Re-encrypts platform-scoped PII tables (`patent_inventor_cache` and `source_channel_record`)
 * via an `execution_budget_platform_writer` PrismaClient.
 */
export async function reencryptPlatformPiiBatch(
  platformWriter: PrismaClient,
  options: { dryRun?: boolean; activeKeyId?: string } = {},
): Promise<PlatformReencryptionCounts> {
  await assertScopedDatabasePrincipal(
    platformWriter,
    EXECUTION_BUDGET_PLATFORM_WRITER_ROLE,
    'PiiReencryption',
  );
  const dryRun = options.dryRun ?? false;
  const activeKeyId = options.activeKeyId ?? getActivePiiKeyId();
  const counts: PlatformReencryptionCounts = {
    patentCacheNames: 0,
    patentCacheKeys: 0,
    patentCacheDedup: 0,
    channelRecords: 0,
  };

  const patentRows = await platformWriter.patentInventorCache.findMany({
    select: {
      id: true,
      assigneeNorm: true,
      assigneeCountry: true,
      inventorName: true,
      inventorNameKey: true,
    },
    orderBy: { id: 'asc' },
  });

  for (const row of patentRows) {
    const needName = needsPiiReencryption(row.inventorName, activeKeyId);
    const needKey =
      row.inventorNameKey !== '' && needsBlindReindex(row.inventorNameKey, activeKeyId);
    if (!needName && !needKey) continue;

    const plainName = decryptPlatformPii(row.inventorName, {
      scope: 'patent_inventor_cache',
      purpose: PII_PURPOSE.PATENT_INVENTOR_NAME,
      allowLegacyPlaintext: true,
    });
    const nextName = needName
      ? reencryptPlatformPii(plainName, {
          scope: 'patent_inventor_cache',
          purpose: PII_PURPOSE.PATENT_INVENTOR_NAME,
          allowLegacyPlaintext: true,
        })
      : row.inventorName;

    if (needName) {
      const collision = await platformWriter.patentInventorCache.findFirst({
        where: {
          assigneeNorm: row.assigneeNorm,
          assigneeCountry: row.assigneeCountry,
          inventorName: nextName,
          NOT: { id: row.id },
        },
        select: { id: true },
      });
      if (collision) {
        if (!dryRun) {
          await platformWriter.patentInventorCache.delete({ where: { id: row.id } });
        }
        counts.patentCacheDedup += 1;
        continue;
      }
    }

    const updateData: { inventorName?: string; inventorNameKey?: string } = {};
    if (needName) {
      updateData.inventorName = nextName;
      counts.patentCacheNames += 1;
    }
    if (needKey) {
      const folded = foldedPersonNameKey(plainName);
      if (folded) {
        updateData.inventorNameKey = blindPlatformKey(folded, {
          scope: 'patent_inventor_cache',
          purpose: PII_PURPOSE.PATENT_INVENTOR_KEY,
        });
        counts.patentCacheKeys += 1;
      }
    }
    if (!dryRun && (updateData.inventorName !== undefined || updateData.inventorNameKey !== undefined)) {
      await platformWriter.patentInventorCache.update({
        where: { id: row.id },
        data: updateData,
      });
    }
  }

  let cursor: string | null = null;
  const pageSize = 200;
  for (;;) {
    const batch: Array<{
      id: string;
      contactName: string | null;
      contactTitle: string | null;
      email: string | null;
      phone: string | null;
    }> = await platformWriter.sourceChannelRecord.findMany({
      where: {
        ...(cursor ? { id: { gt: cursor } } : {}),
        OR: [
          { contactName: { not: null } },
          { contactTitle: { not: null } },
          { email: { not: null } },
          { phone: { not: null } },
        ],
      },
      select: {
        id: true,
        contactName: true,
        contactTitle: true,
        email: true,
        phone: true,
      },
      orderBy: { id: 'asc' },
      take: pageSize,
    });
    if (batch.length === 0) break;

    for (const row of batch) {
      const patch: {
        contactName?: string;
        contactTitle?: string;
        email?: string;
        phone?: string;
      } = {};
      const fieldSpecs = [
        ['contactName', PII_PURPOSE.SOURCE_CHANNEL_CONTACT_NAME],
        ['contactTitle', PII_PURPOSE.SOURCE_CHANNEL_CONTACT_TITLE],
        ['email', PII_PURPOSE.SOURCE_CHANNEL_EMAIL],
        ['phone', PII_PURPOSE.SOURCE_CHANNEL_PHONE],
      ] as const;

      for (const [field, purpose] of fieldSpecs) {
        const val = row[field];
        if (typeof val === 'string' && needsPiiReencryption(val, activeKeyId)) {
          patch[field] = reencryptPlatformPii(val, {
            scope: 'source_channel_record',
            purpose,
            deterministic: false,
            allowLegacyPlaintext: true,
          });
        }
      }

      if (Object.keys(patch).length > 0) {
        if (!dryRun) {
          await platformWriter.sourceChannelRecord.update({
            where: { id: row.id },
            data: patch,
          });
        }
        counts.channelRecords += 1;
      }
    }

    cursor = batch[batch.length - 1]!.id;
    if (batch.length < pageSize) break;
  }

  return counts;
}
