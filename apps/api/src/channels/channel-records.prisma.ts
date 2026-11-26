import { Prisma, type PrismaClient } from '@prisma/client';

import {
  encryptChannelRecordPii,
  type ChannelRecordRow,
  type ChannelRecordWriter,
} from './channel-records';

/**
 * 渠道记录物化的 Prisma 写入器（平台上下文，无租户 RLS）。
 * upsert 键 (channelId, dedupeKey)：跨轮合并、last_seen 前移；首次插入记 firstSeenAt=crawlRunId 轮次。
 * 写入前对 contactName / contactTitle / email / phone 施加 platform:source_channel_record enc:v2 加密（fail-closed）。
 */
export function createPrismaChannelRecordWriter(
  prisma: Pick<PrismaClient, 'sourceChannelRecord'>,
): ChannelRecordWriter {
  return {
    async upsertByChannelAndDedupe(row: ChannelRecordRow, seenAt: Date): Promise<void> {
      const encrypted = encryptChannelRecordPii(row);
      const products = encrypted.products === null ? Prisma.DbNull : encrypted.products;
      const keywords = encrypted.keywords === null ? Prisma.DbNull : encrypted.keywords;
      await prisma.sourceChannelRecord.upsert({
        where: {
          channelId_dedupeKey: { channelId: encrypted.channelId, dedupeKey: encrypted.dedupeKey },
        },
        create: {
          channelId: encrypted.channelId,
          crawlRunId: encrypted.crawlRunId,
          dedupeKey: encrypted.dedupeKey,
          name: encrypted.name,
          website: encrypted.website,
          country: encrypted.country,
          industry: encrypted.industry,
          products,
          keywords,
          contactName: encrypted.contactName,
          contactTitle: encrypted.contactTitle,
          email: encrypted.email,
          phone: encrypted.phone,
          sourceUrl: encrypted.sourceUrl,
          contentHash: encrypted.contentHash,
          firstSeenAt: seenAt,
          lastSeenAt: seenAt,
          // CH-7 观察名单：新观测一律 PENDING，人工抽检后才改 APPROVED/REJECTED；
          // 数据库按内容哈希保留同版本审批，版本变化时将 APPROVED 恢复为 PENDING。
          reviewStatus: 'PENDING',
        },
        update: {
          crawlRunId: encrypted.crawlRunId,
          name: encrypted.name,
          website: encrypted.website,
          country: encrypted.country,
          industry: encrypted.industry,
          products,
          keywords,
          contactName: encrypted.contactName,
          contactTitle: encrypted.contactTitle,
          email: encrypted.email,
          phone: encrypted.phone,
          sourceUrl: encrypted.sourceUrl,
          contentHash: encrypted.contentHash,
          lastSeenAt: seenAt,
        },
      });
    },
  };
}
