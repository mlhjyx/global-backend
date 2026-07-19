import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

interface SchemaNode {
  type?: string;
  nullable?: boolean;
  additionalProperties?: boolean;
  required?: string[];
  enum?: string[];
  allOf?: SchemaNode[];
  properties?: Record<string, SchemaNode>;
}

describe('R4-B BuildRun cost summary generated OpenAPI', () => {
  it('publishes the closed site-builder-cost-summary/v1 shape instead of an open JSON bag', () => {
    const document = JSON.parse(
      readFileSync(
        resolve(process.cwd(), '../../packages/contracts/openapi/openapi.json'),
        'utf8',
      ),
    ) as {
      components: { schemas: Record<string, SchemaNode> };
    };
    expect(
      document.components.schemas.BuildStatusResponseDto.required,
    ).toContain('costSummary');
    const summaryProperty =
      document.components.schemas.BuildStatusResponseDto.properties!
        .costSummary;
    expect(summaryProperty.type).toBe('object');
    expect(summaryProperty.nullable).toBe(true);
    const summary = summaryProperty.allOf?.[0] ?? summaryProperty;

    expect(summary).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: [
        'schemaVersion',
        'currency',
        'unit',
        'budget',
        'totals',
        'usage',
        'operations',
      ],
    });
    expect(summary.properties?.schemaVersion.enum).toEqual([
      'site-builder-cost-summary/v1',
    ]);
    expect(summary.properties?.currency.enum).toEqual(['USD']);
    expect(summary.properties?.unit.enum).toEqual(['microusd']);
    expect(summary.properties?.budget).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: [
        'capMicrousd',
        'reservedMicrousd',
        'chargedMicrousd',
        'remainingMicrousd',
        'paidCallsEnabled',
        'disabledReason',
        'exhaustedAt',
      ],
    });
    expect(summary.properties?.totals?.required).toEqual([
      'reportedCostMicrousd',
      'calculatedCostMicrousd',
      'estimatedCostMicrousd',
      'unknownOperations',
    ]);
    expect(summary.properties?.usage?.required).toEqual([
      'inputTokens',
      'outputTokens',
      'modelCalls',
      'toolCalls',
    ]);
    expect(summary.properties?.operations?.required).toEqual([
      'succeeded',
      'failed',
      'unknown',
      'released',
    ]);
  });
});
