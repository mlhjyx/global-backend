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
import {
  crawlChannel,
  type CrawledRecord,
  type CrawlPageFetcher,
} from "../channels/channel-crawler";
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
  /** PARTIAL = 截断/部分失败但有产出（不参与失败率坏轮，见 channel-run-recorder）。 */
  readonly status: "SUCCEEDED" | "PARTIAL" | "FAILED";
  readonly pagesFetched: number;
  readonly recordsFound: number;
  readonly recordsMaterialized: number;
  readonly failures: number;
  readonly truncated: boolean;
  readonly errorCode?: string;
  // —— CH-6 运行维度 ——
  readonly mode?: "preview" | "run";
  readonly manifestSha256?: string;
  readonly requests?: number;
  readonly durationMs?: number;
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
  /** 记录物化（平台 record 池 upsert）；生产注入 Prisma 版，测试注入假实现。 */
  materializeRecords?: (input: {
    channelId: string;
    crawlRunId: string;
    records: CrawledRecord[];
  }) => Promise<number>;
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
          recordsMaterialized: 0,
          failures: 0,
          truncated: true,
          mode: args.input.mode,
          requests: 0,
        };
      }
      if (!deps.fence || !deps.fetchPage) {
        throw nonRetryable("PLATFORM_EGRESS_FENCE_UNAVAILABLE");
      }
      // CH-6 两段式落账（CP-G7）：运行开始即写 RUNNING 行，逐页更新实际计数——
      // workflow 在失败/取消分支拿不到中间结果，finalize 以本行为准而不是落 0。
      try {
        await deps.prisma.sourceChannelRun.createMany({
          data: [
            {
              channelId: args.input.channelId,
              crawlRunId: args.input.crawlRunId,
              status: "RUNNING",
              mode: args.input.mode,
              startedAt: new Date(now()),
            },
          ],
          skipDuplicates: true,
        });
      } catch {
        throw nonRetryable("CHANNEL_RUN_PROGRESS_UNAVAILABLE");
      }
      const startedAtMs = now();
      let progressRequests = 0;
      const persistProgress = async (): Promise<void> => {
        // 尽力而为：进度写失败不阻断抓取，finalize 仍以最后已知值收敛；GREATEST 保证
        // 活动重试不会把已记录的页数写小。
        try {
          await deps.prisma.$executeRaw`UPDATE "source_channel_run"
              SET "pages_fetched" = GREATEST("pages_fetched", ${progressRequests}),
                  "requests" = GREATEST("requests", ${progressRequests})
            WHERE "crawl_run_id" = ${args.input.crawlRunId}::uuid`;
        } catch {
          // noop
        }
      };
      const platformEgress = channelCrawlEgressDispatcher({
        fence: deps.fence,
        binding,
      });
      const fetchPage: CrawlPageFetcher = async (url) => {
        progressRequests += 1;
        try {
          return await deps.fetchPage!(url, {
            workspaceId: "platform",
            runId: binding.accountKey,
            correlationId: binding.accountKey,
            platformEgress,
            // Declared platform scope: the page HTML is parsed transiently and not
            // persisted as a subjectless PERSONAL_DATA artifact (design 2026-11-06 §4.1).
            transientResultScope: "platform_channel_crawl",
          });
        } finally {
          await persistProgress();
        }
      };
      const result = await crawlChannel(config, fetchPage, { pageCap });
      // 记录物化在活动内完成（记录不进 Temporal 历史）。物化失败按不可重试失败：
      // 活动重试会因围栏拒绝重发已 ACK 的 URL 而拿到空页，重试只会把「已抓未写」伪装成「无记录」。
      let recordsMaterialized = 0;
      if (result.records.length > 0) {
        if (!deps.materializeRecords) {
          throw nonRetryable("CHANNEL_MATERIALIZATION_UNAVAILABLE");
        }
        try {
          recordsMaterialized = await deps.materializeRecords({
            channelId: args.input.channelId,
            crawlRunId: args.input.crawlRunId,
            records: result.records,
          });
        } catch {
          throw nonRetryable("CHANNEL_MATERIALIZATION_FAILED");
        }
      }
      const truncated = result.truncatedByCap || pageCap < args.input.pageCap;
      return {
        // PARTIAL：被页帽/日配额截断但已有产出——运行成功但有边界，不当坏轮。
        status: truncated && result.records.length > 0 ? "PARTIAL" : "SUCCEEDED",
        pagesFetched: result.pagesFetched,
        recordsFound: result.records.length,
        recordsMaterialized,
        failures: result.pageFailures,
        truncated,
        mode: args.input.mode,
        ...(channel.manifestSha256 ? { manifestSha256: channel.manifestSha256 } : {}),
        requests: Math.max(progressRequests, result.pagesFetched),
        durationMs: Math.max(0, now() - startedAtMs),
      };
    },

    async finalizeChannelCrawl(args: {
      readonly input: ChannelCrawlWorkflowInput;
      readonly outcome: ChannelCrawlRunOutcome;
    }): Promise<{ runId: string; autoDisabled: boolean }> {
      assertChannelCrawlWorkflowInput(args.input);
      let outcome = args.outcome;
      if (outcome.status === "FAILED") {
        // CH-6/CP-G7：失败或取消时 workflow 侧没有中间结果——以 RUNNING 两段式行里
        // 已记录的实际页数为准（绝不把「抓了 10 页后失败」落成 0 页、绕过日页帽）。
        try {
          const existing = await deps.prisma.sourceChannelRun.findUnique({
            where: { crawlRunId: args.input.crawlRunId },
            select: { status: true, pagesFetched: true, requests: true },
          });
          if (existing && existing.status === "RUNNING") {
            outcome = {
              ...outcome,
              pagesFetched: Math.max(outcome.pagesFetched, existing.pagesFetched),
              requests: Math.max(outcome.requests ?? 0, existing.requests),
              mode: outcome.mode ?? args.input.mode,
            };
          }
        } catch {
          // 读取失败时保留调用方传入值；finalize 的记账重试会再次收敛。
        }
      }
      const recorded = await deps.recordRun({
        channelId: args.input.channelId,
        crawlRunId: args.input.crawlRunId,
        status: outcome.status,
        pagesFetched: outcome.pagesFetched,
        recordsFound: outcome.recordsFound,
        recordsMaterialized: outcome.recordsMaterialized,
        failures: outcome.failures,
        truncated: outcome.truncated,
        ...(outcome.errorCode ? { errorCode: outcome.errorCode } : {}),
        ...(outcome.mode ? { mode: outcome.mode } : {}),
        ...(outcome.manifestSha256 ? { manifestSha256: outcome.manifestSha256 } : {}),
        ...(outcome.requests === undefined ? {} : { requests: outcome.requests }),
        ...(outcome.durationMs === undefined ? {} : { durationMs: outcome.durationMs }),
      });
      return { runId: recorded.runId, autoDisabled: recorded.autoDisabled };
    },
  };
}
