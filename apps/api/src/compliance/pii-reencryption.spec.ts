import { createCipheriv, createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PII_PURPOSE,
  blindContactKey,
  decryptPii,
  decryptPlatformPii,
  encryptPii,
  encryptPlatformPii,
} from './pii-crypto';
import {
  reencryptPlatformPiiBatch,
  reencryptWorkspacePiiBatch,
} from './pii-reencryption';
import { parseBackfillArgs } from '../../scripts/backfill-pii-encryption.mts';

const WS = '00000000-0000-4000-8000-0000000000aa';

describe('parseBackfillArgs', () => {
  it('parses defaults, flags, and valid --workspace UUID; rejects invalid UUID', () => {
    expect(parseBackfillArgs([])).toEqual({
      dryRun: false,
      workspaceId: null,
      skipPlatform: false,
    });
    expect(parseBackfillArgs(['--dry-run', '--skip-platform', '--workspace', WS])).toEqual({
      dryRun: true,
      workspaceId: WS,
      skipPlatform: true,
    });
    expect(() => parseBackfillArgs(['--workspace', 'not-a-uuid'])).toThrow(/UUID/u);
    expect(() => parseBackfillArgs(['--workspace'])).toThrow(/UUID/u);
  });
});

describe('reencryptWorkspacePiiBatch & reencryptPlatformPiiBatch', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('upgrades legacy enc:v1/bi:v1, plaintext, and rotated enc:v2/bi:v2 rows to activeKeyId even with silent plaintext fallback disabled', async () => {
    const legacyHex = 'a'.repeat(64);
    const makeLegacyV1 = (plain: string): string => {
      const key = Buffer.from(legacyHex, 'hex');
      const iv = createHmac('sha256', key).update('pii-iv:v1:').update(plain, 'utf8').digest().subarray(0, 12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
      return 'enc:v1:' + Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64');
    };
    const makeLegacyV1Blind = (raw: string): string =>
      'bi:v1:' + createHmac('sha256', Buffer.from(legacyHex, 'hex')).update('pii-blind:v1:').update(raw, 'utf8').digest('hex');

    vi.stubEnv('PII_ENCRYPTION_KEY', legacyHex);
    vi.stubEnv('PII_KEYRING_JSON', JSON.stringify({ activeKeyId: 'k1', keys: { k1: '0'.repeat(64) } }));
    const v2k1Name = encryptPii('Anna Weber', { workspaceId: WS, purpose: PII_PURPOSE.CANONICAL_CONTACT_FULL_NAME });
    const v2k1Dedupe = blindContactKey('e:anna@acme.example', { workspaceId: WS, purpose: PII_PURPOSE.CONTACT_DEDUPE_KEY });
    const v2k1Email = encryptPii('anna@acme.example', { workspaceId: WS, purpose: PII_PURPOSE.CONTACT_POINT_VALUE });
    const v2k1DomainBlind = blindContactKey('domain:acme.example', { workspaceId: WS, purpose: PII_PURPOSE.DOMAIN_BLIND_KEY });
    const v2k1EvidenceEmail = encryptPii('anna@acme.example', { workspaceId: WS, purpose: PII_PURPOSE.FIELD_EVIDENCE_VALUE });
    const v1Name = makeLegacyV1('Hans Legacy');
    const v1Dedupe = makeLegacyV1Blind('e:hans@acme.example');
    const v1Email = makeLegacyV1('hans@acme.example');
    const v1DomainBlind = makeLegacyV1Blind('domain:acme.example');

    vi.stubEnv(
      'PII_KEYRING_JSON',
      JSON.stringify({ activeKeyId: 'k2', keys: { k1: '0'.repeat(64), k2: '2'.repeat(64) } }),
    );

    const updatedContacts: Array<{ id: string; data: { fullName?: string; dedupeKey?: string } }> = [];
    const updatedPoints: Array<{ id: string; data: { value?: string; domainBlindKey?: string } }> = [];
    const updatedEvidence: Array<{ id: string; data: { value: unknown } }> = [];

    const tx = {
      $executeRaw: vi.fn(async () => 1),
      canonicalContact: {
        findMany: vi.fn(async () => [
          {
            id: 'ct-1',
            fullName: v2k1Name,
            dedupeKey: v2k1Dedupe,
            company: { dedupeKey: 'd:acme.example' },
            contactPoints: [{ type: 'email', value: v2k1Email }],
          },
          {
            id: 'ct-2',
            fullName: v1Name,
            dedupeKey: v1Dedupe,
            company: { dedupeKey: 'd:acme.example' },
            contactPoints: [{ type: 'email', value: v1Email }],
          },
        ]),
        findFirst: vi.fn(async () => null),
        update: vi.fn(async ({ where, data }: { where: { id: string }; data: { fullName?: string; dedupeKey?: string } }) => {
          updatedContacts.push({ id: where.id, data });
          return {};
        }),
      },
      contactPoint: {
        findMany: vi.fn(async () => [
          {
            id: 'cp-1',
            contactId: 'ct-1',
            type: 'email',
            value: v2k1Email,
            status: 'VALID',
            verifiedAt: null,
            domainBlindKey: v2k1DomainBlind,
          },
          {
            id: 'cp-2',
            contactId: 'ct-2',
            type: 'email',
            value: v1Email,
            status: 'VALID',
            verifiedAt: null,
            domainBlindKey: v1DomainBlind,
          },
        ]),
        findFirst: vi.fn(async () => null),
        update: vi.fn(async ({ where, data }: { where: { id: string }; data: { value?: string; domainBlindKey?: string } }) => {
          updatedPoints.push({ id: where.id, data });
          return {};
        }),
      },
      fieldEvidence: {
        findMany: vi.fn(async ({ where }: { where: { field: unknown } }) =>
          where.field === 'email.guess'
            ? [{ id: 'ev-2', value: { email: v2k1EvidenceEmail, pattern: 'first' } }]
            : [
                { id: 'ev-1', value: v2k1EvidenceEmail },
                { id: 'ev-3', value: 'plain.legacy@acme.example' },
              ],
        ),
        update: vi.fn(async ({ where, data }: { where: { id: string }; data: { value: unknown } }) => {
          updatedEvidence.push({ id: where.id, data });
          return {};
        }),
      },
    };
    const appDb = {
      $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
    };

    const dryCounts = await reencryptWorkspacePiiBatch(appDb as never, WS, { dryRun: true, activeKeyId: 'k2' });
    expect(dryCounts).toEqual({
      workspaceId: WS,
      names: 2,
      dedupeKeys: 2,
      unmatchedDedupeKeys: 0,
      merges: 0,
      points: 2,
      domainBlindKeys: 2,
      dedup: 0,
      evidence: 3,
    });
    expect(updatedContacts).toHaveLength(0);
    expect(updatedPoints).toHaveLength(0);
    expect(updatedEvidence).toHaveLength(0);

    const realCounts = await reencryptWorkspacePiiBatch(appDb as never, WS, { dryRun: false, activeKeyId: 'k2' });
    expect(realCounts).toEqual(dryCounts);
    expect(updatedContacts[0]?.data.fullName).toMatch(/^enc:v2:k2:/);
    expect(updatedContacts[0]?.data.dedupeKey).toMatch(/^bi:v2:k2:/);
    expect(decryptPii(updatedContacts[0]!.data.fullName!, { workspaceId: WS, purpose: PII_PURPOSE.CANONICAL_CONTACT_FULL_NAME })).toBe('Anna Weber');
    expect(updatedContacts[1]?.data.fullName).toMatch(/^enc:v2:k2:/);
    expect(updatedContacts[1]?.data.dedupeKey).toMatch(/^bi:v2:k2:/);
    expect(decryptPii(updatedContacts[1]!.data.fullName!, { workspaceId: WS, purpose: PII_PURPOSE.CANONICAL_CONTACT_FULL_NAME })).toBe('Hans Legacy');
    expect(updatedPoints[0]?.data.value).toMatch(/^enc:v2:k2:/);
    expect(updatedPoints[0]?.data.domainBlindKey).toMatch(/^bi:v2:k2:/);
    expect(updatedPoints[1]?.data.value).toMatch(/^enc:v2:k2:/);
    expect(updatedPoints[1]?.data.domainBlindKey).toMatch(/^bi:v2:k2:/);
    expect((updatedEvidence[0]?.data.value as string)).toMatch(/^enc:v2:k2:/);
    expect((updatedEvidence[1]?.data.value as string)).toMatch(/^enc:v2:k2:/);
    expect(((updatedEvidence[2]?.data.value as { email: string }).email)).toMatch(/^enc:v2:k2:/);
  });

  it('reencryptPlatformPiiBatch upgrades plaintext source_channel_record and rotated patent_inventor_cache via platformWriter', async () => {
    vi.stubEnv('PII_KEYRING_JSON', JSON.stringify({ activeKeyId: 'k1', keys: { k1: '0'.repeat(64) } }));
    const oldInventor = encryptPlatformPii('MUELLER, HANS', {
      scope: 'patent_inventor_cache',
      purpose: PII_PURPOSE.PATENT_INVENTOR_NAME,
    });
    const oldInventorKey = 'bi:v1:' + 'a'.repeat(64);
    vi.stubEnv(
      'PII_KEYRING_JSON',
      JSON.stringify({ activeKeyId: 'k2', keys: { k1: '0'.repeat(64), k2: '2'.repeat(64) } }),
    );

    const updatedPatent: Array<{ id: string; data: { inventorName?: string; inventorNameKey?: string } }> = [];
    const updatedChannel: Array<{ id: string; data: Record<string, string | undefined> }> = [];

    const writer = {
      $queryRaw: vi.fn(async () => [
        {
          sessionUser: 'execution_budget_platform_writer_login',
          currentUser: 'execution_budget_platform_writer_login',
          sessionRole: 'none',
          rolCanLogin: true,
          rolSuper: false,
          rolBypassRls: false,
          rolCreateDb: false,
          rolCreateRole: false,
          rolReplication: false,
          rolInherit: true,
          memberships: ['execution_budget_platform_writer'],
        },
      ]),
      patentInventorCache: {
        findMany: vi.fn(async () => [
          {
            id: 'pic-1',
            assigneeNorm: 'acme',
            assigneeCountry: 'de',
            inventorName: oldInventor,
            inventorNameKey: oldInventorKey,
          },
        ]),
        findFirst: vi.fn(async () => null),
        update: vi.fn(async ({ where, data }: { where: { id: string }; data: { inventorName?: string; inventorNameKey?: string } }) => {
          updatedPatent.push({ id: where.id, data });
          return {};
        }),
      },
      sourceChannelRecord: {
        findMany: vi.fn(async ({ where }: { where: { id?: { gt: string } } }) =>
          where.id
            ? []
            : [
                {
                  id: 'scr-1',
                  contactName: 'Legacy Plain Name',
                  contactTitle: null,
                  email: 'legacy@acme.example',
                  phone: '+49 1234',
                },
              ],
        ),
        update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, string | undefined> }) => {
          updatedChannel.push({ id: where.id, data });
          return {};
        }),
      },
    };

    const counts = await reencryptPlatformPiiBatch(writer as never, { dryRun: false, activeKeyId: 'k2' });
    expect(counts).toEqual({
      patentCacheNames: 1,
      patentCacheKeys: 1,
      patentCacheDedup: 0,
      channelRecords: 1,
    });
    expect(updatedPatent[0]?.data.inventorName).toMatch(/^enc:v2:k2:/);
    expect(updatedPatent[0]?.data.inventorNameKey).toMatch(/^bi:v2:k2:/);
    expect(updatedChannel[0]?.data.contactName).toMatch(/^enc:v2:k2:/);
    expect(updatedChannel[0]?.data.email).toMatch(/^enc:v2:k2:/);
    expect(updatedChannel[0]?.data.phone).toMatch(/^enc:v2:k2:/);
    expect(
      decryptPlatformPii(updatedChannel[0]!.data.email!, {
        scope: 'source_channel_record',
        purpose: PII_PURPOSE.SOURCE_CHANNEL_EMAIL,
      }),
    ).toBe('legacy@acme.example');
  });
});
