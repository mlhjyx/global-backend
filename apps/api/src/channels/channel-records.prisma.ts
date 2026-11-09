import { Prisma } from '@prisma/client';

import type { PrismaService } from '../prisma/prisma.service';
import type { ChannelRecordRow, ChannelRecordWriter } from './channel-records';

/**
 * 渠道记录物化的 Prisma 写入器（平台上下文，无租户 RLS）。
 * upsert 键 (channelId, dedupeKey)：跨轮合并、last_seen 前移；首次插入记 firstSeenAt=crawlRunId 轮次。
 */
export function createPrismaChannelRecordWriter(
  prisma: PrismaService,
): ChannelRecordWriter {
  return {
    async upsertByChannelAndDedupe(row: ChannelRecordRow, seenAt: Date): Promise<void> {
      const products = row.products === null ? Prisma.DbNull : row.products;
      const keywords = row.keywords === null ? Prisma.DbNull : row.keywords;
      await prisma.sourceChannelRecord.upsert({
        where: {
          channelId_dedupeKey: { channelId: row.channelId, dedupeKey: row.dedupeKey },
        },
        create: {
          channelId: row.channelId,
          crawlRunId: row.crawlRunId,
          dedupeKey: row.dedupeKey,
          name: row.name,
          website: row.website,
          country: row.country,
          industry: row.industry,
          products,
          keywords,
          contactName: row.contactName,
          contactTitle: row.contactTitle,
          email: row.email,
          phone: row.phone,
          sourceUrl: row.sourceUrl,
          contentHash: row.contentHash,
          firstSeenAt: seenAt,
          lastSeenAt: seenAt,
          // CH-7 观察名单：新观测一律 PENDING，人工抽检后才改 APPROVED/REJECTED；
          // update 分支刻意不碰 review_status（重复观测不覆盖人工结论）。
          reviewStatus: 'PENDING',
        },
        update: {
          crawlRunId: row.crawlRunId,
          name: row.name,
          website: row.website,
          country: row.country,
          industry: row.industry,
          products,
          keywords,
          contactName: row.contactName,
          contactTitle: row.contactTitle,
          email: row.email,
          phone: row.phone,
          sourceUrl: row.sourceUrl,
          contentHash: row.contentHash,
          lastSeenAt: seenAt,
        },
      });
    },
  };
}
