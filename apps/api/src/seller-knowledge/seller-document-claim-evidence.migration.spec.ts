import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const MIGRATIONS = fileURLToPath(new URL('../../../../packages/db/prisma/migrations/', import.meta.url));
const MIGRATION = '20261123110000_seller_document_claim_evidence';
const PRIVILEGES = fileURLToPath(new URL('../../../../docs/governance/app-user-table-privileges.json', import.meta.url));
const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

function statements(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.replace(/--.*$/u, ''))
    .join('\n')
    .split(';')
    .map((statement) => statement.replace(/\s+/gu, ' ').trim())
    .filter(Boolean);
}

describe('seller document typed claim evidence migration（S1a）', () => {
  const sql = readFileSync(`${MIGRATIONS}${MIGRATION}/migration.sql`, 'utf8');
  const list = statements(sql);

  it('uses the single reserved slot after the merged maximum', () => {
    const names = readdirSync(MIGRATIONS).filter((name) => /^\d{14}_/u.test(name)).sort();
    expect(names).toContain(MIGRATION);
    expect(names.indexOf(MIGRATION)).toBeGreaterThan(names.indexOf('20261123074206_contact_enrichment_safety'));
    expect(list[0]).toBe('BEGIN');
    expect(list.at(-1)).toBe('COMMIT');
    expect(list).toContain("SET LOCAL lock_timeout = '5s'");
  });
  it('adds the published parse revision with a truthful legacy backfill', () => {
    expect(sql).toContain('ALTER TABLE "seller_document" ADD COLUMN "parse_revision" INTEGER;');
    expect(sql).toContain('seller_document_parse_revision_check');
    expect(sql).toMatch(/UPDATE "seller_document" d\s+SET "parse_revision" = 1\s+WHERE d\."status" = 'ready'\s+AND d\."content_hash" IS NOT NULL\s+AND EXISTS \(\s+SELECT 1 FROM "seller_document_chunk" c/u);
  });
  it('creates claim_document_evidence with exact quote identity and immutable digests', () => {
    const table = list.find((statement) => statement.startsWith('CREATE TABLE "claim_document_evidence"')) ?? '';
    for (const column of [
      'workspace_id', 'company_id', 'claim_id', 'evidence_id', 'document_id', 'source_document_id',
      'document_content_sha256', 'parse_revision', 'chunk_seq', 'chunk_text_sha256', 'quote_start_byte', 'quote_end_byte',
      'reference_version', 'claim_statement_digest', 'claim_type', 'binding_sha256', 'requester_id', 'request_digest', 'created_at',
    ])
      expect(table).toContain(`"${column}"`);
    expect(table).toContain('"quote_start_byte" < "quote_end_byte"');
    expect(table).toContain('"reference_version" = 1');
    for (const digest of ['document_content_sha256', 'chunk_text_sha256', 'claim_statement_digest', 'binding_sha256', 'request_digest'])
      expect(table).toContain(`"${digest}" ~ '^[0-9a-f]{64}$'`);
    expect(sql).toContain('CREATE FUNCTION "claim_document_evidence_immutable_v1"()');
    expect(sql).toContain(`RAISE EXCEPTION 'CLAIM_DOCUMENT_EVIDENCE_IMMUTABLE' USING ERRCODE = '23514'`);
  });
  it('keeps live document FK SET NULL on the document column only', () => {
    expect(sql).toMatch(/FOREIGN KEY \("document_id", "workspace_id"\) REFERENCES "seller_document" \("id", "workspace_id"\)\s+ON DELETE SET NULL \("document_id"\) ON UPDATE CASCADE/u);
    expect(sql).toMatch(/FOREIGN KEY \("claim_id", "workspace_id", "company_id"\) REFERENCES "claim" \("id", "workspace_id", "company_id"\)/u);
    expect(sql).toMatch(/FOREIGN KEY \("evidence_id", "workspace_id", "claim_id"\) REFERENCES "evidence" \("id", "workspace_id", "claim_id"\)/u);
  });
  it('forces tenant RLS and grants app_user SELECT/INSERT only', () => {
    expect(sql).toContain('ALTER TABLE "claim_document_evidence" ENABLE ROW LEVEL SECURITY;');
    expect(sql).toContain('ALTER TABLE "claim_document_evidence" FORCE ROW LEVEL SECURITY;');
    expect(sql).toContain('CREATE POLICY "claim_document_evidence_tenant_isolation" ON "claim_document_evidence"');
    expect(sql).toContain('"workspace_id" = current_workspace_id()');
    expect(sql).toContain('REVOKE ALL ON TABLE "claim_document_evidence" FROM PUBLIC, app_user;');
    expect(sql).toContain('GRANT SELECT, INSERT ON TABLE "claim_document_evidence" TO app_user;');
    expect(sql).not.toMatch(/GRANT (?:UPDATE|DELETE)[^\n]*claim_document_evidence/u);
    const privileges = JSON.parse(readFileSync(PRIVILEGES, 'utf8')) as { tables: Record<string, string[]> };
    expect(privileges.tables.claim_document_evidence).toEqual(['INSERT', 'SELECT']);
  });
  it('allows document claims to carry doc origin without a forged Site fact key', () => {
    expect(sql).toContain('ALTER TABLE "claim" DROP CONSTRAINT "claim_origin_fact_key_pair_check";');
    expect(sql).toContain('("origin_key" IS NOT NULL AND "fact_key" IS NULL)');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION reject_bridged_claim_identity_update()');
    expect(sql).toContain('Document Claim approval requires a complete v4 proof');
    expect(sql).toContain('FROM "claim_document_evidence" evidence');
    expect(sql).toContain('origin-keyed Claim approval requires a surviving exact bridge');
  });
  it('adds only a nullable typed seller-document detail to deletion receipts', () => {
    expect(sql).toContain('ALTER TABLE "deletion_receipt" ADD COLUMN "seller_document_detail" JSONB;');
    expect(sql).toContain('deletion_receipt_seller_document_detail_check');
    expect(sql).toContain('"subject_type" = \'seller_document\'');
  });
  it('keeps Prisma in sync with the new model and revision column', () => {
    const schema = readFileSync(`${ROOT}packages/db/prisma/schema.prisma`, 'utf8');
    expect(schema).toMatch(/model ClaimDocumentEvidence \{/u);
    expect(schema).toContain('@map("claim_document_evidence")');
    expect(schema).toContain('parseRevision       Int?      @map("parse_revision")');
    expect(schema).toContain('sellerDocumentDetail  Json?    @map("seller_document_detail")');
  });
});
