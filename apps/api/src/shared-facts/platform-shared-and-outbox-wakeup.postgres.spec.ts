import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import {
  DomainCooldownService,
  PostgresDomainCooldownBackend,
  PostgresSharedFactRepository,
  SharedGreenFactStore,
} from './index';
import { projectApprovedChannelGreenFacts } from '../channels/channel-platform-writer';
import { ChannelService } from '../channels/channel.service';
import { materializeChannelRecords } from '../channels/channel-records';
import { createPrismaChannelRecordWriter } from '../channels/channel-records.prisma';
import { ChannelCatalogDiscoveryProvider } from '../discovery/providers/channel-catalog.provider';
import { createSharedFactsHookFromEnv } from '../discovery/streaming/shared-facts-hook';
import { PgNotifyListener } from '../relay/pg-notify-listener';

const ADMIN_URL = process.env.TEST_M10_PG_ADMIN_URL?.trim();
const WRITER_URL = process.env.TEST_M10_PG_WRITER_URL?.trim();
const APP_USER_URL = process.env.TEST_M10_PG_APP_USER_URL?.trim();

const ENABLED = Boolean(ADMIN_URL && WRITER_URL && APP_USER_URL);

describe.skipIf(!ENABLED)(
  'M10-PR2 Block 4 & 5 real PG16 integration: ADR-003 platform_shared boundary & Outbox PG NOTIFY wakeup',
  () => {
    it('requires a fresh review for changed materialized content and preserves approval on repeat observations', async () => {
      const adminDb = new PrismaClient({ datasourceUrl: ADMIN_URL });
      const channelId = randomUUID();
      const writer = createPrismaChannelRecordWriter(adminDb);
      const record = {
        name: 'Review Fixture GmbH',
        website: 'https://materialized-review-fixture.example',
        country: 'DE',
        sourceUrl: 'https://expo.example/exhibitors/review-fixture',
      };
      const materialize = (industry: string) => materializeChannelRecords(writer, {
        channelId, crawlRunId: randomUUID(), records: [{ ...record, industry }],
      });
      const readBack = () => adminDb.sourceChannelRecord.findFirstOrThrow({ where: { channelId } });
      try {
        await adminDb.sourceChannel.create({ data: {
          id: channelId, name: 'Materialized Review Fixture', category: 'trade_fair',
          mode: 'crawl', config: {}, status: 'ENABLED',
        } });
        await materialize('industrial controls');
        const first = await readBack();
        expect(first.reviewStatus).toBe('PENDING');
        await adminDb.sourceChannelRecord.update({
          where: { id: first.id },
          data: { reviewStatus: 'APPROVED', reviewedAt: new Date(), reviewedBy: randomUUID() },
        });
        await materialize('industrial controls');
        expect((await readBack()).reviewStatus).toBe('APPROVED');

        await materialize('changed directory evidence');
        const changed = await readBack();
        expect(changed.id).toBe(first.id);
        expect(changed.contentHash).not.toBe(first.contentHash);
        expect(changed.reviewStatus).toBe('PENDING');
      } finally {
        await adminDb.sourceChannel.deleteMany({ where: { id: channelId } });
        await adminDb.$disconnect();
      }
    });

    it('returns matching catalog rows beyond the initial page and interleaves channels after review precedence', async () => {
      const adminDb = new PrismaClient({ datasourceUrl: ADMIN_URL });
      const appDb = new PrismaClient({ datasourceUrl: APP_USER_URL });
      const channelIds = Array.from({ length: 53 }, (_, i) =>
        `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
      );
      const primary = channelIds[0]!;
      const late = channelIds[51]!;
      const disabled = channelIds[52]!;
      const crawlRunId = randomUUID();
      const reviewedBy = randomUUID();
      const row = (channelId: string, dedupeKey: string) => ({
        channelId, crawlRunId, dedupeKey,
        name: 'Catalog Fixture', country: 'Italy',
        sourceUrl: 'https://expo.example/directory',
        reviewStatus: 'APPROVED',
        reviewedBy, reviewedAt: new Date(),
      });
      try {
        await adminDb.sourceChannel.createMany({ data: channelIds.map((id) => ({
          id, name: 'Catalog Fixture', category: 'trade_fair', mode: 'crawl', config: {},
          status: id === disabled ? 'DISABLED' : 'ENABLED',
        })) });
        await adminDb.sourceChannelRecord.createMany({ data: [
          ...Array.from({ length: 510 }, (_, i) => ({
            ...row(primary, `a-${String(i).padStart(3, '0')}`),
            ...(i < 255 ? { country: 'Germany', industry: 'photovoltaic' } : { industry: 'bakery' }),
          })),
          { ...row(primary, 'z-1'), name: 'Catalog Solar A', website: 'https://catalog-a.example', products: ['photovoltaic modules'] },
          { ...row(primary, 'z-2'), name: 'Catalog Solar B', website: 'https://catalog-b.example', industry: 'photovoltaic' },
          { ...row(late, 'n-1'), name: 'Catalog Solar C', website: 'https://catalog-c.example', keywords: 'PHOTOVOLTAIC' },
          { ...row(late, 'n-2'), name: 'Catalog Pending Duplicate', website: 'https://catalog-a.example', industry: 'photovoltaic', reviewStatus: 'PENDING', reviewedBy: null, reviewedAt: null },
          { ...row(late, 'n-3'), name: 'Catalog Rejected Match', industry: 'photovoltaic', reviewStatus: 'REJECTED' },
          { ...row(late, 'n-4'), name: 'Catalog Invalid Evidence', website: 'https://candidate.example', industry: 'photovoltaic', sourceUrl: 'https://expo.example:8443/directory' },
          { ...row(disabled, 'n-1'), name: 'Catalog Disabled Match', industry: 'photovoltaic' },
        ] });

        const provider = new ChannelCatalogDiscoveryProvider({ prisma: appDb, lineageEnabled: true });
        const result = await provider.discoverCompanies({
          sourceClass: 'industry_data', filters: { country: 'IT', industry: 'photovoltaic' },
          keywords: [], limit: 5,
        }, {
          workspaceId: randomUUID(), runId: randomUUID(),
          durableBudgetAuthority: { authorityId: randomUUID(), accountId: randomUUID() },
        });
        expect(result.records.map((record) => record.name)).toEqual([
          'Catalog Solar A', 'Catalog Solar C', 'Catalog Solar B',
        ]);
      } finally {
        await adminDb.sourceChannel.deleteMany({ where: { id: { in: channelIds } } });
        await Promise.all([adminDb.$disconnect(), appDb.$disconnect()]);
      }
    });

    it('keeps fresh website facts and leaves normal website collection open for directory-only facts', async () => {
      const writerDb = new PrismaClient({ datasourceUrl: WRITER_URL });
      const appDb = new PrismaClient({ datasourceUrl: APP_USER_URL });
      const repository = new PostgresSharedFactRepository(appDb, writerDb);
      const store = new SharedGreenFactStore(repository);
      const now = new Date('2026-11-27T00:00:00Z');
      const later = new Date(now.getTime() + 1000);
      try {
        await store.putFromRaw({
          domain: 'adr003-rich-website.example', sourceKind: 'public_web_streaming',
          websiteSummary: 'Verified industrial control equipment.',
          contactPageUrl: 'https://adr003-rich-website.example/contact',
        }, { now });
        for (const domain of ['adr003-rich-website.example', 'adr003-directory-only.example']) {
          await store.putFromRaw({ domain, sourceKind: 'public_directory', legalName: 'Listing name' }, { now: later });
        }

        const hook = createSharedFactsHookFromEnv(
          { ADR003_SHARED_GREEN_FACTS: 'readonly' }, { pgReader: appDb },
        );
        const rich = await hook.lookupL1PreFetch({ domain: 'adr003-rich-website.example', nowMs: later.getTime() });
        const directory = await hook.lookupL1PreFetch({ domain: 'adr003-directory-only.example', nowMs: later.getTime() });
        expect(rich.fact?.sourceKind).toBe('public_web_streaming');
        expect(rich.syntheticExtraction?.channels.contactPageUrl).toBe('https://adr003-rich-website.example/contact');
        expect(directory.hit).toBe(false);
        expect(directory.syntheticExtraction).toBeNull();
        expect((await repository.getByDomain('adr003-directory-only.example', later.getTime()))?.sourceKind).toBe('public_directory');
      } finally {
        await repository.deleteByDomain('adr003-rich-website.example');
        await repository.deleteByDomain('adr003-directory-only.example');
        await Promise.all([writerDb.$disconnect(), appDb.$disconnect()]);
      }
    });

    it('enforces platform_writer RW, app_user strict SELECT-only, and physical PII rejection on platform_shared', async () => {
      const writerDb = new PrismaClient({ datasourceUrl: WRITER_URL });
      const appDb = new PrismaClient({ datasourceUrl: APP_USER_URL });
      try {
        await writerDb.$connect();
        await appDb.$connect();

        // 1. platform_writer writes sanitized green company fact via SharedGreenFactStore
        const writerStore = new SharedGreenFactStore(
          new PostgresSharedFactRepository(appDb, writerDb),
        );
        const outcome = await writerStore.putFromRaw({
          domain: 'https://www.bosch-industrial.example/en',
          sourceKind: 'public_web',
          legalName: 'Bosch Industrial GmbH',
          country: 'DE',
          tradeRole: 'manufacturer',
          websiteSummary: 'Industrial automation components manufacturer.',
          emails: ['sales@bosch-industrial.example', 'alice.smith@bosch-industrial.example'],
          linkedinCompanyUrl: 'https://www.linkedin.com/company/bosch-industrial',
        });
        expect(outcome.stored).toBe(true);
        if (outcome.stored) {
          expect(outcome.fact.roleEmails).toEqual(['sales@bosch-industrial.example']);
          expect(outcome.strippedPiiCount).toBeGreaterThanOrEqual(1);
        }

        // 2. app_user (NOSUPERUSER NOBYPASSRLS) can SELECT from platform_shared.company_fact
        const appRepo = new PostgresSharedFactRepository(appDb);
        const readBack = await appRepo.getByDomain('bosch-industrial.example');
        expect(readBack).not.toBeNull();
        expect(readBack!.legalName).toBe('Bosch Industrial GmbH');
        expect(readBack!.roleEmails).toEqual(['sales@bosch-industrial.example']);

        // 3. app_user is DENIED (PG 42501 insufficient_privilege) on INSERT / UPDATE / DELETE / TRUNCATE
        await expect(
          appDb.$executeRawUnsafe(`
            INSERT INTO platform_shared.company_fact
              (domain, homepage_url, source_kind, observed_at, expires_at, ttl_days)
            VALUES ('app-denied.example', 'https://app-denied.example/', 'public_web', now(), now() + interval '21 days', 21)
          `),
        ).rejects.toThrow(/42501|permission denied/i);

        await expect(
          appDb.$executeRawUnsafe(`
            UPDATE platform_shared.company_fact
            SET legal_name = 'Tampered'
            WHERE domain = 'bosch-industrial.example'
          `),
        ).rejects.toThrow(/42501|permission denied/i);

        await expect(
          appDb.$executeRawUnsafe(`
            DELETE FROM platform_shared.company_fact
            WHERE domain = 'bosch-industrial.example'
          `),
        ).rejects.toThrow(/42501|permission denied/i);

        await expect(
          appDb.$executeRawUnsafe(`TRUNCATE TABLE platform_shared.company_fact`),
        ).rejects.toThrow(/42501|permission denied/i);

        // 4. Physical DB trigger/CHECK constraints reject personal emails, multi-part bypasses, LinkedIn /in/, and inline PII even from platform_writer!
        await expect(
          writerDb.$executeRawUnsafe(`
            INSERT INTO platform_shared.company_fact
              (domain, homepage_url, source_kind, role_emails, observed_at, expires_at, ttl_days)
            VALUES (
              'pii-email.example', 'https://pii-email.example/', 'public_web',
              '["john.doe@pii-email.example"]'::jsonb, now(), now() + interval '21 days', 21
            )
          `),
        ).rejects.toThrow(/ADR003_PERSONAL_EMAIL_FORBIDDEN|23514/);

        await expect(
          writerDb.$executeRawUnsafe(`
            INSERT INTO platform_shared.company_fact
              (domain, homepage_url, source_kind, role_emails, observed_at, expires_at, ttl_days)
            VALUES (
              'probe-edge.example', 'https://probe-edge.example/', 'public_web',
              '["sales.john.smith@probe-edge.example"]'::jsonb, now(), now() + interval '21 days', 21
            )
          `),
        ).rejects.toThrow(/ADR003_PERSONAL_EMAIL_FORBIDDEN|23514/);

        await expect(
          writerDb.$executeRawUnsafe(`
            INSERT INTO platform_shared.company_fact
              (domain, homepage_url, source_kind, product_categories, observed_at, expires_at, ttl_days)
            VALUES (
              'pii-cat.example', 'https://pii-cat.example/', 'public_web',
              '["industrial pumps alice@pii-cat.example"]'::jsonb, now(), now() + interval '21 days', 21
            )
          `),
        ).rejects.toThrow(/ADR003_PII_FORBIDDEN_IN_PRODUCT_CATEGORIES|23514/);

        await expect(
          writerDb.$executeRawUnsafe(`
            INSERT INTO platform_shared.company_fact
              (domain, homepage_url, source_kind, product_categories, observed_at, expires_at, ttl_days)
            VALUES (
              'pii-cat-li.example', 'https://pii-cat-li.example/', 'public_web',
              '["https://www.linkedin.com/in/bob-buyer"]'::jsonb, now(), now() + interval '21 days', 21
            )
          `),
        ).rejects.toThrow(/ADR003_PII_FORBIDDEN_IN_PRODUCT_CATEGORIES|23514/);

        // Valid 2-part role email matching ALLOWED_ROLE_SUFFIXES is accepted
        await expect(
          writerDb.$executeRawUnsafe(`
            UPDATE platform_shared.company_fact
            SET role_emails = '["sales@bosch-industrial.example","sales.de@bosch-industrial.example"]'::jsonb
            WHERE domain = 'bosch-industrial.example'
          `),
        ).resolves.toBe(1);

        await expect(
          writerDb.$executeRawUnsafe(`
            INSERT INTO platform_shared.company_fact
              (domain, homepage_url, source_kind, linkedin_company_url, observed_at, expires_at, ttl_days)
            VALUES (
              'pii-li.example', 'https://pii-li.example/', 'public_web',
              'https://www.linkedin.com/in/john-doe-123', now(), now() + interval '21 days', 21
            )
          `),
        ).rejects.toThrow(/platform_shared_company_fact_no_personal_linkedin_chk|23514/);

        await expect(
          writerDb.$executeRawUnsafe(`
            INSERT INTO platform_shared.company_fact
              (domain, homepage_url, source_kind, website_summary, observed_at, expires_at, ttl_days)
            VALUES (
              'pii-summary.example', 'https://pii-summary.example/', 'public_web',
              'Reach out to max.mustermann@pii-summary.example directly', now(), now() + interval '21 days', 21
            )
          `),
        ).rejects.toThrow(/platform_shared_company_fact_no_pii_summary_chk|23514/);

        // 5. Domain cooldown backend via PostgresDomainCooldownBackend (app_user read + platform_writer write)
        const cooldown = new DomainCooldownService({
          backend: new PostgresDomainCooldownBackend(appDb, writerDb),
          pepper: 'test-pepper-at-least-16-chars-long',
          maxDistinctWorkspaces30d: 2,
          windowDays: 30,
        });
        const t1 = await cooldown.recordTouch('bosch-industrial.example', 'ws-1');
        expect(t1.cooledDown).toBe(false);
        expect(t1.distinctWorkspaces30d).toBe(1);
        const t2 = await cooldown.recordTouch('bosch-industrial.example', 'ws-2');
        expect(t2.cooledDown).toBe(true);
        expect(t2.distinctWorkspaces30d).toBe(2);

        // Non-HMAC raw domain/workspace UUID rejected by DB CHECK constraint!
        await expect(
          writerDb.$executeRawUnsafe(`
            INSERT INTO platform_shared.domain_cooldown_touch
              (domain_hmac, workspace_touch_hmac, touched_at, expires_at)
            VALUES ('bosch-industrial.example', '11111111-1111-4111-8111-111111111111', now(), now() + interval '30 days')
          `),
        ).rejects.toThrow(/platform_shared_cooldown_hmac_chk|23514|22001/);

        // app_user cannot delete from domain_cooldown_touch either
        await expect(
          appDb.$executeRawUnsafe(`
            DELETE FROM platform_shared.domain_cooldown_touch
          `),
        ).rejects.toThrow(/42501|permission denied/i);

        // 6. F12: createSharedFactsHookFromEnv PG round-trip (app_user read + platform_writer write)
        const hook = createSharedFactsHookFromEnv(
          {
            ADR003_SHARED_GREEN_FACTS: 'on',
            ADR003_DOMAIN_COOLDOWN_PEPPER: 'test-pepper-at-least-16-chars-long',
            ADR003_DOMAIN_COOLDOWN_THRESHOLD: '2',
          },
          { pgReader: appDb, pgWriter: writerDb },
        );
        expect(hook.getDiagnostics().backendKind).toBe('postgres');
        await hook.writeBackFromStreamingExtraction({
          domain: 'solaris-hook.example',
          legalName: 'Solaris Hook GmbH',
          country: 'DE',
          extraction: {
            domain: 'solaris-hook.example',
            homepageUrl: 'https://solaris-hook.example/',
            fetchMethod: 'raw_http',
            usedCrawl4aiFallback: false,
            usedWwwRetry: false,
            pdfSkipped: false,
            robotsBlocked: false,
            title: 'Solaris Hook GmbH',
            metaDescription: 'Solar modules',
            visibleText: 'Solar modules',
            jsonLd: {
              organizationNames: ['Solaris Hook GmbH'],
              descriptions: ['Solar modules'],
              emails: ['sales@solaris-hook.example'],
              phones: [],
              socialLinks: [],
              products: ['HJT Module'],
              jobPostings: [],
            },
            channels: {
              roleEmails: ['sales@solaris-hook.example'],
              otherEmails: [],
              phones: [],
              socialLinks: [],
              hasInquiryForm: false,
              contactFormUrl: null,
              contactPageUrl: null,
              impressumUrl: null,
              careersPageUrl: null,
            },
            pagesFetched: ['https://solaris-hook.example/'],
            failureReason: null,
          },
          isImportedBuyer: false,
        });
        const preFetch = await hook.lookupL1PreFetch({
          domain: 'solaris-hook.example',
          category: 'trade_fair',
        });
        expect(preFetch.hit).toBe(true);
        expect(preFetch.fact?.roleEmails).toEqual(['sales@solaris-hook.example']);

        // 7. F12: runtime_customer_worker_ops narrow grants + execution_budget_platform_writer ingestion
        const adminDbForRoles = new PrismaClient({ datasourceUrl: ADMIN_URL });
        try {
          const roleRows = await adminDbForRoles.$queryRaw<
            Array<{ worker_ops: boolean; epw: boolean }>
          >`
            SELECT
              EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'runtime_customer_worker_ops') AS worker_ops,
              EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'execution_budget_platform_writer') AS epw
          `;
          if (roleRows[0]?.worker_ops) {
            const privs = await adminDbForRoles.$queryRaw<
              Array<{
                cf_sel: boolean;
                cf_ins: boolean;
                cf_upd: boolean;
                cf_del: boolean;
                dc_del: boolean;
                app_ins: boolean;
              }>
            >`
              SELECT
                has_table_privilege('runtime_customer_worker_ops', 'platform_shared.company_fact', 'SELECT') AS cf_sel,
                has_table_privilege('runtime_customer_worker_ops', 'platform_shared.company_fact', 'INSERT') AS cf_ins,
                has_table_privilege('runtime_customer_worker_ops', 'platform_shared.company_fact', 'UPDATE') AS cf_upd,
                has_table_privilege('runtime_customer_worker_ops', 'platform_shared.company_fact', 'DELETE') AS cf_del,
                has_table_privilege('runtime_customer_worker_ops', 'platform_shared.domain_cooldown_touch', 'DELETE') AS dc_del,
                has_table_privilege('app_user', 'platform_shared.company_fact', 'INSERT') AS app_ins
            `;
            expect(privs[0]).toEqual({
              cf_sel: true,
              cf_ins: true,
              cf_upd: true,
              cf_del: false,
              dc_del: true,
              app_ins: false,
            });
          }

          if (roleRows[0]?.epw) {
            const epwRole = `ci_f12_epw_${randomBytes(4).toString('hex')}`;
            const epwPass = randomBytes(16).toString('hex');
            const epwUrl = new URL(ADMIN_URL!);
            epwUrl.username = epwRole;
            epwUrl.password = epwPass;
            await adminDbForRoles.$executeRawUnsafe(
              `CREATE ROLE "${epwRole}" LOGIN PASSWORD '${epwPass}' IN ROLE execution_budget_platform_writer`,
            );
            const epwDb = new PrismaClient({ datasourceUrl: epwUrl.toString() });
            try {
              await epwDb.$connect();
              const sourceDomain = 'adr003-reviewed-directory.example';
              const approvedDomain = 'solaris-channel.example';
              const excludedDomain = 'unapproved-path-channel.example';
              const fixture = await adminDbForRoles.sourceChannel.create({ data: {
                mode: 'crawl', category: 'trade_fair', name: 'Synthetic Trade Fair',
                status: 'ENABLED', probeRequired: false, license: 'Public discovery fixtures',
                config: {
                  mode: 'crawl', list: { url: `https://${sourceDomain}/exhibitors`, itemSelector: 'article', maxPages: 1, singlePage: true },
                  detail: { enabled: false, fields: {} },
                },
              } });
              const crawlRunId = randomUUID();
              const projectionEnv = { ADR003_SHARED_GREEN_FACTS: 'on' };
              const scope = { platformWriter: epwDb, channelId: fixture.id, crawlRunId, env: projectionEnv };
              const approvedRecord = {
                name: 'Solaris Channel GmbH',
                website: `https://www.${approvedDomain}`,
                country: 'Germany',
                industry: 'Photovoltaic',
                products: ['HJT Module'],
                email: `sales@${approvedDomain}`,
                phone: '+49 89 90410150',
                sourceUrl: `https://${sourceDomain}/exhibitors/public`,
              };
              await adminDbForRoles.sourcePolicy.create({ data: {
                domain: sourceDomain, sourceType: 'trade_fair', accessMode: 'crawl',
                reviewStatus: 'APPROVED', termsStatus: 'REVIEWED_OK', robotsStatus: 'ALLOWS',
                personalData: false, allowedPurpose: ['discovery'],
                allowedPaths: ['/exhibitors/'], disallowedPaths: ['/exhibitors/private'],
                retentionDays: 14,
              } });
              try {
                const recordWriter = createPrismaChannelRecordWriter(epwDb);
                await materializeChannelRecords(recordWriter, {
                  channelId: fixture.id, crawlRunId, records: [
                    approvedRecord,
                    {
                      ...approvedRecord, name: 'Excluded Path GmbH', website: `https://${excludedDomain}`,
                      sourceUrl: `https://${sourceDomain}/exhibitors/%70rivate`,
                    },
                  ],
                });
                expect(await projectApprovedChannelGreenFacts(scope)).toEqual({ stored: 0, skipped: 0, rejected: 0 });

                const recordIds = (await epwDb.sourceChannelRecord.findMany({
                  where: { channelId: fixture.id },
                  select: { id: true },
                })).map(({ id }) => id);
                const service = new ChannelService(appDb as never, undefined, undefined, epwDb);
                vi.stubEnv('ADR003_SHARED_GREEN_FACTS', 'on');
                const reviewer = { workspaceId: randomUUID(), userId: randomUUID(), roles: [] };
                await service.reviewChannelRecords(reviewer, fixture.id, { recordIds, verdict: 'APPROVED' });

                const repository = new PostgresSharedFactRepository(appDb, epwDb);
                const fact = await repository.getByDomain(approvedDomain);
                expect(fact?.sourceKind).toBe('public_directory');
                expect(fact?.websiteSummary).toBe('Synthetic Trade Fair: Photovoltaic');
                expect(fact?.productCategories).toEqual(['HJT Module']);
                expect(fact?.roleEmails).toEqual([]);
                expect(fact?.switchboardPhones).toEqual([]);
                expect(fact?.ttlDays).toBe(14);
                expect(await repository.getByDomain(excludedDomain)).toBeNull();

                const nextRunId = randomUUID();
                await materializeChannelRecords(recordWriter, {
                  channelId: fixture.id, crawlRunId: nextRunId,
                  records: [{ ...approvedRecord, industry: 'Changed source content' }],
                });
                expect(await projectApprovedChannelGreenFacts({ ...scope, crawlRunId: nextRunId }))
                  .toEqual({ stored: 0, skipped: 0, rejected: 0 });
                expect(await repository.getByDomain(approvedDomain)).toEqual(fact);
              } finally {
                vi.unstubAllEnvs();
                await new PostgresSharedFactRepository(appDb, epwDb).deleteByDomain(approvedDomain);
                await adminDbForRoles.sourceChannel.delete({ where: { id: fixture.id } });
                await adminDbForRoles.sourcePolicy.delete({ where: { domain: sourceDomain } });
              }
            } finally {
              await epwDb.$disconnect();
              await adminDbForRoles.$executeRawUnsafe(`DROP ROLE IF EXISTS "${epwRole}"`);
            }
          }
        } finally {
          await adminDbForRoles.$disconnect();
        }
      } finally {
        await writerDb.$disconnect();
        await appDb.$disconnect();
      }
    });

    it('fires transactional pg_notify wakeup <1s on outbox_event COMMIT and 0 notifications on ROLLBACK', async () => {
      const adminDb = new PrismaClient({ datasourceUrl: ADMIN_URL });
      const notifications: { payload: string; receivedAt: number }[] = [];
      let resolveFirst!: (payload: string) => void;
      const firstNotification = new Promise<string>((resolve) => {
        resolveFirst = resolve;
      });
      let readyResolve!: () => void;
      const ready = new Promise<void>((resolve) => {
        readyResolve = resolve;
      });

      const listener = new PgNotifyListener({
        connectionString: ADMIN_URL!,
        onReady: () => readyResolve(),
        onNotification: (msg) => {
          notifications.push({ payload: msg.payload, receivedAt: Date.now() });
          if (notifications.length === 1) resolveFirst(msg.payload);
        },
      });
      listener.start();

      try {
        await adminDb.$connect();
        await ready;

        const wsRollback = '33333333-3333-4333-8333-333333333333';
        const wsCommit = '44444444-4444-4444-8444-444444444444';

        await adminDb.workspace.upsert({
          where: { id: wsRollback },
          create: { id: wsRollback, name: 'Rollback WS' },
          update: {},
        });
        await adminDb.workspace.upsert({
          where: { id: wsCommit },
          create: { id: wsCommit, name: 'Commit WS' },
          update: {},
        });

        // 1. Rolled-back transaction MUST NOT emit any PG NOTIFY
        await adminDb
          .$transaction(async (tx) => {
            await tx.outboxEvent.create({
              data: {
                workspaceId: wsRollback,
                eventType: 'ClaimExpired',
                aggregateType: 'Claim',
                aggregateId: '55555555-5555-4555-8555-555555555555',
                payload: {},
              },
            });
            throw new Error('INTENTIONAL_ROLLBACK');
          })
          .catch(() => undefined);

        await new Promise((r) => setTimeout(r, 150));
        expect(notifications).toHaveLength(0);

        // 2. Committed transaction MUST deliver wakeup in < 1000ms
        const insertedAt = Date.now();
        await adminDb.outboxEvent.create({
          data: {
            workspaceId: wsCommit,
            eventType: 'ClaimExpired',
            aggregateType: 'Claim',
            aggregateId: '66666666-6666-4666-8666-666666666666',
            payload: {},
          },
        });

        const receivedPayload = await Promise.race([
          firstNotification,
          new Promise<string>((_, reject) =>
            setTimeout(() => reject(new Error('PG_NOTIFY_TIMEOUT_1S')), 1000),
          ),
        ]);
        const latencyMs = notifications[0]!.receivedAt - insertedAt;
        expect(receivedPayload).toBe(wsCommit);
        expect(latencyMs).toBeLessThan(1000);
      } finally {
        await listener.close();
        await adminDb.$disconnect();
      }
    });
  },
);
