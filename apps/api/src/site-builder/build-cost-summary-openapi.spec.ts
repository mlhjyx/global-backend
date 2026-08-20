import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

interface SchemaNode {
  type?: string;
  nullable?: boolean;
  additionalProperties?: boolean;
  required?: string[];
  enum?: string[];
  properties?: Record<string, SchemaNode>;
}

describe('R4-B BuildRun cost summary generated OpenAPI', () => {
  it('publishes the closed site-builder-cost-summary/v2 shape instead of an open JSON bag', () => {
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

    expect(summaryProperty).toMatchObject({
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
        'reconciliation',
      ],
    });
    expect(summaryProperty.properties?.schemaVersion.enum).toEqual([
      'site-builder-cost-summary/v2',
    ]);
    expect(summaryProperty.properties?.currency.enum).toEqual(['USD']);
    expect(summaryProperty.properties?.unit.enum).toEqual(['microusd']);
    expect(summaryProperty.properties?.budget).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: [
        'capMicrousd',
        'authorizedCapMicrousd',
        'reservedMicrousd',
        'chargedMicrousd',
        'conservativeChargedMicrousd',
        'remainingMicrousd',
        'paidCallsEnabled',
        'disabledReason',
        'exhaustedAt',
      ],
    });
    expect(summaryProperty.properties?.totals?.required).toEqual([
      'reportedCostMicrousd',
      'calculatedCostMicrousd',
      'estimatedCostMicrousd',
      'unknownOperations',
      'exactCostMicrousd',
      'upperBoundCostMicrousd',
    ]);
    for (const name of [
      'capMicrousd',
      'authorizedCapMicrousd',
      'reservedMicrousd',
      'chargedMicrousd',
      'conservativeChargedMicrousd',
      'remainingMicrousd',
    ]) {
      expect(summaryProperty.properties?.budget?.properties?.[name]).toMatchObject({
        type: 'string',
        pattern: '^(0|[1-9][0-9]*)$',
      });
    }
    for (const name of [
      'reportedCostMicrousd',
      'calculatedCostMicrousd',
      'estimatedCostMicrousd',
      'exactCostMicrousd',
      'upperBoundCostMicrousd',
    ]) {
      expect(summaryProperty.properties?.totals?.properties?.[name]).toMatchObject({
        type: 'string',
        pattern: '^(0|[1-9][0-9]*)$',
      });
    }
    expect(summaryProperty.properties?.usage?.required).toEqual([
      'inputTokens',
      'outputTokens',
      'modelCalls',
      'toolCalls',
    ]);
    expect(summaryProperty.properties?.operations?.required).toEqual([
      'succeeded',
      'failed',
      'unknown',
      'released',
    ]);
    expect(summaryProperty.properties?.reconciliation?.required).toEqual([
      'pendingOperations',
      'resolvedOperations',
      'conflictOperations',
      'asOf',
      'revision',
    ]);
  });
});
