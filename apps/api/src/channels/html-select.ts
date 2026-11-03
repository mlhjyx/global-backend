/**
 * M1 通用爬虫 v0 的极简 HTML 选择器（零依赖、确定性、可单测）。
 *
 * 支持配置里用到的子集：`tag`、`.class`、`#id`、`tag.class`、`[attr=value]`、后代组合（空格），
 * 以及 `::attr(name)` / `::text` 取值后缀。这不是通用 CSS 引擎：伪类、兄弟组合、属性选择符等
 * 一律不支持，解析失败按空结果处理（宁可抓不到，不误抓）。
 */

export interface HtmlNode {
  tag: string;
  attrs: Record<string, string>;
  children: HtmlNode[];
  /** 节点自身的直接文本片段。 */
  texts: string[];
}

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr',
]);
const RAW_TEXT_TAGS = new Set(['script', 'style']);
const TOKEN = /<!--[\s\S]*?-->|<![^>]*>|<\/([a-zA-Z][a-zA-Z0-9-]*)\s*>|<([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
const ATTR = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

function parseAttrs(source: string): { attrs: Record<string, string>; selfClosing: boolean } {
  const attrs: Record<string, string> = {};
  const selfClosing = /\/\s*$/.test(source);
  ATTR.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ATTR.exec(source)) !== null) {
    const name = match[1]!.toLowerCase();
    const value = match[2] ?? match[3] ?? match[4] ?? '';
    if (!(name in attrs)) attrs[name] = value;
  }
  return { attrs, selfClosing };
}

export function parseHtml(html: string): HtmlNode {
  const root: HtmlNode = { tag: '#root', attrs: {}, children: [], texts: [] };
  const stack: HtmlNode[] = [root];
  let cursor = 0;
  TOKEN.lastIndex = 0;
  let match: RegExpExecArray | null;
  const appendText = (text: string): void => {
    if (text) stack[stack.length - 1]!.texts.push(text);
  };
  while ((match = TOKEN.exec(html)) !== null) {
    appendText(html.slice(cursor, match.index));
    cursor = TOKEN.lastIndex;
    if (match[1]) {
      // 闭合标签：向上找到同名节点（容错：跨层不匹配时忽略）。
      const name = match[1].toLowerCase();
      for (let index = stack.length - 1; index > 0; index -= 1) {
        if (stack[index]!.tag === name) {
          stack.length = index;
          break;
        }
      }
      continue;
    }
    if (match[2]) {
      const name = match[2].toLowerCase();
      const { attrs, selfClosing } = parseAttrs(match[3] ?? '');
      const node: HtmlNode = { tag: name, attrs, children: [], texts: [] };
      stack[stack.length - 1]!.children.push(node);
      if (RAW_TEXT_TAGS.has(name) && !selfClosing) {
        const close = new RegExp(`</${name}\\s*>`, 'ig');
        close.lastIndex = cursor;
        const ending = close.exec(html);
        if (ending) {
          node.texts.push(html.slice(cursor, ending.index));
          cursor = close.lastIndex;
          TOKEN.lastIndex = cursor;
        }
        continue;
      }
      if (!selfClosing && !VOID_TAGS.has(name)) stack.push(node);
    }
  }
  appendText(html.slice(cursor));
  return root;
}

export function nodeText(node: HtmlNode): string {
  const parts = [...node.texts];
  for (const child of node.children) parts.push(nodeText(child));
  return parts.join(' ').replace(/\s+/gu, ' ').trim();
}

interface Compound {
  tag: string | null;
  id: string | null;
  classes: string[];
  attrs: Array<{ name: string; value: string | null }>;
}

function parseSelector(selector: string): Compound[] {
  const steps = selector
    .replace(/::(?:attr\([^)]*\)|text)$/u, '')
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
  return steps.map((step) => {
    const compound: Compound = { tag: null, id: null, classes: [], attrs: [] };
    const pattern = /([a-zA-Z][a-zA-Z0-9-]*)|#([A-Za-z0-9_-]+)|\.([A-Za-z0-9_-]+)|\[([A-Za-z0-9_-]+)(?:=("([^"]*)"|'([^']*)'|[^\]]*))?\]/gu;
    let part: RegExpExecArray | null;
    while ((part = pattern.exec(step)) !== null) {
      if (part[1]) compound.tag = part[1].toLowerCase();
      else if (part[2]) compound.id = part[2];
      else if (part[3]) compound.classes.push(part[3]);
      else if (part[4]) {
        compound.attrs.push({
          name: part[4].toLowerCase(),
          value: part[5] === undefined ? null : (part[6] ?? part[7] ?? part[5]),
        });
      }
    }
    return compound;
  });
}

function matches(node: HtmlNode, compound: Compound): boolean {
  if (compound.tag && node.tag !== compound.tag) return false;
  if (compound.id && node.attrs.id !== compound.id) return false;
  if (compound.classes.length > 0) {
    const classes = new Set((node.attrs.class ?? '').split(/\s+/u).filter(Boolean));
    if (!compound.classes.every((value) => classes.has(value))) return false;
  }
  for (const attr of compound.attrs) {
    if (!(attr.name in node.attrs)) return false;
    if (attr.value !== null && node.attrs[attr.name] !== attr.value) return false;
  }
  return true;
}

/**
 * 取匹配节点的内部 HTML 文本与属性值。`selector` 可带 `::attr(name)` / `::text` 后缀。
 * 解析失败/无匹配 → 空数组。
 */
export function selectAll(html: string, selector: string): HtmlNode[] {
  const [base, extractor] = selector.split('::') as [string, string | undefined];
  const steps = parseSelector(base);
  if (steps.length === 0) return [];
  const root = parseHtml(html);
  const matched = matchDescendants(root, steps, steps.length - 1);
  if (!extractor || extractor === 'text') return matched;
  const attr = /^attr\(([^)]+)\)$/u.exec(extractor);
  if (!attr) return [];
  return matched.filter((node) => attr[1]!.toLowerCase() in node.attrs);
}

/** 从右到左匹配后代组合（正确语义：最右步命中节点，逐级在祖先链上匹配左一步）。 */
function matchDescendants(root: HtmlNode, steps: readonly Compound[], lastIndex: number): HtmlNode[] {
  const candidates: HtmlNode[] = [];
  const collect = (node: HtmlNode, chain: readonly HtmlNode[]): void => {
    for (const child of node.children) {
      const nextChain = [...chain, child];
      if (matches(child, steps[lastIndex]!)) {
        let step = lastIndex - 1;
        for (let index = nextChain.length - 2; index >= 0 && step >= 0; index -= 1) {
          if (matches(nextChain[index]!, steps[step]!)) step -= 1;
        }
        if (step < 0) candidates.push(child);
      }
      collect(child, nextChain);
    }
  };
  collect(root, []);
  return candidates;
}

/** 取第一个匹配节点的文本；无匹配返回 null。 */
export function selectText(html: string, selector: string): string | null {
  const [node] = selectAll(html, selector);
  if (!node) return null;
  const [base, extractor] = selector.split('::') as [string, string | undefined];
  const attr = extractor ? /^attr\(([^)]+)\)$/u.exec(extractor) : null;
  if (attr) return node.attrs[attr[1]!.toLowerCase()] ?? null;
  const text = nodeText(node);
  return text.length > 0 ? text : null;
}

/** 在某个节点子树内取第一个匹配（用于列表条目内部的 href 等）。 */
export function selectInNode(node: HtmlNode, selector: string): string | null {
  const [base, extractor] = selector.split('::') as [string, string | undefined];
  const steps = parseSelector(base);
  if (steps.length === 0) return null;
  const [first] = matchDescendants(node, steps, steps.length - 1);
  if (!first) return null;
  const attr = extractor ? /^attr\(([^)]+)\)$/u.exec(extractor) : null;
  if (attr) return first.attrs[attr[1]!.toLowerCase()] ?? null;
  const text = nodeText(first);
  return text.length > 0 ? text : null;
}

/** 取匹配节点的 href/src 等属性值（自动解析相对 href 由调用方 absolutize）。 */
export function selectAttr(html: string, selector: string, attr: string): string | null {
  const [node] = selectAll(html, selector);
  return node?.attrs[attr.toLowerCase()] ?? null;
}
