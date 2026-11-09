/**
 * run 产出池的数据库读取（`buildRecallPoolExport` 的取数层）。
 *
 * 租户表（outcome / canonical_company / canonical_contact）必须经 withWorkspace 事务
 * （app_user + set_config）；本函数只接收已带 workspace 上下文的 client。
 * CLI（scripts/frames/recall-pool-export.mts）以 owner 连接运行并显式按 workspaceId 过滤。
 */
import type { Prisma } from '@prisma/client';
import {
  parseRegistryExternalId,
  REGISTRY_POOL_PROVIDER_KEYS,
  type RecallPoolSourceRow,
} from './recall-pool-export';

type PoolSourceClient = Pick<
  Prisma.TransactionClient,
  'discoveryCompanyMaterializationOutcome' | 'rawSourceRecord' | 'canonicalCompany' | 'canonicalContact'
>;

export async function loadRunPoolSourceRows(
  client: PoolSourceClient,
  workspaceId: string,
  runId: string,
): Promise<RecallPoolSourceRow[]> {
  const outcomes = await client.discoveryCompanyMaterializationOutcome.findMany({
    where: { workspaceId, runId, canonicalCompanyId: { not: null } },
    select: { canonicalCompanyId: true, rawRecordId: true },
    orderBy: [{ queryOrdinal: 'asc' }, { recordIndex: 'asc' }],
  });
  if (outcomes.length === 0) return [];

  // 每个公司保留第一条物化记录的注册身份（同公司多记录时以先到者为准）。
  const companyIds: string[] = [];
  const seen = new Set<string>();
  const rawIdByCompany = new Map<string, string>();
  for (const outcome of outcomes) {
    const companyId = outcome.canonicalCompanyId!;
    if (seen.has(companyId)) continue;
    seen.add(companyId);
    companyIds.push(companyId);
    rawIdByCompany.set(companyId, outcome.rawRecordId);
  }

  const [rawRecords, companies, contactCounts] = await Promise.all([
    client.rawSourceRecord.findMany({
      where: { id: { in: [...rawIdByCompany.values()] } },
      select: { id: true, externalId: true, providerKey: true },
    }),
    client.canonicalCompany.findMany({
      where: { id: { in: companyIds }, workspaceId },
      select: { id: true, name: true, domain: true },
    }),
    client.canonicalContact.groupBy({
      by: ['companyId'],
      where: { workspaceId, companyId: { in: companyIds } },
      _count: { _all: true },
    }),
  ]);

  const rawById = new Map(rawRecords.map((record) => [record.id, record]));
  const companyById = new Map(companies.map((company) => [company.id, company]));
  const contactsByCompany = new Map(
    contactCounts.map((count) => [count.companyId, count._count._all]),
  );

  const rows: RecallPoolSourceRow[] = [];
  for (const companyId of companyIds) {
    const company = companyById.get(companyId);
    if (!company) continue; // 公司行不存在（跨 workspace 或已删）→ 不参与池。
    const raw = rawById.get(rawIdByCompany.get(companyId)!);
    const registry =
      raw && REGISTRY_POOL_PROVIDER_KEYS.includes(raw.providerKey)
        ? parseRegistryExternalId(raw.externalId)
        : null;
    rows.push({
      companyId,
      name: company.name,
      domain: company.domain,
      registryScheme: registry?.scheme ?? null,
      registryNumber: registry?.number ?? null,
      contacts: contactsByCompany.get(companyId) ?? 0,
    });
  }
  return rows;
}
