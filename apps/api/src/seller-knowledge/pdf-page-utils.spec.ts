import { describe, expect, it } from 'vitest';
import { computePdfPageBatches, countPdfPages } from './pdf-page-utils';

describe('pdf-page-utils', () => {
  it('从 /Type /Pages /Count 树节点准确识别总页数（取根节点最大值）', () => {
    const pdf = Buffer.from(
      '%PDF-1.7\n1 0 obj << /Type /Pages /Kids [2 0 R 3 0 R] /Count 48 >> endobj\n2 0 obj << /Type /Pages /Count 24 >> endobj\n',
      'latin1',
    );
    expect(countPdfPages(pdf)).toBe(48);
  });

  it('支持 /Count 在 /Type /Pages 之前的字典序以及叶子 /Type /Page 回退', () => {
    const reversePdf = Buffer.from(
      '%PDF-1.6\n1 0 obj << /Count 19 /Type /Pages >> endobj\n',
      'latin1',
    );
    expect(countPdfPages(reversePdf)).toBe(19);

    const leafOnlyPdf = Buffer.from(
      '%PDF-1.4\n1 0 obj << /Type /Page >> endobj\n2 0 obj << /Type /Page >> endobj\n3 0 obj << /Type /Page >> endobj\n',
      'latin1',
    );
    expect(countPdfPages(leafOnlyPdf)).toBe(3);
  });

  it('非 PDF 或无页数元数据时安全返回 null', () => {
    expect(countPdfPages(Buffer.from('not a pdf', 'utf8'))).toBeNull();
    expect(countPdfPages(Buffer.from('%PDF-1.7\nstream compressed\n', 'latin1'))).toBeNull();
  });

  it('computePdfPageBatches 按固定批次切分闭区间页码', () => {
    expect(computePdfPageBatches(16, 48, 15)).toEqual([
      [16, 30],
      [31, 45],
      [46, 48],
    ]);
    expect(computePdfPageBatches(16, 16, 15)).toEqual([[16, 16]]);
    expect(computePdfPageBatches(20, 10, 15)).toEqual([]);
  });
});
