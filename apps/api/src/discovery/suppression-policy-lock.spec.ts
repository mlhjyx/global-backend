import { describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@prisma/client';
import { lockWorkspaceSuppressionPolicy } from './suppression-policy-lock';

describe('workspace suppression policy lock', () => {
  it('uses a transaction-scoped PostgreSQL advisory lock keyed by the authenticated workspace', async () => {
    const queryRaw = vi.fn(async () => [{ locked: true }]);
    const receipt = await lockWorkspaceSuppressionPolicy(
      { $queryRaw: queryRaw } as unknown as Prisma.TransactionClient,
      'ws-1',
    );
    expect(queryRaw).toHaveBeenCalledTimes(1);
    expect(receipt).toMatchObject({ workspaceId: 'ws-1' });
    expect(Object.isFrozen(receipt)).toBe(true);
  });
});
