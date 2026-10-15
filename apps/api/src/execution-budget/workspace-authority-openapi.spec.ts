import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EXECUTION_BUDGET_GRANT_HEADER } from './execution-budget-grant.decorator';

const operations = [
  '/api/v1/companies',
  '/api/v1/companies/{companyId}/icps',
  '/api/v1/icps/{icpId}/query-plans',
  '/api/v1/query-plans/{planId}/execute',
  '/api/v1/canonical-companies/{id}/discover-contacts',
  '/api/v1/canonical-companies/{id}/guess-emails',
  '/api/v1/contact-points/{pointId}/verify',
] as const;

describe('workspace execution authority OpenAPI', () => {
  it.each(operations)('%s requires the exact grant header and stable failures', (path) => {
    const document = JSON.parse(
      readFileSync(
        resolve(process.cwd(), '../../packages/contracts/openapi/openapi.json'),
        'utf8',
      ),
    ) as {
      paths: Record<
        string,
        {
          post?: {
            parameters?: Array<{
              in?: string;
              name?: string;
              required?: boolean;
              schema?: Record<string, unknown>;
            }>;
            responses?: Record<string, unknown>;
          };
        }
      >;
    };
    const operation = document.paths[path]?.post;

    expect(operation, `missing POST ${path}`).toBeDefined();
    expect(
      operation?.parameters?.filter(
        (parameter) =>
          parameter.in === 'header' &&
          parameter.name?.toLowerCase() ===
            EXECUTION_BUDGET_GRANT_HEADER.toLowerCase(),
      ),
    ).toEqual([
      expect.objectContaining({
        name: EXECUTION_BUDGET_GRANT_HEADER,
        in: 'header',
        required: true,
        schema: expect.objectContaining({
          type: 'string',
          minLength: 1,
          maxLength: 16_384,
        }),
      }),
    ]);
    expect(Object.keys(operation?.responses ?? {})).toEqual(
      expect.arrayContaining(['402', '403', '409', '503']),
    );
  });

  it('documents the query-plan conflicts that come from the data-source kill switch (BI-30)', () => {
    const document = JSON.parse(
      readFileSync(
        resolve(process.cwd(), '../../packages/contracts/openapi/openapi.json'),
        'utf8',
      ),
    ) as {
      paths: Record<string, { post?: { responses?: Record<string, { description?: string }> } }>;
    };
    const conflict =
      document.paths['/api/v1/icps/{icpId}/query-plans']?.post?.responses?.['409']?.description ?? '';

    for (const code of [
      'EXECUTION_BUDGET_GRANT_REUSED',
      'INVALID_STATE',
      'NO_ENABLED_DISCOVERY_SOURCE',
      'NO_RUNNABLE_QUERIES',
    ]) {
      expect(conflict).toContain(code);
    }
    // The other grant-bound operations keep their own 409 text.
    expect(
      document.paths['/api/v1/query-plans/{planId}/execute']?.post?.responses?.['409']?.description,
    ).toBe('EXECUTION_BUDGET_GRANT_REUSED');
  });

  it('documents a settled unusable model answer of the two generation endpoints as 502 MODEL_UPSTREAM_UNUSABLE', () => {
    type OpenApiSchema = {
      required?: string[];
      properties?: Record<string, OpenApiSchema>;
      enum?: string[];
      type?: string;
    };
    type OpenApiOperation = {
      responses?: Record<
        string,
        {
          description?: string;
          content?: { 'application/json'?: { schema?: OpenApiSchema } };
        }
      >;
    };
    const document = JSON.parse(
      readFileSync(
        resolve(process.cwd(), '../../packages/contracts/openapi/openapi.json'),
        'utf8',
      ),
    ) as { paths: Record<string, { post?: OpenApiOperation }> };

    for (const path of ['/api/v1/companies/{companyId}/icps', '/api/v1/icps/{icpId}/query-plans']) {
      const response = document.paths[path]?.post?.responses?.['502'];
      expect(response?.description, `missing 502 on POST ${path}`).toContain('MODEL_UPSTREAM_UNUSABLE');
      const error = response?.content?.['application/json']?.schema?.properties?.error;
      expect(error?.required).toEqual(['code', 'message', 'details']);
      expect(error?.properties?.code?.enum).toEqual(['MODEL_UPSTREAM_UNUSABLE']);
      expect(error?.properties?.details?.required).toEqual(['reasonCode']);
      expect(error?.properties?.details?.properties?.reasonCode?.type).toBe('string');
    }
    // Plan execution is asynchronous: its model calls fail inside the run, not the request.
    expect(
      document.paths['/api/v1/query-plans/{planId}/execute']?.post?.responses?.['502'],
    ).toBeUndefined();
  });

  it('publishes the required lawful-basis body and stable 403 code for contact discovery', () => {
    type OpenApiSchema = {
      required?: string[];
      properties?: Record<string, OpenApiSchema>;
      enum?: string[];
    };
    type OpenApiOperation = {
      requestBody?: { required?: boolean };
      responses?: Record<
        string,
        {
          content?: {
            'application/json'?: { schema?: OpenApiSchema };
          };
        }
      >;
    };
    const document = JSON.parse(
      readFileSync(
        resolve(process.cwd(), '../../packages/contracts/openapi/openapi.json'),
        'utf8',
      ),
    ) as {
      paths: Record<string, { post?: OpenApiOperation }>;
      components?: { schemas?: Record<string, OpenApiSchema> };
    };
    const operation =
      document.paths['/api/v1/canonical-companies/{id}/discover-contacts']
        ?.post;
    expect(operation?.requestBody).toMatchObject({ required: false });
    expect(
      document.components?.schemas?.DiscoverContactsDto?.required,
    ).toContain('lawfulBasis');
    expect(
      operation?.responses?.['403']?.content?.['application/json']?.schema
        ?.properties?.error?.properties?.code?.enum,
    ).toContain('CONTACT_DISCOVERY_LAWFUL_BASIS_REQUIRED');
  });
});
