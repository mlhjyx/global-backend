/**
 * §8.5 discovery 证据许可归一（纯函数，无 DB —— 供 canonicalizeRun 与 CI 单测共用）。
 *
 * 记录声明许可优先：绿事实源（如 TED）须带 CC BY 4.0 署名义务，绝不被硬编码 'licensed' 吞掉。
 * 未声明则回退既有 providerKey 推断。public_web 的 Registry 明确是
 * SOURCE_SPECIFIC，不能把未知网页条款伪装成 blanket licensed；其余旧 Provider
 * 保持既有回退，避免在未逐源迁移前扩大行为变化。
 *
 * 注：署名串 + notice id 不落此标量列（field_evidence 无 attribution 列，免迁移），
 * 而是随 `attributes.<source>.*`（如 attributes.ted.attribution/publication_number）
 * 与 raw_source_record.sourceUrl 一并留痕，展示/导出可回溯。
 */
export function resolveEvidenceLicense(recordLicense: string | undefined, providerKey: string): string {
  if (recordLicense) return recordLicense;
  if (providerKey === 'sandbox') return 'sandbox';
  if (providerKey === 'public_web') return 'SOURCE_SPECIFIC';
  return 'licensed';
}
