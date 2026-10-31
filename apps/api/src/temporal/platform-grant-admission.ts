import { ExecutionBudgetGrantError } from "../execution-budget/execution-budget-authority.types";
import type { PlatformExecutionBudgetAuthorityIngestionService } from "../execution-budget/platform-authority-ingestion.service";
import {
  PlatformExecutionTechnicalQuoteService,
  type PlatformExecutionTechnicalQuoteV1,
} from "../platform-authority/platform-execution-technical-quote";
import { resolveCurrentPlatformExecutionProviderSnapshotV1 } from "../platform-authority/platform-execution-provider-snapshot";
import { platformExecutionTechnicalRow } from "../platform-authority/platform-execution-contract";
import type { PlatformGrantClient } from "./platform-grant.client";
import type { PlatformScheduleAuthorityScope } from "./platform-schedule-authority";

/** 平台运行准入（v2）：quote → 权威签发 Grant → 验签并 ingest+admit。
 *
 * 活动只依赖这个窄接口；Grant 的密码学验证与 SQL 绑定都在
 * `PlatformExecutionBudgetAuthorityIngestionService` 里完成。失败语义：
 *  - 端点不可达/配置缺失 → PLATFORM_GRANT_UNAVAILABLE（不可重试，readiness 已报警）
 *  - Grant 被权威拒绝 → ExecutionBudgetGrantError（不可重试，fail closed）
 */
export interface PlatformRunAdmissionPort {
  admit(input: {
    readonly executionScope: PlatformScheduleAuthorityScope;
    readonly workflowId: string;
    readonly workflowRunId: string;
  }): Promise<{ readonly authorityId: string; readonly replay: boolean }>;
}

export class PlatformGrantAdmission implements PlatformRunAdmissionPort {
  constructor(
    private readonly deps: {
      readonly quoteService: Pick<PlatformExecutionTechnicalQuoteService, "quote">;
      readonly ingestion: Pick<
        PlatformExecutionBudgetAuthorityIngestionService,
        "ingestAndAdmit"
      >;
      readonly client: Pick<PlatformGrantClient, "issue">;
      readonly now?: () => Date;
    },
  ) {}

  async admit(input: {
    readonly executionScope: PlatformScheduleAuthorityScope;
    readonly workflowId: string;
    readonly workflowRunId: string;
  }): Promise<{ readonly authorityId: string; readonly replay: boolean }> {
    const scope = input.executionScope;
    const row = platformExecutionTechnicalRow(scope.scheduleId);
    if (
      row.scheduleRequestSha256 !== scope.requestSha256 ||
      row.purpose !== scope.purpose ||
      scope.scheduleId !== row.scheduleId
    )
      throw new ExecutionBudgetGrantError("EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH");
    let quote: PlatformExecutionTechnicalQuoteV1;
    try {
      quote = this.deps.quoteService.quote({
        purpose: row.purpose,
        scheduleId: row.scheduleId,
        workflowType: row.workflowType,
        workflowId: input.workflowId,
        workflowRunId: input.workflowRunId,
        scheduleRequestSha256: row.scheduleRequestSha256,
        now: this.deps.now?.() ?? new Date(),
        providerSnapshot: resolveCurrentPlatformExecutionProviderSnapshotV1(
          row.scheduleId,
        ),
      });
    } catch {
      throw new ExecutionBudgetGrantError("EXECUTION_BUDGET_GRANT_INVALID");
    }
    const grant = await this.deps.client.issue({
      scheduleId: row.scheduleId,
      purpose: row.purpose,
      workflowId: input.workflowId,
      workflowRunId: input.workflowRunId,
      scheduleRequestSha256: row.scheduleRequestSha256,
      technicalPolicyRevision: quote.execution_envelope_sha256,
      capPerRunMicrousd: quote.required_cap_per_run_microusd,
      campaignCapMicrousd: quote.required_campaign_cap_microusd,
    });
    const admitted = await this.deps.ingestion.ingestAndAdmit({
      compactJws: grant.token,
      expected: {
        purpose: row.purpose,
        subjectType: "schedule",
        subjectId: row.scheduleId,
        scheduleId: row.scheduleId,
        scheduleRequestSha256: row.scheduleRequestSha256,
        workflowId: input.workflowId,
        workflowRunId: input.workflowRunId,
        technicalPolicyRevision: quote.execution_envelope_sha256,
      },
    });
    return { authorityId: admitted.authorityId, replay: admitted.replay };
  }
}
