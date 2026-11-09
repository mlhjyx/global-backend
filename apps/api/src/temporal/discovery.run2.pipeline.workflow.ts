import { CancellationScope, isCancellation, patched, proxyActivities } from '@temporalio/workflow';
import type { Run2PipelineActivities } from './discovery.run2.pipeline.activities';
import type { ExecutionBudgetBinding } from '../execution-budget/execution-budget-binding';
import type { FailureCode, FailureStage } from '../discovery/judgment/failure-codes';
import { MAX_RUN_ENRICH_COMPANIES } from '../discovery/execution-envelope';
import { classifyPipelineFailure } from './pipeline-failure-taxonomy';

/** P1-10b：contacts 阶段后的付费富集步骤（版本化闸：旧历史 replay 不新增命令）。 */
export const COMPANY_CONTACT_ENRICHMENT_PATCH = 'company-contact-enrichment-v1';

/**
 * M0④ 公司级深挖流水线（每家一个子工作流）：
 * profiling → fitting →（mismatch 提前收工）→ signals → contacts → done。
 *
 * 失败隔离：单家失败只把自己标 failed / skipped，父工作流照常收尾（PARTIAL），绝不拖垮整轮。
 * 取消传播：父工作流被 RequestCancel 时取消子工作流；这里在不可取消作用域里把未完成状态
 * 标成 skipped(DEEP_STOPPED)——下一次 run 会把这家公司重新排队（可续）。
 *
 * P3 J02 W1：失败不再塌缩成 `COMPANY_PIPELINE_FAILED`——catch 里用
 * `classifyPipelineFailure` 把异常（含 Temporal 的 ActivityFailure 链）归一到
 * `failure-codes.ts` 的版本化 cause，`last_error_code` 写具体码，`run_event`
 * payload 同时带 `failureStage`（E4-2 失败可归因率 100%）。
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
  /**
   * P1-10b：本公司在 run 深挖批次里的序号（父工作流按 cursor 传入）。
   * 只有前 MAX_RUN_ENRICH_COMPANIES 家（0..24）触发付费富集；缺省按 0 处理
   * （新历史总带此字段；旧历史由 patched() 闸挡住）。
   */
  enrichmentSlot?: number;
}

export async function companyPipelineWorkflow(
  input: CompanyPipelineWorkflowInput,
): Promise<{ stage: 'done' | 'failed' | 'stopped' }> {
  const mark = (
    stage: 'profiling' | 'fitting' | 'signals' | 'contacts' | 'done' | 'failed' | 'skipped',
    extra: {
      verdictDeep?: 'match' | 'weak' | 'mismatch';
      errorCode?: FailureCode | 'DEEP_STOPPED';
      failureStage?: FailureStage;
    } = {},
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
    // P1-10b：contacts 之后对 match 公司补邮箱（付费 finder 瀑布；run 内限额由父工作流序号控制）。
    // 富集是可选增强：失败只留在该活动历史里，不把已完成的联系人发现打成 failed。
    if (
      patched(COMPANY_CONTACT_ENRICHMENT_PATCH) &&
      fit.verdict === 'match' &&
      (input.enrichmentSlot ?? 0) < MAX_RUN_ENRICH_COMPANIES
    ) {
      await signalActs.enrichContactsForCompany(input).catch(() => undefined);
    }
    await mark('done', fit.verdict ? { verdictDeep: fit.verdict } : {});
    return { stage: 'done' };
  } catch (error) {
    if (isCancellation(error)) {
      await CancellationScope.nonCancellable(async () => {
        await mark('skipped', { errorCode: 'DEEP_STOPPED' }).catch(() => undefined);
      });
      throw error;
    }
    const failure = classifyPipelineFailure(error);
    await CancellationScope.nonCancellable(async () => {
      await mark('failed', {
        errorCode: failure.code,
        failureStage: failure.failureStage,
      }).catch(() => undefined);
    });
    return { stage: 'failed' };
  }
}
