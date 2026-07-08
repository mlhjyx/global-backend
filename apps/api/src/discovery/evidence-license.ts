/**
 * §8.5 discovery 证据许可归一（纯函数，无 DB —— 供 canonicalizeRun 与 CI 单测共用）。
 *
 * 记录声明许可优先：绿事实源（如 TED）须带 CC BY 4.0 署名义务，绝不被硬编码 'licensed' 吞掉。
 * 未声明则回退既有 providerKey 推断（sandbox → 'sandbox'，其余 → 'licensed'），
 * 对所有未声明许可的 provider **字节级不变**——不因 providerKey 静默假定任何许可。
 *
 * 注：署名串 + notice id 不落此标量列（field_evidence 无 attribution 列，免迁移），
 * 而是随 `attributes.<source>.*`（如 attributes.ted.attribution/publication_number）
 * 与 raw_source_record.sourceUrl 一并留痕，展示/导出可回溯。
 */
export function resolveEvidenceLicense(recordLicense: string | undefined, providerKey: string): string {
  return recordLicense ?? (providerKey === 'sandbox' ? 'sandbox' : 'licensed');
}
