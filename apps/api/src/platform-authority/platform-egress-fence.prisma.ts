import { Injectable, Optional } from "@nestjs/common";
import type { PlatformEgressOperation } from "./platform-egress-operation";
import { CurrentPlatformExecutionPolicy, type CurrentPlatformPolicyProjection } from "./platform-current-policy";

import type { PrismaService } from "../prisma/prisma.service";
import type {
  PlatformEgressAuthorization,
  PlatformEgressBinding,
  PlatformEgressDispatchCapability,
  PlatformEgressFencePort,
} from "./platform-egress-fence.v1";

type AuthorizationRow = Readonly<{
  attempt_id: string;
  generation: bigint;
  replay: boolean;
}>;

type ClaimRow = Readonly<{
  attempt_id: string;
  generation: bigint;
}>;

function one<T>(rows: readonly T[], code: string): T {
  const row = rows[0];
  if (rows.length !== 1 || !row) throw new Error(code);
  return row;
}

function confirmed(rows: unknown, field: string, code: string): void {
  if (
    !Array.isArray(rows) || rows.length !== 1 ||
    rows[0] === null || typeof rows[0] !== "object" ||
    rows[0][field] !== true
  ) {
    throw new Error(code);
  }
}

/**
 * PostgreSQL-backed port for the 4D fence. The port deliberately exposes no
 * table writes: each transition is a migration-owned SECURITY DEFINER function
 * with the platform writer principal and row locks.
 * Each transition recomputes the official policy and asks v2 SQL to lock and
 * compare the durable generation, authority, account and reservation facts.
 * Per-physical-wire splitting still belongs to the transport integration.
 */
@Injectable()
export class PrismaPlatformEgressFencePort implements PlatformEgressFencePort {
  constructor(
    private readonly database: Pick<PrismaService, "$queryRaw">,
    @Optional() private readonly currentPolicy = new CurrentPlatformExecutionPolicy(),
  ) {}

  private async effectivePolicy(
    binding: PlatformEgressBinding,
    operation: PlatformEgressOperation,
  ): Promise<{ effective: PlatformEgressBinding; policy: CurrentPlatformPolicyProjection }> {
    const rows = await this.database.$queryRaw<
      ReadonlyArray<{
        workflow_id: string | null;
        workflow_run_id: string | null;
        schedule_id: string | null;
        schedule_request_sha256: string | null;
        purpose: string;
        technical_policy_revision: string | null;
        cap_per_run_microusd: bigint | null;
      }>
    >`
      SELECT purpose, schedule_id, workflow_id, workflow_run_id,
             schedule_request_sha256, technical_policy_revision, cap_per_run_microusd
      FROM "execution_budget_authority"
      WHERE id = ${binding.authorityId}::uuid
        AND scope_key = 'platform'
        AND authority_kind = 'PLATFORM_GRANT'
    `;
    const row = rows[0];
    if (
      rows.length !== 1 || !row ||
      row.workflow_id !== binding.workflowId ||
      row.workflow_run_id !== binding.workflowRunId || row.schedule_id !== binding.scheduleId ||
      row.schedule_request_sha256 !== binding.scheduleRequestSha256 ||
      binding.accountKey !== `platform:${row.schedule_request_sha256}:${row.workflow_run_id}` ||
      typeof row.technical_policy_revision !== "string" || typeof row.cap_per_run_microusd !== "bigint" ||
      (binding.technicalPolicyRevision !== undefined && binding.technicalPolicyRevision !== row.technical_policy_revision)
    ) {
      throw new Error("PLATFORM_EGRESS_BINDING_INVALID");
    }
    const effective = Object.freeze({
      ...binding,
      technicalPolicyRevision: row.technical_policy_revision,
    });
    const policy = this.currentPolicy.attest({ purpose: row.purpose, scheduleId: binding.scheduleId,
      workflowId: binding.workflowId, workflowRunId: binding.workflowRunId,
      scheduleRequestSha256: binding.scheduleRequestSha256, technicalPolicyRevision: row.technical_policy_revision,
      authorizedCapMicrousd: row.cap_per_run_microusd }, operation.execution, new Date());
    return { effective, policy };
  }

  async authorize(
    binding: PlatformEgressBinding,
    operation: PlatformEgressOperation,
  ): Promise<PlatformEgressAuthorization> {
    const { effective, policy } = await this.effectivePolicy(binding, operation);
    const rows = await this.database.$queryRaw<AuthorizationRow[]>`
      SELECT * FROM authorize_platform_egress_v2(
        ${effective.authorityId}::uuid,
        ${effective.scheduleId}::text,
        ${effective.workflowId}::text,
        ${effective.workflowRunId}::text,
        ${operation.operationKey}::text,
        ${policy.policyRevision}::text,
        ${effective.accountKey}::text, ${operation.budgetOperationId}::uuid,
        ${operation.budgetOperationKey}::text, ${operation.reservedMicrousd}::bigint,
        ${policy.requiredCapMicrousd}::bigint, ${policy.operationReservationMicrousd}::bigint,
        ${policy.policyArtifactSha256}::text, ${policy.executionEnvelopeSha256}::text
      )
    `;
    const row = one(rows, "PLATFORM_EGRESS_AUTHORIZATION_UNAVAILABLE");
    return Object.freeze({ attemptId: row.attempt_id });
  }

  async claimSend(
    binding: PlatformEgressBinding,
    authorization: PlatformEgressAuthorization,
    operation: PlatformEgressOperation,
  ): Promise<PlatformEgressDispatchCapability> {
    const { effective, policy } = await this.effectivePolicy(binding, operation);
    const rows = await this.database.$queryRaw<ClaimRow[]>`
      SELECT * FROM claim_platform_egress_send_v2(
        ${authorization.attemptId}::uuid,
        ${effective.authorityId}::uuid,
        ${effective.scheduleId}::text,
        ${effective.workflowId}::text,
        ${effective.workflowRunId}::text,
        ${operation.operationKey}::text,
        ${policy.policyRevision}::text,
        ${effective.accountKey}::text, ${operation.budgetOperationId}::uuid,
        ${operation.budgetOperationKey}::text, ${operation.reservedMicrousd}::bigint,
        ${policy.requiredCapMicrousd}::bigint, ${policy.operationReservationMicrousd}::bigint,
        ${policy.policyArtifactSha256}::text, ${policy.executionEnvelopeSha256}::text
      )
    `;
    const row = one(rows, "PLATFORM_EGRESS_SEND_CAS_REJECTED");
    let consumed = false;
    return Object.freeze({
      attemptId: row.attempt_id,
      dispatch: async <T>(executePhysicalWire: () => Promise<T>): Promise<T> => {
        if (consumed) throw new Error("PLATFORM_EGRESS_CAPABILITY_REUSED");
        consumed = true;
        return executePhysicalWire();
      },
    });
  }

  async acknowledged(
    attemptId: string,
    meta: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    const digest = typeof meta.digest === "string" ? meta.digest : null;
    const rows = await this.database.$queryRaw`
      SELECT acknowledge_platform_egress_v1(${attemptId}::uuid, ${digest}::text)
    `;
    confirmed(rows, "acknowledge_platform_egress_v1", "PLATFORM_EGRESS_ACK_NOT_CONFIRMED");
  }

  async unknown(
    attemptId: string,
    meta: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    const reason = typeof meta.reason === "string" ? meta.reason : "PHYSICAL_CALL_OR_ACK_UNKNOWN";
    const rows = await this.database.$queryRaw`
      SELECT mark_unknown_platform_egress_v1(${attemptId}::uuid, ${reason}::text)
    `;
    confirmed(rows, "mark_unknown_platform_egress_v1", "PLATFORM_EGRESS_UNKNOWN_NOT_CONFIRMED");
  }
}
