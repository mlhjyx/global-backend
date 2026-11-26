import { createCipheriv, createHash, createHmac, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ChannelService } from '../channels/channel.service';
import { buildChannelRecordRows, recordContentHash } from '../channels/channel-records';
import { createPrismaChannelRecordWriter } from '../channels/channel-records.prisma';
import {
  upsertGuessedEmailPoint,
  upsertObservedContactPoint,
  upsertProviderEmailPoint,
} from '../discovery/contact-point-writer';
import { readbackGuessedEmail } from '../discovery/email-guess-persist';
import { OutreachDncService } from '../outreach/outreach-dnc.service';
import { rehashOutreachGlobalSuppression } from '../../scripts/rehash-outreach-global-suppression.mts';
import {
  PII_PURPOSE,
  blindContactKey,
  blindPlatformKey,
  decryptPii,
  decryptPlatformPii,
  encryptPii,
  encryptPlatformPii,
} from './pii-crypto';
import { piiExtension } from './pii-crypto.extension';
import {
  listPlatformWorkspaceIds,
  reencryptPlatformPiiBatch,
  reencryptWorkspacePiiBatch,
} from './pii-reencryption';

/**
 * M8 (`mt-p2-backend-crypto`) real PostgreSQL integration verification:
 *   1. Per-workspace `enc:v2` / `bi:v2` HKDF + AAD isolation (same plaintext -> distinct ciphertext & blind index across wsA/wsB),
 *      AAD tamper/cross-tenant transplant rejection, default silent plaintext fallback refusal, legacy v1->v2 & k1->k2 rotation.
 *   2. `outreach_global_suppression` peppered HMAC + retired-pepper rotation + rehash CLI + `gain-saas` HTTP `emailHash` preservation.
 *   3. `source_channel_record` `TEXT` widening (>255 chars) + platform `enc:v2` random-IV write + `ChannelService.listChannelRecords` decryption.
 *   4. M4 `record_patent_inventor_tombstones_v1` / `purge_patent_inventor_cache_by_keys_v1` SECURITY DEFINER RPCs accept both `bi:v1:` and `bi:v2:`.
 */
const enabled = process.env.PII_CRYPTO_V2_TEST === '1';
const ownerUrl = process.env.DATABASE_URL;
const appUrl = process.env.APP_DATABASE_URL;
const platformWriterUrl = process.env.EXECUTION_BUDGET_PLATFORM_WRITER_DATABASE_URL;

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const ALLOWED_DB_PATHS = new Set(['/global_test', '/global_test_scoped_principals']);

function assertLoopbackTestUrl(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(
      `PII_CRYPTO_V2_TEST=1 requires ${name} (DATABASE_URL, APP_DATABASE_URL, EXECUTION_BUDGET_PLATFORM_WRITER_DATABASE_URL)`,
    );
  }
  const parsed = new URL(value);
  if (
    parsed.protocol !== 'postgresql:' ||
    !LOOPBACK_HOSTS.has(parsed.hostname) ||
    !ALLOWED_DB_PATHS.has(parsed.pathname) ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    throw new Error(`pii-crypto-v2.postgres.spec.ts requires loopback test database URL for ${name}`);
  }
  return value;
}

function makeLegacyV1Ciphertext(plaintext: string, hexKey: string): string {
  const key = Buffer.from(hexKey, 'hex');
  const iv = createHmac('sha256', key)
    .update('pii-iv:v1:')
    .update(plaintext, 'utf8')
    .digest()
    .subarray(0, 12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return 'enc:v1:' + Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64');
}

function makeLegacyV1Blind(rawKey: string, hexKey: string): string {
  const mac = createHmac('sha256', Buffer.from(hexKey, 'hex'))
    .update('pii-blind:v1:')
    .update(rawKey, 'utf8')
    .digest('hex');
  return `bi:v1:${mac}`;
}

describe.skipIf(!enabled)('MT-P2 PII crypto v2 on disposable PostgreSQL', () => {
  const wsA = randomUUID();
  const wsB = randomUUID();
  const companyA = randomUUID();
  const companyB = randomUUID();
  const contactA = randomUUID();
  const contactB = randomUUID();
  const contactLegacy = randomUUID();
  const pointA = randomUUID();
  const pointB = randomUUID();
  const pointLegacy = randomUUID();
  const channelRunId = randomUUID();
  const patentNorm = `m8probe${randomUUID().slice(0, 8)}`;
  const dncEmail = `m8-dnc-${randomUUID().slice(0, 8)}@example.com`;
  const tombstoneKeysToClean: string[] = [];
  let createdChannelId: string | null = null;

  let owner: PrismaClient;
  let appRaw: PrismaClient;
  let appExt: ReturnType<PrismaClient['$extends']>;
  let platformWriter: PrismaClient;

  const origEnv = {
    PII_KEYRING_JSON: process.env.PII_KEYRING_JSON,
    PII_ENCRYPTION_KEY: process.env.PII_ENCRYPTION_KEY,
    PII_ALLOW_LEGACY_PLAINTEXT_READ: process.env.PII_ALLOW_LEGACY_PLAINTEXT_READ,
    OUTREACH_DNC_HMAC_PEPPER: process.env.OUTREACH_DNC_HMAC_PEPPER,
    OUTREACH_DNC_HMAC_RETIRED_PEPPERS: process.env.OUTREACH_DNC_HMAC_RETIRED_PEPPERS,
  };

  const K1 = '0'.repeat(64);
  const K2 = '2'.repeat(64);
  const LEGACY_V1_KEY = 'a'.repeat(64);
  const PEPPER_1 = '1'.repeat(64);
  const PEPPER_2 = '3'.repeat(64);

  beforeAll(async () => {
    const verifiedOwnerUrl = assertLoopbackTestUrl('DATABASE_URL', ownerUrl);
    const verifiedAppUrl = assertLoopbackTestUrl('APP_DATABASE_URL', appUrl);
    const verifiedPlatformWriterUrl = assertLoopbackTestUrl(
      'EXECUTION_BUDGET_PLATFORM_WRITER_DATABASE_URL',
      platformWriterUrl,
    );
    process.env.PII_KEYRING_JSON = JSON.stringify({ activeKeyId: 'k1', keys: { k1: K1 } });
    process.env.PII_ENCRYPTION_KEY = LEGACY_V1_KEY;
    delete process.env.PII_ALLOW_LEGACY_PLAINTEXT_READ;
    process.env.OUTREACH_DNC_HMAC_PEPPER = PEPPER_1;
    delete process.env.OUTREACH_DNC_HMAC_RETIRED_PEPPERS;

    owner = new PrismaClient({ datasources: { db: { url: verifiedOwnerUrl } } });
    appRaw = new PrismaClient({ datasources: { db: { url: verifiedAppUrl } } });
    appExt = appRaw.$extends(piiExtension);
    platformWriter = new PrismaClient({ datasources: { db: { url: verifiedPlatformWriterUrl } } });

    await owner.workspace.createMany({
      data: [
        { id: wsA, name: 'M8 Probe A' },
        { id: wsB, name: 'M8 Probe B' },
      ],
    });
  });

  afterAll(async () => {
    for (const [k, v] of Object.entries(origEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }

    if (owner) {
      await owner.$executeRaw`DELETE FROM source_channel_record WHERE crawl_run_id = ${channelRunId}::uuid`;
      await owner.$executeRaw`DELETE FROM source_channel_run WHERE id = ${channelRunId}::uuid`;
      if (createdChannelId) {
        await owner.$executeRaw`DELETE FROM source_channel WHERE id = ${createdChannelId}::uuid`;
      }
      await owner.$executeRaw`DELETE FROM patent_inventor_cache WHERE assignee_norm = ${patentNorm}`;
      if (tombstoneKeysToClean.length > 0) {
        await owner.patentInventorTombstone.deleteMany({
          where: { inventorNameKey: { in: tombstoneKeysToClean } },
        });
      }
      const sha = createHash('sha256').update(dncEmail).digest('hex');
      const h1 = createHmac('sha256', Buffer.from(PEPPER_1, 'hex')).update('outreach-dnc:v1:').update(dncEmail).digest('hex');
      const h2 = createHmac('sha256', Buffer.from(PEPPER_2, 'hex')).update('outreach-dnc:v1:').update(dncEmail).digest('hex');
      await owner.outreachGlobalSuppression.deleteMany({
        where: { emailHash: { in: [sha, h1, h2] } },
      });
      await owner.$executeRaw`DELETE FROM field_evidence WHERE workspace_id IN (${wsA}::uuid, ${wsB}::uuid)`;
      await owner.$executeRaw`DELETE FROM contact_point_verification_event WHERE workspace_id IN (${wsA}::uuid, ${wsB}::uuid)`;
      await owner.$executeRaw`DELETE FROM contact_point WHERE workspace_id IN (${wsA}::uuid, ${wsB}::uuid)`;
      await owner.$executeRaw`DELETE FROM canonical_contact WHERE workspace_id IN (${wsA}::uuid, ${wsB}::uuid)`;
      await owner.$executeRaw`DELETE FROM canonical_company WHERE workspace_id IN (${wsA}::uuid, ${wsB}::uuid)`;
      await owner.$executeRaw`DELETE FROM workspace WHERE id IN (${wsA}::uuid, ${wsB}::uuid)`;
    }

    await Promise.all([
      owner?.$disconnect(),
      appRaw?.$disconnect(),
      platformWriter?.$disconnect(),
    ]);
  });

  it('isolates enc:v2/bi:v2 per workspace via HKDF+AAD, rejects plaintext fallback, and performs idempotent v1/k1->k2 re-encryption across tenant & platform tables', async () => {
    const extClient = appExt as unknown as {
      withWorkspace: <T>(
        workspaceId: string,
        fn: (tx: PrismaClient) => Promise<T>,
      ) => Promise<T>;
    };
    const withWs = <T>(workspaceId: string, fn: (tx: PrismaClient) => Promise<T>) =>
      extClient.withWorkspace(workspaceId, fn);

    // 1. Write identical plaintext PII under wsA and wsB via piiExtension.withWorkspace using k1
    for (const [ws, companyId, contactId, pointId] of [
      [wsA, companyA, contactA, pointA],
      [wsB, companyB, contactB, pointB],
    ] as const) {
      await withWs(ws, async (tx) => {
        await tx.canonicalCompany.create({
          data: {
            id: companyId,
            workspaceId: ws,
            name: 'M8 Probe GmbH',
            domain: 'm8-probe.example',
            dedupeKey: 'd:m8-probe.example',
          },
        });
        await tx.canonicalContact.create({
          data: {
            id: contactId,
            workspaceId: ws,
            companyId,
            fullName: 'Klara Beispiel',
            dedupeKey: blindContactKey('e:klara@m8-probe.example', {
              workspaceId: ws,
              purpose: PII_PURPOSE.CONTACT_DEDUPE_KEY,
            }),
          },
        });
        await tx.contactPoint.create({
          data: {
            id: pointId,
            workspaceId: ws,
            contactId,
            type: 'email',
            value: 'klara@m8-probe.example',
            domainBlindKey: blindContactKey('domain:m8-probe.example', {
              workspaceId: ws,
              purpose: PII_PURPOSE.DOMAIN_BLIND_KEY,
            }),
            sourceType: 'contact_page',
          },
        });
      });
    }

    // Seed legacy enc:v1 + bi:v1 contact & point + plaintext field_evidence under wsA directly via owner
    await owner.canonicalContact.create({
      data: {
        id: contactLegacy,
        workspaceId: wsA,
        companyId: companyA,
        fullName: makeLegacyV1Ciphertext('Lukas Alt', LEGACY_V1_KEY),
        dedupeKey: makeLegacyV1Blind('e:lukas@m8-probe.example', LEGACY_V1_KEY),
      },
    });
    await owner.contactPoint.create({
      data: {
        id: pointLegacy,
        workspaceId: wsA,
        contactId: contactLegacy,
        type: 'email',
        value: makeLegacyV1Ciphertext('lukas@m8-probe.example', LEGACY_V1_KEY),
        domainBlindKey: makeLegacyV1Blind('domain:m8-probe.example', LEGACY_V1_KEY),
        sourceType: 'contact_page',
      },
    });
    await owner.fieldEvidence.create({
      data: {
        workspaceId: wsA,
        entityType: 'contact',
        entityId: contactA,
        field: 'email',
        value: 'klara@m8-probe.example',
        providerKey: 'm8_probe',
        license: 'public',
        dataClass: 'red',
      },
    });

    // Verify cross-tenant identical plaintext produces distinct enc:v2 ciphertexts & bi:v2 blind keys in DB
    const [rawA] = await owner.$queryRaw<Array<{ full_name: string; dedupe_key: string }>>`
      SELECT full_name, dedupe_key FROM canonical_contact WHERE id = ${contactA}::uuid
    `;
    const [rawB] = await owner.$queryRaw<Array<{ full_name: string; dedupe_key: string }>>`
      SELECT full_name, dedupe_key FROM canonical_contact WHERE id = ${contactB}::uuid
    `;
    const [rawPtA] = await owner.$queryRaw<Array<{ value: string; domain_blind_key: string }>>`
      SELECT value, domain_blind_key FROM contact_point WHERE id = ${pointA}::uuid
    `;
    const [rawPtB] = await owner.$queryRaw<Array<{ value: string; domain_blind_key: string }>>`
      SELECT value, domain_blind_key FROM contact_point WHERE id = ${pointB}::uuid
    `;
    expect(rawA?.full_name.startsWith('enc:v2:k1:')).toBe(true);
    expect(rawB?.full_name.startsWith('enc:v2:k1:')).toBe(true);
    expect(rawA?.full_name).not.toBe(rawB?.full_name);
    expect(rawA?.dedupe_key.startsWith('bi:v2:k1:')).toBe(true);
    expect(rawA?.dedupe_key).not.toBe(rawB?.dedupe_key);
    expect(rawPtA?.value).not.toBe(rawPtB?.value);
    expect(rawPtA?.domain_blind_key).not.toBe(rawPtB?.domain_blind_key);

    // AAD blocks cross-tenant ciphertext transplant
    expect(() =>
      decryptPii(rawA!.full_name, {
        workspaceId: wsB,
        purpose: PII_PURPOSE.CANONICAL_CONTACT_FULL_NAME,
      }),
    ).toThrow();
    expect(
      decryptPii(rawA!.full_name, {
        workspaceId: wsA,
        purpose: PII_PURPOSE.CANONICAL_CONTACT_FULL_NAME,
      }),
    ).toBe('Klara Beispiel');

    // Read back decrypted through piiExtension (both v2 and legacy v1!)
    const readContact = await withWs(wsA, (tx) =>
      tx.canonicalContact.findUnique({
        where: { id: contactA },
        include: { contactPoints: true },
      }),
    );
    expect(readContact?.fullName).toBe('Klara Beispiel');
    expect(readContact?.contactPoints[0]?.value).toBe('klara@m8-probe.example');

    const readLegacy = await withWs(wsA, (tx) =>
      tx.canonicalContact.findUnique({
        where: { id: contactLegacy },
        include: { contactPoints: true },
      }),
    );
    expect(readLegacy?.fullName).toBe('Lukas Alt');
    expect(readLegacy?.contactPoints[0]?.value).toBe('lukas@m8-probe.example');

    // Verify silent plaintext fallback is CLOSED by default on DB read path
    await owner.$executeRaw`UPDATE canonical_contact SET full_name = 'Unencrypted Probe' WHERE id = ${contactB}::uuid`;
    await expect(
      withWs(wsB, (tx) => tx.canonicalContact.findUnique({ where: { id: contactB } })),
    ).rejects.toThrow(/PII_PLAINTEXT_FALLBACK_FORBIDDEN/);
    // Restore wsB ciphertext before rotation check
    await owner.$executeRaw`UPDATE canonical_contact SET full_name = ${rawB!.full_name} WHERE id = ${contactB}::uuid`;

    // Seed platform patent_inventor_cache row under k1 + test M4 SECURITY DEFINER RPCs with bi:v1 & bi:v2
    const patentV2Key = blindPlatformKey('beispiel klara', {
      scope: 'patent_inventor_cache',
      purpose: PII_PURPOSE.PATENT_INVENTOR_KEY,
    });
    const patentV1Key = makeLegacyV1Blind('beispiel klara', LEGACY_V1_KEY);
    await platformWriter.patentInventorCache.create({
      data: {
        assigneeNorm: patentNorm,
        assigneeCountry: 'de',
        assigneeNameRaw: 'M8 Probe GmbH',
        inventorName: encryptPlatformPii('BEISPIEL, KLARA', {
          scope: 'patent_inventor_cache',
          purpose: PII_PURPOSE.PATENT_INVENTOR_NAME,
        }),
        inventorNameKey: patentV2Key,
        windowFromYear: 2021,
        windowToYear: 2025,
        license: 'CC-BY-4.0',
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    const tombstoneV1 = makeLegacyV1Blind(`m8-tomb-${randomUUID().slice(0, 8)}`, LEGACY_V1_KEY);
    const tombstoneV2 = blindPlatformKey(`m8-tomb-${randomUUID().slice(0, 8)}`, {
      scope: 'patent_inventor_cache',
      purpose: PII_PURPOSE.PATENT_INVENTOR_KEY,
    });
    tombstoneKeysToClean.push(tombstoneV1, tombstoneV2);
    const [tombRes] = await withWs(wsA, (tx) =>
      tx.$queryRaw<Array<{ inserted: number }>>`
        SELECT public.record_patent_inventor_tombstones_v1(ARRAY[${tombstoneV1}, ${tombstoneV2}]::text[]) AS inserted
      `,
    );
    expect(tombRes?.inserted).toBe(2);
    const [purgeRes] = await withWs(wsA, (tx) =>
      tx.$queryRaw<Array<{ deleted: number }>>`
        SELECT public.purge_patent_inventor_cache_by_keys_v1(ARRAY[${patentV1Key}]::text[]) AS deleted
      `,
    );
    expect(purgeRes?.deleted).toBe(0);

    // 2. Seed source_channel + encrypted source_channel_record (also verifying TEXT > 255 chars)
    const appServiceProxy = {
      withWorkspace: withWs,
      sourceChannel: appRaw.sourceChannel,
      sourceChannelRun: appRaw.sourceChannelRun,
      sourceChannelRecord: appRaw.sourceChannelRecord,
    } as never;
    const channelCtx = { workspaceId: wsA, userId: randomUUID(), roles: ['operator'], scopes: [] } as never;
    const channelSvc = new ChannelService(appServiceProxy, undefined, undefined, platformWriter);
    const channel = await channelSvc.createChannel(channelCtx, {
      name: `m8-ch-${randomUUID().slice(0, 8)}`,
      mode: 'crawl',
      category: 'trade_fair',
      config: {
        list: { url: 'https://expo.example/p/{page}', maxPages: 1, itemSelector: '.card' },
        detail: { enabled: true, fields: { name: 'h1' } },
      },
    });
    createdChannelId = channel.id;

    await owner.sourceChannelRun.create({
      data: {
        id: channelRunId,
        channelId: channel.id,
        status: 'SUCCEEDED',
        triggeredByWorkspaceId: wsA,
      },
    });

    const longContactName = `Dr. Klara ${'von-'.repeat(70)}Beispiel`;
    expect(longContactName.length).toBeGreaterThan(255);
    const plainEmail = 'klara.channel@m8-probe.example';
    const [builtRow] = buildChannelRecordRows({
      channelId: channel.id,
      crawlRunId: channelRunId,
      records: [
        {
          name: 'M8 Channel Co',
          website: 'https://m8-channel.example',
          country: 'DE',
          contactName: longContactName,
          contactTitle: 'Managing Director',
          email: plainEmail,
          phone: '+49 89 998877',
          sourceUrl: 'https://expo.example/rec-1',
        },
      ],
    });
    // Override contactName past 255 chars to assert TEXT widening directly on PG16
    const wideRow = { ...builtRow!, contactName: longContactName };
    wideRow.contentHash = recordContentHash(wideRow);

    const writer = createPrismaChannelRecordWriter(platformWriter);
    await writer.upsertByChannelAndDedupe(wideRow, new Date());

    const rawChannelRec = await owner.sourceChannelRecord.findUniqueOrThrow({
      where: { channelId_dedupeKey: { channelId: channel.id, dedupeKey: wideRow.dedupeKey } },
    });
    expect(rawChannelRec.contentHash).toBe(wideRow.contentHash);
    expect(rawChannelRec.contactName?.startsWith('enc:v2:k1:')).toBe(true);
    expect(rawChannelRec.contactName!.length).toBeGreaterThan(320);
    expect(rawChannelRec.email?.startsWith('enc:v2:k1:')).toBe(true);
    expect(rawChannelRec.email).not.toContain('klara.channel');

    const listed = await channelSvc.listChannelRecords(channelCtx, channel.id, '20');
    expect(listed.records[0]).toMatchObject({
      name: 'M8 Channel Co',
      contactName: longContactName,
      contactTitle: 'Managing Director',
      email: plainEmail,
      phone: '+49 89 998877',
    });

    // 3. Rotate keyring to k2 (keeping k1) & run workspace + platform re-encryption (upgrades k1 + v1 + plaintext evidence)
    process.env.PII_KEYRING_JSON = JSON.stringify({
      activeKeyId: 'k2',
      keys: { k1: K1, k2: K2 },
    });

    const workspaces = await listPlatformWorkspaceIds(platformWriter);
    expect(workspaces).toContain(wsA);

    const wsCounts = await reencryptWorkspacePiiBatch(appRaw, wsA, { activeKeyId: 'k2' });
    expect(wsCounts.names).toBe(2);
    expect(wsCounts.dedupeKeys).toBe(2);
    expect(wsCounts.points).toBe(2);
    expect(wsCounts.domainBlindKeys).toBe(2);
    expect(wsCounts.evidence).toBe(1);

    const platCounts = await reencryptPlatformPiiBatch(platformWriter, { activeKeyId: 'k2' });
    expect(platCounts.patentCacheNames).toBeGreaterThanOrEqual(1);
    expect(platCounts.patentCacheKeys).toBeGreaterThanOrEqual(1);
    expect(platCounts.channelRecords).toBeGreaterThanOrEqual(1);

    const [rotatedContact] = await owner.$queryRaw<Array<{ full_name: string; dedupe_key: string }>>`
      SELECT full_name, dedupe_key FROM canonical_contact WHERE id = ${contactA}::uuid
    `;
    expect(rotatedContact?.full_name.startsWith('enc:v2:k2:')).toBe(true);
    expect(rotatedContact?.dedupe_key.startsWith('bi:v2:k2:')).toBe(true);

    const [rotatedLegacy] = await owner.$queryRaw<Array<{ full_name: string; dedupe_key: string }>>`
      SELECT full_name, dedupe_key FROM canonical_contact WHERE id = ${contactLegacy}::uuid
    `;
    expect(rotatedLegacy?.full_name.startsWith('enc:v2:k2:')).toBe(true);
    expect(rotatedLegacy?.dedupe_key.startsWith('bi:v2:k2:')).toBe(true);

    const rotatedChannelRec = await owner.sourceChannelRecord.findUniqueOrThrow({
      where: { channelId_dedupeKey: { channelId: channel.id, dedupeKey: wideRow.dedupeKey } },
    });
    expect(rotatedChannelRec.contactName?.startsWith('enc:v2:k2:')).toBe(true);
    expect(
      decryptPlatformPii(rotatedChannelRec.contactName!, {
        scope: 'source_channel_record',
        purpose: PII_PURPOSE.SOURCE_CHANNEL_CONTACT_NAME,
      }),
    ).toBe(longContactName);

    // Idempotent re-run produces 0 updates for wsA
    const secondWs = await reencryptWorkspacePiiBatch(appRaw, wsA, { activeKeyId: 'k2' });
    expect(secondWs).toMatchObject({ names: 0, dedupeKeys: 0, points: 0, domainBlindKeys: 0, evidence: 0 });
  });

  it('stores peppered HMAC in outreach_global_suppression, preserves sha256 emailHash on check, and rotates pepper via rehash', async () => {
    process.env.OUTREACH_DNC_HMAC_PEPPER = PEPPER_1;
    delete process.env.OUTREACH_DNC_HMAC_RETIRED_PEPPERS;

    const appReadOnly = {
      withWorkspace: <T>(_ws: string, fn: (tx: PrismaClient) => Promise<T>) => fn(appRaw),
      outreachGlobalSuppression: appRaw.outreachGlobalSuppression,
    } as never;

    const dnc1 = new OutreachDncService(appReadOnly, platformWriter);
    const publicSha256 = dnc1.emailHash(dncEmail);
    const hmac1 = dnc1.storageEmailHash(dncEmail);
    expect(hmac1).not.toBe(publicSha256);

    await dnc1.suppressGlobal({ email: dncEmail, reason: 'bounce', source: 'm8-pg-test' });
    expect(
      await owner.outreachGlobalSuppression.findUnique({ where: { emailHash: hmac1 } }),
    ).not.toBeNull();
    expect(
      await owner.outreachGlobalSuppression.findUnique({ where: { emailHash: publicSha256 } }),
    ).toBeNull();

    // Rotate to PEPPER_2 with PEPPER_1 retired: check() still hits AND returns public sha256 emailHash!
    process.env.OUTREACH_DNC_HMAC_PEPPER = PEPPER_2;
    process.env.OUTREACH_DNC_HMAC_RETIRED_PEPPERS = PEPPER_1;

    const dnc2 = new OutreachDncService(appReadOnly, platformWriter);
    const checked = await dnc2.check(wsA, [dncEmail]);
    expect(checked).toEqual([
      {
        emailHash: publicSha256,
        suppressed: true,
        reasons: ['global:bounce'],
      },
    ]);

    // Append-only rehash succeeds with platformWriter (no DELETE needed)
    const rehashed = await rehashOutreachGlobalSuppression(platformWriter, [dncEmail]);
    expect(rehashed).toMatchObject({ migrated: 1, prunedLegacy: 0 });
    const hmac2 = dnc2.storageEmailHash(dncEmail);
    expect(
      await owner.outreachGlobalSuppression.findUnique({ where: { emailHash: hmac2 } }),
    ).not.toBeNull();
    // platformWriter stays append-only on outreach_global_suppression (M4 boundary)
    await expect(
      platformWriter.outreachGlobalSuppression.deleteMany({ where: { emailHash: hmac1 } }),
    ).rejects.toThrow(/42501|permission denied/i);
    // Prune legacy via dedicated owner migration connection
    const pruned = await rehashOutreachGlobalSuppression(platformWriter, [dncEmail], {
      pruneLegacy: true,
      pruneWriter: owner,
    });
    expect(pruned).toMatchObject({ alreadyCurrent: 1, prunedLegacy: 1 });
    expect(
      await owner.outreachGlobalSuppression.findUnique({ where: { emailHash: hmac2 } }),
    ).not.toBeNull();
    expect(
      await owner.outreachGlobalSuppression.findUnique({ where: { emailHash: hmac1 } }),
    ).toBeNull();
  });

  it('preserves stronger four-state contact_point and verification event ledger on reencryption collision, and prevents rotation-window duplicates across writers/readback', async () => {
    const extClient = appExt as unknown as {
      withWorkspace: <T>(
        workspaceId: string,
        fn: (tx: PrismaClient) => Promise<T>,
      ) => Promise<T>;
    };
    const withWs = <T>(workspaceId: string, fn: (tx: PrismaClient) => Promise<T>) =>
      extClient.withWorkspace(workspaceId, fn);

    // 1. Seed a k1-encrypted VALID contact_point with full P1-02 four-state columns & verification event
    process.env.PII_KEYRING_JSON = JSON.stringify({ activeKeyId: 'k1', keys: { k1: K1 } });
    const collisionContactId = randomUUID();
    const strongK1PointId = randomUUID();
    const strongEventId = randomUUID();
    const weakK2PointId = randomUUID();
    const validSince = new Date('2026-10-01T00:00:00.000Z');
    const nextReverifyAt = new Date('2026-12-30T00:00:00.000Z');
    const collisionEmail = 'strong-valid@m8-probe.example';
    const k1Cipher = encryptPii(collisionEmail, {
      workspaceId: wsA,
      purpose: PII_PURPOSE.CONTACT_POINT_VALUE,
    });
    const k1Domain = blindContactKey('domain:m8-probe.example', {
      workspaceId: wsA,
      purpose: PII_PURPOSE.DOMAIN_BLIND_KEY,
    });

    await owner.canonicalContact.create({
      data: {
        id: collisionContactId,
        workspaceId: wsA,
        companyId: companyA,
        fullName: encryptPii('Maria Kollision', {
          workspaceId: wsA,
          purpose: PII_PURPOSE.CANONICAL_CONTACT_FULL_NAME,
        }),
        dedupeKey: blindContactKey(`e:${collisionEmail}`, {
          workspaceId: wsA,
          purpose: PII_PURPOSE.CONTACT_DEDUPE_KEY,
        }),
      },
    });
    await owner.contactPoint.create({
      data: {
        id: strongK1PointId,
        workspaceId: wsA,
        contactId: collisionContactId,
        type: 'email',
        value: k1Cipher,
        status: 'VALID',
        verifiedAt: validSince,
        sourceType: 'contact_page',
        emailType: 'personal',
        verificationState: 'VALID',
        verificationProvider: 'smtp_self',
        verificationMethod: 'smtp_rcpt',
        catchAll: 'not_catch_all',
        catchAllClass: 'not_catch_all',
        confidence: 95,
        validSince,
        nextReverifyAt,
        domainBlindKey: k1Domain,
      },
    });
    await owner.contactPointVerificationEvent.create({
      data: {
        id: strongEventId,
        workspaceId: wsA,
        contactPointId: strongK1PointId,
        attemptNo: 1,
        providerKey: 'smtp_self',
        method: 'smtp_rcpt',
        verdict: 'valid',
        detail: 'smtp_accepted:250',
        catchAll: 'not_catch_all',
        catchAllClass: 'not_catch_all',
        score: 95,
        actorId: 'm8-pg-test',
        requestHash: `m8-collision-${strongEventId}`,
      },
    });
    await owner.contactPoint.update({
      where: { id: strongK1PointId },
      data: { lastVerificationEventId: strongEventId },
    });

    // Switch keyring to k2 (keeping k1) and verify rotation-window writers/readback hit the existing k1 row
    process.env.PII_KEYRING_JSON = JSON.stringify({
      activeKeyId: 'k2',
      keys: { k1: K1, k2: K2 },
    });

    await withWs(wsA, async (tx) => {
      await upsertObservedContactPoint(tx, {
        workspaceId: wsA,
        contactId: collisionContactId,
        type: 'email',
        value: collisionEmail,
        sourceType: 'homepage',
      });
      const providerSnap = await upsertProviderEmailPoint(tx, {
        workspaceId: wsA,
        contactId: collisionContactId,
        email: collisionEmail,
        emailType: 'personal',
      });
      expect(providerSnap).toEqual({
        id: strongK1PointId,
        verificationState: 'VALID',
        validSince,
        nextReverifyAt,
      });

      const readback = await readbackGuessedEmail(tx, {
        workspaceId: wsA,
        contactId: collisionContactId,
        result: {
          status: 'verified',
          best: {
            email: collisionEmail,
            pattern: 'first',
            prior: 0.9,
            verdict: { status: 'VALID', detail: 'smtp_accepted:250', costCents: 0 },
            confidence: 0.95,
          },
          triedCount: 1,
          candidates: [],
          reason: 'smtp_verified:first',
        },
      });
      expect(readback).toEqual({
        persisted: true,
        email: collisionEmail,
        status: 'VALID',
        reason: 'smtp_verified:first',
      });

      const guessed = await upsertGuessedEmailPoint(tx, {
        workspaceId: wsA,
        contactId: collisionContactId,
        email: collisionEmail,
        status: 'VALID',
        verifiedAt: validSince,
        emailType: 'personal',
        sourceType: 'pattern_guess',
        verificationMethod: 'smtp_rcpt',
        catchAll: 'not_catch_all',
        verificationState: 'VALID',
        catchAllClass: 'not_catch_all',
        verificationProvider: 'smtp_self',
        confidence: 95,
        validSince,
        nextReverifyAt,
      });
      expect(guessed.id).toBe(strongK1PointId);
    });

    const pointsBeforeDup = await owner.contactPoint.findMany({
      where: { contactId: collisionContactId, type: 'email' },
    });
    expect(pointsBeforeDup).toHaveLength(1);

    // 2. Seed a pre-existing weaker k2 UNKNOWN duplicate directly via owner and verify reencryptWorkspacePiiBatch
    // deletes the weaker k2 row first, rekeys the stronger k1 row in place, and preserves all four-state columns & events.
    const k2Cipher = encryptPii(collisionEmail, {
      workspaceId: wsA,
      purpose: PII_PURPOSE.CONTACT_POINT_VALUE,
    });
    await owner.contactPoint.create({
      data: {
        id: weakK2PointId,
        workspaceId: wsA,
        contactId: collisionContactId,
        type: 'email',
        value: k2Cipher,
        status: 'UNVERIFIED',
        sourceType: 'homepage',
        verificationState: 'UNKNOWN',
        domainBlindKey: k1Domain,
      },
    });

    const dedupCounts = await reencryptWorkspacePiiBatch(appRaw, wsA, { activeKeyId: 'k2' });
    expect(dedupCounts.dedup).toBe(1);

    const survivingPoints = await owner.contactPoint.findMany({
      where: { contactId: collisionContactId, type: 'email' },
    });
    expect(survivingPoints).toHaveLength(1);
    const survivor = survivingPoints[0]!;
    expect(survivor.id).toBe(strongK1PointId);
    expect(survivor.value.startsWith('enc:v2:k2:')).toBe(true);
    expect(survivor.domainBlindKey?.startsWith('bi:v2:k2:')).toBe(true);
    expect(survivor.status).toBe('VALID');
    expect(survivor.verificationState).toBe('VALID');
    expect(survivor.validSince?.toISOString()).toBe(validSince.toISOString());
    expect(survivor.verificationProvider).toBe('smtp_self');
    expect(survivor.verificationMethod).toBe('smtp_rcpt');
    expect(survivor.confidence).toBe(95);
    expect(survivor.lastVerificationEventId).toBe(strongEventId);

    const events = await owner.contactPointVerificationEvent.findMany({
      where: { contactPointId: strongK1PointId },
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.id).toBe(strongEventId);
  });
});
