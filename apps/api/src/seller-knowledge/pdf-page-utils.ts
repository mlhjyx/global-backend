/**
 * 纯 JS PDF 页数探测与分页切片工具（零外部二进制依赖）。
 * 用于将大页数印刷级画册拆分为「前 15 页优先解析 + 后台分批补全尾页」，
 * 防止整份大 PDF 一次性塞给 Docling 造成 OOM 或长尾阻塞。
 */

const PDF_MAGIC = '%PDF-';
const MAX_REASONABLE_PDF_PAGES = 10_000;

/**
 * 从 PDF 原始字节估计总页数：
 * 1) 优先取 `/Type /Pages ... /Count N` 节点中的最大 Count（即根节点总页数，兼容增量更新与嵌套页树）；
 * 2) 若对象流压缩导致 `/Pages /Count` 不可见，则回退统计明文 `/Type /Page` 叶子数量；
 * 3) 无法确定时返回 null（调用方可结合文件体积采取保守前 15 页窗口策略）。
 */
export function countPdfPages(buffer: Buffer): number | null {
  if (!Buffer.isBuffer(buffer) || buffer.byteLength < PDF_MAGIC.length) return null;
  if (buffer.subarray(0, PDF_MAGIC.length).toString('latin1') !== PDF_MAGIC) return null;

  const latin1 = buffer.toString('latin1');
  let maxTreeCount = 0;
  const pagesTreeRe = /\/Type\s*\/Pages\b[\s\S]{0,400}?\/Count\s+(\d{1,5})\b/g;
  for (const match of latin1.matchAll(pagesTreeRe)) {
    const n = Number(match[1]);
    if (Number.isSafeInteger(n) && n > maxTreeCount && n <= MAX_REASONABLE_PDF_PAGES) {
      maxTreeCount = n;
    }
  }
  if (maxTreeCount > 0) return maxTreeCount;

  // 反向字典序（/Count N 出现在 /Type /Pages 之前）
  const countFirstRe = /\/Count\s+(\d{1,5})\b[\s\S]{0,400}?\/Type\s*\/Pages\b/g;
  for (const match of latin1.matchAll(countFirstRe)) {
    const n = Number(match[1]);
    if (Number.isSafeInteger(n) && n > maxTreeCount && n <= MAX_REASONABLE_PDF_PAGES) {
      maxTreeCount = n;
    }
  }
  if (maxTreeCount > 0) return maxTreeCount;

  const leafMatches = latin1.match(/\/Type\s*\/Page\b(?!s)/g);
  if (leafMatches && leafMatches.length > 0 && leafMatches.length <= MAX_REASONABLE_PDF_PAGES) {
    return leafMatches.length;
  }
  return null;
}

/** 将 [startPage, endPage]（1-based 闭区间）按固定 batchSize 切分为若干 Docling 安全页段。 */
export function computePdfPageBatches(
  startPage: number,
  endPage: number,
  batchSize: number,
): Array<[number, number]> {
  if (
    !Number.isSafeInteger(startPage) ||
    !Number.isSafeInteger(endPage) ||
    !Number.isSafeInteger(batchSize) ||
    startPage < 1 ||
    endPage < startPage ||
    batchSize < 1
  ) {
    return [];
  }
  const batches: Array<[number, number]> = [];
  for (let current = startPage; current <= endPage; current += batchSize) {
    batches.push([current, Math.min(endPage, current + batchSize - 1)]);
  }
  return batches;
}
