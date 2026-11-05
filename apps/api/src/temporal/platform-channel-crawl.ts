import type {
  PlatformEgressBinding,
  PlatformEgressFence,
} from "../platform-authority/platform-egress-fence";
import type { PlatformEgressOperation } from "../platform-authority/platform-egress-operation";

/** P4-P4c：渠道抓取运行的工作流契约与围栏绑定（schedule 之外的第二形状）。 */

export const CHANNEL_CRAWL_CONTRACT_VERSION = 1 as const;
export const CHANNEL_CRAWL_WORKFLOW_TYPE = "channelCrawlWorkflow" as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const DECIMAL = /^[1-9][0-9]*$/;
const MODES = ["preview", "run"] as const;

export type ChannelCrawlMode = (typeof MODES)[number];

export interface ChannelCrawlWorkflowInput {
  readonly executionContractVersion: typeof CHANNEL_CRAWL_CONTRACT_VERSION;
  readonly channelId: string;
  readonly crawlRunId: string;
  readonly mode: ChannelCrawlMode;
  readonly pageCap: number;
  readonly requestSha256: string;
  readonly technicalPolicyRevision: string;
  readonly capPerRunMicrousd: string;
  readonly campaignCapMicrousd: string;
}

export interface ChannelCrawlBudgetBinding {
  readonly authorityId: string;
  readonly accountKey: string;
  readonly channelId: string;
  readonly crawlRunId: string;
  readonly requestSha256: string;
  readonly technicalPolicyRevision: string;
}

export function assertChannelCrawlWorkflowInput(
  value: unknown,
): asserts value is ChannelCrawlWorkflowInput {
  const input = value as Partial<ChannelCrawlWorkflowInput> | null;
  if (
    !input ||
    input.executionContractVersion !== CHANNEL_CRAWL_CONTRACT_VERSION ||
    typeof input.channelId !== "string" ||
    !UUID.test(input.channelId) ||
    typeof input.crawlRunId !== "string" ||
    !UUID.test(input.crawlRunId) ||
    (input.mode !== "preview" && input.mode !== "run") ||
    typeof input.pageCap !== "number" ||
    !Number.isSafeInteger(input.pageCap) ||
    input.pageCap < 1 ||
    input.pageCap > 50 ||
    (input.mode === "preview" && input.pageCap !== 1) ||
    typeof input.requestSha256 !== "string" ||
    !SHA256.test(input.requestSha256) ||
    typeof input.technicalPolicyRevision !== "string" ||
    !SHA256.test(input.technicalPolicyRevision) ||
    typeof input.capPerRunMicrousd !== "string" ||
    !DECIMAL.test(input.capPerRunMicrousd) ||
    typeof input.campaignCapMicrousd !== "string" ||
    !DECIMAL.test(input.campaignCapMicrousd)
  ) {
    throw new Error("CHANNEL_CRAWL_INPUT_INVALID");
  }
}

export function parseChannelCrawlBudgetBinding(
  value: unknown,
): ChannelCrawlBudgetBinding {
  const binding = value as Partial<ChannelCrawlBudgetBinding> | null;
  if (
    !binding ||
    typeof binding.authorityId !== "string" ||
    !UUID.test(binding.authorityId) ||
    typeof binding.accountKey !== "string" ||
    binding.accountKey.length < 1 ||
    binding.accountKey.length > 200 ||
    typeof binding.channelId !== "string" ||
    !UUID.test(binding.channelId) ||
    typeof binding.crawlRunId !== "string" ||
    !UUID.test(binding.crawlRunId) ||
    typeof binding.requestSha256 !== "string" ||
    !SHA256.test(binding.requestSha256) ||
    typeof binding.technicalPolicyRevision !== "string" ||
    !SHA256.test(binding.technicalPolicyRevision) ||
    binding.accountKey !==
      `platform:${binding.requestSha256}:${binding.crawlRunId}`
  ) {
    throw new Error("CHANNEL_CRAWL_BINDING_INVALID");
  }
  return Object.freeze({ ...binding }) as ChannelCrawlBudgetBinding;
}

export function channelCrawlEgressBinding(
  binding: ChannelCrawlBudgetBinding,
): PlatformEgressBinding {
  return {
    subjectKind: "source_channel",
    authorityId: binding.authorityId,
    channelId: binding.channelId,
    crawlRunId: binding.crawlRunId,
    requestSha256: binding.requestSha256,
    technicalPolicyRevision: binding.technicalPolicyRevision,
    accountKey: binding.accountKey,
  };
}

/** 与 platformEgressDispatcher 同形，但绑定的是 crawl 形状。 */
export function channelCrawlEgressDispatcher(input: {
  readonly fence: PlatformEgressFence;
  readonly binding: ChannelCrawlBudgetBinding;
}): {
  authorizeAndDispatch: <T>(
    operation: PlatformEgressOperation,
    executePhysicalWire: () => Promise<T>,
  ) => Promise<T>;
} {
  const binding = channelCrawlEgressBinding(input.binding);
  return {
    authorizeAndDispatch: (operation, executePhysicalWire) =>
      input.fence.authorizeAndDispatchPlatformEgress(
        binding,
        operation,
        executePhysicalWire,
      ),
  };
}
