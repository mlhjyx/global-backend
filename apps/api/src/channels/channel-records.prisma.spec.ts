import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPrismaChannelRecordWriter } from './channel-records.prisma';
import {
  buildChannelRecordRows,
  decryptChannelRecordPii,
  type ChannelRecordRow,
} from './channel-records';

const ROW: ChannelRecordRow = {
  channelId: '11111111-1111-4111-8111-111111111111',
  crawlRunId: '22222222-2222-4222-8222-222222222222',
  dedupeKey: 'd:acme.example',
  name: 'Acme',
  website: 'https://acme.example',
  country: 'DE',
  industry: 'pumps',
  products: ['pump'],
  keywords: null,
  contactName: null,
  contactTitle: null,
  email: null,
  phone: null,
  sourceUrl: 'https://acme.example/about',
  contentHash: 'a'.repeat(64),
};

const PII_ROW: ChannelRecordRow = {
  ...ROW,
  contactName: 'Max Mustermann',
  contactTitle: 'VP Sales',
  email: 'max@acme.example',
  phone: '+49 30 123456',
};

describe('CH-7：渠道记录物化的观察名单语义与 PII enc:v2 加密', () => {
  const prevKeyring = process.env.PII_KEYRING_JSON;

  afterEach(() => {
    if (prevKeyring === undefined) delete process.env.PII_KEYRING_JSON;
    else process.env.PII_KEYRING_JSON = prevKeyring;
  });

  it('新观测 create 置 reviewStatus=PENDING', async () => {
    const upsert = vi.fn(async () => ({}));
    const writer = createPrismaChannelRecordWriter({ sourceChannelRecord: { upsert } } as never);
    await writer.upsertByChannelAndDedupe(ROW, new Date('2026-11-09T00:00:00Z'));
    const args = upsert.mock.calls[0]![0] as { create: Record<string, unknown>; update: Record<string, unknown> };
    expect(args.create).toMatchObject({ reviewStatus: 'PENDING' });
  });

  it('重复观测 update 不覆盖人工抽检结论（review_status/reviewed_by/at 均不写）', async () => {
    const upsert = vi.fn(async () => ({}));
    const writer = createPrismaChannelRecordWriter({ sourceChannelRecord: { upsert } } as never);
    await writer.upsertByChannelAndDedupe(ROW, new Date('2026-11-09T00:00:00Z'));
    const args = upsert.mock.calls[0]![0] as { update: Record<string, unknown> };
    expect(args.update).not.toHaveProperty('reviewStatus');
    expect(args.update).not.toHaveProperty('reviewedBy');
    expect(args.update).not.toHaveProperty('reviewedAt');
  });

  it('加密 contactName/contactTitle/email/phone 为 enc:v2 随机 IV 密文，保留 contentHash，且可解密回原明文', async () => {
    const [plainRow] = buildChannelRecordRows({
      channelId: ROW.channelId,
      crawlRunId: ROW.crawlRunId,
      records: [
        {
          name: 'Acme',
          website: 'https://acme.example',
          country: 'DE',
          industry: 'pumps',
          products: ['pump'],
          contactName: PII_ROW.contactName ?? undefined,
          contactTitle: PII_ROW.contactTitle ?? undefined,
          email: PII_ROW.email ?? undefined,
          phone: PII_ROW.phone ?? undefined,
          sourceUrl: 'https://acme.example/about',
        },
      ],
    });
    const upsert = vi.fn(async () => ({}));
    const writer = createPrismaChannelRecordWriter({ sourceChannelRecord: { upsert } } as never);
    await writer.upsertByChannelAndDedupe(plainRow!, new Date('2026-11-09T00:00:00Z'));
    await writer.upsertByChannelAndDedupe(plainRow!, new Date('2026-11-09T01:00:00Z'));

    const first = upsert.mock.calls[0]![0] as { create: Record<string, unknown>; update: Record<string, unknown> };
    const second = upsert.mock.calls[1]![0] as { create: Record<string, unknown> };
    for (const field of ['contactName', 'contactTitle', 'email', 'phone'] as const) {
      const c1 = first.create[field] as string;
      const c2 = second.create[field] as string;
      expect(c1).toMatch(/^enc:v2:[A-Za-z0-9_-]+:/);
      expect(c1).not.toBe(c2); // random 12B IV per write
      expect(first.update[field]).toBe(c1);
    }
    expect(first.create.contentHash).toBe(plainRow!.contentHash);
    expect(JSON.stringify(first)).not.toContain('Max Mustermann');
    expect(JSON.stringify(first)).not.toContain('max@acme.example');

    const decrypted = decryptChannelRecordPii({
      contactName: first.create.contactName as string,
      contactTitle: first.create.contactTitle as string,
      email: first.create.email as string,
      phone: first.create.phone as string,
    });
    expect(decrypted).toEqual({
      contactName: PII_ROW.contactName,
      contactTitle: PII_ROW.contactTitle,
      email: PII_ROW.email,
      phone: PII_ROW.phone,
    });
  });

  it('fail-closed：缺失 PII_KEYRING_JSON 时拒绝以明文写入 source_channel_record PII', async () => {
    delete process.env.PII_KEYRING_JSON;
    const upsert = vi.fn(async () => ({}));
    const writer = createPrismaChannelRecordWriter({ sourceChannelRecord: { upsert } } as never);
    await expect(
      writer.upsertByChannelAndDedupe(PII_ROW, new Date('2026-11-09T00:00:00Z')),
    ).rejects.toThrow(/PII_KEYRING_JSON/);
    expect(upsert).not.toHaveBeenCalled();
  });
});
