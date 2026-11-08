import { describe, expect, it } from 'vitest';
import { extractJsonPath, extractJsonPathFirst, parseJsonPath } from './json-path';

describe('受控 JSONPath 子集', () => {
  const body = {
    items: [{ name: 'A', links: [{ href: 'https://a.example' }] }, { name: 'B' }],
    meta: { next: 'abc', empty: '' },
    count: 3,
    ok: true,
  };

  it('解析 $.a.b / $.a[0].c / $.a[*].b', () => {
    expect(parseJsonPath('$.items[0].name')).toEqual(['items', 0, 'name']);
    expect(parseJsonPath('$.items[*].name')).toEqual(['items', '*', 'name']);
    expect(extractJsonPath(body, '$.items[*].name')).toEqual(['A', 'B']);
    expect(extractJsonPath(body, '$.items[0].name')).toEqual(['A']);
    expect(extractJsonPath(body, '$.meta.next')).toEqual(['abc']);
  });

  it('拒绝函数、过滤表达式与越界语法', () => {
    for (const bad of [
      'items',
      '$.items[?(@.a==1)]',
      '$.items.length()',
      '$..name',
      "$['items']",
      '$.',
      '$.items[-1]',
      `$.${'a'.repeat(300)}`,
    ]) {
      expect(() => parseJsonPath(bad), bad).toThrow(/json path/i);
    }
  });

  it('extractJsonPathFirst 取第一个非空标量，数组展开一层', () => {
    expect(extractJsonPathFirst(body, '$.items[*].name')).toBe('A');
    expect(extractJsonPathFirst(body, '$.meta.empty')).toBeNull();
    expect(extractJsonPathFirst({ a: [{ b: 1 }, { b: 2 }] }, '$.a[*].b')).toBe('1');
    expect(extractJsonPathFirst({ a: { b: null } }, '$.a.b')).toBeNull();
    expect(extractJsonPathFirst({ a: true }, '$.a')).toBe('true');
    expect(extractJsonPathFirst({ a: { deep: 1 } }, '$.a')).toBeNull();
    expect(extractJsonPathFirst({ arr: ['x', 'y'] }, '$.arr')).toBe('x');
  });
});
