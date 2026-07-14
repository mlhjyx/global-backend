/**
 * KB digest（09 §2.4 / 合规 D4）：知识库内容进模型 prompt 前的统一组装。
 * - 逐文档来源标注（sourceType + 标题）→ evidence 分级溯源的输入侧；
 * - 每文档 + 总量双截断，截断/丢弃都显式标注（无静默截断）。
 * 纯函数，不做任何 IO。
 */

export interface DigestSource {
  /** kb_document.source：intake | wizard | upload | storefront | web_research */
  source: string;
  title: string;
  text: string;
}

export interface DigestOptions {
  perDocChars?: number;
  totalChars?: number;
}

const DEFAULT_PER_DOC_CHARS = 4000;
const DEFAULT_TOTAL_CHARS = 16_000;

export function buildKbDigest(sources: DigestSource[], opts: DigestOptions = {}): string {
  if (sources.length === 0) return '';
  const perDoc = opts.perDocChars ?? DEFAULT_PER_DOC_CHARS;
  const total = opts.totalChars ?? DEFAULT_TOTAL_CHARS;

  const blocks: string[] = [];
  let used = 0;
  let included = 0;

  for (const src of sources) {
    const body =
      src.text.length > perDoc ? `${src.text.slice(0, perDoc)}…[截断]` : src.text;
    const block = `[来源:${src.source} | ${src.title}]\n${body}`;
    if (used + block.length > total) break;
    blocks.push(block);
    used += block.length;
    included += 1;
  }

  // included=0（首块即超 total）→ 返回空串走「无知识库资料」语义（复审 F4：
  // 否则模型看到一份「声称有省略却零内容」的孤行摘要）。
  if (included === 0) return '';
  const dropped = sources.length - included;
  if (dropped > 0) blocks.push(`（其余 ${dropped} 份文档未纳入本摘要）`);
  return blocks.join('\n\n');
}
