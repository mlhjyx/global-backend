import { proxyActivities } from '@temporalio/workflow';
import type { UnderstandingActivities } from './understanding.activities';

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
  await dbActs.setStatus({ companyId, workspaceId, status: 'ENRICHING' });

  const home = await crawlActs.crawlWebsite(website);
  const subUrls = await dbActs.selectSubpages({ markdown: home.text, website });
  const { pages: subPages } = await crawlActs.crawlPages(subUrls);
  const pages = [home, ...subPages];

  // Per-page extraction so every Evidence row points at the page it came from.
  // Claims and offerings extract concurrently across pages.
  const [claimPages, offeringPages] = await Promise.all([
    Promise.all(
      pages.map(async (p) => ({
        url: p.url,
        claims: (await modelActs.extractClaims({ workspaceId, text: p.text })).claims,
      })),
    ),
    Promise.all(
      pages.map(async (p) => ({
        url: p.url,
        offerings: (await modelActs.extractOfferings({ workspaceId, text: p.text })).offerings,
      })),
    ),
  ]);

  await dbActs.persistClaims({ workspaceId, companyId, website, pages: claimPages });
  await dbActs.persistOfferings({ workspaceId, companyId, website, pages: offeringPages });
  await dbActs.persistPublicContacts({ workspaceId, companyId, website, pages });

  await dbActs.setStatus({ companyId, workspaceId, status: 'ACTIVE' });
}
