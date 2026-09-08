import { centsToMicrousd } from "../tools/microusd";
import { loadVerifiedPlatformAuthorityPolicyAsset } from "./platform-authority-policy-asset";
import { PLATFORM_EXECUTION_TECHNICAL_CONTRACT_V1, platformExecutionTechnicalRow, type PlatformExecutionScheduleId } from "./platform-execution-contract";
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
