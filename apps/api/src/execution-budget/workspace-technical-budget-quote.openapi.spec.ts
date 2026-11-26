import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EXECUTION_BUDGET_GRANT_HEADER } from './execution-budget-grant.decorator';

function document() {
  return JSON.parse(
    readFileSync(
      resolve(process.cwd(), '../../packages/contracts/openapi/openapi.json'),
      'utf8',
    ),
  ) as {
    paths: Record<string, { post?: Record<string, unknown> }>;
    components: { schemas: Record<string, Record<string, unknown>> };
  };
}

describe('Workspace technical budget quote OpenAPI', () => {
  it('publishes one authenticated zero-grant endpoint with stable bounded failures', () => {
    const operation = document().paths[
      '/api/v1/execution-budget/workspace-technical-quote'
    ]?.post as {
      security?: unknown;
      parameters?: Array<{ name?: string }>;
      responses?: Record<string, unknown>;
      'x-required-scopes'?: string[];
      requestBody?: {
        content?: {
          'application/json'?: {
            schema?: { oneOf?: Array<Record<string, unknown>> };
          };
        };
      };
    };

    expect(operation).toBeDefined();
    expect(operation.security).toEqual([{ bearer: [] }]);
    expect(operation['x-required-scopes']).toEqual(['acquisition:write']);
    expect(operation.parameters ?? []).not.toContainEqual(
      expect.objectContaining({ name: EXECUTION_BUDGET_GRANT_HEADER }),
    );
    expect(operation.responses).toHaveProperty('200');
    expect(operation.responses).toHaveProperty('400');
    expect(operation.responses).toHaveProperty('503');
    expect(operation.responses).not.toHaveProperty('402');
    expect(JSON.stringify(operation.requestBody)).not.toMatch(
      /requestSha256|requiredCapMicrousd|customer|balance|credits|subscription|prepaid|invoice/i,
    );
    expect(JSON.stringify(operation.responses?.['503'])).toContain(
      'EXECUTION_BUDGET_QUOTE_UNAVAILABLE',
    );
    expect(JSON.stringify(operation.responses?.['503'])).toContain(
      'EXECUTION_BUDGET_POLICY_DRIFT',
    );
    const variants = operation.requestBody?.content?.['application/json']
      ?.schema?.oneOf;
    expect(variants).toHaveLength(13);
    expect(
      variants?.every((variant) => variant.additionalProperties === false),
    ).toBe(true);
    expect(JSON.stringify(variants)).toContain('maxContacts');
    expect(JSON.stringify(variants)).toContain('maximum');
  });

  it('publishes a closed internal authorization response without commercial fields', () => {
    const schema = document().components.schemas
      .WorkspaceTechnicalBudgetQuoteResponseDto as {
      additionalProperties?: boolean;
      required?: string[];
      properties?: Record<string, unknown>;
    };

    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual([
      'schemaVersion',
      'authorityKind',
      'operation',
      'workspaceId',
      'purpose',
      'subjectType',
      'subjectId',
      'requestSha256',
      'currency',
      'unit',
      'requiredCapMicrousd',
      'policyRevision',
      'expiresAt',
    ]);
    expect(schema.properties?.requiredCapMicrousd).toMatchObject({
      type: 'string',
      pattern: '^[1-9][0-9]*$',
    });
    expect(JSON.stringify(schema)).not.toMatch(
      /customer|balance|credits|subscription|prepaid|invoice/i,
    );
  });
  it('documents only the bounded explicit generation intent, never budget authority or business input', () => {
    const operation = document().paths['/api/v1/execution-budget/workspace-technical-quote']?.post;
    const body = operation?.requestBody as {content:{'application/json':{schema:{oneOf:Array<{properties:{operation:{enum:string[]}};required:string[];additionalProperties:boolean}>}}}};
    const variant = body.content['application/json'].schema.oneOf.find(v=>v.properties.operation.enum[0]==='POST /market-candidate-generations/:generationId/execute');
    expect(variant).toMatchObject({ additionalProperties:false, required:['operation','generationId','body'], properties:{generationId:{format:'uuid'},body:{additionalProperties:false,required:['intentDigest'],properties:{intentDigest:{pattern:'^[0-9a-f]{64}$'}}}} });
    const response = document().components.schemas.WorkspaceTechnicalBudgetQuoteResponseDto;
    expect(JSON.stringify(response)).toContain('market.candidates.generate');
    expect(JSON.stringify(response)).toContain('market_candidate_generation');
  });

  it('documents the bounded icp.rejudge quote variant and purpose enum', () => {
    const operation = document().paths['/api/v1/execution-budget/workspace-technical-quote']?.post;
    const body = operation?.requestBody as {
      content: {
        'application/json': {
          schema: {
            oneOf: Array<{
              properties: Record<string, unknown>;
              required: string[];
              additionalProperties: boolean;
            }>;
          };
        };
      };
    };
    const variant = body.content['application/json'].schema.oneOf.find(
      (v) => (v.properties.operation as { enum: string[] }).enum[0] === 'POST /icps/:icpId/rejudge',
    );
    expect(variant).toMatchObject({
      additionalProperties: false,
      required: ['operation', 'icpId', 'body'],
      properties: {
        icpId: { format: 'uuid' },
        body: {
          additionalProperties: false,
          required: ['attemptId'],
          properties: {
            attemptId: { minLength: 1, maxLength: 128 },
            maxCompanies: { minimum: 1, maximum: 100 },
            batchSize: { minimum: 1, maximum: 25 },
            companyIds: { minItems: 1, maxItems: 100 },
          },
        },
      },
    });
    const response = document().components.schemas.WorkspaceTechnicalBudgetQuoteResponseDto;
    expect(JSON.stringify(response)).toContain('icp.rejudge');
  });

});
