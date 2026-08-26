/**
 * §8.5 discovery 证据许可归一（纯函数，无 DB —— 供 canonicalizeRun 与 CI 单测共用）。
 *
 * 记录声明许可优先：绿事实源（如 TED）须带 CC BY 4.0 署名义务，绝不被硬编码 'licensed' 吞掉。
 * 未声明则回退既有 providerKey 推断（sandbox → 'sandbox'，其余 → 'licensed'），
 * 对所有未声明许可的 provider **字节级不变**——不因 providerKey 静默假定任何许可。
 *
 * 注：不把自由文本署名串复制进绿 Raw；license token、结构化 notice id 与
 * raw_source_record.sourceUrl 共同提供展示层固定署名合同所需的可回溯事实。
 */
export function resolveEvidenceLicense(recordLicense: string | undefined, providerKey: string): string {
  return recordLicense ?? (providerKey === 'sandbox' ? 'sandbox' : 'licensed');
}

export interface DiscoveryProvenanceMarker {
  readonly providerKey?: unknown;
  readonly license?: unknown;
}

export interface DiscoveryEntityProvenanceMarker extends DiscoveryProvenanceMarker {
  readonly entityId: string;
}

const SYNTHETIC_PROVENANCE_MARKERS = new Set(['sandbox', 'stub', 'fake', 'synthetic', 'fixture']);

function normalizedMarker(value: unknown): string | null {
  return typeof value === 'string' ? value.trim().toLowerCase() : null;
}

/**
 * Historical synthetic rows remain immutable provenance, but they are never product input.
 * Both columns are checked because legacy rows may expose the marker only through
 * `field_evidence.license` or a raw payload copied from an old provider response.
 */
export function isSyntheticDiscoveryProvenance(
  provenance: DiscoveryProvenanceMarker | null | undefined,
): boolean {
  if (!provenance) return false;
  const providerKey = normalizedMarker(provenance.providerKey);
  const license = normalizedMarker(provenance.license);
  return (
    (providerKey !== null && SYNTHETIC_PROVENANCE_MARKERS.has(providerKey)) ||
    (license !== null && SYNTHETIC_PROVENANCE_MARKERS.has(license))
  );
}

export class SyntheticDiscoveryProvenanceError extends Error {
  readonly code = 'SYNTHETIC_DISCOVERY_PROVENANCE';

  constructor() {
    super('synthetic discovery provenance is quarantined from the product path');
    this.name = 'SyntheticDiscoveryProvenanceError';
  }
}

export function assertProductDiscoveryProvenance(provenance: DiscoveryProvenanceMarker): void {
  if (isSyntheticDiscoveryProvenance(provenance)) {
    throw new SyntheticDiscoveryProvenanceError();
  }
}

/**
 * Converts one bounded evidence query into a quarantine set without mutating or
 * deleting historical rows. Callers keep pagination based on the unfiltered
 * source page, then exclude these ids before any product derivation.
 */
export function syntheticDiscoveryEntityIds(
  rows: readonly DiscoveryEntityProvenanceMarker[],
): ReadonlySet<string> {
  return new Set(rows.filter(isSyntheticDiscoveryProvenance).map((row) => row.entityId));
}

export function isProductDiscoveryRawRecord(record: {
  readonly providerKey?: unknown;
  readonly payload?: unknown;
}): boolean {
  const payload =
    record.payload !== null && typeof record.payload === 'object'
      ? (record.payload as Readonly<Record<string, unknown>>)
      : undefined;
  return !isSyntheticDiscoveryProvenance({
    providerKey: record.providerKey,
    license: payload?.license,
  });
}
