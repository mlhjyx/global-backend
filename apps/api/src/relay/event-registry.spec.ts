import { describe, expect, it } from 'vitest';
import {
  INTEGRATION_EVENTS,
  integrationEventValidationClass,
  validateIntegrationEvent,
  validateIntegrationEventWarnOnly,
} from './event-registry';

const workspaceId = '10000000-0000-4000-8000-000000000001';
const uuid = '20000000-0000-4000-8000-000000000001';
const companyId = '30000000-0000-4000-8000-000000000001';
const deletionRequestId = '40000000-0000-4000-8000-000000000001';

function event(eventType: string, payload: unknown, schemaVersion = 1) {
  return {
    eventId: uuid,
    eventType,
    schemaVersion,
    workspaceId,
    aggregateType: 'Test',
    aggregateId: uuid,
    payload,
  };
}

const leadQualifiedPayload = {
  snapshot_version: 1,
  lead_id: uuid,
  workspace_id: workspaceId,
  icp_id: uuid,
  icp_version: 1,
  company_ref: { canonical_company_id: companyId },
  contact_refs: [],
  scores: {},
  fit_verdict: 'MATCH',
  evidence_refs: { score_detail_available: true, fit_reasons_available: true },
  qualification_rule_version: 'v1',
  storage_rights_decision: 'ALLOW',
  personal_data_class: 'NONE',
  suppression_state: 'CLEAR',
  recommended_action: 'REVIEW',
  valid_until: '2026-12-01T00:00:00.000Z',
  sanctions_screening: { status: 'cleared' },
};

const candidateBatchPayload = {
  run_ref: 'run-1',
  icp_id: uuid,
  batch_no: 1,
  batch_ref: 'batch-1',
  scored: 3,
  queues: {},
  candidates: [],
};

/** Historical shape: DiscoveryRunCompleted v1 before taskRef was added. */
const discoveryRunCompletedPayload = {
  planId: uuid,
  status: 'DONE',
  stats: { discovered: 3 },
  cost: 1.2,
  costBasis: 'usage_ledger-runid/v1',
};

/** Historical shape: LeadsScored v1 never had a status field. */
const leadsScoredPayload = {
  scored: 3,
  queues: { recommended: 1, needs_review: 2, rejected: 0, suppressed: 0, sanctions_hold: 0 },
};

const deletionPayload = {
  snapshot_version: 1,
  deletion_request_id: deletionRequestId,
  subject_type: 'contact',
  subject_ref: uuid,
  contacts_erased: 1,
  contact_points_erased: 2,
  field_evidence_erased: 3,
  signals_revoked: 0,
  companies_suppressed: 1,
  leads_rescore_requested: 1,
  rule_version: 'art17-erasure-v1',
  erased_at: '2026-11-12T00:00:00.000Z',
};

describe('integration event payload gate', () => {
  it('classifies every registered integration event as validator or envelope-only', () => {
    for (const eventType of INTEGRATION_EVENTS) {
      expect(['validator', 'envelope-only']).toContain(
        integrationEventValidationClass(eventType),
      );
    }
  });

  it('accepts the minimal structured payloads', () => {
    expect(validateIntegrationEvent(event('LeadQualified', leadQualifiedPayload))).toBe(true);
    expect(
      validateIntegrationEvent(event('CandidateBatchCompleted', candidateBatchPayload)),
    ).toBe(true);
    expect(validateIntegrationEvent(event('DeletionCompleted', deletionPayload))).toBe(true);
    expect(validateIntegrationEvent(event('LeadsScored', { queues: {} }))).toBe(true);
  });

  it('rejects missing required fields and cross-workspace payloads', () => {
    const { lead_id: _leadId, ...missingLead } = leadQualifiedPayload;
    expect(validateIntegrationEvent(event('LeadQualified', missingLead))).toBe(false);
    expect(
      validateIntegrationEvent(
        event('LeadQualified', { ...leadQualifiedPayload, workspace_id: uuid }),
      ),
    ).toBe(false);
    expect(validateIntegrationEvent(event('CandidateBatchCompleted', { run_ref: 'r' }))).toBe(false);
    expect(validateIntegrationEvent(event('DeletionCompleted', { snapshot_version: 1 }))).toBe(false);
  });

  it('fails closed for unregistered and unclassified types', () => {
    expect(validateIntegrationEvent(event('NotARealEvent', {}))).toBe(false);
    expect(integrationEventValidationClass('NotARealEvent')).toBe('unregistered');
  });

  it('rejects non-object payloads even for envelope-only events', () => {
    expect(validateIntegrationEvent(event('LeadsScored', null))).toBe(false);
    expect(validateIntegrationEvent(event('LeadsScored', []))).toBe(false);
  });

  it('accepts historical run/scored payloads and only warns on the stricter v1 shape', () => {
    const run = event('DiscoveryRunCompleted', discoveryRunCompletedPayload);
    const scored = event('LeadsScored', leadsScoredPayload);

    // The existing envelope gate is unchanged: both remain envelope-only and accepted.
    expect(validateIntegrationEvent(run)).toBe(true);
    expect(validateIntegrationEvent(scored)).toBe(true);
    // The compatibility validator accepts the historical shapes (no taskRef, no status).
    expect(validateIntegrationEventWarnOnly(run)).toEqual({ ok: true });
    expect(validateIntegrationEventWarnOnly(scored)).toEqual({ ok: true });
  });

  it('warn-only validators flag malformed payloads without parking or blocking', () => {
    const badRun = event('DiscoveryRunCompleted', { planId: uuid });
    const badScored = event('LeadsScored', { queues: {} });

    expect(validateIntegrationEvent(badRun)).toBe(true);
    expect(validateIntegrationEvent(badScored)).toBe(true);
    expect(validateIntegrationEventWarnOnly(badRun)).toEqual({
      ok: false,
      reason: 'payload_contract_mismatch',
    });
    expect(validateIntegrationEventWarnOnly(badScored)).toEqual({
      ok: false,
      reason: 'payload_contract_mismatch',
    });
  });
});
