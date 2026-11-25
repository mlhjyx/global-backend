import { ServiceUnavailableException } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import {
  assertExecutionBudgetPlatformWriterPrincipal,
  ScopedDatabasePrincipalError,
} from '../execution-budget/execution-budget-platform-writer.database';

export const CHANNEL_PLATFORM_WRITER_UNAVAILABLE =
  'PLATFORM_CHANNEL_WRITER_UNAVAILABLE';

export async function requireChannelPlatformWriter(
  platformWriter: PrismaClient | null | undefined,
): Promise<PrismaClient> {
  if (!platformWriter) {
    throw new ServiceUnavailableException({
      error: {
        code: CHANNEL_PLATFORM_WRITER_UNAVAILABLE,
        message:
          'Platform channel writes require EXECUTION_BUDGET_PLATFORM_WRITER_DATABASE_URL',
      },
    });
  }
  try {
    await assertExecutionBudgetPlatformWriterPrincipal(
      platformWriter,
      'ChannelPlatformWriter',
    );
  } catch (error) {
    if (error instanceof ScopedDatabasePrincipalError) {
      throw new ServiceUnavailableException({
        error: {
          code: CHANNEL_PLATFORM_WRITER_UNAVAILABLE,
          message:
            'Platform channel writes require a valid execution_budget_platform_writer database principal',
        },
      });
    }
    throw error;
  }
  return platformWriter;
}
