import { describe, expect, it } from 'vitest';
import { chunkMarkdown } from './chunker';

describe('chunkMarkdown（结构感知切块，02 §12：标题路径入 meta、表格原子、长段落切分）', () => {
  it('按标题分节，meta 带 headingPath，seq 连续', () => {
    const md = [
      '# Acme Pump',
      'We build pumps.',
      '## Products',
      'Centrifugal pumps for chemical plants.',
      '## Certifications',
      'CE and ISO9001 certified.',
    ].join('\n');
    const chunks = chunkMarkdown(md);
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    expect(chunks.map((c) => c.seq)).toEqual(chunks.map((_, i) => i));
    const products = chunks.find((c) => c.text.includes('Centrifugal'));
    expect(products?.meta.headingPath).toEqual(['Acme Pump', 'Products']);
  });

  it('markdown 表格作为原子块不被拆开，meta.kind=table', () => {
    const md = [
      '## Specs',
      '| model | flow |',
      '| --- | --- |',
      '| P100 | 50m3/h |',
      '| P200 | 80m3/h |',
    ].join('\n');
    const chunks = chunkMarkdown(md);
    const table = chunks.find((c) => c.meta.kind === 'table');
    expect(table).toBeDefined();
    expect(table!.text).toContain('P100');
    expect(table!.text).toContain('P200');
  });

  it('超长段落按目标大小切分，每块不超过上限', () => {
    const long = Array.from({ length: 200 }, (_, i) => `Sentence number ${i} about pumps.`).join(' ');
    const chunks = chunkMarkdown(`## Long\n${long}`);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(1600);
  });

  it('碎小段落合并（不产出零碎噪声块），空输入产出空数组', () => {
    const md = ['## A', 'x.', 'y.', 'z.'].join('\n\n');
    const chunks = chunkMarkdown(md);
    expect(chunks).toHaveLength(1);
    expect(chunkMarkdown('')).toEqual([]);
    expect(chunkMarkdown('   \n \n')).toEqual([]);
  });

  it('无标题的纯文本也能切块（headingPath=[]）', () => {
    const chunks = chunkMarkdown('Just a plain intro paragraph about the company.');
    expect(chunks).toHaveLength(1);
    expect(chunks[0].meta.headingPath).toEqual([]);
  });
});
