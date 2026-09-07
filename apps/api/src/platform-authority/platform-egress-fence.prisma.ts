import { Injectable } from "@nestjs/common";

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
  if (!row) throw new Error(code);
  return row;
}

/**
 * PostgreSQL-backed port for the 4D fence. The port deliberately exposes no
 * table writes: each transition is a migration-owned SECURITY DEFINER function
 * with the platform writer principal and row locks.
 */
@Injectable()
export class PrismaPlatformEgressFencePort implements PlatformEgressFencePort {
  constructor(
    private readonly database: Pick<PrismaService, "$queryRaw">,
  ) {}

  private async effectiveBinding(
    binding: PlatformEgressBinding,
  ): Promise<PlatformEgressBinding> {
    if (binding.technicalPolicyRevision) return binding;
    const rows = await this.database.$queryRaw<
      ReadonlyArray<{
        workflow_id: string | null;
        technical_policy_revision: string | null;
      }>
    >`
      SELECT workflow_id, technical_policy_revision
      FROM "execution_budget_authority"
      WHERE id = ${binding.authorityId}::uuid
        AND scope_key = 'platform'
        AND authority_kind = 'PLATFORM_GRANT'
    `;
    const row = rows[0];
    if (
      !row ||
      row.workflow_id !== binding.workflowId ||
      typeof row.technical_policy_revision !== "string"
    ) {
      throw new Error("PLATFORM_EGRESS_BINDING_INVALID");
    }
    return Object.freeze({
      ...binding,
      technicalPolicyRevision: row.technical_policy_revision,
    });
  }

  async authorize(
    binding: PlatformEgressBinding,
    operationKey: string,
  ): Promise<PlatformEgressAuthorization> {
    const effective = await this.effectiveBinding(binding);
    const rows = await this.database.$queryRaw<AuthorizationRow[]>`
      SELECT * FROM authorize_platform_egress_v1(
        ${effective.authorityId}::uuid,
        ${effective.scheduleId}::text,
        ${effective.workflowId}::text,
        ${effective.workflowRunId}::text,
        ${operationKey}::text,
        ${effective.technicalPolicyRevision}::text
      )
    `;
    const row = one(rows, "PLATFORM_EGRESS_AUTHORIZATION_UNAVAILABLE");
    return Object.freeze({ attemptId: row.attempt_id });
  }

  async claimSend(
    binding: PlatformEgressBinding,
    authorization: PlatformEgressAuthorization,
    operationKey: string,
  ): Promise<PlatformEgressDispatchCapability> {
    const effective = await this.effectiveBinding(binding);
    const rows = await this.database.$queryRaw<ClaimRow[]>`
      SELECT * FROM claim_platform_egress_send_v1(
        ${authorization.attemptId}::uuid,
        ${effective.authorityId}::uuid,
        ${effective.scheduleId}::text,
        ${effective.workflowId}::text,
        ${effective.workflowRunId}::text,
        ${operationKey}::text,
        ${effective.technicalPolicyRevision}::text
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
    await this.database.$queryRaw`
      SELECT acknowledge_platform_egress_v1(${attemptId}::uuid, ${digest}::text)
    `;
  }

  async unknown(
    attemptId: string,
    meta: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    const reason = typeof meta.reason === "string" ? meta.reason : "PHYSICAL_CALL_OR_ACK_UNKNOWN";
    await this.database.$queryRaw`
      SELECT mark_unknown_platform_egress_v1(${attemptId}::uuid, ${reason}::text)
    `;
  }
}
