import { proxyActivities } from '@temporalio/workflow';
import type { RejudgeWorkflowInput } from '../relay/rejudge-command';
import type { RejudgeActivities } from './rejudge.activities';

// Single-attempt activity policy: never silently retry paid model/tool wires or duplicate VIES/GLEIF probes.
const acts = proxyActivities<RejudgeActivities>({
  startToCloseTimeout: '5 minutes',
  retry: { maximumAttempts: 1 },
});

export interface RejudgeWorkflowSummary {
  readonly rejudgeId: string;
  readonly processed: number;
  readonly refreshedProfiles: number;
  readonly viesMatched: number;
  readonly fitCount: number;
  readonly notFitCount: number;
  readonly unknownCount: number;
  readonly failedSoft: number;
  readonly stoppedByBudget: boolean;
}

/**
 * Audited historical lead rejudge workflow (Batch 1.7B-2).
 * Zero module-level numeric constants: all batch boundaries arrive in the recorded input.
 */
export async function rejudgeWorkflow(
  input: RejudgeWorkflowInput,
): Promise<RejudgeWorkflowSummary> {
  let processed = 0;
  let refreshedProfiles = 0;
  let viesMatched = 0;
  let fitCount = 0;
  let notFitCount = 0;
  let unknownCount = 0;
  let failedSoft = 0;
  let stoppedByBudget = false;
  const updatedCompanyIds: string[] = [];

  for (const batch of input.batches) {
    for (const companyId of batch.companyIds) {
      const outcome = await acts.rejudgeCompanyOnce({
        workspaceId: input.workspaceId,
        icpId: input.icpId,
        rejudgeId: input.rejudgeId,
        companyId,
        executionContractVersion: input.executionContractVersion,
        budgetBinding: input.budgetBinding,
        refreshWebsiteProfile: input.refreshWebsiteProfile,
        refreshCorroboration: input.refreshCorroboration,
      });
      if (outcome.fatalBudgetError) {
        stoppedByBudget = true;
        break;
      }
      if (outcome.processed) processed += 1;
      if (outcome.refreshedProfile) refreshedProfiles += 1;
      if (outcome.viesMatched) viesMatched += 1;
      if (outcome.failedSoft) failedSoft += 1;
      if (outcome.judged || outcome.leadUpdated) {
        updatedCompanyIds.push(companyId);
      }
      if (outcome.judged) {
        if (outcome.verdict === 'match') fitCount += 1;
        else if (outcome.verdict === 'mismatch') notFitCount += 1;
        else if (outcome.verdict === 'weak') unknownCount += 1;
      } else if (outcome.leadUpdated && outcome.verdict === 'mismatch') {
        notFitCount += 1;
      }
    }
    if (stoppedByBudget) break;
  }

  if (updatedCompanyIds.length > 0) {
    await acts.enqueueRejudgeQualify({
      workspaceId: input.workspaceId,
      icpId: input.icpId,
      rejudgeId: input.rejudgeId,
    });
  }

  return {
    rejudgeId: input.rejudgeId,
    processed,
    refreshedProfiles,
    viesMatched,
    fitCount,
    notFitCount,
    unknownCount,
    failedSoft,
    stoppedByBudget,
  };
}
