/**
 * 渠道抓取记录物化（2026-11-05 设计；OWNER-DECISION-2026-11-05）。
 *
 * - 平台级 source_channel_record：(channelId, dedupeKey) 跨轮 upsert，last_seen 前移、content_hash 记录字段快照；
 * - 联系人字段 PII_PENDING_ENCRYPTION 明文存储（列级加密/Q25 审计/保留期由 OWNER-DECISION-2026-11-05 延后）；
 * - 幂等：同一批记录重复写入无害（唯一键 + upsert），活动重试不产生重复行；
 * - 同轮内同名折叠（首条为准），返回写入条数（recordsMaterialized 的口径）。
 */
import { createHash } from 'node:crypto';
import { companyIdentity } from '../discovery/identity';
import type { CrawledRecord } from './channel-crawler';

export interface ChannelRecordRow {
  channelId: string;
  crawlRunId: string;
  dedupeKey: string;
  name: string;
  website: string | null;
  country: string | null;
  industry: string | null;
  products: string[] | null;
  keywords: string[] | null;
  contactName: string | null;
  contactTitle: string | null;
  email: string | null;
  phone: string | null;
  sourceUrl: string;
  contentHash: string;
}

export interface ChannelRecordWriter {
  upsertByChannelAndDedupe(row: ChannelRecordRow, seenAt: Date): Promise<void>;
}

function recordContentHash(row: ChannelRecordRow): string {
  const fields = [
    row.name,
    row.website,
    row.country,
    row.industry,
    row.products,
    row.keywords,
    row.contactName,
    row.contactTitle,
    row.email,
    row.phone,
    row.sourceUrl,
  ];
  return createHash('sha256').update(JSON.stringify(fields)).digest('hex');
}

/** 把爬虫记录转成 (channelId, dedupeKey) 唯一键的行集合；同轮同名折叠。 */
export function buildChannelRecordRows(input: {
  channelId: string;
  crawlRunId: string;
  records: readonly CrawledRecord[];
}): ChannelRecordRow[] {
  const rows = new Map<string, ChannelRecordRow>();
  for (const record of input.records) {
    const dedupeKey = companyIdentity({
      name: record.name,
      domain: record.website ?? null,
      country: record.country ?? null,
    }).dedupeKey;
    if (!dedupeKey || dedupeKey.length > 200) continue;
    if (rows.has(dedupeKey)) continue;
    const row: ChannelRecordRow = {
      channelId: input.channelId,
      crawlRunId: input.crawlRunId,
      dedupeKey,
      name: record.name.slice(0, 300),
      website: record.website?.slice(0, 2048) ?? null,
      country: record.country?.slice(0, 100) ?? null,
      industry: record.industry?.slice(0, 200) ?? null,
      products: record.products && record.products.length > 0 ? record.products.slice(0, 20) : null,
      keywords: record.keywords && record.keywords.length > 0 ? record.keywords.slice(0, 20) : null,
      contactName: record.contactName?.slice(0, 200) ?? null,
      contactTitle: record.contactTitle?.slice(0, 200) ?? null,
      email: record.email?.slice(0, 320) ?? null,
      phone: record.phone?.slice(0, 64) ?? null,
      sourceUrl: record.sourceUrl.slice(0, 2048),
      contentHash: '',
    };
    row.contentHash = recordContentHash(row);
    rows.set(dedupeKey, row);
  }
  return [...rows.values()];
}

/** 逐行 upsert 物化；返回写入条数（同轮折叠后的行数）。 */
export async function materializeChannelRecords(
  writer: ChannelRecordWriter,
  input: {
    channelId: string;
    crawlRunId: string;
    records: readonly CrawledRecord[];
    now?: () => number;
  },
): Promise<number> {
  const rows = buildChannelRecordRows(input);
  const seenAt = new Date(input.now ? input.now() : Date.now());
  for (const row of rows) {
    await writer.upsertByChannelAndDedupe(row, seenAt);
  }
  return rows.length;
}
