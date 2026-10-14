import { randomInt, randomUUID } from 'node:crypto';
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
    lastWeek: randomUUID(),
    rejected: randomUUID(),
    otherIcp: randomUUID(),
    workspaceB: randomUUID(),
  };
  const leads = Object.fromEntries(Object.keys(companies).map((key) => [key, randomUUID()])) as Record<
    keyof typeof companies,
    string
  >;
  const site = `https://pumpen-${suffix}.example`;

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
      evidence: boolean;
    }> = [
      { key: 'exported', workspace: workspaceA, icpId: icp, status: 'QUALIFIED', companyStatus: 'ENRICHED', acceptedAt: inWeek, evidence: true },
      { key: 'suppressed', workspace: workspaceA, icpId: icp, status: 'QUALIFIED', companyStatus: 'SUPPRESSED', acceptedAt: inWeek, evidence: true },
      { key: 'noEvidence', workspace: workspaceA, icpId: icp, status: 'QUALIFIED', companyStatus: 'ENRICHED', acceptedAt: inWeek, evidence: false },
      { key: 'lastWeek', workspace: workspaceA, icpId: icp, status: 'QUALIFIED', companyStatus: 'ENRICHED', acceptedAt: lastWeek, evidence: true },
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
        await owner.fieldEvidence.create({
          data: {
            workspaceId: fixture.workspace,
            entityType: 'company',
            entityId: companyId,
            field: 'name',
            value: 'synthetic',
            providerKey: 'public_web',
            license: 'licensed',
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
      if (fixture.status === 'REJECTED') {
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
      [COST_COLUMN]: '',
    });
    expect(report).toMatchObject({ rows: 1, withheld: { rights: 2, sanctions: 0, quarantined: 0 } });

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
    expect(records(report.csv).map((row) => row['线索 ID'])).toEqual([leads.lastWeek]);

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
});
