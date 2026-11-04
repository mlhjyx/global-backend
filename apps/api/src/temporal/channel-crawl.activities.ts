import { ApplicationFailure } from "@temporalio/activity";
import type { PrismaService } from "../prisma/prisma.service";
import type { ToolContext } from "../tools/tool-contract";
import type { BudgetStore } from "../tools/budget-store";
import type { PlatformEgressFence } from "../platform-authority/platform-egress-fence";
import type { PlatformExecutionBudgetAuthorityIngestionService } from "../execution-budget/platform-authority-ingestion.service";
import {
  CHANNEL_DAILY_PAGE_CAP,
  CHANNEL_RUN_MAX_PAGES,
  parseChannelConfig,
} from "../channels/channel-config";
import { crawlChannel, type CrawlPageFetcher } from "../channels/channel-crawler";
import { recordChannelRunInTransaction, type RecordChannelRunInput } from "../channels/channel-run-recorder";
import {
  PlatformCrawlGrantClient,
  type PlatformCrawlGrantClientError,
} from "./platform-crawl-grant.client";
import {
  assertChannelCrawlWorkflowInput,
  parseChannelCrawlBudgetBinding,
  channelCrawlEgressDispatcher,
  type ChannelCrawlBudgetBinding,
  type ChannelCrawlWorkflowInput,
} from "./platform-channel-crawl";

export interface ChannelCrawlRunOutcome {
  readonly status: "SUCCEEDED" | "FAILED";
  readonly pagesFetched: number;
  readonly recordsFound: number;
  readonly failures: number;
  readonly truncated: boolean;
  readonly errorCode?: string;
}

function nonRetryable(code: string): ApplicationFailure {
  return ApplicationFailure.nonRetryable(code, code);
}

function startOfUtcDay(now: number): Date {
  const date = new Date(now);
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
}

/**
 * P4-P4c：渠道抓取活动（平台 worker 进程内）。
 *
 * 顺序固定：admit（mTLS 取 Grant → 验签/摄入开户 → 只读 attest）→ run
 * （日配额截断 → 逐页经 fence 的 crawl 绑定出网）→ finalize（source_channel_run
 * 落账并推进 failure streak）。活动不接收任何可以伪造 authority/账户的参数：
 * 绑定由 admit 返回值携带并被 run/finalize 重新解析校验。
 */
export function createChannelCrawlActivities(deps: {
  prisma: PrismaService;
  /** 平台上下文的运行落账（worker 内以 prisma 事务实现，无租户 RLS）。 */
  recordRun: (input: RecordChannelRunInput) => Promise<{ runId: string; autoDisabled: boolean }>;
  grantClient: PlatformCrawlGrantClient;
  ingestion: PlatformExecutionBudgetAuthorityIngestionService;
  budgetStore: BudgetStore;
  fence?: PlatformEgressFence;
  /** 生产为 Crawl4aiPageFetcher(broker) 的逐页闭包；测试注入假实现。 */
  fetchPage?: (url: string, context: ToolContext) => Promise<{ url: string; html: string } | null>;
  now?: () => number;
}) {
  const now = deps.now ?? Date.now;

  return {
    async admitChannelCrawl(
      input: ChannelCrawlWorkflowInput,
    ): Promise<{ binding: ChannelCrawlBudgetBinding }> {
      assertChannelCrawlWorkflowInput(input);
      let token: string;
      try {
        const grant = await deps.grantClient.requestChannelCrawlGrant({
          channelId: input.channelId,
          mode: input.mode,
          pageCap: String(input.pageCap),
          crawlRunId: input.crawlRunId,
          requestSha256: input.requestSha256,
          technicalPolicyRevision: input.technicalPolicyRevision,
          capPerRunMicrousd: input.capPerRunMicrousd,
          campaignCapMicrousd: input.campaignCapMicrousd,
        });
        token = grant.token;
      } catch (error) {
        const code =
          (error as PlatformCrawlGrantClientError)?.code ??
          "PLATFORM_GRANT_UNAVAILABLE";
        throw nonRetryable(code === "PLATFORM_GRANT_UNAVAILABLE" ? code : "PLATFORM_GRANT_REJECTED");
      }
      let admitted;
      try {
        admitted = await deps.ingestion.ingestChannelCrawlAndAdmit({
          compactJws: token,
          expected: {
            purpose: "platform.channel_crawl",
            subjectType: "source_channel",
            subjectId: input.channelId,
            requestSha256: input.requestSha256,
            crawlRunId: input.crawlRunId,
            technicalPolicyRevision: input.technicalPolicyRevision,
          },
        });
      } catch {
        throw nonRetryable("EXECUTION_BUDGET_VERIFICATION_UNAVAILABLE");
      }
      const binding: ChannelCrawlBudgetBinding = {
        authorityId: admitted.authorityId,
        accountKey: `platform:${input.requestSha256}:${input.crawlRunId}`,
        channelId: input.channelId,
        crawlRunId: input.crawlRunId,
        requestSha256: input.requestSha256,
        technicalPolicyRevision: input.technicalPolicyRevision,
      };
      try {
        await deps.budgetStore.attestAuthorized({
          authorityId: binding.authorityId,
          scopeKey: "platform",
          accountKey: binding.accountKey,
        });
      } catch {
        throw nonRetryable("EXECUTION_BUDGET_VERIFICATION_UNAVAILABLE");
      }
      return { binding };
    },

    async runChannelCrawl(args: {
      readonly input: ChannelCrawlWorkflowInput;
      readonly binding: ChannelCrawlBudgetBinding;
    }): Promise<ChannelCrawlRunOutcome> {
      assertChannelCrawlWorkflowInput(args.input);
      const binding = parseChannelCrawlBudgetBinding(args.binding);
      if (binding.channelId !== args.input.channelId || binding.crawlRunId !== args.input.crawlRunId) {
        throw nonRetryable("CHANNEL_CRAWL_BINDING_INVALID");
      }
      const channel = await deps.prisma.sourceChannel.findUnique({
        where: { id: args.input.channelId },
      });
      if (!channel || channel.mode !== "crawl" || channel.status !== "ENABLED") {
        throw nonRetryable("CHANNEL_NOT_APPROVED");
      }
      let config;
      try {
        config = parseChannelConfig("crawl", channel.config);
      } catch {
        throw nonRetryable("CHANNEL_CONFIG_INVALID");
      }
      if (config.mode !== "crawl") {
        throw nonRetryable("CHANNEL_NOT_CRAWL");
      }
      const used = await deps.prisma.sourceChannelRun.aggregate({
        _sum: { pagesFetched: true },
        where: {
          channelId: args.input.channelId,
          startedAt: { gte: startOfUtcDay(now()) },
        },
      });
      const remaining =
        CHANNEL_DAILY_PAGE_CAP - Number(used._sum.pagesFetched ?? 0);
      const pageCap = Math.max(
        0,
        Math.min(args.input.pageCap, CHANNEL_RUN_MAX_PAGES, remaining),
      );
      if (pageCap === 0) {
        return {
          status: "SUCCEEDED",
          pagesFetched: 0,
          recordsFound: 0,
          failures: 0,
          truncated: true,
        };
      }
      if (!deps.fence || !deps.fetchPage) {
        throw nonRetryable("PLATFORM_EGRESS_FENCE_UNAVAILABLE");
      }
      const platformEgress = channelCrawlEgressDispatcher({
        fence: deps.fence,
        binding,
      });
      const fetchPage: CrawlPageFetcher = (url) =>
        deps.fetchPage!(url, {
          workspaceId: "platform",
          runId: binding.accountKey,
          correlationId: binding.accountKey,
          platformEgress,
        });
      const result = await crawlChannel(config, fetchPage, { pageCap });
      return {
        status: "SUCCEEDED",
        pagesFetched: result.pagesFetched,
        recordsFound: result.records.length,
        failures: result.pageFailures,
        truncated: result.truncatedByCap || pageCap < args.input.pageCap,
      };
    },

    async finalizeChannelCrawl(args: {
      readonly input: ChannelCrawlWorkflowInput;
      readonly outcome: ChannelCrawlRunOutcome;
    }): Promise<{ runId: string; autoDisabled: boolean }> {
      assertChannelCrawlWorkflowInput(args.input);
      const outcome = args.outcome;
      const recorded = await deps.recordRun({
        channelId: args.input.channelId,
        status: outcome.status,
        pagesFetched: outcome.pagesFetched,
        recordsFound: outcome.recordsFound,
        recordsMaterialized: 0,
        failures: outcome.failures,
        truncated: outcome.truncated,
        ...(outcome.errorCode ? { errorCode: outcome.errorCode } : {}),
      });
      return { runId: recorded.runId, autoDisabled: recorded.autoDisabled };
    },
  };
}
