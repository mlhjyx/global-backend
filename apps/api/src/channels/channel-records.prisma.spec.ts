import { describe, expect, it, vi } from 'vitest';
import { createPrismaChannelRecordWriter } from './channel-records.prisma';
import type { ChannelRecordRow } from './channel-records';

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

describe('CH-7：渠道记录物化的观察名单语义', () => {
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
});
