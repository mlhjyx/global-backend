import { BadRequestException, ConflictException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

const RECORD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const CONTENT_HASH = /^[0-9a-f]{64}$/u;

export interface ChannelRecordReviewInput {
  recordIds?: unknown;
  verdict?: unknown;
  expectedContentHashes?: unknown;
}

interface ReviewVersion {
  id: string;
  content_hash: string;
}

interface ReviewBatch {
  recordIds: string[];
  verdict: 'APPROVED' | 'REJECTED';
  versions?: ReviewVersion[];
}

function invalidVersions(): BadRequestException {
  return new BadRequestException({ error: {
    code: 'VALIDATION_ERROR',
    message: 'expectedContentHashes must contain exactly one lowercase SHA-256 hash for each recordId',
  } });
}

function parseReviewVersions(value: unknown, ids: readonly string[]): ReviewVersion[] | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalidVersions();

  const unseen = new Set(ids);
  const versions = Object.entries(value).map(([key, hash]) => {
    const id = key.toLowerCase();
    if (!unseen.delete(id) || typeof hash !== 'string' || !CONTENT_HASH.test(hash)) throw invalidVersions();
    return { id, content_hash: hash };
  });
  if (unseen.size !== 0) throw invalidVersions();
  return versions;
}

export function parseChannelRecordReview(input: ChannelRecordReviewInput): ReviewBatch {
  const { recordIds: ids, verdict } = input;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 200 ||
      Array.from(ids).some((id) => typeof id !== 'string' || !RECORD_ID.test(id))) {
    throw new BadRequestException({
      error: { code: 'VALIDATION_ERROR', message: 'recordIds must be 1–200 record UUIDs' },
    });
  }
  if (verdict !== 'APPROVED' && verdict !== 'REJECTED') {
    throw new BadRequestException({
      error: { code: 'VALIDATION_ERROR', message: 'verdict must be APPROVED or REJECTED' },
    });
  }
  const recordIds = (ids as string[]).map((id) => id.toLowerCase());
  if (new Set(recordIds).size !== recordIds.length) {
    throw new BadRequestException({
      error: { code: 'CHANNEL_RECORD_IDS_INVALID', message: 'recordIds must be distinct' },
    });
  }
  return { recordIds, verdict, versions: parseReviewVersions(input.expectedContentHashes, recordIds) };
}

/** Called within the review transaction so any failed comparison rolls back the whole batch. */
export async function writeChannelRecordReview(
  tx: Pick<Prisma.TransactionClient, '$executeRaw' | 'sourceChannelRecord'>,
  review: ReviewBatch & { channelId: string; reviewedBy: string },
): Promise<number> {
  const { channelId, recordIds, verdict, versions, reviewedBy } = review;
  const reviewedAt = new Date();
  if (versions) {
    const reviewed = await tx.$executeRaw`
      UPDATE public.source_channel_record AS record
      SET review_status = ${verdict},
          reviewed_by = ${reviewedBy},
          reviewed_at = ${reviewedAt},
          reviewed_content_hash = CASE WHEN ${verdict} = 'APPROVED' THEN expected.content_hash ELSE NULL END
      FROM pg_catalog.jsonb_to_recordset(${JSON.stringify(versions)}::jsonb) AS expected (id uuid, content_hash text)
      WHERE record.channel_id = ${channelId}::uuid
        AND record.id = expected.id
        AND record.content_hash = expected.content_hash
    `;
    if (reviewed !== recordIds.length) {
      throw new ConflictException({ error: {
        code: 'CHANNEL_RECORD_VERSION_CONFLICT',
        message: 'At least one record version no longer matches. Reload the records and review the batch again.',
      } });
    }
    return reviewed;
  }

  const { count } = await tx.sourceChannelRecord.updateMany({
    where: { channelId, id: { in: recordIds } },
    data: { reviewStatus: verdict, reviewedBy, reviewedAt, reviewedContentHash: null },
  });
  if (count !== recordIds.length) {
    throw new BadRequestException({ error: {
      code: 'CHANNEL_RECORD_IDS_INVALID',
      message: `reviewed ${count} of ${recordIds.length} recordIds (all must belong to this channel)`,
    } });
  }
  return count;
}
