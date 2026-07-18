export interface ClaimProjectionOrderRow {
  sortKey: string;
  factIndex: number;
}

/** Binary code-unit order is identical on every runtime/locale and fixes DB lock order. */
export function compareClaimProjectionOrder(
  left: ClaimProjectionOrderRow,
  right: ClaimProjectionOrderRow,
): number {
  if (left.sortKey < right.sortKey) return -1;
  if (left.sortKey > right.sortKey) return 1;
  return left.factIndex - right.factIndex;
}
