import { CancellationScope, isCancellation, proxyActivities } from '@temporalio/workflow';
import type { Run2PipelineActivities } from './discovery.run2.pipeline.activities';
import type { ExecutionBudgetBinding } from '../execution-budget/execution-budget-binding';

/**
 * M0④ 公司级深挖流水线（每家一个子工作流）：
 * profiling → fitting →（mismatch 提前收工）→ signals → contacts → done。
 *
 * 失败隔离：单家失败只把自己标 failed / skipped，父工作流照常收尾（PARTIAL），绝不拖垮整轮。
 * 取消传播：父工作流被 RequestCancel 时取消子工作流；这里在不可取消作用域里把未完成状态
 * 标成 skipped(DEEP_STOPPED)——下一次 run 会把这家公司重新排队（可续）。
 */
const modelActs = proxyActivities<Run2PipelineActivities>({
  startToCloseTimeout: '15 minutes',
  retry: { maximumAttempts: 2 },
});
const signalActs = proxyActivities<Run2PipelineActivities>({
  startToCloseTimeout: '30 minutes',
  retry: { maximumAttempts: 2 },
});
const bookkeeping = proxyActivities<Run2PipelineActivities>({
  startToCloseTimeout: '2 minutes',
  retry: { maximumAttempts: 3 },
});

export interface CompanyPipelineWorkflowInput {
  workspaceId: string;
  runId: string;
  icpId: string;
  companyId: string;
  executionContractVersion?: 2;
  executionBudget?: ExecutionBudgetBinding;
}

export async function companyPipelineWorkflow(
  input: CompanyPipelineWorkflowInput,
): Promise<{ stage: 'done' | 'failed' | 'stopped' }> {
  const mark = (
    stage: 'profiling' | 'fitting' | 'signals' | 'contacts' | 'done' | 'failed' | 'skipped',
    extra: { verdictDeep?: 'match' | 'weak' | 'mismatch'; errorCode?: string } = {},
  ) =>
    bookkeeping.updateCompanyJobStage({
      workspaceId: input.workspaceId,
      runId: input.runId,
      companyId: input.companyId,
      stage,
      ...extra,
    });

  try {
    await mark('profiling');
    await signalActs.profileCompanyOnce(input);
    await mark('fitting');
    const fit = await modelActs.fitCompanyOnce(input);
    if (fit.verdict === 'mismatch') {
      await mark('done', { verdictDeep: 'mismatch' });
      return { stage: 'done' };
    }
    await mark('signals');
    await signalActs.signalsCompanyOnce(input);
    await mark('contacts');
    await signalActs.contactsCompanyOnce(input);
    await mark('done', fit.verdict ? { verdictDeep: fit.verdict } : {});
    return { stage: 'done' };
  } catch (error) {
    if (isCancellation(error)) {
      await CancellationScope.nonCancellable(async () => {
        await mark('skipped', { errorCode: 'DEEP_STOPPED' }).catch(() => undefined);
      });
      throw error;
    }
    await CancellationScope.nonCancellable(async () => {
      await mark('failed', { errorCode: 'COMPANY_PIPELINE_FAILED' }).catch(() => undefined);
    });
    return { stage: 'failed' };
  }
}
