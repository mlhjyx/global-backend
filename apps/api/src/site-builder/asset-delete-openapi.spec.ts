import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

interface SchemaNode {
  properties?: Record<string, SchemaNode>;
  enum?: string[];
  required?: string[];
  items?: SchemaNode;
  type?: string;
  format?: string;
  additionalProperties?: boolean;
}

describe('Asset DELETE generated OpenAPI', () => {
  it('publishes the stable ASSET_IN_USE usage contract', () => {
    const document = JSON.parse(
      readFileSync(resolve(process.cwd(), '../../packages/contracts/openapi/openapi.json'), 'utf8'),
    ) as {
      paths: Record<
        string,
        {
          delete: {
            responses: Record<string, { content: Record<string, { schema: SchemaNode }> }>;
          };
        }
      >;
    };
    const response = document.paths['/api/v1/site-builder/assets/{id}'].delete.responses['409'];
    const schema = response.content['application/json'].schema;
    const error = schema.properties!.error;
    const usage = error.properties!.details.properties!.usages.items!;

    expect(error.required).toEqual(['code', 'message']);
    expect(error.properties!.code.enum).toContain('ASSET_IN_USE');
    expect(usage.required).toEqual(['source', 'page', 'component', 'fieldPath']);
    expect(usage.additionalProperties).toBe(false);
    expect(usage.properties!.source.enum).toEqual(['profile', 'site_spec']);
    expect(usage.properties!.siteVersionId).toMatchObject({
      type: 'string',
      format: 'uuid',
    });
  });
});
