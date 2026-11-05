import {
  ApplicationFailure,
  CancellationScope,
  isCancellation,
  proxyActivities,
} from "@temporalio/workflow";
import type { createChannelCrawlActivities, ChannelCrawlRunOutcome } from "./channel-crawl.activities";
import type { ChannelCrawlWorkflowInput } from "./platform-channel-crawl";

const acts = proxyActivities<ReturnType<typeof createChannelCrawlActivities>>({
  startToCloseTimeout: "10 minutes",
  retry: { maximumAttempts: 3 },
});

function failureCode(error: unknown): string {
  if (error instanceof ApplicationFailure) {
    const message = error.message;
    return typeof message === "string" && /^[A-Z][A-Z0-9_]{2,63}$/u.test(message)
      ? message
      : "CHANNEL_CRAWL_FAILED";
  }
  return "CHANNEL_CRAWL_FAILED";
}

/**
 * P4-P4c：一次渠道抓取运行。admit → run → finalize 三段固定；
 * 取消或失败都先落 source_channel_run 再结束（取消走 nonCancellable）。
 */
export async function channelCrawlWorkflow(
  input: ChannelCrawlWorkflowInput,
): Promise<{ status: "SUCCEEDED" | "FAILED" | "CANCELLED"; pagesFetched: number }> {
  const admitted = await acts.admitChannelCrawl(input);
  let outcome: ChannelCrawlRunOutcome;
  try {
    outcome = await acts.runChannelCrawl({ input, binding: admitted.binding });
  } catch (error) {
    if (isCancellation(error)) {
      await CancellationScope.nonCancellable(() =>
        acts.finalizeChannelCrawl({
          input,
          outcome: {
            status: "FAILED",
            pagesFetched: 0,
            recordsFound: 0,
            failures: 0,
            truncated: false,
            errorCode: "CHANNEL_CRAWL_CANCELLED",
          },
        }),
      );
      return { status: "CANCELLED", pagesFetched: 0 };
    }
    const code = failureCode(error);
    await acts.finalizeChannelCrawl({
      input,
      outcome: {
        status: "FAILED",
        pagesFetched: 0,
        recordsFound: 0,
        failures: 0,
        truncated: false,
        errorCode: code,
      },
    });
    return { status: "FAILED", pagesFetched: 0 };
  }
  await acts.finalizeChannelCrawl({ input, outcome });
  return { status: "SUCCEEDED", pagesFetched: outcome.pagesFetched };
}
