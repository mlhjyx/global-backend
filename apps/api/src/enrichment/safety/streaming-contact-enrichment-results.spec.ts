import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceEnrichmentTransactions } from './enrichment-execution.repository';
import {
  readStreamingContactEnrichmentResult,
  runBypassStreamingContactEnrichment,
} from './streaming-contact-enrichment-results';

const workspaceId = '00000000-0000-4000-8000-000000000001';
const runId = '00000000-0000-4000-8000-000000000002';
const companyId = '00000000-0000-4000-8000-000000000003';
const jobId = '00000000-0000-4000-8000-000000000004';
const contactId = '00000000-0000-4000-8000-000000000005';
const attemptId = '00000000-0000-4000-8000-000000000006';
const otherWorkspaceId = '00000000-0000-4000-8000-000000000007';
const startedAt = new Date('2026-11-27T00:00:00.123Z');
const address = { workspaceId, runId, companyId };

type State = 'APPLY_PENDING' | 'COMPLETED' | 'RATE_LIMITED';

function world(attemptOutcome = 'error') {
  let state: State | null = null;
  let ref: string | null = null;
  let depth = 0;
  let present = true;
  let legacyExecution = false;
  let companySuppressed = false;
  let attempted = true;
  const queryRaw = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join('$');
    expect(sql).not.toMatch(/\b(?:execution_budget_authority|tool_budget_account|tool_budget_operation)\b/);
    if (sql.includes('UPDATE public.discovery_company_job')) {
      if (sql.includes('contact_enrichment_operation_ref IS NULL')) {
        expect(sql).toContain('public.canonical_company');
        expect(sql).toContain('public.discovery_run');
        expect(sql).toContain("j.verdict_deep = 'match'");
        const [operationRef, workspace, run, company] = values;
        if (state !== null || !present || workspace !== workspaceId || run !== runId || company !== companyId) return [];
        if (legacyExecution && sql.includes('FROM public.contact_enrichment_execution')) {
          expect(sql).toContain('e.workspace_id = j.workspace_id');
          expect(sql).toContain('e.company_id = j.canonical_company_id');
          expect(sql).toContain('e.business_run_id = j.run_id');
          expect(sql).toContain("e.entrypoint = 'discovery_run'");
          return [];
        }
        state = 'APPLY_PENDING';
        ref = String(operationRef);
        return [{ id: jobId }];
      }
      const [next, workspace, run, company, job, operationRef] = values;
      expect([workspace, run, company, job, operationRef]).toEqual([workspaceId, runId, companyId, jobId, ref]);
      expect(sql).toContain("contact_enrichment_status = 'APPLY_PENDING'");
      state = next as State;
      return [{ id: jobId }];
    }
    if (sql.includes('FROM public.discovery_company_job')) {
      expect(sql).toContain('public.canonical_company');
      expect(sql).toContain('public.canonical_contact');
      expect(sql).toContain('public.deletion_request');
      expect(sql).toContain('a.run_id = head.run_id::text');
      const [workspace, company, lookupId, lookupRef] = values;
      if (!present || state === null || workspace !== workspaceId || company !== companyId ||
          (lookupId !== null && lookupId !== jobId) || (lookupRef !== null && lookupRef !== ref)) return [];
      return [{
        operation_ref: ref, run_id: runId, started_at: startedAt, result_status: state,
        company_suppressed: companySuppressed,
        contact_id: attempted && !companySuppressed ? contactId : null,
        attempt_refs: attempted && !companySuppressed ? [attemptId] : null,
        attempt_outcomes: attempted && !companySuppressed ? [attemptOutcome] : null,
      }];
    }
    throw new Error('unexpected read or write');
  });
  const database = {
    withWorkspace: async <T>(scope: string, work: (tx: unknown) => Promise<T>): Promise<T> => {
      expect([workspaceId, otherWorkspaceId]).toContain(scope);
      depth += 1;
      try {
        return await work({
          $queryRaw: queryRaw,
          $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => (await queryRaw(strings, ...values)).length,
        });
      }
      finally { depth -= 1; }
    },
  } as WorkspaceEnrichmentTransactions;
  return {
    database, queryRaw,
    current: () => ({ depth, state, ref }),
    removeCompany: () => { present = false; },
    seedLegacyExecution: () => { legacyExecution = true; },
    suppressCompany: () => { companySuppressed = true; },
    eraseContact: () => { attempted = false; },
  };
}

describe('bypass streaming enrichment execution readback', () => {
  it('commits one claim before executing and seals the observed rate limit without a redispatch', async () => {
    const x = world();
    let release!: () => void;
    let dispatched!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const called = new Promise<void>((resolve) => { dispatched = resolve; });
    const execute = vi.fn(async () => {
      expect(x.current()).toMatchObject({ depth: 0, state: 'APPLY_PENDING' });
      dispatched();
      await hold;
      return { rateLimited: true };
    });
    const started = runBypassStreamingContactEnrichment(x.database, address, execute);
    await called;
    const resultAtClaim = await readStreamingContactEnrichmentResult(x.database, address, { id: jobId });
    expect(resultAtClaim).toMatchObject({ status: 'APPLY_PENDING', resultRevision: 1, operationRef: x.current().ref });
    await runBypassStreamingContactEnrichment(x.database, address, execute);
    release();
    await started;
    await runBypassStreamingContactEnrichment(x.database, address, execute);
    expect(execute).toHaveBeenCalledOnce();
    expect(x.current()).toMatchObject({ state: 'RATE_LIMITED', ref: expect.stringMatching(/^[a-f0-9]{64}$/) });

    const result = await readStreamingContactEnrichmentResult(x.database, address, { operationRef: x.current().ref! });
    expect(result).toMatchObject({
      version: 1, entrypoint: 'discovery_run', businessRunId: runId, companyId,
      createdAt: startedAt.toISOString(), status: 'APPLY_PENDING', resultRevision: 2,
      summary: { consideredUniqueContacts: 1, newCandidatePoints: 0 },
      perContact: [{ contactId, attemptRefs: [attemptId], reasonCode: 'RESULT_UNKNOWN', pointRefs: [], eventRefs: [] }],
      spend: { quotedUpperBoundMicrousd: '0', knownChargedMicrousd: null, unknownUpperBoundMicrousd: null },
    });
  });

  it('leaves an ambiguous interruption readable and prevents retrying under the same run and company', async () => {
    const x = world();
    const execute = vi.fn(async () => { throw new Error('interrupted'); });
    await expect(runBypassStreamingContactEnrichment(x.database, address, execute)).rejects.toThrow('interrupted');
    await runBypassStreamingContactEnrichment(x.database, address, execute);
    expect(execute).toHaveBeenCalledOnce();
    await expect(readStreamingContactEnrichmentResult(x.database, address, { id: jobId })).resolves.toMatchObject({
      operationRef: x.current().ref, status: 'APPLY_PENDING', resultRevision: 1,
    });
  });

  it('keeps the stable head after contact erasure and excludes a deleted or foreign company', async () => {
    const x = world();
    await runBypassStreamingContactEnrichment(x.database, address, async () => ({}));
    x.eraseContact();
    const keys = { operationRef: x.current().ref! };
    await expect(readStreamingContactEnrichmentResult(x.database, address, keys)).resolves.toMatchObject({
      status: 'COMPLETED', businessRunId: runId, perContact: [], summary: { consideredUniqueContacts: 0 },
    });
    await expect(readStreamingContactEnrichmentResult(x.database, { workspaceId: otherWorkspaceId, companyId }, keys)).resolves.toBeNull();
    x.suppressCompany();
    await expect(readStreamingContactEnrichmentResult(x.database, address, keys)).resolves.toMatchObject({
      status: 'REDACTED', perContact: [], summary: { consideredUniqueContacts: 0 },
    });
    x.removeCompany();
    await expect(readStreamingContactEnrichmentResult(x.database, address, keys)).resolves.toBeNull();
  });

  it.each([
    { outcome: 'miss', reasonCode: 'NO_MATCH', eligible: 1 },
    { outcome: 'hit', reasonCode: 'UNAVAILABLE', eligible: 1 },
    { outcome: 'skipped_budget', reasonCode: 'BUDGET_CAP', eligible: 1 },
    { outcome: 'skipped_compliance', reasonCode: 'GOVERNANCE_PENDING', eligible: 0 },
  ])('projects $outcome evidence without claiming money or point creation', async ({ outcome, reasonCode, eligible }) => {
    const x = world(outcome);
    await runBypassStreamingContactEnrichment(x.database, address, async () => ({}));
    await expect(readStreamingContactEnrichmentResult(x.database, address, { id: jobId })).resolves.toMatchObject({
      status: 'COMPLETED',
      summary: { consideredUniqueContacts: 1, eligibleUniqueContacts: eligible, physicallyAttemptedUniqueContacts: null, newCandidatePoints: 0 },
      perContact: [{ reasonCode, pointRefs: [], newCandidate: null }],
      spend: { knownChargedMicrousd: null, unknownUpperBoundMicrousd: null },
    });
  });

  it('skips work without an eligible job in the same workspace, run and company scope', async () => {
    const x = world();
    const execute = vi.fn(async () => ({}));
    await runBypassStreamingContactEnrichment(x.database, { ...address, workspaceId: otherWorkspaceId }, execute);
    await runBypassStreamingContactEnrichment(x.database, { ...address, runId: otherWorkspaceId }, execute);
    await runBypassStreamingContactEnrichment(x.database, { ...address, companyId: otherWorkspaceId }, execute);
    expect(execute).not.toHaveBeenCalled();
    await expect(runBypassStreamingContactEnrichment(x.database, { ...address, runId: 'invalid' }, execute)).rejects.toThrow('INVALID_PLAN');
  });

  it('does not redispatch a run and company already executed under enforce mode', async () => {
    const x = world();
    x.seedLegacyExecution();
    const execute = vi.fn(async () => ({}));
    await runBypassStreamingContactEnrichment(x.database, address, execute);
    expect(execute).not.toHaveBeenCalled();
    expect(x.current()).toMatchObject({ state: null, ref: null });
  });
});
