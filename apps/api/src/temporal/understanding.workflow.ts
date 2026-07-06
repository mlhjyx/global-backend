import { proxyActivities } from '@temporalio/workflow';
import type { UnderstandingActivities } from './understanding.activities';

const acts = proxyActivities<UnderstandingActivities>({
  startToCloseTimeout: '1 minute',
  retry: { maximumAttempts: 3 },
});

export interface UnderstandingWorkflowInput {
  workspaceId: string;
  companyId: string;
  website: string;
}

/**
 * Durable orchestration of 企业理解 (PRD 5.2). Business state (CompanyProfile
 * status, Claims) lives in PostgreSQL — the workflow only sequences the steps,
 * survives failures, and retries activities.
 */
export async function understandingWorkflow(input: UnderstandingWorkflowInput): Promise<void> {
  await acts.setStatus({ companyId: input.companyId, workspaceId: input.workspaceId, status: 'ENRICHING' });

  const raw = await acts.crawlWebsite(input.website);
  const parsed = await acts.parseContent(raw);
  const { claims } = await acts.extractClaims({ workspaceId: input.workspaceId, text: parsed.text });
  await acts.persistClaims({
    workspaceId: input.workspaceId,
    companyId: input.companyId,
    website: input.website,
    claims,
  });

  await acts.setStatus({ companyId: input.companyId, workspaceId: input.workspaceId, status: 'ACTIVE' });
}
