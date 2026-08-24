import { describe, expect, it, vi } from 'vitest';
import { collectProductReadPage } from './product-read-pagination';

describe('collectProductReadPage', () => {
  it.each([0, 1.5])('rejects an invalid product page limit: %s', async (limit) => {
    await expect(
      collectProductReadPage({
        limit,
        fetchBatch: async () => {
          throw new Error('must not fetch');
        },
        projectProductRows: async () => [],
      }),
    ).rejects.toThrow('product read page limit must be a positive safe integer');
  });

  it('uses the last returned product row as the cursor when one product is buffered', async () => {
    const rows = [{ id: 'product-1' }, { id: 'product-2' }, { id: 'product-3' }];

    await expect(
      collectProductReadPage({
        limit: 2,
        fetchBatch: async () => rows,
        projectProductRows: async (batch) =>
          batch.map((row) => ({ cursor: row.id, value: row })),
      }),
    ).resolves.toEqual({
      data: rows.slice(0, 2),
      nextCursor: 'product-2',
      hasMore: true,
    });
  });

  it('caps an all-quarantined scan and advances to the last inspected raw cursor', async () => {
    let batchNumber = 0;
    const fetchBatch = vi.fn(async () => {
      batchNumber += 1;
      return [1, 2, 3].map((index) => ({ id: `synthetic-${batchNumber}-${index}` }));
    });

    await expect(
      collectProductReadPage({
        limit: 2,
        fetchBatch,
        projectProductRows: async () => [],
      }),
    ).resolves.toEqual({
      data: [],
      nextCursor: 'synthetic-16-3',
      hasMore: true,
    });
    expect(fetchBatch).toHaveBeenCalledTimes(16);
  });
});
