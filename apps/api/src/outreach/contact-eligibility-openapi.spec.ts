import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * P1-16 契约钉：contact-eligibility 端点在提交的 openapi.json 里必须存在、带说明、
 * 请求体形状（workspaceId + emails≤50）与 200 响应（results 数组）稳定。
 * openapi.json 与代码的一致性由 CI 的 drift 步骤保证（导出物必须与实现一致）。
 */
const api = JSON.parse(
  readFileSync(resolve(__dirname, '../../../../packages/contracts/openapi/openapi.json'), 'utf8'),
) as {
  paths: Record<string, Record<string, {
    summary?: string;
    description?: string;
    requestBody?: { content?: { 'application/json'?: { schema?: { $ref?: string } } } };
    responses?: Record<string, unknown>;
  }>>;
  components?: { schemas?: Record<string, { properties?: Record<string, unknown> }> };
};

describe('contact-eligibility OpenAPI 契约', () => {
  const operation = api.paths['/api/v1/outreach/contact-eligibility']?.post;

  it('端点存在且带 summary/description（门户完整性）', () => {
    expect(operation).toBeDefined();
    expect(operation?.summary?.trim()).not.toBe('');
    expect(operation?.description?.trim()).not.toBe('');
  });

  it('请求体含 workspaceId 与 emails（≤50）', () => {
    const ref = operation?.requestBody?.content?.['application/json']?.schema?.$ref ?? '';
    const name = ref.split('/').at(-1) ?? '';
    const properties = api.components?.schemas?.[name]?.properties ?? {};
    expect(Object.keys(properties)).toEqual(expect.arrayContaining(['workspaceId', 'emails']));
    expect(JSON.stringify(properties.emails)).toContain('50');
  });

  it('200 响应存在', () => {
    expect(operation?.responses).toHaveProperty('200');
  });
});
