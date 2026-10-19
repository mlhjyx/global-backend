import { Prisma } from '@prisma/client';
import {
  ActivityFailure,
  DefaultFailureConverter,
  defaultPayloadConverter,
  ensureApplicationFailure,
} from '@temporalio/common';
import { temporal } from '@temporalio/proto';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../prisma/prisma.service';
import { PostgresBudgetStore } from '../tools/budget-store';
import { failureConverter } from './diagnostic-failure-converter';
import { describeDiscoveryRunFailure } from './discovery.run-failure';

/**
 * A reserve that the database refuses because the run's authority ended (the
 * admission lease expired, or the authority was revoked) must reach the
 * workflow as a control failure, like the same refusal from attestAuthorized.
 * Before the store mapped it, the raw Prisma error crossed the Activity
 * boundary as `{ errorType: 'PrismaClientKnownRequestError', control: false }`.
 */
function storeWhoseReserveRaises(marker: string): PostgresBudgetStore {
  const failure = new Prisma.PrismaClientKnownRequestError('Raw query failed. Code: `P0001`.', {
    code: 'P2010',
    clientVersion: 'test',
    meta: { code: 'P0001', message: `ERROR: ${marker}` },
  });
  return new PostgresBudgetStore({
    withWorkspace: vi.fn(async (_workspaceId, fn) =>
      fn({
        $queryRaw: vi.fn(async () => {
          throw failure;
        }),
      } as never),
    ),
  } as unknown as PrismaService);
}

// What the Worker sends for an Activity's thrown error, decoded as the workflow sees it after the last attempt.
function workflowView(error: unknown) {
  const wire = temporal.api.failure.v1.Failure.decode(
    temporal.api.failure.v1.Failure.encode(
      failureConverter.errorToFailure(ensureApplicationFailure(error), defaultPayloadConverter),
    ).finish(),
  );
  const decoded = new DefaultFailureConverter().failureToError(wire, defaultPayloadConverter);
  return describeDiscoveryRunFailure(
    'query',
    new ActivityFailure('Activity task failed', 'executeQuery', '11', 'MAXIMUM_ATTEMPTS_REACHED', 'worker', decoded),
  );
}

describe('a reserve refused because the authority ended', () => {
  it.each(['EXECUTION_BUDGET_GRANT_EXPIRED', 'EXECUTION_BUDGET_AUTHORITY_REVOKED'])(
    'reaches the workflow as a control failure: %s',
    async (marker) => {
      const error = await storeWhoseReserveRaises(marker)
        .reserve({
          workspaceId: 'e03abddd-1307-47cb-a731-7e7a786615a0',
          accountKey: 'discovery:run:lease',
          operationKey: 'op:lease-boundary',
          estimatedMicrousd: 0n,
        })
        .catch((caught: unknown) => caught);

      expect(workflowView(error)).toEqual({ stage: 'query', errorType: 'ExecutionBudgetGrantError', control: true });
    },
  );
});
