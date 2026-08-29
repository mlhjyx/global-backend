import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const migrationUrl = new URL(
  '../../../../packages/db/prisma/migrations/20260830120000_governed_subject_relation_schema/migration.sql',
  import.meta.url,
);
const schemaUrl = new URL('../../../../packages/db/prisma/schema.prisma', import.meta.url);

const TABLES = [
  'governed_subject',
  'tool_operation_subject',
  'governed_subject_relation',
  'governed_subject_tombstone',
  'governed_subject_tombstone_audit',
] as const;

const MODEL_FIELDS = Object.freeze({
  GovernedSubject: [
    ['id', 'String', '@id', '@default(dbgenerated("gen_random_uuid()"))', '@db.Uuid'],
    ['scopeKey', 'String', '@map("scope_key")', '@db.VarChar(200)'],
    ['workspaceId', 'String', '@map("workspace_id")', '@db.Uuid'],
    ['subjectType', 'String', '@map("subject_type")', '@db.VarChar(191)'],
    ['subjectId', 'String', '@map("subject_id")', '@db.Uuid'],
    ['dataClass', 'String', '@map("data_class")', '@db.VarChar(16)'],
    ['dsrSubjectType', 'String?', '@map("dsr_subject_type")', '@db.VarChar(191)'],
    ['dsrSubjectId', 'String?', '@map("dsr_subject_id")', '@db.Uuid'],
    ['createdAt', 'DateTime', '@default(now())', '@map("created_at")', '@db.Timestamptz(3)'],
  ],
  ToolOperationSubject: [
    ['subjectId', 'String', '@id', '@map("subject_id")', '@db.Uuid'],
    ['scopeKey', 'String', '@map("scope_key")', '@db.VarChar(200)'],
    ['workspaceId', 'String', '@map("workspace_id")', '@db.Uuid'],
    ['authorityId', 'String', '@map("authority_id")', '@db.Uuid'],
    ['accountId', 'String', '@map("account_id")', '@db.Uuid'],
    ['operationId', 'String', '@map("operation_id")', '@db.Uuid'],
    ['operationGeneration', 'Int', '@map("operation_generation")'],
    ['rootSubjectId', 'String', '@map("root_subject_id")', '@db.Uuid'],
    ['ackId', 'String', '@map("ack_id")', '@db.Char(64)'],
    ['resultDigest', 'String', '@map("result_digest")', '@db.Char(64)'],
    ['createdAt', 'DateTime', '@default(now())', '@map("created_at")', '@db.Timestamptz(3)'],
  ],
  GovernedSubjectRelation: [
    ['id', 'String', '@id', '@default(dbgenerated("gen_random_uuid()"))', '@db.Uuid'],
    ['scopeKey', 'String', '@map("scope_key")', '@db.VarChar(200)'],
    ['workspaceId', 'String', '@map("workspace_id")', '@db.Uuid'],
    ['authorityId', 'String', '@map("authority_id")', '@db.Uuid'],
    ['accountId', 'String', '@map("account_id")', '@db.Uuid'],
    ['operationId', 'String', '@map("operation_id")', '@db.Uuid'],
    ['operationGeneration', 'Int', '@map("operation_generation")'],
    ['ackId', 'String', '@map("ack_id")', '@db.Char(64)'],
    ['operationSubjectId', 'String', '@map("operation_subject_id")', '@db.Uuid'],
    ['parentSubjectId', 'String', '@map("parent_subject_id")', '@db.Uuid'],
    ['childSubjectId', 'String', '@map("child_subject_id")', '@db.Uuid'],
    ['relationKey', 'String', '@map("relation_key")', '@db.VarChar(200)'],
    ['relationKind', 'String', '@map("relation_kind")', '@db.VarChar(32)'],
    ['sourceRefNamespace', 'String', '@map("source_ref_namespace")', '@db.VarChar(64)'],
    ['sourceRefUuid', 'String?', '@map("source_ref_uuid")', '@db.Uuid'],
    ['sourceRefSha256', 'String?', '@map("source_ref_sha256")', '@db.Char(64)'],
    ['contractSha256', 'String', '@map("contract_sha256")', '@db.Char(64)'],
    ['createdAt', 'DateTime', '@default(now())', '@map("created_at")', '@db.Timestamptz(3)'],
  ],
  GovernedSubjectTombstone: [
    ['workspaceId', 'String', '@map("workspace_id")', '@db.Uuid'],
    ['governedSubjectId', 'String', '@map("governed_subject_id")', '@db.Uuid'],
    ['tombstonedAt', 'DateTime', '@default(now())', '@map("tombstoned_at")', '@db.Timestamptz(3)'],
  ],
  GovernedSubjectTombstoneAudit: [
    ['deletionRequestId', 'String', '@id', '@map("deletion_request_id")', '@db.Uuid'],
    ['workspaceId', 'String', '@map("workspace_id")', '@db.Uuid'],
    ['governedSubjectId', 'String', '@map("governed_subject_id")', '@db.Uuid'],
    ['tombstonedAt', 'DateTime', '@map("tombstoned_at")', '@db.Timestamptz(3)'],
  ],
});

const MODEL_FIELD_NAMES = Object.freeze({
  GovernedSubject: [
    'id', 'scopeKey', 'workspaceId', 'subjectType', 'subjectId', 'dataClass',
    'dsrSubjectType', 'dsrSubjectId', 'createdAt', 'workspace',
    'operationSubject', 'operationRoot', 'parentRelations', 'childRelations',
    'tombstone',
  ],
  ToolOperationSubject: [
    'subjectId', 'scopeKey', 'workspaceId', 'authorityId', 'accountId',
    'operationId', 'operationGeneration', 'rootSubjectId', 'ackId',
    'resultDigest', 'createdAt', 'workspace', 'authority', 'account',
    'operation', 'subject', 'rootSubject', 'relations',
  ],
  GovernedSubjectRelation: [
    'id', 'scopeKey', 'workspaceId', 'authorityId', 'accountId', 'operationId',
    'operationGeneration', 'ackId', 'operationSubjectId', 'parentSubjectId',
    'childSubjectId', 'relationKey', 'relationKind', 'sourceRefNamespace',
    'sourceRefUuid', 'sourceRefSha256', 'contractSha256', 'createdAt',
    'workspace', 'authority', 'account', 'operation', 'operationSubject',
    'parentSubject', 'childSubject',
  ],
  GovernedSubjectTombstone: [
    'workspaceId', 'governedSubjectId', 'tombstonedAt', 'workspace',
    'subject', 'audits',
  ],
  GovernedSubjectTombstoneAudit: [
    'deletionRequestId', 'workspaceId', 'governedSubjectId', 'tombstonedAt',
    'request', 'workspace', 'tombstone',
  ],
});

const MODEL_ATTRIBUTES = Object.freeze({
  GovernedSubject: [
    '@@unique([workspaceId, subjectType, subjectId], map: "governed_subject_workspace_subject_key")',
    '@@unique([scopeKey, id], map: "governed_subject_scope_id_key")',
    '@@unique([workspaceId, id], map: "governed_subject_workspace_id_key")',
    '@@index([workspaceId, dsrSubjectType, dsrSubjectId], map: "governed_subject_workspace_dsr_idx")',
    '@@map("governed_subject")',
  ],
  ToolOperationSubject: [
    '@@unique([workspaceId, operationId], map: "tool_operation_subject_workspace_operation_key")',
    '@@unique([scopeKey, operationId], map: "tool_operation_subject_scope_operation_key")',
    '@@unique([workspaceId, operationGeneration, subjectId], map: "tool_operation_subject_workspace_generation_subject_key")',
    '@@index([scopeKey, authorityId, accountId, operationId, operationGeneration], map: "tool_operation_subject_authority_operation_idx")',
    '@@map("tool_operation_subject")',
  ],
  GovernedSubjectRelation: [
    '@@unique([workspaceId, operationId, relationKey], map: "governed_subject_relation_workspace_operation_relation_key")',
    '@@index([workspaceId, operationId, parentSubjectId], map: "governed_subject_relation_operation_parent_idx")',
    '@@index([workspaceId, operationId, childSubjectId], map: "governed_subject_relation_operation_child_idx")',
    '@@map("governed_subject_relation")',
  ],
  GovernedSubjectTombstone: [
    '@@id([workspaceId, governedSubjectId], map: "governed_subject_tombstone_pkey")',
    '@@index([workspaceId, tombstonedAt], map: "governed_subject_tombstone_workspace_time_idx")',
    '@@map("governed_subject_tombstone")',
  ],
  GovernedSubjectTombstoneAudit: [
    '@@index([workspaceId, governedSubjectId, tombstonedAt], map: "governed_subject_tombstone_audit_subject_idx")',
    '@@map("governed_subject_tombstone_audit")',
  ],
});

const FORBIDDEN_OWNERSHIP = [
  'discovery', 'raw_source_record', 'identity_link', 'canonical_company',
  'canonical_contact', 'provider_key', 'producer_id', 'opportunity',
] as const;

function compact(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function requirePattern(value: string, pattern: RegExp, label: string): void {
  if (!pattern.test(value)) throw new Error(`MISSING_${label}`);
}

function tableBody(sql: string, table: string): string {
  const match = new RegExp(
    `CREATE TABLE (?:public\\.)?"?${table}"?\\s*\\(([^;]+?)\\n\\s*\\);`,
    'i',
  ).exec(sql);
  if (!match?.[1]) throw new Error(`MISSING_TABLE_${table}`);
  return compact(match[1]);
}

function modelBody(schema: string, model: string): string {
  const match = new RegExp(`model ${model} \\{([^]*?)\\n\\}`, 'u').exec(schema);
  if (!match?.[1]) throw new Error(`MISSING_MODEL_${model}`);
  return match[1];
}

function assertExactWorkspacePolicy(sql: string, table: string): void {
  requirePattern(
    compact(sql),
    new RegExp(
      `CREATE POLICY ${table}_workspace_isolation ON (?:public\\.)?${table} USING \\(workspace_id = public\\.current_workspace_id\\(\\)\\) WITH CHECK \\(workspace_id = public\\.current_workspace_id\\(\\)\\)`,
      'i',
    ),
    `POLICY_${table}`,
  );
}

async function migration(): Promise<string> {
  return readFile(migrationUrl, 'utf8');
}

describe('governed subject relation schema migration', () => {
  it('is one additive bounded transaction and creates exactly the five product-neutral tables', async () => {
    const sql = await migration();
    expect(sql).toMatch(/^--[^]*?\nBEGIN;\n/);
    expect(sql.trimEnd()).toMatch(/COMMIT;$/);
    expect(sql).toContain("SET LOCAL lock_timeout = '5s'");
    expect(sql).toContain("SET LOCAL statement_timeout = '30s'");
    expect(sql).not.toMatch(/\b(?:DROP\s+TABLE|DROP\s+COLUMN|TRUNCATE)\b/i);
    expect([...sql.matchAll(/CREATE TABLE\s+(?:public\.)?"?([a-z0-9_]+)"?\s*\(/g)]
      .map((match) => match[1]))
      .toEqual([...TABLES]);
  });

  it('locks every column type, nullability, default and the complete FK/check/unique matrix', async () => {
    const sql = await migration();
    const subject = tableBody(sql, 'governed_subject');
    for (const fragment of [
      'id UUID NOT NULL DEFAULT gen_random_uuid()', 'scope_key VARCHAR(200) NOT NULL',
      'workspace_id UUID NOT NULL', 'subject_type VARCHAR(191) NOT NULL',
      'subject_id UUID NOT NULL', 'data_class VARCHAR(16) NOT NULL',
      'dsr_subject_type VARCHAR(191)', 'dsr_subject_id UUID',
      'created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP',
      'UNIQUE (workspace_id, subject_type, subject_id)', 'UNIQUE (scope_key, id)',
      'UNIQUE (workspace_id, id)', 'CHECK (scope_key = workspace_id::text)',
      "subject_type ~ '^[a-z][a-z0-9_.]{0,190}$'",
      "data_class = 'PERSONAL' AND dsr_subject_type IS NOT NULL AND dsr_subject_id IS NOT NULL",
      "data_class = 'NON_PERSONAL' AND dsr_subject_type IS NULL AND dsr_subject_id IS NULL",
      'FOREIGN KEY (workspace_id) REFERENCES public.workspace(id)',
    ]) expect(subject).toContain(compact(fragment));

    const operation = tableBody(sql, 'tool_operation_subject');
    for (const fragment of [
      'subject_id UUID NOT NULL', 'scope_key VARCHAR(200) NOT NULL',
      'workspace_id UUID NOT NULL', 'authority_id UUID NOT NULL',
      'account_id UUID NOT NULL', 'operation_id UUID NOT NULL',
      'operation_generation INTEGER NOT NULL', 'root_subject_id UUID NOT NULL',
      'ack_id CHAR(64) NOT NULL', 'result_digest CHAR(64) NOT NULL',
      'created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP',
      'UNIQUE (workspace_id, operation_id)',
      'UNIQUE (scope_key, operation_id)',
      'UNIQUE (workspace_id, operation_generation, subject_id)',
      'CHECK (scope_key = workspace_id::text)', 'CHECK (operation_generation >= 1)',
      'CHECK (root_subject_id = subject_id)',
      "CHECK (ack_id ~ '^[0-9a-f]{64}$')", "CHECK (result_digest ~ '^[0-9a-f]{64}$')",
      'FOREIGN KEY (scope_key, authority_id) REFERENCES public.execution_budget_authority(scope_key, id)',
      'FOREIGN KEY (scope_key, account_id) REFERENCES public.tool_budget_account(scope_key, id)',
      'FOREIGN KEY (scope_key, operation_id) REFERENCES public.tool_budget_operation(scope_key, id)',
      'FOREIGN KEY (workspace_id, subject_id) REFERENCES public.governed_subject(workspace_id, id)',
      'FOREIGN KEY (workspace_id, root_subject_id) REFERENCES public.governed_subject(workspace_id, id)',
      'FOREIGN KEY (ack_id) REFERENCES public.execution_domain_ack(ack_id)',
    ]) expect(operation).toContain(compact(fragment));

    const relation = tableBody(sql, 'governed_subject_relation');
    for (const fragment of [
      'id UUID NOT NULL DEFAULT gen_random_uuid()', 'scope_key VARCHAR(200) NOT NULL',
      'workspace_id UUID NOT NULL', 'authority_id UUID NOT NULL',
      'account_id UUID NOT NULL', 'operation_id UUID NOT NULL',
      'operation_generation INTEGER NOT NULL', 'ack_id CHAR(64) NOT NULL',
      'operation_subject_id UUID NOT NULL', 'parent_subject_id UUID NOT NULL',
      'child_subject_id UUID NOT NULL', 'relation_key VARCHAR(200) NOT NULL',
      'relation_kind VARCHAR(32) NOT NULL', 'source_ref_namespace VARCHAR(64) NOT NULL',
      'source_ref_uuid UUID', 'source_ref_sha256 CHAR(64)',
      'contract_sha256 CHAR(64) NOT NULL',
      'created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP',
      'UNIQUE (workspace_id, operation_id, relation_key)',
      'CHECK (scope_key = workspace_id::text)', 'CHECK (operation_generation >= 1)',
      'CHECK (parent_subject_id <> child_subject_id)',
      "CHECK (relation_kind IN ('MATERIALIZED_CHILD', 'DERIVED_FROM'))",
      "relation_key ~ '^[a-z][a-z0-9_.:-]{0,199}$'",
      "source_ref_namespace ~ '^[a-z][a-z0-9_.]{0,63}$'",
      "source_ref_sha256 ~ '^[0-9a-f]{64}$'", "contract_sha256 ~ '^[0-9a-f]{64}$'",
      'source_ref_uuid IS NOT NULL AND source_ref_sha256 IS NULL',
      'source_ref_uuid IS NULL AND source_ref_sha256 IS NOT NULL',
      'FOREIGN KEY (scope_key, authority_id) REFERENCES public.execution_budget_authority(scope_key, id)',
      'FOREIGN KEY (scope_key, account_id) REFERENCES public.tool_budget_account(scope_key, id)',
      'FOREIGN KEY (scope_key, operation_id) REFERENCES public.tool_budget_operation(scope_key, id)',
      'FOREIGN KEY (workspace_id, operation_subject_id) REFERENCES public.tool_operation_subject(workspace_id, subject_id)',
      'FOREIGN KEY (workspace_id, parent_subject_id) REFERENCES public.governed_subject(workspace_id, id)',
      'FOREIGN KEY (workspace_id, child_subject_id) REFERENCES public.governed_subject(workspace_id, id)',
      'FOREIGN KEY (ack_id) REFERENCES public.execution_domain_ack(ack_id)',
    ]) expect(relation).toContain(compact(fragment));

    const tombstone = tableBody(sql, 'governed_subject_tombstone');
    expect(tombstone).toContain('PRIMARY KEY (workspace_id, governed_subject_id)');
    expect(tombstone).toContain('FOREIGN KEY (workspace_id, governed_subject_id) REFERENCES public.governed_subject(workspace_id, id)');
    const audit = tableBody(sql, 'governed_subject_tombstone_audit');
    expect(audit).toContain('deletion_request_id UUID NOT NULL');
    expect(audit).toContain('PRIMARY KEY (deletion_request_id)');
    expect(audit).toContain('FOREIGN KEY (deletion_request_id) REFERENCES public.deletion_request(id)');
    expect(audit).toContain('FOREIGN KEY (workspace_id, governed_subject_id) REFERENCES public.governed_subject_tombstone(workspace_id, governed_subject_id)');
  });

  it('locks the indexes needed for DSR lookup, operation root and bounded reachability', async () => {
    const sql = compact(await migration());
    for (const index of [
      'CREATE INDEX governed_subject_workspace_dsr_idx ON public.governed_subject (workspace_id, dsr_subject_type, dsr_subject_id)',
      'CREATE INDEX tool_operation_subject_authority_operation_idx ON public.tool_operation_subject (scope_key, authority_id, account_id, operation_id, operation_generation)',
      'CREATE INDEX governed_subject_relation_operation_parent_idx ON public.governed_subject_relation (workspace_id, operation_id, parent_subject_id)',
      'CREATE INDEX governed_subject_relation_operation_child_idx ON public.governed_subject_relation (workspace_id, operation_id, child_subject_id)',
      'CREATE INDEX governed_subject_tombstone_workspace_time_idx ON public.governed_subject_tombstone (workspace_id, tombstoned_at)',
      'CREATE INDEX governed_subject_tombstone_audit_subject_idx ON public.governed_subject_tombstone_audit (workspace_id, governed_subject_id, tombstoned_at)',
    ]) expect(sql).toContain(index);
  });

  it('forces an exact workspace policy and function-only append-only ACL on all five tables', async () => {
    const sql = await migration();
    const normalized = compact(sql);
    for (const table of TABLES) {
      expect(normalized).toContain(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY`);
      expect(normalized).toContain(`ALTER TABLE public.${table} FORCE ROW LEVEL SECURITY`);
      assertExactWorkspacePolicy(sql, table);
      for (const principal of [
        'PUBLIC', 'app_user', 'execution_budget_platform_writer',
        'runtime_api', 'runtime_worker', 'runtime_outbox_relay',
      ]) {
        requirePattern(
          normalized,
          new RegExp(`REVOKE ALL ON TABLE public\\.${table} FROM[^;]*\\b${principal}\\b`, 'i'),
          `ACL_${table}_${principal}`,
        );
      }
      expect(normalized).not.toMatch(new RegExp(
        `GRANT [^;]* ON TABLE public\\.${table} TO (?:app_user|execution_budget_platform_writer|runtime_api|runtime_worker|runtime_outbox_relay)`,
        'i',
      ));
    }
    expect(sql).not.toMatch(/\bCREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\b/i);
  });

  it('mutation-kills a same-named weak constraint and a USING true RLS policy', () => {
    const wrongConstraint = `
      CREATE TABLE public.governed_subject (
        id UUID NOT NULL, workspace_id UUID NOT NULL,
        subject_type VARCHAR(191) NOT NULL, subject_id UUID NOT NULL,
        CONSTRAINT governed_subject_workspace_subject_key UNIQUE (id)
      );
    `;
    expect(() => {
      const body = tableBody(wrongConstraint, 'governed_subject');
      requirePattern(
        body,
        /CONSTRAINT governed_subject_workspace_subject_key UNIQUE \(workspace_id, subject_type, subject_id\)/i,
        'EXACT_UNIQUE',
      );
    }).toThrow('MISSING_EXACT_UNIQUE');

    const weakPolicy = `
      ALTER TABLE public.governed_subject ENABLE ROW LEVEL SECURITY;
      ALTER TABLE public.governed_subject FORCE ROW LEVEL SECURITY;
      CREATE POLICY governed_subject_workspace_isolation
        ON public.governed_subject USING (true) WITH CHECK (true);
    `;
    expect(() => assertExactWorkspacePolicy(weakPolicy, 'governed_subject'))
      .toThrow('MISSING_POLICY_governed_subject');

    const distinctRoot = `
      CREATE TABLE public.tool_operation_subject (
        subject_id UUID NOT NULL,
        root_subject_id UUID NOT NULL,
        CONSTRAINT tool_operation_subject_root_check
          CHECK (root_subject_id <> subject_id)
      );
    `;
    expect(() => requirePattern(
      tableBody(distinctRoot, 'tool_operation_subject'),
      /CHECK \(root_subject_id = subject_id\)/i,
      'OPERATION_IS_GRAPH_ROOT',
    )).toThrow('MISSING_OPERATION_IS_GRAPH_ROOT');

    const nullableSourceNamespace = `
      CREATE TABLE public.governed_subject_relation (
        source_ref_namespace VARCHAR(64),
        source_ref_uuid UUID,
        source_ref_sha256 CHAR(64),
        CONSTRAINT governed_subject_relation_source_ref_check CHECK (
          (source_ref_uuid IS NOT NULL AND source_ref_sha256 IS NULL)
          OR (source_ref_uuid IS NULL AND source_ref_sha256 IS NOT NULL)
        )
      );
    `;
    expect(() => requirePattern(
      tableBody(nullableSourceNamespace, 'governed_subject_relation'),
      /source_ref_namespace VARCHAR\(64\) NOT NULL/i,
      'SOURCE_NAMESPACE_REQUIRED',
    )).toThrow('MISSING_SOURCE_NAMESPACE_REQUIRED');
  });

  it('keeps the Task 1 SQL product-neutral', async () => {
    const sql = (await migration()).toLowerCase();
    for (const forbidden of FORBIDDEN_OWNERSHIP) expect(sql).not.toContain(forbidden);
  });

  it('projects complete Prisma models plus relation anchors independently of migration presence', async () => {
    const schema = await readFile(schemaUrl, 'utf8');
    const projection = Object.keys(MODEL_FIELDS).map((model) => modelBody(schema, model)).join('\n');
    for (const [model, fields] of Object.entries(MODEL_FIELDS)) {
      const rawBody = modelBody(schema, model);
      const body = compact(rawBody);
      for (const field of fields) expect(body).toContain(field.join(' '));
      const fieldNames = rawBody.split('\n').map((line) => line.trim())
        .map((line) => /^([A-Za-z][A-Za-z0-9]*)\s+[A-Z][A-Za-z0-9]*(?:\[\]|\?)?/u.exec(line)?.[1])
        .filter((value): value is string => typeof value === 'string');
      expect(fieldNames).toEqual(MODEL_FIELD_NAMES[model as keyof typeof MODEL_FIELD_NAMES]);
      const attributes = rawBody.split('\n').map((line) => line.trim())
        .filter((line) => line.startsWith('@@'));
      expect(attributes).toEqual(MODEL_ATTRIBUTES[model as keyof typeof MODEL_ATTRIBUTES]);
    }
    for (const forbidden of ['RawSourceRecord', 'IdentityLink', 'CanonicalCompany', 'CanonicalContact', 'Opportunity']) {
      expect(projection).not.toContain(forbidden);
    }

    const anchors = Object.freeze({
      Workspace: ['governedSubjects GovernedSubject[]', 'toolOperationSubjects ToolOperationSubject[]', 'governedSubjectRelations GovernedSubjectRelation[]', 'governedSubjectTombstones GovernedSubjectTombstone[]', 'governedSubjectTombstoneAudits GovernedSubjectTombstoneAudit[]'],
      ExecutionBudgetAuthority: ['toolOperationSubjects ToolOperationSubject[]', 'governedSubjectRelations GovernedSubjectRelation[]'],
      ToolBudgetAccount: ['toolOperationSubjects ToolOperationSubject[]', 'governedSubjectRelations GovernedSubjectRelation[]'],
      ToolBudgetOperation: ['toolOperationSubject ToolOperationSubject?', 'governedSubjectRelations GovernedSubjectRelation[]'],
      DeletionRequest: ['governedSubjectTombstoneAudit GovernedSubjectTombstoneAudit?'],
    });
    for (const [model, relations] of Object.entries(anchors)) {
      const body = compact(modelBody(schema, model));
      for (const relation of relations) expect(body).toContain(relation);
    }
  });
});
