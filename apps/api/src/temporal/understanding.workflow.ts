import {
  ApplicationFailure,
  CancellationScope,
  TemporalFailure,
  patched,
  proxyActivities,
} from '@temporalio/workflow';
import type { UnderstandingActivities } from './understanding.activities';
import {
  describeUnderstandingFailure,
  type UnderstandingStage,
} from './understanding.run-failure';
import {
  parseExecutionBudgetBinding,
  type ExecutionBudgetBinding,
} from '../execution-budget/execution-budget-binding';

// Crawling can be slow (headless browser per page) — generous timeout, few retries.
const crawlActs = proxyActivities<UnderstandingActivities>({
  startToCloseTimeout: '3 minutes',
  retry: { maximumAttempts: 3 },
});

// Model extraction: one page per call; reasoning models can take a while.
// 429 bursts from the model gateway last tens of seconds (2026-11-01: an
// understanding run burned its 3 quick attempts in ~3s). Back off long enough
// that a burst can clear: 5s → 10s → 20s → 40s, ~75s of cover.
const modelActs = proxyActivities<UnderstandingActivities>({
  startToCloseTimeout: '3 minutes',
  retry: {
    maximumAttempts: 5,
    initialInterval: '5 seconds',
    backoffCoefficient: 2,
    maximumInterval: '60 seconds',
  },
});

// DB writes are fast and idempotent enough for quick retries.
const dbActs = proxyActivities<UnderstandingActivities>({
  startToCloseTimeout: '1 minute',
  retry: { maximumAttempts: 3 },
});

export interface UnderstandingWorkflowInput {
  workspaceId: string;
  companyId: string;
  website: string;
  executionContractVersion?: 2;
  executionBudget?: ExecutionBudgetBinding;
}

export const UNDERSTANDING_AUTHORITY_PATCH = 'understanding-workspace-authority-v2';
/** A stage failure returns the profile to DRAFT with the failure recorded before the workflow fails. */
export const UNDERSTANDING_FAILURE_RECORD_PATCH = 'understanding-failure-record-v1';
const EXECUTION_CONTRACT_VERSION = 2 as const;

function invalidAuthorityInput(): never {
  throw ApplicationFailure.nonRetryable(
    'EXECUTION_BUDGET_WORKFLOW_INPUT_INVALID',
    'EXECUTION_BUDGET_WORKFLOW_INPUT_INVALID',
  );
}

/**
 * Durable orchestration of 企业理解 (PRD 5.2). Business state (CompanyProfile
 * status, Claims, Offerings) lives in PostgreSQL — the workflow only sequences
 * steps, survives failures, and retries activities.
 *
 * Flow: homepage → pick key subpages (deterministic) → crawl them → per-page
 * claim + offering extraction (evidence keeps the real page URL) → persist →
 * deterministic public-contact extraction → REVIEW. The crawls carry the
 * company id: the activities name the seller profile as the G3 artifact subject.
 */
export async function understandingWorkflow(input: UnderstandingWorkflowInput): Promise<void> {
  const { workspaceId, companyId, website } = input;
  const usesAuthority = patched(UNDERSTANDING_AUTHORITY_PATCH);
  let executionBudget: ExecutionBudgetBinding | undefined;
  if (usesAuthority) {
    if (input.executionContractVersion !== EXECUTION_CONTRACT_VERSION) {
      invalidAuthorityInput();
    }
    try {
      executionBudget = parseExecutionBudgetBinding(input.executionBudget, {
        scopeKey: workspaceId,
        purpose: 'understanding.run',
        subjectType: 'company',
      });
    } catch {
      invalidAuthorityInput();
    }
  }
  const authorityArgs = usesAuthority
    ? { executionContractVersion: EXECUTION_CONTRACT_VERSION, executionBudget: executionBudget! }
    : {};
  await dbActs.setStatus({ companyId, workspaceId, ...authorityArgs, status: 'ENRICHING' });

  let stage: UnderstandingStage = 'crawlWebsite';
  try {
    const home = await crawlActs.crawlWebsite({ workspaceId, companyId, website, ...authorityArgs });
    stage = 'selectSubpages';
    const subUrls = await dbActs.selectSubpages({
      markdown: home.text,
      website,
      ...(usesAuthority ? { workspaceId, ...authorityArgs } : {}),
    });
    stage = 'crawlPages';
    const { pages: subPages } = await crawlActs.crawlPages({ workspaceId, companyId, urls: subUrls, ...authorityArgs });
    const pages = [home, ...subPages];

    // Per-page extraction so every Evidence row points at the page it came from.
    // Claims and offerings extract concurrently across pages.
    stage = 'extract';
    const [claimPages, offeringPages] = await Promise.all([
      Promise.all(
        pages.map(async (p) => ({
          url: p.url,
          ...(p.durableReceipt ? { crawlDurableReceipt: p.durableReceipt } : {}),
          ...await modelActs.extractClaims({ workspaceId, text: p.text, ...authorityArgs }),
        })),
      ),
      Promise.all(
        pages.map(async (p) => ({
          url: p.url,
          ...(p.durableReceipt ? { crawlDurableReceipt: p.durableReceipt } : {}),
          ...await modelActs.extractOfferings({ workspaceId, text: p.text, ...authorityArgs }),
        })),
      ),
    ]);

    stage = 'persistClaims';
    await dbActs.persistClaims({ workspaceId, companyId, website, pages: claimPages, ...authorityArgs });
    stage = 'persistOfferings';
    await dbActs.persistOfferings({ workspaceId, companyId, website, pages: offeringPages, ...authorityArgs });
    stage = 'persistPublicContacts';
    await dbActs.persistPublicContacts({ workspaceId, companyId, website, pages, ...authorityArgs });
    stage = 'extractProfile';
    await modelActs.extractAndPersistProfile({ workspaceId, companyId, website, text: home.text, ...authorityArgs });
  } catch (error) {
    // 阶段失败（重试用尽、控制错误、超时或取消）不能让画像永远停在 ENRICHING：先把「阶段:错误类型」
    // 回写到 company_profile（状态回 DRAFT）再抛原错误，工作流照旧失败、控制错误照旧可见。只处理
    // Temporal 上报的失败：工作流代码自身的缺陷让工作流任务失败并重试，修好的版本还能接着跑。
    // 收尾（REVIEW）本身失败不在这里补写，免得把已落库的结果说成没有。授权前的旧历史跳过；patch
    // 守卫让旧历史重放时命令序列不变。补写放在不可取消的作用域里；补写失败时以阶段错误为准。
    if (
      error instanceof TemporalFailure &&
      usesAuthority &&
      patched(UNDERSTANDING_FAILURE_RECORD_PATCH)
    ) {
      try {
        await CancellationScope.nonCancellable(() =>
          dbActs.recordUnderstandingFailure({
            workspaceId,
            companyId,
            ...authorityArgs,
            failure: describeUnderstandingFailure(stage, error),
          }),
        );
      } catch {
        /* 阶段错误才是要报告的结果，回写失败不能顶替它 */
      }
    }
    throw error;
  }

  // 5.2.7：理解完成 ≠ 可用。落 REVIEW，等待人工审批（Claim 审批达阈值或显式 confirm）→ ACTIVE。
  await dbActs.setStatus({ companyId, workspaceId, ...authorityArgs, status: 'REVIEW' });
}
