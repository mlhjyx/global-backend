import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BUILTIN_AGENTS } from '../agents/agent-catalog';
import { ChannelService } from '../channels/channel.service';
import { OutreachDncService } from '../outreach/outreach-dnc.service';
import {
  DEFAULT_EXPECTED_PROVIDER_KEYS,
  PlatformCatalogNotSeededError,
  verifyPlatformCatalogsReadOnly,
} from '../runtime/platform-catalog-verification';
import {
  assertScopedDatabasePrincipal,
  CUSTOMER_WORKER_OPS_DATABASE_ROLE,
  EXECUTION_BUDGET_PLATFORM_WRITER_ROLE,
  MEMORY_OUTBOX_DATABASE_ROLE,
  OUTBOX_RELAY_DATABASE_ROLE,
  ScopedDatabasePrincipalError,
} from '../runtime/scoped-database-principal';
import { SANCTIONS_SOURCE_SEEDS } from '../sanctions/sanctions-seed';
import { BUILTIN_SKILLS } from '../skills/generated/builtin-skill-catalog';
import { BUILTIN_PACKS } from '../skills/packs/generated/builtin-pack-catalog';
import { createContactReverifyActivities } from '../temporal/contact-reverify.activities';

/**
 * Isolated disposable PostgreSQL verification for M4 scoped non-superuser
 * NOBYPASSRLS principals and the 4 narrow SECURITY DEFINER RPCs.
 * Opt-in via SCOPED_RUNTIME_PRINCIPALS_TEST=1 with loopback /global_test
 * or /global_test_scoped_principals URLs.
 */
const enabled = process.env.SCOPED_RUNTIME_PRINCIPALS_TEST === '1';
const ownerUrl = process.env.DATABASE_URL;
const appUrl = process.env.APP_DATABASE_URL;
const outboxRelayUrl = process.env.OUTBOX_RELAY_DATABASE_URL;
const memoryOutboxUrl = process.env.MEMORY_OUTBOX_DATABASE_URL;
const customerWorkerOpsUrl = process.env.CUSTOMER_WORKER_OPS_DATABASE_URL;
const platformWriterUrl = process.env.EXECUTION_BUDGET_PLATFORM_WRITER_DATABASE_URL;

describe.skipIf(!enabled)('scoped runtime principals (disposable PostgreSQL)', () => {
  let owner: PrismaClient;
  let app: PrismaClient;
  let relay: PrismaClient;
  let memory: PrismaClient;
  let workerOps: PrismaClient;
  let platformWriter: PrismaClient;

  beforeAll(async () => {
    for (const [name, value] of [
      ['DATABASE_URL', ownerUrl],
      ['APP_DATABASE_URL', appUrl],
      ['OUTBOX_RELAY_DATABASE_URL', outboxRelayUrl],
      ['MEMORY_OUTBOX_DATABASE_URL', memoryOutboxUrl],
      ['CUSTOMER_WORKER_OPS_DATABASE_URL', customerWorkerOpsUrl],
      ['EXECUTION_BUDGET_PLATFORM_WRITER_DATABASE_URL', platformWriterUrl],
    ] as const) {
      if (!value) throw new Error(`${name} is required when SCOPED_RUNTIME_PRINCIPALS_TEST=1`);
      const u = new URL(value);
      if (
        !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) ||
        !['/global_test', '/global_test_scoped_principals'].includes(u.pathname)
      ) {
        throw new Error(
          `${name} must target a loopback /global_test or /global_test_scoped_principals database`,
        );
      }
    }
    owner = new PrismaClient({ datasourceUrl: ownerUrl });
    app = new PrismaClient({ datasourceUrl: appUrl });
    relay = new PrismaClient({ datasourceUrl: outboxRelayUrl });
    memory = new PrismaClient({ datasourceUrl: memoryOutboxUrl });
    workerOps = new PrismaClient({ datasourceUrl: customerWorkerOpsUrl });
    platformWriter = new PrismaClient({ datasourceUrl: platformWriterUrl });
    await Promise.all([
      owner.$connect(),
      app.$connect(),
      relay.$connect(),
      memory.$connect(),
      workerOps.$connect(),
      platformWriter.$connect(),
    ]);
  }, 30_000);

  afterAll(async () => {
    await Promise.allSettled([
      owner?.$disconnect(),
      app?.$disconnect(),
      relay?.$disconnect(),
      memory?.$disconnect(),
      workerOps?.$disconnect(),
      platformWriter?.$disconnect(),
    ]);
  });

  it('verifies pg_roles invariants for all 4 scoped principals and rejects owner/app_user', async () => {
    await expect(
      assertScopedDatabasePrincipal(relay, OUTBOX_RELAY_DATABASE_ROLE, 'test'),
    ).resolves.toMatchObject({ rolSuper: false, rolBypassRls: false });
    await expect(
      assertScopedDatabasePrincipal(memory, MEMORY_OUTBOX_DATABASE_ROLE, 'test'),
    ).resolves.toMatchObject({ rolSuper: false, rolBypassRls: false });
    await expect(
      assertScopedDatabasePrincipal(workerOps, CUSTOMER_WORKER_OPS_DATABASE_ROLE, 'test'),
    ).resolves.toMatchObject({ rolSuper: false, rolBypassRls: false });
    await expect(
      assertScopedDatabasePrincipal(
        platformWriter,
        EXECUTION_BUDGET_PLATFORM_WRITER_ROLE,
        'test',
      ),
    ).resolves.toMatchObject({ rolSuper: false, rolBypassRls: false });

    await expect(
      assertScopedDatabasePrincipal(owner, OUTBOX_RELAY_DATABASE_ROLE, 'test'),
    ).rejects.toBeInstanceOf(ScopedDatabasePrincipalError);
    await expect(
      assertScopedDatabasePrincipal(app, OUTBOX_RELAY_DATABASE_ROLE, 'test'),
    ).rejects.toBeInstanceOf(ScopedDatabasePrincipalError);
  });

  it('enforces runtime_outbox_relay_worker positive grants and denies DELETE / catalog writes / PII', async () => {
    const wsId = randomUUID();
    const eventId = randomUUID();
    await owner.workspace.create({ data: { id: wsId, name: 'relay-test' } });
    try {
      await expect(relay.outboxEvent.findMany({ take: 1 })).resolves.toBeInstanceOf(Array);
      const created = await relay.outboxEvent.create({
        data: {
          eventId,
          workspaceId: wsId,
          eventType: 'TestIntegrationEvent',
          aggregateType: 'test',
          aggregateId: wsId,
          payload: {},
        },
      });
      await relay.outboxDelivery.create({
        data: { workspaceId: wsId, eventId, sink: 'saas', status: 'PENDING' },
      });
      await relay.outboxEvent.update({
        where: { id: created.id },
        data: { publishedAt: new Date() },
      });

      await expect(
        relay.outboxEvent.deleteMany({ where: { id: created.id } }),
      ).rejects.toThrow(/42501|permission denied/i);
      await expect(
        relay.$executeRawUnsafe(
          `INSERT INTO public.source_policy (id, domain, source_type) VALUES (gen_random_uuid(), 'blocked-relay.example', 'news')`,
        ),
      ).rejects.toThrow(/42501|permission denied/i);
      await expect(
        relay.$executeRawUnsafe(
          `INSERT INTO public.data_provider (id, key, class) VALUES (gen_random_uuid(), 'bad_relay', 'public_intelligence')`,
        ),
      ).rejects.toThrow(/42501|permission denied/i);
      await expect(relay.deletionRequest.findMany({ take: 1 })).rejects.toThrow(
        /42501|permission denied/i,
      );
    } finally {
      await owner.outboxDelivery.deleteMany({ where: { eventId } });
      await owner.outboxEvent.deleteMany({ where: { eventId } });
      await owner.workspace.delete({ where: { id: wsId } });
    }
  });

  it('enforces runtime_memory_outbox_reader SELECT-only on outbox_event', async () => {
    await expect(memory.outboxEvent.findMany({ take: 1 })).resolves.toBeInstanceOf(Array);
    await expect(
      memory.$executeRawUnsafe(`DELETE FROM public.outbox_event WHERE false`),
    ).rejects.toThrow(/42501|permission denied/i);
    await expect(
      memory.$executeRawUnsafe(
        `UPDATE public.outbox_event SET parked_at = now() WHERE false`,
      ),
    ).rejects.toThrow(/42501|permission denied/i);
    await expect(memory.outboxDelivery.findMany({ take: 1 })).rejects.toThrow(
      /42501|permission denied/i,
    );
  });

  it('enforces runtime_customer_worker_ops narrow scope and blocks outbox/DSR/budget/source_policy/signal writes', async () => {
    await expect(workerOps.dataProvider.findMany({ take: 1 })).resolves.toBeInstanceOf(Array);
    await expect(workerOps.icpDefinition.findMany({ take: 1 })).resolves.toBeInstanceOf(Array);
    await expect(workerOps.sourceSignal.findMany({ take: 1 })).resolves.toBeInstanceOf(Array);

    await expect(workerOps.signalIngest.findMany({ take: 1 })).rejects.toThrow(
      /42501|permission denied/i,
    );
    await expect(
      workerOps.$executeRawUnsafe(
        `INSERT INTO public.signal_ingest (id, provider_key, query_fingerprint, window_key, query_spec, status) VALUES (gen_random_uuid(), 'ted', 'fp', 'w', '{}'::jsonb, 'OK')`,
      ),
    ).rejects.toThrow(/42501|permission denied/i);
    await expect(
      workerOps.$executeRawUnsafe(`UPDATE public.signal_ingest SET status = 'ERROR' WHERE false`),
    ).rejects.toThrow(/42501|permission denied/i);
    await expect(
      workerOps.$executeRawUnsafe(
        `INSERT INTO public.source_signal (id, provider_key, signal_type, external_id, subject_name, subject_key, occurred_at, observed_at, payload, license, jurisdiction) VALUES (gen_random_uuid(), 'ted', 'TENDER_PUBLISHED', 'ext-1', 'Co', 'k-1', now(), now(), '{}'::jsonb, 'public', 'EU')`,
      ),
    ).rejects.toThrow(/42501|permission denied/i);
    await expect(
      workerOps.$executeRawUnsafe(`UPDATE public.source_signal SET status = 'EXPIRED' WHERE false`),
    ).rejects.toThrow(/42501|permission denied/i);

    await expect(workerOps.outboxEvent.findMany({ take: 1 })).rejects.toThrow(
      /42501|permission denied/i,
    );
    await expect(workerOps.outboxDelivery.findMany({ take: 1 })).rejects.toThrow(
      /42501|permission denied/i,
    );
    await expect(workerOps.deletionRequest.findMany({ take: 1 })).rejects.toThrow(
      /42501|permission denied/i,
    );
    await expect(workerOps.liaRecord.findMany({ take: 1 })).rejects.toThrow(
      /42501|permission denied/i,
    );
    await expect(workerOps.executionBudgetAuthority.findMany({ take: 1 })).rejects.toThrow(
      /42501|permission denied/i,
    );
    await expect(workerOps.sourcePolicy.findMany({ take: 1 })).rejects.toThrow(
      /42501|permission denied/i,
    );
    await expect(
      workerOps.$executeRawUnsafe(
        `INSERT INTO public.data_provider (id, key, class) VALUES (gen_random_uuid(), 'bad_ops', 'public_intelligence')`,
      ),
    ).rejects.toThrow(/42501|permission denied/i);
  });

  it('enforces execution_budget_platform_writer expanded platform ops & workspace RPC while denying catalog writes', async () => {
    const wsId = randomUUID();
    await owner.workspace.create({ data: { id: wsId, name: 'pw-list-test' } });
    try {
      const wsRows = await platformWriter.$queryRaw<Array<{ id: string }>>`
        SELECT id::text AS id FROM public.list_platform_workspace_ids_v1()
      `;
      expect(wsRows.some((r) => r.id === wsId)).toBe(true);

      await expect(
        app.$queryRaw`SELECT id::text AS id FROM public.list_platform_workspace_ids_v1()`,
      ).rejects.toThrow(/42501|permission denied/i);

      await expect(
        platformWriter.dataProvider.findMany({ take: 1 }),
      ).resolves.toBeInstanceOf(Array);
      await expect(
        platformWriter.sourcePolicy.findMany({ take: 1 }),
      ).resolves.toBeInstanceOf(Array);
      await expect(
        platformWriter.$executeRawUnsafe(
          `INSERT INTO public.source_policy (id, domain, source_type) VALUES (gen_random_uuid(), 'blocked-pw.example', 'news')`,
        ),
      ).rejects.toThrow(/42501|permission denied/i);

      const channel = await platformWriter.sourceChannel.create({
        data: {
          name: `pw-ch-${wsId.slice(0, 8)}`,
          mode: 'crawl',
          category: 'trade_fair',
          status: 'DISABLED',
          config: {},
        },
      });
      await platformWriter.sourceChannel.update({
        where: { id: channel.id },
        data: { status: 'ENABLED' },
      });
      await owner.sourceChannel.delete({ where: { id: channel.id } });
    } finally {
      await owner.workspace.delete({ where: { id: wsId } });
    }
  });

  it('verifies seeded platform catalogs read-only as app_user and relay and rejects missing keys', async () => {
    const sharedInput = {
      expectedProviderKeys: DEFAULT_EXPECTED_PROVIDER_KEYS,
      expectedSanctionsKeys: SANCTIONS_SOURCE_SEEDS.map((s) => s.key),
      expectedSkillVersions: BUILTIN_SKILLS.map((s) => ({
        skillKey: s.manifest.platform.skillKey,
        version: s.manifest.platform.version,
      })),
      expectedPackVersions: BUILTIN_PACKS.map((p) => ({
        packKey: p.manifest.packKey,
        version: p.manifest.version,
      })),
      expectedAgentKeys: BUILTIN_AGENTS.map((a) => a.agentKey),
    };

    const appSummary = await verifyPlatformCatalogsReadOnly(app, {
      requireJurisdictionPolicy: true,
      ...sharedInput,
    });
    expect(appSummary.jurisdictionPolicyCount).toBeGreaterThan(0);
    expect(appSummary.providerCount).toBe(DEFAULT_EXPECTED_PROVIDER_KEYS.length);

    const relaySummary = await verifyPlatformCatalogsReadOnly(relay, sharedInput);
    expect(relaySummary.jurisdictionPolicyCount).toBeNull();
    expect(relaySummary.providerCount).toBe(DEFAULT_EXPECTED_PROVIDER_KEYS.length);

    await expect(
      verifyPlatformCatalogsReadOnly(app, {
        expectedProviderKeys: ['nonexistent_sandbox_provider'],
      }),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof PlatformCatalogNotSeededError &&
        err.code === 'PROVIDER_CATALOG_NOT_SEEDED',
    );
  });

  it('rejects owner/app_user platformWriter in OutreachDncService & ChannelService while allowing execution_budget_platform_writer', async () => {
    const probeEmail = `dnc-probe-${randomUUID()}@example.com`;
    const badDncOwner = new OutreachDncService({} as never, owner);
    const badDncApp = new OutreachDncService({} as never, app);
    await expect(
      badDncOwner.suppressGlobal({ email: probeEmail, reason: 'bounce', source: 'pg-test' }),
    ).rejects.toMatchObject({ status: 503 });
    await expect(
      badDncApp.suppressGlobal({ email: probeEmail, reason: 'bounce', source: 'pg-test' }),
    ).rejects.toMatchObject({ status: 503 });
    const canonicalProbe = badDncOwner.canonicalEmail(probeEmail);
    const unsaltedHash = badDncOwner.emailHash(canonicalProbe);
    const probeHash = badDncOwner.storageEmailHash(canonicalProbe);
    expect(probeHash).not.toBe(unsaltedHash);
    expect(
      await owner.outreachGlobalSuppression.findUnique({ where: { emailHash: probeHash } }),
    ).toBeNull();

    const badChannelOwner = new ChannelService({} as never, undefined, undefined, owner);
    const badChannelApp = new ChannelService({} as never, undefined, undefined, app);
    const badChannelName = `blocked-owner-ch-${randomUUID().slice(0, 8)}`;
    const validCrawlConfig = {
      list: {
        url: 'https://expo.example/exhibitors?page={page}',
        maxPages: 5,
        itemSelector: '.card',
      },
      detail: { enabled: true, fields: { name: 'h1' } },
    };
    const channelCtx = {
      workspaceId: randomUUID(),
      userId: randomUUID(),
      roles: ['operator'],
      scopes: [],
    } as never;
    await expect(
      badChannelOwner.createChannel(channelCtx, {
        name: badChannelName,
        mode: 'crawl',
        category: 'trade_fair',
        config: validCrawlConfig,
      }),
    ).rejects.toMatchObject({ status: 503 });
    await expect(
      badChannelApp.createChannel(channelCtx, {
        name: badChannelName,
        mode: 'crawl',
        category: 'trade_fair',
        config: validCrawlConfig,
      }),
    ).rejects.toMatchObject({ status: 503 });
    expect(
      await owner.sourceChannel.findFirst({ where: { name: badChannelName } }),
    ).toBeNull();

    const validDnc = new OutreachDncService({} as never, platformWriter);
    try {
      await validDnc.suppressGlobal({ email: probeEmail, reason: 'bounce', source: 'pg-test' });
      expect(
        await owner.outreachGlobalSuppression.findUnique({ where: { emailHash: probeHash } }),
      ).not.toBeNull();
      expect(
        await owner.outreachGlobalSuppression.findUnique({ where: { emailHash: unsaltedHash } }),
      ).toBeNull();
    } finally {
      await owner.outreachGlobalSuppression.deleteMany({ where: { emailHash: probeHash } });
    }
  });

  it('runs contactReverifySweepOnce gate check via app_user without 42501 on source_policy', async () => {
    const domain = `reverify-gate-probe-${randomUUID().slice(0, 8)}.example`;
    const providerKey = 'millionverifier';
    const priorProvider = await owner.dataProvider.findUnique({
      where: { key: providerKey },
      select: { status: true },
    });
    await owner.dataProvider.update({
      where: { key: providerKey },
      data: { status: 'ENABLED' },
    });
    await owner.sourcePolicy.create({
      data: {
        domain,
        sourceType: 'api',
        reviewStatus: 'APPROVED',
        allowedPurpose: ['enrichment'],
      },
    });
    try {
      const activities = createContactReverifyActivities({
        prisma: app,
        ownerDb: workerOps,
        providers: [
          {
            key: providerKey,
            domain,
            isConfigured: () => true,
            verify: async () => ({ state: 'UNKNOWN', raw: {} }),
          },
        ],
      });
      const result = await activities.contactReverifySweepOnce({ limit: 1 });
      expect(result.status).toBe('ran');
    } finally {
      await owner.sourcePolicy.deleteMany({ where: { domain } });
      if (priorProvider) {
        await owner.dataProvider.update({
          where: { key: providerKey },
          data: { status: priorProvider.status },
        });
      }
    }
  });
});
