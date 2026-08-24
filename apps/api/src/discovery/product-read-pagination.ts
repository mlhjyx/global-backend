const MAX_PRODUCT_READ_SCAN_BATCHES = 16;

interface ProductReadPageEntry<T> {
  readonly cursor: string;
  readonly value: T;
}

export interface ProductReadPage<T> {
  readonly data: T[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

/**
 * Fills one public product page without allowing quarantined historical rows to
 * starve the first visible result. Every database read is bounded to limit + 1,
 * and the total request is capped so a corrupt workspace cannot force an
 * unbounded scan. When the cap is reached, the raw cursor advances past every
 * inspected row and the caller can safely continue.
 */
export async function collectProductReadPage<Source extends { readonly id: string }, Product>(input: {
  readonly limit: number;
  readonly cursor?: string;
  readonly fetchBatch: (cursor: string | undefined, take: number) => Promise<readonly Source[]>;
  readonly projectProductRows: (
    rows: readonly Source[],
  ) => Promise<readonly ProductReadPageEntry<Product>[]>;
}): Promise<ProductReadPage<Product>> {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1) {
    throw new RangeError('product read page limit must be a positive safe integer');
  }

  const take = input.limit + 1;
  let scanCursor = input.cursor;
  let lastScannedCursor: string | null = null;
  let exhausted = false;
  let visible: readonly ProductReadPageEntry<Product>[] = [];

  for (
    let batch = 0;
    batch < MAX_PRODUCT_READ_SCAN_BATCHES && visible.length <= input.limit;
    batch += 1
  ) {
    const rows = await input.fetchBatch(scanCursor, take);
    if (rows.length === 0) {
      exhausted = true;
      break;
    }

    visible = [...visible, ...(await input.projectProductRows(rows))];
    lastScannedCursor = rows[rows.length - 1].id;
    scanCursor = lastScannedCursor;

    if (rows.length < take) {
      exhausted = true;
      break;
    }
  }

  const page = visible.slice(0, input.limit);
  const hasBufferedProduct = visible.length > input.limit;
  const hasMore = hasBufferedProduct || !exhausted;
  const nextCursor = hasMore
    ? hasBufferedProduct
      ? page[page.length - 1].cursor
      : lastScannedCursor
    : null;

  return {
    data: page.map((entry) => entry.value),
    nextCursor,
    hasMore,
  };
}
