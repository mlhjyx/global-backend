import { describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import {
  DomainCooldownService,
  PostgresDomainCooldownBackend,
  PostgresSharedFactRepository,
  SharedGreenFactStore,
} from './index';
import { PgNotifyListener } from '../relay/pg-notify-listener';

const ADMIN_URL = process.env.TEST_M10_PG_ADMIN_URL?.trim();
const WRITER_URL = process.env.TEST_M10_PG_WRITER_URL?.trim();
const APP_USER_URL = process.env.TEST_M10_PG_APP_USER_URL?.trim();

const ENABLED = Boolean(ADMIN_URL && WRITER_URL && APP_USER_URL);

describe.skipIf(!ENABLED)(
  'M10-PR2 Block 4 & 5 real PG16 integration: ADR-003 platform_shared boundary & Outbox PG NOTIFY wakeup',
  () => {
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
