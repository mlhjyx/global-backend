import { describe, expect, it, vi } from 'vitest';
import { runLeadQualityLabelOperator } from './lead-quality-label.operator-cli';

const LEAD_ID = '11111111-1111-4111-8111-111111111111';
const EVENT_ID = '22222222-2222-4222-8222-222222222222';
const WORKSPACE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const FAKE_BEARER = ['unit', 'test', 'bearer'].join('-');

const labelInput = JSON.stringify({
  source_event_id: 'crm:event:1001',
  lead_id: LEAD_ID,
  lead_qualified_event_id: EVENT_ID,
  label: 'QGO_CREATED',
  occurred_at: '2026-08-07T12:00:00.000Z',
  source_system: 'growth-saas',
});

const validLeadQualified = {
  event_id: EVENT_ID,
  event_type: 'LeadQualified',
  schema_version: 1,
  workspace_id: WORKSPACE_ID,
  aggregate_type: 'Lead',
  aggregate_id: LEAD_ID,
  occurred_at: '2026-08-07T11:00:00.000Z',
  producer: 'global-backend',
  correlation_id: null,
  causation_id: null,
  privacy_classification: 'CONFIDENTIAL',
  payload: {
    snapshot_version: 1,
    lead_id: LEAD_ID,
    workspace_id: WORKSPACE_ID,
    icp_id: '33333333-3333-4333-8333-333333333333',
    icp_version: 1,
    company_ref: {
      canonical_company_id: '44444444-4444-4444-8444-444444444444',
      name: 'Example Co',
      domain: 'example.com',
      country: 'DE',
      identifiers: { lei: null, fda_reg: null },
    },
    contact_refs: [],
    scores: {
      fit: 1,
      role: 0,
      intent: 0,
      demand_proof: null,
      reachability: 0,
      data_quality: 1,
      engagement: 0,
      total: 0.5,
    },
    fit_verdict: 'match',
    evidence_refs: { score_detail_available: true, fit_reasons_available: true },
    qualification_rule_version: 'additive-6dim-v2',
    storage_rights_decision: 'ALLOW',
    personal_data_class: 'company_facts_only',
    suppression_state: 'none',
    recommended_action: 'handoff_to_campaign',
    valid_until: null,
    sanctions_screening: { status: 'not_screened', screened_at: null, list_versions: {} },
  },
};

function io() {
  const lines: string[] = [];
  return { lines, write: (line: string) => lines.push(line) };
}

describe('lead-quality-label operator CLI', () => {
  it('defaults post to dry-run, performs no network call, and redacts identifiers', async () => {
    const output = io();
    const fetchImpl = vi.fn();
    const exitCode = await runLeadQualityLabelOperator(['post', '--input', 'label.json'], {
      env: {},
      fetchImpl: fetchImpl as unknown as typeof fetch,
      readFileText: () => labelInput,
      write: output.write,
    });

    expect(exitCode).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(output.lines.join('\n')).toContain('DRY_RUN');
    expect(output.lines.join('\n')).not.toContain(LEAD_ID);
    expect(output.lines.join('\n')).not.toContain(EVENT_ID);
  });

  it('pulls only LeadQualified, validates both envelope and payload schemas, and prints redacted summaries', async () => {
    const output = io();
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({ data: [validLeadQualified], page: { next_cursor: null, has_more: false } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const exitCode = await runLeadQualityLabelOperator(['pull'], {
      env: { GLOBAL_API_BASE_URL: 'https://api.example.test', GLOBAL_API_BEARER_TOKEN: FAKE_BEARER },
      fetchImpl: fetchImpl as unknown as typeof fetch,
      readFileText: () => '',
      write: output.write,
    });

    expect(exitCode).toBe(0);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain('/api/v1/events?type=LeadQualified');
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({
      headers: { authorization: `Bearer ${FAKE_BEARER}` },
    });
    const rendered = output.lines.join('\n');
    expect(rendered).toContain('schema_valid');
    expect(rendered).not.toContain(LEAD_ID);
    expect(rendered).not.toContain(EVENT_ID);
    expect(rendered).not.toContain(FAKE_BEARER);
    expect(rendered).not.toContain('Example Co');
  });

  it('requires explicit --execute for ACK and POST mutations and never prints the env token', async () => {
    const output = io();
    const fetchImpl = vi.fn(async (url: string | URL | Request) =>
      new Response(
        JSON.stringify(String(url).endsWith('/events/ack') ? { data: { acked: 1 } } : { data: { id: 'x', disposition: 'ACCEPTED' } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const deps = {
      env: { GLOBAL_API_BASE_URL: 'https://api.example.test', GLOBAL_API_BEARER_TOKEN: FAKE_BEARER },
      fetchImpl: fetchImpl as unknown as typeof fetch,
      readFileText: () => labelInput,
      write: output.write,
    };

    await expect(
      runLeadQualityLabelOperator(['ack', '--event-id', EVENT_ID, '--execute'], deps),
    ).resolves.toBe(0);
    await expect(
      runLeadQualityLabelOperator(['post', '--input', 'label.json', '--execute'], deps),
    ).resolves.toBe(0);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(output.lines.join('\n')).not.toContain(FAKE_BEARER);
    expect(output.lines.join('\n')).not.toContain(EVENT_ID);
  });

  it('fails closed on an invalid LeadQualified payload', async () => {
    const output = io();
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: [{ ...validLeadQualified, payload: { snapshot_version: 1, lead_id: LEAD_ID } }],
          page: { next_cursor: null, has_more: false },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    await expect(
      runLeadQualityLabelOperator(['pull'], {
        env: { GLOBAL_API_BASE_URL: 'https://api.example.test', GLOBAL_API_BEARER_TOKEN: FAKE_BEARER },
        fetchImpl: fetchImpl as unknown as typeof fetch,
        readFileText: () => '',
        write: output.write,
      }),
    ).rejects.toThrow(/schema/i);
    expect(output.lines.join('\n')).not.toContain(FAKE_BEARER);
  });
});
