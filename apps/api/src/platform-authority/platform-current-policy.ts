import { centsToMicrousd } from "../tools/microusd";
import {
  loadVerifiedPlatformAuthorityPolicyAsset,
  PLATFORM_CHANNEL_CRAWL_ENVELOPE_SHA256,
} from "./platform-authority-policy-asset";
import {
  PLATFORM_EXECUTION_TECHNICAL_CONTRACT_V1,
  platformExecutionTechnicalRow,
  platformExecutionToolContract,
  type PlatformExecutionScheduleId,
} from "./platform-execution-contract";
import { resolveCurrentPlatformExecutionProviderSnapshotV1 } from "./platform-execution-provider-snapshot";
import { PlatformExecutionTechnicalQuoteService } from "./platform-execution-technical-quote";

export interface PersistedPlatformPolicyAuthority {
  readonly purpose: string;
  readonly scheduleId: string;
  readonly workflowId: string;
  readonly workflowRunId: string;
  readonly scheduleRequestSha256: string;
  readonly technicalPolicyRevision: string;
  readonly authorizedCapMicrousd: bigint;
}
export interface CurrentPlatformPolicyProjection {
  readonly policyRevision: string;
  readonly executionEnvelopeSha256: string;
  readonly policyArtifactSha256: string;
  readonly requiredCapMicrousd: bigint;
  readonly operationReservationMicrousd: bigint;
}
/** Pure recomputation, not a DB generation proof. The SQL send cut must compare
 * these fingerprints under its schedule/account/operation locks on both stages. */
export class CurrentPlatformExecutionPolicy {
  private readonly quotes = new PlatformExecutionTechnicalQuoteService({
    policyAsset: loadVerifiedPlatformAuthorityPolicyAsset(),
    technicalContract: PLATFORM_EXECUTION_TECHNICAL_CONTRACT_V1,
  });
  attest(authority: PersistedPlatformPolicyAuthority,
    execution: { readonly kind: string; readonly toolId?: string; readonly toolVersion?: string },
    now: Date): CurrentPlatformPolicyProjection {
    try {
      const row = platformExecutionTechnicalRow(authority.scheduleId as PlatformExecutionScheduleId);
      // None of the current four closed envelopes authorizes a model operation.
      // No inferred provider/version or model-price fallback is permitted here.
      if (execution.kind !== "tool" || row.costMode === "disabled_no_egress") throw new Error();
      const tool = row.toolContracts.find(candidate => candidate.toolId === execution.toolId && candidate.version === execution.toolVersion);
      if (!tool) throw new Error();
      const quote = this.quotes.quote({ purpose: authority.purpose, scheduleId: row.scheduleId,
        workflowType: row.workflowType, workflowId: authority.workflowId, workflowRunId: authority.workflowRunId,
        scheduleRequestSha256: authority.scheduleRequestSha256, now,
        providerSnapshot: resolveCurrentPlatformExecutionProviderSnapshotV1(row.scheduleId) });
      const cap = BigInt(quote.required_cap_per_run_microusd);
      if (quote.policy_revision !== authority.technicalPolicyRevision || cap !== authority.authorizedCapMicrousd) throw new Error();
      return Object.freeze({ policyRevision: quote.policy_revision,
        executionEnvelopeSha256: quote.execution_envelope_sha256, policyArtifactSha256: quote.policy_artifact_sha256,
        requiredCapMicrousd: cap, operationReservationMicrousd: centsToMicrousd(Number(tool.estimatedCents)) });
    } catch { throw new Error("PLATFORM_EGRESS_CURRENT_POLICY_UNAVAILABLE"); }
  }
}

/** P4-P4：渠道抓取 Grant 的运行期策略投影（与 schedule 投影并列，互不复用）。 */
export interface PersistedPlatformChannelCrawlAuthority {
  readonly purpose: string;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly requestSha256: string;
  readonly crawlRunId: string;
  readonly technicalPolicyRevision: string;
  readonly authorizedCapMicrousd: bigint;
}

const CRAWL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CRAWL_SHA256 = /^[0-9a-f]{64}$/;

export class CurrentPlatformChannelCrawlPolicy {
  private readonly policyAsset = loadVerifiedPlatformAuthorityPolicyAsset();

  attest(
    authority: PersistedPlatformChannelCrawlAuthority,
    execution: { readonly kind: string; readonly toolId?: string; readonly toolVersion?: string },
  ): CurrentPlatformPolicyProjection {
    try {
      if (
        authority.purpose !== "platform.channel_crawl" ||
        authority.subjectType !== "source_channel" ||
        !CRAWL_UUID.test(authority.subjectId) ||
        !CRAWL_UUID.test(authority.crawlRunId) ||
        !CRAWL_SHA256.test(authority.requestSha256) ||
        authority.technicalPolicyRevision !==
          PLATFORM_CHANNEL_CRAWL_ENVELOPE_SHA256 ||
        authority.authorizedCapMicrousd <= 0n
      ) {
        throw new Error();
      }
      const tool = platformExecutionToolContract("crawl4ai.render");
      if (
        execution.kind !== "tool" ||
        execution.toolId !== tool.toolId ||
        execution.toolVersion !== tool.version
      ) {
        throw new Error();
      }
      return Object.freeze({
        policyRevision: PLATFORM_CHANNEL_CRAWL_ENVELOPE_SHA256,
        executionEnvelopeSha256: PLATFORM_CHANNEL_CRAWL_ENVELOPE_SHA256,
        policyArtifactSha256: this.policyAsset.sha256,
        requiredCapMicrousd: authority.authorizedCapMicrousd,
        operationReservationMicrousd: centsToMicrousd(Number(tool.estimatedCents)),
      });
    } catch {
      throw new Error("PLATFORM_EGRESS_CURRENT_POLICY_UNAVAILABLE");
    }
  }
}
