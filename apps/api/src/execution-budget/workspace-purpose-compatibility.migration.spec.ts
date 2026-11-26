import { describe, expect, it } from 'vitest';
import { assertAuthorityPurposeShape, type ExecutionBudgetPurpose } from './execution-budget-authority.types';

// Independent contract matrix: discovery keeps both of its existing subject forms.
const PAIRS = [
  ['understanding.run', 'company'],
  ['icp.design', 'company'],
  ['icp.query_plan', 'icp'],
  ['icp.rejudge', 'icp'],
  ['discovery.run', 'discovery_run'],
  ['discovery.run', 'company'],
  ['contact.verify', 'contact_point'],
  ['contact.enrich', 'company'],
  ['outreach.draft', 'lead'],
  ['campaign.plan', 'campaign'],
  ['market.candidates.generate', 'market_candidate_generation'],
] as const;

function authority(purpose: string, subjectType: string) {
  return {
    authorityKind: 'WORKSPACE_GRANT' as const,
    purpose: purpose as ExecutionBudgetPurpose,
    workspaceId: '11111111-1111-4111-8111-111111111111',
    requestSha256: 'a'.repeat(64),
    subjectType,
    subjectId: '22222222-2222-4222-8222-222222222222',
    scheduleId: null,
    capMicrousd: 800_000n,
    capPerRunMicrousd: null,
    campaignCapMicrousd: null,
    maxRuns: null,
  };
}

const WRONG_PAIRS = [...new Set(PAIRS.map(([purpose]) => purpose))].flatMap(purpose =>
  [...new Set(PAIRS.map(([, subject]) => subject))]
    .filter(subject => !PAIRS.some(([allowedPurpose, allowedSubject]) => allowedPurpose === purpose && allowedSubject === subject))
    .map(subject => [purpose, subject] as const),
);

describe('workspace purpose compatibility at the actual authority boundary', () => {
  it.each(PAIRS)('admits only the declared workspace pair %s / %s', (purpose, subjectType) => {
    expect(() => assertAuthorityPurposeShape(authority(purpose, subjectType))).not.toThrow();
  });

  it.each(WRONG_PAIRS)('refuses the undeclared Cartesian pair %s / %s', (purpose, subjectType) => {
    expect(() => assertAuthorityPurposeShape(authority(purpose, subjectType)))
      .toThrow('EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH');
  });

  it.each(['platform.acquisition', 'platform.intent_watch', 'platform.sanctions', 'platform.channel_crawl'])(
    'does not admit platform purpose %s through the workspace consumer shape', purpose => {
      expect(() => assertAuthorityPurposeShape(authority(purpose, 'market_candidate_generation')))
        .toThrow('EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH');
    },
  );

  it.each([
    { authorityKind: 'PLATFORM_GRANT' as const },
    { workspaceId: null },
    { requestSha256: null },
    { subjectId: '' },
    { scheduleId: 'schedule' },
    { capMicrousd: 0n },
    { capMicrousd: -1n },
    { capMicrousd: null },
    { capPerRunMicrousd: 800_000n },
    { campaignCapMicrousd: 800_000n },
    { maxRuns: 1n },
    { workflowRunId: '33333333-3333-4333-8333-333333333333' },
  ])('keeps generation authority confined to a complete positive workspace grant %#', override => {
    expect(() => assertAuthorityPurposeShape({
      ...authority('market.candidates.generate', 'market_candidate_generation'), ...override,
    })).toThrow('EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH');
  });
});
