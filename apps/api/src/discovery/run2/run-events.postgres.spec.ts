import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, describe, expect, it } from 'vitest';
import { appendRunEvent, RUN_EVENT_TYPES } from './run-events';
import { sanitizeCanonicalCompanyAttributes, sanitizeStoredCompanyFieldEvidence } from '../canonical-company-attributes';

// Explicitly opted-in, disposable PostgreSQL only (schema from prisma migrate deploy).
const databaseUrl = process.env.RUN_EVENTS_TEST_DATABASE_URL;
if (databaseUrl) {
  const url = new URL(databaseUrl);
  if (
    url.protocol !== 'postgresql:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    !['/global_test', '/run_events_test'].includes(url.pathname)
  ) {
    throw new Error('run-event seq test requires a loopback test database');
  }
}

describe.runIf(Boolean(databaseUrl))('run-event seq allocation on PostgreSQL', () => {
  const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('keeps the SQL country-identity sanitizer contract equal to the application without granting app_user private execution', async () => {
    for (const value of ['Q183', 'Q12345678', 'Q0', 'Q0123', 'Q12345678901234567', 'person@example.test', '+49 30 1234567']) {
      const attributes = { wikidata: { country_qid: value }, gleif: { country_qid: value }, website_profile: { country_qid: value } };
      const [row] = await prisma.$queryRaw<Array<{ attributes: unknown; field: unknown; wrong_path: unknown }>>`
        SELECT public.sanitize_canonical_company_attributes_v3(${JSON.stringify(attributes)}::jsonb) AS attributes,
          public.raw_source_sanitize_stored_company_field_evidence_v1('wikidata.country_qid',${JSON.stringify(value)}::jsonb) AS field,
          public.raw_source_sanitize_stored_company_field_evidence_v1('gleif.country_qid',${JSON.stringify(value)}::jsonb) AS wrong_path`;
      expect(row?.attributes).toEqual(sanitizeCanonicalCompanyAttributes(attributes));
      expect(row?.field).toEqual(sanitizeStoredCompanyFieldEvidence('wikidata.country_qid', value) ?? null);
      expect(row?.wrong_path).toBeNull();
    }
    const [privileges] = await prisma.$queryRaw<Array<{ executable: boolean }>>`
      SELECT bool_or(has_function_privilege('app_user',p.oid,'EXECUTE')) AS executable
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname IN ('raw_source_stored_field_attribute_path_v1',
        'raw_source_semantic_identifier_valid_v1','raw_source_sanitize_derived_json_v4')`;
    expect(privileges?.executable).toBe(false);
  });

  it('writes the full closed event vocabulary with app_user RLS and consecutive advisory-lock seqs', async () => {
    // 2026-11-04: pg_advisory_xact_lock returns void; reading it through $queryRaw
    // failed at runtime with "Failed to deserialize column of type 'void'" and
    // aborted every discovery run at quickScan. This exercises the real statement.
    const workspaceId = randomUUID();
    const runId = await prisma.$transaction(async (tx) => {
      await tx.workspace.create({ data: { id: workspaceId, name: 'run-events probe' } });
      const company = await tx.companyProfile.create({
        data: { workspaceId, name: 'Run Events Probe' },
      });
      const icp = await tx.icpDefinition.create({
        data: { workspaceId, companyId: company.id, name: 'probe' },
      });
      const plan = await tx.discoveryQueryPlan.create({
        data: { workspaceId, icpId: icp.id, status: 'CONFIRMED', queries: [] },
      });
      const run = await tx.discoveryRun.create({
        data: {
          workspaceId,
          planId: plan.id,
          icpId: icp.id,
          materializationContractVersion: 'discovery-company-materialization/v1',
        },
      });
      return run.id;
    });

    try {
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL ROLE app_user`;
        await tx.$queryRaw`SELECT set_config('app.current_workspace_id', ${workspaceId}, true)`;
        for (const type of RUN_EVENT_TYPES) {
          await appendRunEvent(tx as never, { workspaceId, runId, type, payload: { phase: 'contract-probe' } });
        }
      });
      const rows = await prisma.runEvent.findMany({
        where: { runId },
        orderBy: { seq: 'asc' },
        select: { seq: true, type: true },
      });
      expect(rows.map((row) => Number(row.seq))).toEqual(RUN_EVENT_TYPES.map((_, index) => index + 1));
      expect(rows.map((row) => row.type)).toEqual([...RUN_EVENT_TYPES]);
      await expect(prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL ROLE app_user`;
        await tx.$queryRaw`SELECT set_config('app.current_workspace_id', ${workspaceId}, true)`;
        await appendRunEvent(tx as never, { workspaceId, runId, type: 'unknown_event' as never });
      })).rejects.toThrow(/run_event_type_check/u);
      await expect(prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL ROLE app_user`;
        await tx.$queryRaw`SELECT set_config('app.current_workspace_id', ${randomUUID()}, true)`;
        await appendRunEvent(tx as never, { workspaceId, runId, type: 'company_done' });
      })).rejects.toThrow(/row-level security/u);
      expect(await prisma.runEvent.count({ where: { runId } })).toBe(RUN_EVENT_TYPES.length);
    } finally {
      await prisma.runEvent.deleteMany({ where: { runId } });
      await prisma.discoveryRun.deleteMany({ where: { id: runId } });
      await prisma.workspace.deleteMany({ where: { id: workspaceId } });
    }
  }, 60_000);
});
