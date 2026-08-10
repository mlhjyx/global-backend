import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../../../..');
const schema = readFileSync(resolve(root, 'packages/db/prisma/schema.prisma'), 'utf8');
const openApi = JSON.parse(
  readFileSync(resolve(root, 'packages/contracts/openapi/openapi.json'), 'utf8'),
) as {
  components?: {
    schemas?: Record<string, {
      properties?: Record<string, {
        type?: string;
        minimum?: number;
        maximum?: number;
        maxLength?: number;
        pattern?: string;
      }>;
    }>;
  };
  paths: Record<string, Record<string, {
    parameters?: Array<{ name?: string; schema?: { type?: string } }>;
    responses?: Record<string, { content?: { 'application/json'?: { schema?: { required?: string[]; properties?: Record<string, unknown> } } } }>;
  }>>;
};
const readMigration = (): string =>
  readFileSync(
    resolve(root, 'packages/db/prisma/migrations/20260810010000_suppression_decision_governance/migration.sql'),
    'utf8',
  );

describe('suppression decision governance migration', () => {
  it('keeps suppression facts and decisions as separate models', () => {
    expect(schema).toContain('protectionClass String');
    expect(schema).toContain('model SuppressionDecision');
    expect(schema).toContain('requestedDecision   String');
    expect(schema).toContain('requestedReasonCode String');
    expect(schema).toContain('@@unique([workspaceId, requestId])');
  });

  it('makes app suppression deletion and decision mutation impossible at the DB privilege layer', () => {
    const migration = readMigration();
    expect(migration).toMatch(/REVOKE DELETE ON TABLE "suppression_record" FROM app_user/);
    expect(migration).toMatch(/GRANT SELECT, INSERT ON TABLE "suppression_decision" TO app_user/);
    expect(migration).toMatch(/REVOKE UPDATE, DELETE ON TABLE "suppression_decision" FROM app_user/);
  });

  it('forces tenant RLS and prevents cross-workspace decision references', () => {
    const migration = readMigration();
    expect(migration).toContain('ALTER TABLE "suppression_decision" ENABLE ROW LEVEL SECURITY');
    expect(migration).toContain('ALTER TABLE "suppression_decision" FORCE ROW LEVEL SECURITY');
    expect(migration).toMatch(/FOREIGN KEY \("workspace_id", "suppression_id"\)/);
  });

  it('enforces protection/reason and decision/reason semantic pairs at the DB layer', () => {
    const migration = readMigration();
    expect(migration).toContain('suppression_record_preference_reason_check');
    expect(migration).toContain('suppression_decision_requested_pair_check');
    expect(migration).toContain('suppression_decision_semantic_pair_check');
    expect(migration).toContain('suppression_decision_outcome_matches_request_check');
    expect(migration).toMatch(/"decision" = 'RELEASE_REQUEST_DENIED'[\s\S]+"reason_code" = 'LEGAL_SUPPRESSION_IMMUTABLE'/);
  });

  it('publishes the legal-release 409 as a machine-readable API response', () => {
    const operation = openApi.paths['/api/v1/suppressions/{id}/decisions']?.post;
    expect(operation?.responses).toHaveProperty('409');
    expect(operation?.responses?.['409']?.content?.['application/json']?.schema?.required).toEqual(['error']);
    expect(operation?.responses).toHaveProperty('400');
    expect(operation?.responses).toHaveProperty('404');
    expect(operation?.parameters?.find((parameter) => parameter.name === 'id')?.schema).toMatchObject({
      type: 'string',
      format: 'uuid',
    });
    const listOperation = openApi.paths['/api/v1/suppressions/{id}/decisions']?.get;
    expect(listOperation?.parameters?.find((parameter) => parameter.name === 'limit')?.schema?.type).toBe('integer');
    expect(listOperation?.responses).toHaveProperty('400');
    expect(listOperation?.responses).toHaveProperty('404');

    const createOperation = openApi.paths['/api/v1/suppressions']?.post;
    expect(createOperation?.responses).toHaveProperty('400');

    const deprecatedDelete = openApi.paths['/api/v1/suppressions/{id}']?.delete;
    expect(deprecatedDelete?.responses).toHaveProperty('400');
    expect(deprecatedDelete?.responses).toHaveProperty('404');
    expect(deprecatedDelete?.responses).toHaveProperty('409');
    expect(deprecatedDelete?.responses?.['409']?.content?.['application/json']?.schema?.required).toEqual(['error']);
    expect(deprecatedDelete?.parameters?.find((parameter) => parameter.name === 'id')?.schema).toMatchObject({
      type: 'string',
      format: 'uuid',
    });

    const decision400 = operation?.responses?.['400']?.content?.['application/json']?.schema as {
      properties?: { error?: { properties?: { code?: { enum?: string[] } } } };
    };
    expect(decision400?.properties?.error?.properties?.code?.enum).toEqual([
      'VALIDATION_ERROR',
      'INVALID_REASON',
    ]);

    const accept = openApi.paths['/api/v1/leads/{leadId}/accept']?.post;
    expect(accept?.responses).toHaveProperty('409');
    const accept409 = accept?.responses?.['409']?.content?.['application/json']?.schema as {
      properties?: { error?: { properties?: { code?: { enum?: string[] } } } };
    };
    expect(accept409?.properties?.error?.properties?.code?.enum).toContain('SUPPRESSED_CONTACT_UNREACHABLE');
  });

  it('publishes verification and guessing input bounds in OpenAPI', () => {
    const verify = openApi.components?.schemas?.VerifyContactPointDto?.properties;
    expect(verify?.lawfulBasisRef).toMatchObject({ type: 'string', maxLength: 512 });
    expect(verify?.lawfulBasisNote).toMatchObject({ type: 'string', maxLength: 1000 });
    expect(verify?.lawfulBasisRef?.pattern).toBeDefined();
    expect(verify?.lawfulBasisNote?.pattern).toBeDefined();

    const guess = openApi.components?.schemas?.GuessEmailsDto?.properties;
    expect(guess?.lawfulBasisRef).toMatchObject({ type: 'string', maxLength: 512 });
    expect(guess?.lawfulBasisNote).toMatchObject({ type: 'string', maxLength: 1000 });
    expect(guess?.lawfulBasisRef?.pattern).toBeDefined();
    expect(guess?.lawfulBasisNote?.pattern).toBeDefined();
    expect(guess?.maxContacts).toMatchObject({ type: 'integer', minimum: 1, maximum: 25 });
    expect(guess?.maxProbe).toMatchObject({ type: 'integer', minimum: 1, maximum: 8 });
  });
});
