/**
 * 受控 JSONPath 子集（章节 §6.3.3/§6.3.5）：只支持 `$.a.b`、`$.a[0].c`、`$.a[*].b`。
 * 不支持函数、过滤表达式、递归下降或引号键——配置即攻击面，语法越小越安全。
 */

export type JsonPathToken = string | number | '*';

const MAX_PATH_LENGTH = 256;
const PROP_CHAR = /[A-Za-z0-9_-]/u;

export function parseJsonPath(path: string): JsonPathToken[] {
  if (typeof path !== 'string' || path.length === 0 || path.length > MAX_PATH_LENGTH) {
    throw new Error('invalid json path');
  }
  if (path[0] !== '$') throw new Error('invalid json path');
  const tokens: JsonPathToken[] = [];
  let index = 1;
  while (index < path.length) {
    const char = path[index];
    if (char === '.') {
      index += 1;
      const start = index;
      while (index < path.length && PROP_CHAR.test(path[index]!)) index += 1;
      if (index === start) throw new Error('invalid json path');
      tokens.push(path.slice(start, index));
    } else if (char === '[') {
      const close = path.indexOf(']', index);
      if (close === -1) throw new Error('invalid json path');
      const inner = path.slice(index + 1, close);
      if (inner === '*') {
        tokens.push('*');
      } else if (/^\d{1,6}$/u.test(inner)) {
        tokens.push(Number(inner));
      } else {
        throw new Error('invalid json path');
      }
      index = close + 1;
    } else {
      throw new Error('invalid json path');
    }
  }
  return tokens;
}

export function assertJsonPath(path: string): string {
  parseJsonPath(path);
  return path;
}

function walk(node: unknown, tokens: readonly JsonPathToken[], offset: number, out: unknown[]): void {
  if (offset >= tokens.length) {
    out.push(node);
    return;
  }
  const head = tokens[offset]!;
  if (head === '*') {
    if (Array.isArray(node)) {
      for (const item of node) walk(item, tokens, offset + 1, out);
    }
    return;
  }
  if (typeof head === 'number') {
    if (Array.isArray(node)) walk(node[head], tokens, offset + 1, out);
    return;
  }
  if (node !== null && typeof node === 'object' && !Array.isArray(node)) {
    walk((node as Record<string, unknown>)[head], tokens, offset + 1, out);
  }
}

/** 返回全部命中（按文档顺序）。 */
export function extractJsonPath(value: unknown, path: string): unknown[] {
  const out: unknown[] = [];
  walk(value, parseJsonPath(path), 0, out);
  return out;
}

function toScalar(value: unknown): string | null {
  if (typeof value === 'string') return value.length > 0 ? value : null;
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null;
  if (typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const scalar = toScalar(item);
      if (scalar !== null) return scalar;
    }
  }
  return null;
}

/** 取第一个非空标量（对象/空串/null 跳过；数组展开一层）。 */
export function extractJsonPathFirst(value: unknown, path: string): string | null {
  for (const match of extractJsonPath(value, path)) {
    const scalar = toScalar(match);
    if (scalar !== null) return scalar;
  }
  return null;
}
