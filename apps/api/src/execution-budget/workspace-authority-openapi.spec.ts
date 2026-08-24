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
});
