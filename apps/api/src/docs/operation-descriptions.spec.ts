import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OPERATION_DESCRIPTIONS } from './operation-descriptions';

/**
 * 接口门户的完整性闸门。
 *
 * 门户是给人看的：一个端点没有正文说明，对接方就得翻代码。这条测试让「新增端点却
 * 没写说明」在 CI 里直接红掉，而不是等有人打开门户才发现。
 *
 * 契约来自 `--export-openapi` 的落盘产物（contracts 门的 drift 检查保证它与代码一致）。
 */

interface Operation {
  summary?: string;
  description?: string;
}

interface OpenApiDocument {
  paths: Record<string, Record<string, Operation>>;
  tags?: Array<{ name: string; description?: string }>;
}

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

function openApiDocument(): OpenApiDocument {
  return JSON.parse(
    readFileSync(
      resolve(process.cwd(), '../../packages/contracts/openapi/openapi.json'),
      'utf8',
    ),
  ) as OpenApiDocument;
}

function operations(document: OpenApiDocument): Array<{
  key: string;
  operation: Operation;
}> {
  const rows: Array<{ key: string; operation: Operation }> = [];
  for (const [path, item] of Object.entries(document.paths)) {
    for (const method of HTTP_METHODS) {
      const operation = item[method];
      if (operation) rows.push({ key: `${method.toUpperCase()} ${path}`, operation });
    }
  }
  return rows;
}

describe('接口门户文档完整性', () => {
  it('每个操作都有 summary 和正文 description', () => {
    const missing = operations(openApiDocument())
      .filter(({ operation }) => !operation.summary?.trim() || !operation.description?.trim())
      .map(({ key }) => key);
    expect(missing).toEqual([]);
  });

  it('每个声明过的 tag 都有说明', () => {
    const missing = (openApiDocument().tags ?? [])
      .filter((tag) => !tag.description?.trim())
      .map((tag) => tag.name);
    expect(missing).toEqual([]);
  });

  it('说明不是占位符', () => {
    const tooShort = operations(openApiDocument())
      .filter(({ operation }) => (operation.description ?? '').trim().length < 12)
      .map(({ key }) => key);
    expect(tooShort).toEqual([]);
  });

  it('描述表里没有指向已不存在操作的条目', () => {
    const known = new Set(operations(openApiDocument()).map(({ key }) => key));
    expect(Object.keys(OPERATION_DESCRIPTIONS).filter((key) => !known.has(key))).toEqual([]);
  });
});
