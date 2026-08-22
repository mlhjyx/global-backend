import { ApplicationFailure, patched, proxyActivities } from '@temporalio/workflow';
import type { UnderstandingActivities } from './understanding.activities';
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
const modelActs = proxyActivities<UnderstandingActivities>({
  startToCloseTimeout: '3 minutes',
  retry: { maximumAttempts: 3 },
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
 * deterministic public-contact extraction → ACTIVE.
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

  const home = await crawlActs.crawlWebsite({ workspaceId, website, ...authorityArgs });
  const subUrls = await dbActs.selectSubpages({
    markdown: home.text,
    website,
    ...(usesAuthority ? { workspaceId, ...authorityArgs } : {}),
  });
  const { pages: subPages } = await crawlActs.crawlPages({ workspaceId, urls: subUrls, ...authorityArgs });
  const pages = [home, ...subPages];

  // Per-page extraction so every Evidence row points at the page it came from.
  // Claims and offerings extract concurrently across pages.
  const [claimPages, offeringPages] = await Promise.all([
    Promise.all(
      pages.map(async (p) => ({
        url: p.url,
        claims: (await modelActs.extractClaims({ workspaceId, text: p.text, ...authorityArgs })).claims,
      })),
    ),
    Promise.all(
      pages.map(async (p) => ({
        url: p.url,
        offerings: (await modelActs.extractOfferings({ workspaceId, text: p.text, ...authorityArgs })).offerings,
      })),
    ),
  ]);

  await dbActs.persistClaims({ workspaceId, companyId, website, pages: claimPages, ...authorityArgs });
  await dbActs.persistOfferings({ workspaceId, companyId, website, pages: offeringPages, ...authorityArgs });
  await dbActs.persistPublicContacts({ workspaceId, companyId, website, pages, ...authorityArgs });
  await modelActs.extractAndPersistProfile({ workspaceId, companyId, website, text: home.text, ...authorityArgs });

  // 5.2.7：理解完成 ≠ 可用。落 REVIEW，等待人工审批（Claim 审批达阈值或显式 confirm）→ ACTIVE。
  await dbActs.setStatus({ companyId, workspaceId, ...authorityArgs, status: 'REVIEW' });
}
