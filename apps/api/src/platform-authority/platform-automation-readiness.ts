import type { RuntimeComponentStatus } from "../runtime/runtime-readiness-registry";
import type { VerifiedPlatformAuthorityPolicyAsset } from "./platform-authority-policy-asset";
import type {
  PlatformExecutionScheduleId,
  PlatformExecutionTechnicalContractV1,
  PlatformExecutionTechnicalRowV1,
} from "./platform-execution-contract";

export const PLATFORM_AUTOMATION_READINESS_STATES = Object.freeze([
  "ISSUABLE",
  "INTENTIONALLY_DISABLED_NO_EGRESS",
  "QUOTE_UNAVAILABLE",
  "TEMPORAL_PROOF_UNAVAILABLE",
  "ISSUER_UNAVAILABLE",
  "WRITER_UNAVAILABLE",
  "REVOCATION_DELIVERY_UNAVAILABLE",
  "POLICY_DRIFT",
  "BLOCKED",
] as const);

export type PlatformAutomationReadinessState =
  (typeof PLATFORM_AUTOMATION_READINESS_STATES)[number];
export type PlatformAutomationDesiredMode =
  "ENABLED" | "INTENTIONALLY_DISABLED_NO_EGRESS";
export type PlatformAutomationExternalReadinessFact =
  "temporal_proof" | "issuer" | "revocation_delivery";

export interface PlatformAutomationReadinessIdentity {
  readonly temporalNamespace: "platform-automation";
  readonly scheduleId: PlatformExecutionScheduleId;
  readonly purpose:
    "platform.acquisition" | "platform.intent_watch" | "platform.sanctions";
  readonly workflowType: string;
  readonly taskQueue: "understanding";
}

export interface PlatformAutomationReadinessRow {
  readonly identity: PlatformAutomationReadinessIdentity;
  readonly desiredMode: PlatformAutomationDesiredMode;
  readonly state: PlatformAutomationReadinessState;
  readonly code: string;
}

export interface PlatformAutomationReadinessReport {
  readonly status: "ready" | "not_ready";
  readonly rows: readonly PlatformAutomationReadinessRow[];
}

export function platformAutomationReadinessFactName(
  fact: PlatformAutomationExternalReadinessFact,
  scheduleId: PlatformExecutionScheduleId,
): string {
  return `platform_${scheduleId.replaceAll("-", "_")}_${fact}`;
}

export type PlatformAutomationReadinessProbe = (
  identity: PlatformAutomationReadinessIdentity,
) => RuntimeComponentStatus | Promise<RuntimeComponentStatus>;

export interface PlatformAutomationReadinessDependencies {
  readonly technicalContract: PlatformExecutionTechnicalContractV1;
  readonly policyAsset: VerifiedPlatformAuthorityPolicyAsset;
  readonly quote: PlatformAutomationReadinessProbe;
  readonly temporalProof: PlatformAutomationReadinessProbe;
  readonly issuer: PlatformAutomationReadinessProbe;
  readonly writer: PlatformAutomationReadinessProbe;
  readonly revocationDelivery: PlatformAutomationReadinessProbe;
  readonly egressFence: PlatformAutomationReadinessProbe;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function identity(row: PlatformExecutionTechnicalRowV1) {
  return deepFreeze({
    temporalNamespace: row.temporalNamespace,
    scheduleId: row.scheduleId,
    purpose: row.purpose,
    workflowType: row.workflowType,
    taskQueue: row.taskQueue,
  } as PlatformAutomationReadinessIdentity);
}

function code(
  scheduleId: PlatformExecutionScheduleId,
  state: PlatformAutomationReadinessState,
): string {
  return `PLATFORM_AUTOMATION_${scheduleId.replaceAll("-", "_").toUpperCase()}_${state}`;
}

function rowResult(
  rowIdentity: PlatformAutomationReadinessIdentity,
  desiredMode: PlatformAutomationDesiredMode,
  state: PlatformAutomationReadinessState,
): PlatformAutomationReadinessRow {
  return deepFreeze({
    identity: rowIdentity,
    desiredMode,
    state,
    code: code(rowIdentity.scheduleId, state),
  });
}

function policyRowMatches(
  technical: PlatformExecutionTechnicalRowV1,
  policy: VerifiedPlatformAuthorityPolicyAsset["policy"]["rows"][number],
): boolean {
  return (
    policy.row_id === technical.rowId &&
    policy.purpose === technical.purpose &&
    policy.temporal_namespace === technical.temporalNamespace &&
    policy.schedule_id === technical.scheduleId &&
    policy.workflow_type === technical.workflowType &&
    policy.task_queue === technical.taskQueue &&
    policy.schedule_request_sha256 === technical.scheduleRequestSha256 &&
    policy.default_issuance_state === "DENIED" &&
    (policy.desired_mode === "INTENTIONALLY_DISABLED_NO_EGRESS"
      ? technical.costMode === "disabled_no_egress" &&
        technical.physicalWireSelection === "disabled_no_egress" &&
        technical.hardBounds.maximumPhysicalInvocations === "0" &&
        technical.providerRequirements.every(
          (provider) => provider.requiredEnablement === "DISABLED",
        )
      : technical.costMode !== "disabled_no_egress" &&
        technical.physicalWireSelection !== "disabled_no_egress")
  );
}

async function probeReady(
  probe: PlatformAutomationReadinessProbe,
  rowIdentity: PlatformAutomationReadinessIdentity,
): Promise<boolean> {
  try {
    return (await probe(rowIdentity)).status === "ok";
  } catch {
    return false;
  }
}

/**
 * JIT platform grants do not need to exist before a run. Readiness therefore
 * proves that each exact Schedule identity can issue and admit a fresh grant,
 * or that the one approved disabled row is deterministically no-egress.
 */
export class PlatformAutomationReadinessService {
  constructor(
    private readonly dependencies: PlatformAutomationReadinessDependencies,
  ) {}

  async inspect(): Promise<PlatformAutomationReadinessReport> {
    const rows: PlatformAutomationReadinessRow[] = [];
    const policyRows = this.dependencies.policyAsset.policy.rows;

    for (const technical of this.dependencies.technicalContract.rows) {
      const rowIdentity = identity(technical);
      const policy = policyRows.find(
        (candidate) => candidate.schedule_id === technical.scheduleId,
      );
      const desiredMode =
        policy?.desired_mode ?? ("ENABLED" as PlatformAutomationDesiredMode);

      if (!policy || !policyRowMatches(technical, policy)) {
        rows.push(rowResult(rowIdentity, desiredMode, "POLICY_DRIFT"));
        continue;
      }
      if (desiredMode === "INTENTIONALLY_DISABLED_NO_EGRESS") {
        rows.push(
          rowResult(
            rowIdentity,
            desiredMode,
            "INTENTIONALLY_DISABLED_NO_EGRESS",
          ),
        );
        continue;
      }
      if (!(await probeReady(this.dependencies.quote, rowIdentity))) {
        rows.push(rowResult(rowIdentity, desiredMode, "QUOTE_UNAVAILABLE"));
        continue;
      }
      if (!(await probeReady(this.dependencies.temporalProof, rowIdentity))) {
        rows.push(
          rowResult(rowIdentity, desiredMode, "TEMPORAL_PROOF_UNAVAILABLE"),
        );
        continue;
      }
      if (!(await probeReady(this.dependencies.issuer, rowIdentity))) {
        rows.push(rowResult(rowIdentity, desiredMode, "ISSUER_UNAVAILABLE"));
        continue;
      }
      if (!(await probeReady(this.dependencies.writer, rowIdentity))) {
        rows.push(rowResult(rowIdentity, desiredMode, "WRITER_UNAVAILABLE"));
        continue;
      }
      if (
        !(await probeReady(this.dependencies.revocationDelivery, rowIdentity))
      ) {
        rows.push(
          rowResult(
            rowIdentity,
            desiredMode,
            "REVOCATION_DELIVERY_UNAVAILABLE",
          ),
        );
        continue;
      }
      if (!(await probeReady(this.dependencies.egressFence, rowIdentity))) {
        rows.push(rowResult(rowIdentity, desiredMode, "BLOCKED"));
        continue;
      }
      rows.push(rowResult(rowIdentity, desiredMode, "ISSUABLE"));
    }

    const expectedRows = this.dependencies.technicalContract.rows.length === 4;
    const policyShape =
      policyRows.length === 4 &&
      policyRows.every(
        (policy, index) =>
          policy.schedule_id ===
          this.dependencies.technicalContract.rows[index]?.scheduleId,
      );
    const ready =
      expectedRows &&
      policyShape &&
      rows.every((row) =>
        row.desiredMode === "ENABLED"
          ? row.state === "ISSUABLE"
          : row.state === "INTENTIONALLY_DISABLED_NO_EGRESS",
      );
    return deepFreeze({ status: ready ? "ready" : "not_ready", rows });
  }
}
