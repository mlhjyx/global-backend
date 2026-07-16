import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

interface OpenApiSchema {
  type?: string;
  additionalProperties?: boolean;
  properties?: Record<string, OpenApiSchema>;
  nullable?: boolean;
  required?: string[];
  anyOf?: OpenApiSchema[];
}

interface OpenApiOperation {
  parameters?: Array<{ in?: string; name?: string; required?: boolean }>;
  requestBody?: { content?: Record<string, { schema?: OpenApiSchema }> };
  responses?: Record<string, { headers?: Record<string, unknown> }>;
}

function contract() {
  return JSON.parse(
    readFileSync(
      resolve(process.cwd(), '../../packages/contracts/openapi/openapi.json'),
      'utf8',
    ),
  ) as {
    paths: Record<string, Record<string, OpenApiOperation>>;
  };
}

describe('R2-A3 generated OpenAPI contract', () => {
  it('declares the bounded five-group request, strong ETag, and all precondition responses', () => {
    const path = contract().paths['/api/v1/site-builder/sites/{id}/profile'];
    const get = path?.get;
    const patch = path?.patch;
    expect(get?.responses?.['200']?.headers).toHaveProperty('ETag');
    expect(get?.responses?.['200']?.headers).toHaveProperty('Cache-Control');
    expect(get?.responses?.['409']?.headers).toHaveProperty('ETag');
    expect(get?.responses?.['409']?.headers).toHaveProperty('Cache-Control');

    const ifMatch = patch?.parameters?.filter(
      (parameter) => parameter.in === 'header' && parameter.name === 'if-match',
    );
    expect(ifMatch).toHaveLength(1);
    expect(ifMatch?.[0]).toMatchObject({ required: false });

    const body = patch?.requestBody?.content?.['application/json']?.schema;
    expect(body).toMatchObject({ type: 'object', additionalProperties: false });
    expect(Object.keys(body?.properties ?? {})).toEqual([
      'baseVersionId',
      'companyProfile',
      'trustAssets',
      'onlineAssets',
      'brand',
      'contact',
    ]);
    expect(body?.properties?.brand).toMatchObject({
      type: 'object',
      additionalProperties: false,
      nullable: true,
    });
    expect(body?.anyOf?.map((branch) => branch.required?.[0])).toEqual([
      'companyProfile',
      'trustAssets',
      'onlineAssets',
      'brand',
      'contact',
    ]);
    expect(new Set(Object.keys(patch?.responses ?? {}))).toEqual(
      new Set(['200', '400', '404', '409', '412', '422', '428']),
    );
    expect(patch?.responses?.['200']?.headers).toHaveProperty('ETag');
    expect(patch?.responses?.['409']?.headers).toHaveProperty('ETag');
    expect(patch?.responses?.['412']?.headers).toHaveProperty('ETag');
  });
});
