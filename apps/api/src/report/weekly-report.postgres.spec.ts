import { createHash, randomInt, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { NotFoundException } from '@nestjs/common';
import { parse } from 'csv-parse/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DataRightsService } from '../compliance/data-rights.service';
import { PrismaService } from '../prisma/prisma.service';
import { SanctionsScreeningService } from '../sanctions/sanctions-screening.service';
import { WEEKLY_REPORT_COLUMNS } from './weekly-report-row';
import { WeeklyReportService } from './weekly-report.service';

/*
 * BI-22 weekly report on PostgreSQL. Explicitly opted-in, disposable and migrated (`prisma migrate
 * deploy`) database only. The owner connection (a superuser, which bypasses RLS) builds and removes
 * synthetic `.example` fixtures; the report itself runs as app_user through the production
 * PrismaService, so row-level security, the app_user grants and the append-only
 * policy_decision_log are what the assertions prove.
 *
 * Not in CI. Run by hand against a throwaway container, for example:
 *   docker run -d --rm --name weekly-report-pg -e POSTGRES_USER=global -e POSTGRES_PASSWORD=<pw> \
 *     -e POSTGRES_DB=weekly_report_test --tmpfs /var/lib/postgresql/data -p 127.0.0.1:55671:5432 \
 *     pgvector/pgvector:pg16
 *   DATABASE_URL=postgresql://global:<pw>@127.0.0.1:55671/weekly_report_test \
 *     pnpm --filter @global/db exec prisma migrate deploy
 *   WEEKLY_REPORT_TEST_DATABASE_URL=postgresql://global:<pw>@127.0.0.1:55671/weekly_report_test \
 *   WEEKLY_REPORT_TEST_APP_DATABASE_URL=postgresql://app_user:app_pw@127.0.0.1:55671/weekly_report_test \
 *     pnpm --filter @global/api exec vitest run src/report/weekly-report.postgres.spec.ts
 *   docker rm -f weekly-report-pg
 * (app_user and its password come from the migration 20260706033625_rls_and_app_role.)
 */
const ownerUrl = process.env.WEEKLY_REPORT_TEST_DATABASE_URL;
const appUrl = process.env.WEEKLY_REPORT_TEST_APP_DATABASE_URL;
if (Boolean(ownerUrl) !== Boolean(appUrl)) {
  throw new Error('weekly report test needs both WEEKLY_REPORT_TEST_DATABASE_URL and WEEKLY_REPORT_TEST_APP_DATABASE_URL');
}
const urls = [ownerUrl, appUrl].filter((value): value is string => Boolean(value)).map((value) => new URL(value));
if (
  urls.some(
    (url) =>
      url.protocol !== 'postgresql:' ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      !/^\/[a-z0-9_]+_test$/u.test(url.pathname) ||
      url.host !== urls[0]!.host ||
      url.pathname !== urls[0]!.pathname,
  )
) {
  throw new Error('weekly report test requires one loopback *_test database');
}

const COST_COLUMN = '本条成本 USD（所属发现 run 合计，后端账本口径，未按线索分摊）';
/** Constants the materialization and query receipt CHECKs pin; the report does not read them. */
const MATERIALIZATION_CONTRACT_SHA256 = '558e526a674a7eac4e5e83d03fcf4f635c15b1b3081cffc7f03c2d9213c0c9fe';
const QUERY_CONTRACT_SHA256 = 'c665fc06432925532b3caa20824f9b9a310ce0bdfc497b3c0e688527badcbe0c';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/** Lower-case letters only, so no fixture value carries a long digit run. */
function letters(count: number): string {
  return Array.from({ length: count }, () => String.fromCharCode(97 + randomInt(26))).join('');
}

function records(csv: string): Array<Record<string, string>> {
  const rows = parse(csv, { bom: true }) as string[][];
  expect(rows[0]).toEqual([...WEEKLY_REPORT_COLUMNS]);
  return rows.slice(1).map((row) => Object.fromEntries(WEEKLY_REPORT_COLUMNS.map((column, index) => [column, row[index]!])));
}

describe.runIf(Boolean(ownerUrl && appUrl))('weekly report on PostgreSQL as app_user (BI-22)', { timeout: 120_000 }, () => {
  // Created only when the suite runs: collecting a skipped suite still executes this body.
  let owner: PrismaClient;
  let app: PrismaService;
  let service: WeeklyReportService;
  const suffix = letters(6);
  const workspaceA = randomUUID();
  const workspaceB = randomUUID();
  const icp = randomUUID();
  const otherIcp = randomUUID();
  const icpB = randomUUID();
  const operator = `operator-${suffix}`;
  const inWeek = new Date('2026-10-13T10:00:00.000Z'); // 2026-W42
  const lastWeek = new Date('2026-10-09T10:00:00.000Z'); // 2026-W41
  const companies = {
    exported: randomUUID(),
    suppressed: randomUUID(),
    noEvidence: randomUUID(),
    quarantined: randomUUID(),
    lastWeek: randomUUID(),
    reaccepted: randomUUID(),
    rejected: randomUUID(),
    otherIcp: randomUUID(),
    workspaceB: randomUUID(),
  };
  const leads = Object.fromEntries(Object.keys(companies).map((key) => [key, randomUUID()])) as Record<
    keyof typeof companies,
    string
  >;
  const site = `https://pumpen-${suffix}.example`;
  const runs = { beforeAccept: randomUUID(), afterAccept: randomUUID(), reaccepted: randomUUID() };

  /*
   * A discovery run of the ICP that materialized the company, one query receipt and its budget
   * account: the outcome → run → receipt → account chain the cost column reads. The governed
   * lineage upstream of a materialization outcome (admission, batch receipt, Q item, governed
   * subjects and relations) is not what this report reads, so these rows are written with FK and
   * row triggers off (session_replication_role = replica, as other suites do for upstream chains);
   * every CHECK constraint still applies.
   */
  async function materializedBy(input: {
    companyId: string;
    runId: string;
    createdAt: Date;
    chargedMicrousd: bigint;
    reservedMicrousd: bigint;
  }): Promise<void> {
    const requestSha256 = sha256(`weekly-report:${input.runId}`);
    const accountKey = `discovery.run:discovery_run:request:${requestSha256}:${requestSha256}`;
    const queryKey = sha256(`weekly-report-query:${input.runId}`);
    await owner.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
      await tx.$executeRaw`
        INSERT INTO discovery_run(id, workspace_id, plan_id, icp_id, status, created_at)
        VALUES (${input.runId}::uuid, ${workspaceA}::uuid, ${randomUUID()}::uuid, ${icp}::uuid, 'DONE', ${input.createdAt})`;
      await tx.$executeRaw`
        INSERT INTO tool_budget_account(id, scope_key, account_key, generation, cap_cents, reserved_cents,
          charged_cents, exhausted, ref_count, authority_id, authorized_cap_microusd, reserved_microusd,
          charged_microusd, created_at, updated_at)
        VALUES (${randomUUID()}::uuid, ${workspaceA}, ${accountKey}, 1, 0, 0, 0, false, 1, ${randomUUID()}::uuid,
          100000000, ${input.reservedMicrousd}, ${input.chargedMicrousd}, now(), now())`;
      await tx.$executeRaw`
        INSERT INTO discovery_query_receipt(workspace_id, run_id, plan_id, authority_id, account_key, purpose,
          subject_type, subject_id, request_sha256, query_key, query_ordinal, source_class, providers,
          provider_count, record_count, accepted_count, quarantined_count, rejected_count, duplicate_count,
          governance_denied_count, usage_quantity, cost_cents, contract_sha256)
        SELECT ${workspaceA}::uuid, run.id, run.plan_id, ${randomUUID()}::uuid, ${accountKey}, 'discovery.run',
          'discovery_run', ${`request:${requestSha256}`}, ${requestSha256}, ${queryKey}, 0, 'public_intelligence',
          '["public_web"]'::jsonb, 1, 1, 1, 0, 0, 0, 0, 1, 0, ${QUERY_CONTRACT_SHA256}
        FROM discovery_run run WHERE run.id = ${input.runId}::uuid`;
      await tx.$executeRaw`
        INSERT INTO discovery_company_materialization_outcome(workspace_id, admission_id, run_id, query_item_id,
          query_key, query_ordinal, provider_key, operation_id, record_index, raw_record_id,
          raw_governed_subject_id, q_relation_id, q_ingest_status, batch_ordinal, outcome, canonical_company_id,
          identity_link_id, identity_canonical_type, canonical_governed_subject_id,
          canonical_governed_subject_type, c_relation_id, c_relation_key, match_rule, confidence, mutation_class,
          evidence_count, evidence_manifest_sha256, contract_sha256)
        VALUES (${workspaceA}::uuid, ${randomUUID()}::uuid, ${input.runId}::uuid, ${randomUUID()}::uuid, ${queryKey},
          0, 'public_web', ${randomUUID()}::uuid, 0, ${randomUUID()}::uuid, ${randomUUID()}::uuid,
          ${randomUUID()}::uuid, 'ACCEPTED', 0, 'CANONICALIZED', ${input.companyId}::uuid, ${randomUUID()}::uuid,
          'company', ${randomUUID()}::uuid, 'canonical_company', ${randomUUID()}::uuid,
          'discovery.canonical_company:0', 'domain_exact', 1, 'CREATED', 1, ${sha256(input.runId)},
          ${MATERIALIZATION_CONTRACT_SHA256})`;
    });
  }

  beforeAll(async () => {
    owner = new PrismaClient({ datasourceUrl: ownerUrl });
    const previous = process.env.APP_DATABASE_URL;
    process.env.APP_DATABASE_URL = appUrl;
    try {
      app = new PrismaService();
    } finally {
      if (previous === undefined) delete process.env.APP_DATABASE_URL;
      else process.env.APP_DATABASE_URL = previous;
    }
    const [identity] = await app.$queryRaw<{ current: string; superuser: string; bypassrls: boolean }[]>`
      SELECT current_user::text AS current, current_setting('is_superuser') AS superuser,
        (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypassrls`;
    // RLS is only proven by a principal it applies to: a superuser or BYPASSRLS session passes silently.
    if (identity?.current !== 'app_user' || identity.superuser !== 'off' || identity.bypassrls !== false) {
      throw new Error('weekly report test must run the report as app_user without RLS bypass');
    }
    const dataRights = new DataRightsService(app);
    // Never initialized: no enabled sanctions source, so live screening reports not_screened.
    const sanctions = new SanctionsScreeningService(app);
    service = new WeeklyReportService(app, dataRights, sanctions);

    for (const [workspace, icpIds] of [
      [workspaceA, [icp, otherIcp]],
      [workspaceB, [icpB]],
    ] as const) {
      await owner.workspace.create({ data: { id: workspace, name: `weekly-report-${suffix}` } });
      const seller = await owner.companyProfile.create({ data: { workspaceId: workspace, name: `Seller ${suffix}` } });
      for (const id of icpIds) {
        await owner.icpDefinition.create({
          data: { id, workspaceId: workspace, companyId: seller.id, name: `ICP ${suffix}`, status: 'ACTIVE' },
        });
      }
    }

    const fixtures: Array<{
      key: keyof typeof companies;
      workspace: string;
      icpId: string;
      status: 'QUALIFIED' | 'REJECTED';
      companyStatus: string;
      acceptedAt: Date;
      evidence: boolean | 'synthetic';
    }> = [
      { key: 'exported', workspace: workspaceA, icpId: icp, status: 'QUALIFIED', companyStatus: 'ENRICHED', acceptedAt: inWeek, evidence: true },
      { key: 'suppressed', workspace: workspaceA, icpId: icp, status: 'QUALIFIED', companyStatus: 'SUPPRESSED', acceptedAt: inWeek, evidence: true },
      { key: 'noEvidence', workspace: workspaceA, icpId: icp, status: 'QUALIFIED', companyStatus: 'ENRICHED', acceptedAt: inWeek, evidence: false },
      { key: 'quarantined', workspace: workspaceA, icpId: icp, status: 'QUALIFIED', companyStatus: 'ENRICHED', acceptedAt: inWeek, evidence: 'synthetic' },
      { key: 'lastWeek', workspace: workspaceA, icpId: icp, status: 'QUALIFIED', companyStatus: 'ENRICHED', acceptedAt: lastWeek, evidence: true },
      // Accepted in W40, rejected, accepted again in W41 (decisions written below): W41 only.
      { key: 'reaccepted', workspace: workspaceA, icpId: icp, status: 'QUALIFIED', companyStatus: 'ENRICHED', acceptedAt: new Date('2026-10-02T10:00:00.000Z'), evidence: true },
      { key: 'rejected', workspace: workspaceA, icpId: icp, status: 'REJECTED', companyStatus: 'ENRICHED', acceptedAt: inWeek, evidence: true },
      { key: 'otherIcp', workspace: workspaceA, icpId: otherIcp, status: 'QUALIFIED', companyStatus: 'ENRICHED', acceptedAt: inWeek, evidence: true },
      { key: 'workspaceB', workspace: workspaceB, icpId: icpB, status: 'QUALIFIED', companyStatus: 'ENRICHED', acceptedAt: inWeek, evidence: true },
    ];
    for (const fixture of fixtures) {
      const companyId = companies[fixture.key];
      const domain = `${fixture.key.toLowerCase()}-${suffix}.example`;
      await owner.canonicalCompany.create({
        data: {
          id: companyId,
          workspaceId: fixture.workspace,
          name: fixture.key === 'exported' ? `Pumpen ${suffix} GmbH` : `${fixture.key} ${suffix} GmbH`,
          domain: fixture.key === 'exported' ? `pumpen-${suffix}.example` : domain,
          country: 'DE',
          status: fixture.companyStatus,
          dedupeKey: `d:${domain}`,
          attributes:
            fixture.key === 'exported'
              ? {
                  website_profile: {
                    trade_role: 'distributor',
                    trade_role_confidence: 0.7,
                    own_manufacturing: false,
                    carried_brands: [{ name: 'Shimge', country: 'cn' }],
                    register_key: 'de-hrb:siegburg:1525',
                    vat_id: 'DE811255398',
                    source_url: `${site}/impressum`,
                  },
                }
              : undefined,
        },
      });
      if (fixture.evidence) {
        const synthetic = fixture.evidence === 'synthetic';
        await owner.fieldEvidence.create({
          data: {
            workspaceId: fixture.workspace,
            entityType: 'company',
            entityId: companyId,
            field: 'name',
            value: 'synthetic',
            providerKey: synthetic ? 'Sandbox' : 'public_web',
            license: synthetic ? 'sandbox' : 'licensed',
            dataClass: 'green',
            fetchedAt: new Date('2026-10-10T00:00:00.000Z'),
          },
        });
      }
      await owner.lead.create({
        data: {
          id: leads[fixture.key],
          workspaceId: fixture.workspace,
          icpId: fixture.icpId,
          canonicalCompanyId: companyId,
          status: fixture.status,
          queue: fixture.status === 'QUALIFIED' ? 'recommended' : 'rejected',
          fitVerdict: 'match',
          totalScore: 0.8,
          scores: { fit: 0.9, role: 0.8, intent: 0.2, dataQuality: 0.7, reachability: 1, engagement: 0 },
        },
      });
      await owner.leadDecision.create({
        data: {
          workspaceId: fixture.workspace,
          leadId: leads[fixture.key],
          action: 'accept',
          decidedBy: operator,
          createdAt: fixture.acceptedAt,
        },
      });
      if (fixture.status === 'REJECTED' || fixture.key === 'reaccepted') {
        await owner.leadDecision.create({
          data: {
            workspaceId: fixture.workspace,
            leadId: leads[fixture.key],
            action: 'reject',
            decidedBy: operator,
            createdAt: new Date(fixture.acceptedAt.getTime() + 60_000),
          },
        });
      }
    }
    await owner.leadDecision.create({
      data: {
        workspaceId: workspaceA,
        leadId: leads.reaccepted,
        action: 'accept',
        decidedBy: operator,
        createdAt: new Date('2026-10-08T10:00:00.000Z'),
      },
    });
    // The exported company: found before its accept (counted) and again after it (never counted).
    await materializedBy({
      companyId: companies.exported,
      runId: runs.beforeAccept,
      createdAt: new Date('2026-10-12T08:00:00.000Z'),
      chargedMicrousd: 2_840_000n,
      reservedMicrousd: 0n,
    });
    await materializedBy({
      companyId: companies.exported,
      runId: runs.afterAccept,
      createdAt: new Date('2026-10-14T08:00:00.000Z'),
      chargedMicrousd: 9_000_000n,
      reservedMicrousd: 0n,
    });
    // The re-accepted company's run still holds a reservation: its cost is unknown, not low.
    await materializedBy({
      companyId: companies.reaccepted,
      runId: runs.reaccepted,
      createdAt: new Date('2026-10-01T08:00:00.000Z'),
      chargedMicrousd: 1_000_000n,
      reservedMicrousd: 250_000n,
    });
    await owner.companyContactPoint.create({
      data: {
        workspaceId: workspaceA,
        companyId: companies.exported,
        kind: 'contact_page',
        value: `${site}/kontakt`,
        sourceKind: 'homepage',
        providerKey: 'company_contact',
        parserVersion: 'company_contact/v1',
        firstSeenAt: new Date('2026-10-11T09:00:00.000Z'),
        lastSeenAt: new Date('2026-10-11T09:00:00.000Z'),
      },
    });
  });

  afterAll(async () => {
    if (owner) {
      const workspaces = [workspaceA, workspaceB];
      await owner.$transaction(async (tx) => {
        // The receipt and outcome tables reject DELETE by trigger; the fixtures go with triggers off.
        await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
        await tx.$executeRaw`DELETE FROM discovery_company_materialization_outcome WHERE workspace_id = ${workspaceA}::uuid`;
        await tx.$executeRaw`DELETE FROM discovery_query_receipt WHERE workspace_id = ${workspaceA}::uuid`;
        await tx.$executeRaw`DELETE FROM tool_budget_account WHERE scope_key = ${workspaceA}`;
        await tx.$executeRaw`DELETE FROM discovery_run WHERE workspace_id = ${workspaceA}::uuid`;
      });
      await owner.policyDecisionLog.deleteMany({ where: { workspaceId: { in: workspaces } } });
      await owner.leadDecision.deleteMany({ where: { workspaceId: { in: workspaces } } });
      await owner.lead.deleteMany({ where: { workspaceId: { in: workspaces } } });
      await owner.companyContactPoint.deleteMany({ where: { workspaceId: { in: workspaces } } });
      await owner.fieldEvidence.deleteMany({ where: { workspaceId: { in: workspaces } } });
      await owner.canonicalCompany.deleteMany({ where: { workspaceId: { in: workspaces } } });
      await owner.icpDefinition.deleteMany({ where: { workspaceId: { in: workspaces } } });
      await owner.companyProfile.deleteMany({ where: { workspaceId: { in: workspaces } } });
      await owner.workspace.deleteMany({ where: { id: { in: workspaces } } });
      await owner.$disconnect();
    }
    await app?.$disconnect();
  });

  it('exports the accepted, allowed leads of the week and logs every EXPORT decision as app_user', async () => {
    const report = await service.weekly(
      { workspaceId: workspaceA, userId: operator, roles: ['TENANT_OWNER'], scopes: [] } as never,
      { icpId: icp, week: '2026-W42' },
    );

    const rows = records(report.csv);
    expect(rows.map((row) => row['线索 ID'])).toEqual([leads.exported]);
    expect(rows[0]).toMatchObject({
      公司名: `Pumpen ${suffix} GmbH`,
      域名: `pumpen-${suffix}.example`,
      国家: 'DE',
      贸易角色: '分销商',
      贸易角色置信度: '0.70',
      自有制造: '否',
      '在售品牌（中国）': 'Shimge',
      登记号: 'de-hrb:siegburg:1525',
      税号: 'DE811255398',
      'Fit 结论': '匹配',
      证据链接: `${site}/impressum\n${site}/kontakt`,
      联系路径: `联系页：${site}/kontakt`,
      制裁状态: '未筛查（筛查未启用）',
      有效期至: '2027-04-08',
      // The run created before the 2026-10-13 accept, read through RLS as app_user; the later run is not counted.
      '所属发现 run ID': runs.beforeAccept,
      [COST_COLUMN]: '2.840000',
    });
    expect(report).toMatchObject({ rows: 1, withheld: { rights: 2, sanctions: 0, quarantined: 1 } });

    const logged = await app.withWorkspace(workspaceA, (tx) =>
      tx.policyDecisionLog.findMany({
        where: { correlationId: report.reportId },
        orderBy: { subjectId: 'asc' },
        select: {
          workspaceId: true,
          action: true,
          dataClass: true,
          subjectJurisdiction: true,
          effect: true,
          allowed: true,
          reason: true,
          subjectType: true,
          subjectId: true,
          actorId: true,
        },
      }),
    );
    const expected = [
      [leads.exported, 'ALLOW', true, 'green_company_fact'],
      [leads.suppressed, 'DENY', false, 'suppressed'],
      [leads.noEvidence, 'DENY', false, 'no_evidence'],
      [leads.quarantined, 'DENY', false, 'synthetic_quarantined'],
    ]
      .map(([subjectId, effect, allowed, reason]) => ({
        workspaceId: workspaceA,
        action: 'EXPORT',
        dataClass: 'green',
        subjectJurisdiction: 'EU',
        effect,
        allowed,
        reason,
        subjectType: 'lead',
        subjectId,
        actorId: operator,
      }))
      .sort((left, right) => String(left.subjectId).localeCompare(String(right.subjectId)));
    expect(logged).toEqual(expected);

    // The log is tenant data: the other workspace sees none of it.
    const leaked = await app.withWorkspace(workspaceB, (tx) =>
      tx.policyDecisionLog.count({ where: { correlationId: report.reportId } }),
    );
    expect(leaked).toBe(0);
  });

  it('keeps another workspace out: its ICP is not found and its leads never appear', async () => {
    const asA = { workspaceId: workspaceA, userId: operator, roles: [], scopes: [] } as never;
    await expect(service.weekly(asA, { icpId: icpB, week: '2026-W42' })).rejects.toBeInstanceOf(NotFoundException);

    const asB = { workspaceId: workspaceB, userId: operator, roles: [], scopes: [] } as never;
    const report = await service.weekly(asB, { icpId: icpB, week: '2026-W42' });
    expect(records(report.csv).map((row) => row['线索 ID'])).toEqual([leads.workspaceB]);
    await expect(service.weekly(asB, { icpId: icp, week: '2026-W42' })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('lists last week on its own and refuses app_user rewriting the export log', async () => {
    const asA = { workspaceId: workspaceA, userId: operator, roles: [], scopes: [] } as never;
    const report = await service.weekly(asA, { icpId: icp, week: '2026-W41' });
    const rows = records(report.csv);
    expect(rows.map((row) => row['线索 ID']).sort()).toEqual([leads.lastWeek, leads.reaccepted].sort());
    expect(rows.find((row) => row['线索 ID'] === leads.reaccepted)).toMatchObject({
      '所属发现 run ID': runs.reaccepted,
      [COST_COLUMN]: '',
    });

    const updated = await app
      .withWorkspace(workspaceA, (tx) =>
        tx.policyDecisionLog.updateMany({ where: { correlationId: report.reportId }, data: { allowed: false } }),
      )
      .then(
        () => 'updated',
        (error: unknown) => String((error as { message?: unknown }).message ?? error),
      );
    expect(updated).toMatch(/permission denied/u);
  });

  it('leaves a re-accepted lead out of the week of its first accept', async () => {
    const asA = { workspaceId: workspaceA, userId: operator, roles: [], scopes: [] } as never;
    const report = await service.weekly(asA, { icpId: icp, week: '2026-W40' });
    expect(records(report.csv)).toEqual([]);
    expect(report).toMatchObject({ rows: 0, withheld: { rights: 0, sanctions: 0, quarantined: 0 } });
    const logged = await app.withWorkspace(workspaceA, (tx) =>
      tx.policyDecisionLog.count({ where: { correlationId: report.reportId } }),
    );
    expect(logged).toBe(0);
  });
});
