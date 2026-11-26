/**
 * 结构感知切块（02 §12）：按标题分节（headingPath 入 meta）、表格原子块、
 * 长段落按目标大小切分、碎段合并。纯函数，Docling markdown 输出为主要输入。
 */

export interface ChunkMeta {
  headingPath: string[];
  kind: 'text' | 'table';
}

export interface Chunk {
  seq: number;
  text: string;
  meta: ChunkMeta;
}

const TARGET_CHARS = 1200; // 目标块大小（BGE-M3 上限远高于此，取检索友好粒度）
const MAX_CHARS = 1600; // 硬上限（超长段落按句切分的封顶）
const MIN_CHARS = 200; // 低于此与相邻块合并，避免零碎噪声

interface Block {
  text: string;
  headingPath: string[];
  kind: 'text' | 'table';
}

function isTableLine(line: string): boolean {
  return line.trimStart().startsWith('|');
}

const HEADING_RE = /^(#{1,6})\s+(.*)$/;

/** 第一遍：按标题/表格/空行切出结构块。 */
function toBlocks(markdown: string): Block[] {
  const blocks: Block[] = [];
  const headingStack: { level: number; title: string }[] = [];
  let paragraph: string[] = [];
  let table: string[] = [];

  const path = () => headingStack.map((h) => h.title);
  const flushParagraph = () => {
    const text = paragraph.join(' ').trim();
    paragraph = [];
    if (text) blocks.push({ text, headingPath: path(), kind: 'text' });
  };
  const flushTable = () => {
    const text = table.join('\n').trim();
    table = [];
    if (text) blocks.push({ text, headingPath: path(), kind: 'table' });
  };

  for (const rawLine of markdown.split('\n')) {
    const line = rawLine.trimEnd();
    const heading = HEADING_RE.exec(line);
    if (heading) {
      flushParagraph();
      flushTable();
      const level = heading[1].length;
      while (headingStack.length > 0 && headingStack[headingStack.length - 1].level >= level) {
        headingStack.pop();
      }
      headingStack.push({ level, title: heading[2].trim() });
      continue;
    }
    if (isTableLine(line)) {
      flushParagraph();
      table.push(line);
      continue;
    }
    if (table.length > 0) flushTable();
    if (line.trim() === '') {
      flushParagraph();
    } else {
      paragraph.push(line.trim());
    }
  }
  flushParagraph();
  flushTable();
  return blocks;
}

/** 超长文本按句边界切到 MAX_CHARS 内。 */
function splitLongText(text: string): string[] {
  if (text.length <= MAX_CHARS) return [text];
  const sentences = text.split(/(?<=[.!?。！？])\s+/);
  const parts: string[] = [];
  let current = '';
  for (const sentence of sentences) {
    if (current.length > 0 && current.length + sentence.length + 1 > TARGET_CHARS) {
      parts.push(current);
      current = sentence;
    } else {
      current = current.length > 0 ? `${current} ${sentence}` : sentence;
    }
  }
  if (current) parts.push(current);
  // 单句仍超硬上限的极端情况：按硬上限截段
  return parts.flatMap((p) => {
    if (p.length <= MAX_CHARS) return [p];
    const out: string[] = [];
    for (let i = 0; i < p.length; i += MAX_CHARS) out.push(p.slice(i, i + MAX_CHARS));
    return out;
  });
}

const TABLE_SEPARATOR_RE = /^\|[\s:|-]+\|?$/;

/** 超长表格按行切到 MAX_CHARS 内，每段重复表头以保持语义自洽；短表格保持原子。 */
function splitLongTable(text: string): string[] {
  if (text.length <= MAX_CHARS) return [text];
  const lines = text.split('\n');
  const hasHeader = lines.length >= 2 && TABLE_SEPARATOR_RE.test(lines[1].trim());
  const header = hasHeader ? `${lines[0]}\n${lines[1]}` : '';
  const bodyLines = hasHeader ? lines.slice(2) : lines;
  if (bodyLines.length === 0) return splitLongText(text);

  const pieces: string[] = [];
  let current = header;
  for (const row of bodyLines) {
    const candidate = current ? `${current}\n${row}` : row;
    if (candidate.length <= MAX_CHARS) {
      current = candidate;
      continue;
    }
    if (current && current !== header) {
      pieces.push(current);
    }
    const withHeader = header ? `${header}\n${row}` : row;
    if (withHeader.length <= MAX_CHARS) {
      current = withHeader;
    } else {
      // 单行本身超过 MAX_CHARS 的极端情况：保留行前缀并按硬上限切段，确保绝不撑爆嵌入窗口
      for (let i = 0; i < row.length; i += MAX_CHARS) {
        pieces.push(row.slice(i, i + MAX_CHARS));
      }
      current = header;
    }
  }
  if (current && current !== header) pieces.push(current);
  return pieces.length > 0 ? pieces : [text.slice(0, MAX_CHARS)];
}

/** 相邻同节碎块合并到 MIN_CHARS 以上（表格不参与合并）。 */
function mergeSmall(blocks: Block[]): Block[] {
  const merged: Block[] = [];
  for (const block of blocks) {
    const prev = merged[merged.length - 1];
    const samePath = prev && prev.headingPath.join(' ') === block.headingPath.join(' ');
    const bothText = prev && prev.kind === 'text' && block.kind === 'text';
    const fits = prev && prev.text.length + block.text.length + 1 <= TARGET_CHARS;
    if (prev && samePath && bothText && fits && (prev.text.length < MIN_CHARS || block.text.length < MIN_CHARS)) {
      merged[merged.length - 1] = { ...prev, text: `${prev.text}\n${block.text}` };
    } else {
      merged.push(block);
    }
  }
  return merged;
}

export function chunkMarkdown(markdown: string): Chunk[] {
  if (!markdown || markdown.trim() === '') return [];
  const blocks = mergeSmall(toBlocks(markdown));
  const chunks: Chunk[] = [];
  for (const block of blocks) {
    const pieces = block.kind === 'table' ? splitLongTable(block.text) : splitLongText(block.text);
    for (const text of pieces) {
      chunks.push({
        seq: chunks.length,
        text,
        meta: { headingPath: block.headingPath, kind: block.kind },
      });
    }
  }
  return chunks;
}
