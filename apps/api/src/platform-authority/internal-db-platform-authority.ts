import { createHash, randomUUID } from "node:crypto";
import { ExecutionBudgetGrantError } from "../execution-budget/execution-budget-authority.types";
import { ExecutionControlError } from "../execution-budget/execution-control-error";
import { BYPASS_TECHNICAL_CAP_MICROUSD } from "../execution-budget/legacy-execution-budget-mode";
import type {
  BudgetAccountAuthorization,
  BudgetStore,
} from "../tools/budget-store";
import { loadVerifiedPlatformAuthorityPolicyAsset } from "./platform-authority-policy-asset";
import {
  PlatformAutomationReadinessService,
  type PlatformAutomationReadinessReport,
} from "./platform-automation-readiness";
import { PLATFORM_EXECUTION_TECHNICAL_CONTRACT_V1 } from "./platform-execution-contract";
import {
  PlatformEgressFenceError,
  type PlatformEgressAuthorization,
  type PlatformEgressBinding,
  type PlatformEgressDispatchCapability,
  type PlatformEgressFencePort,
} from "./platform-egress-fence.v1";
import type { PlatformEgressOperation } from "./platform-egress-operation";
import {
  isCanonicalPlatformScheduleId,
  type PlatformScheduleConfigService,
} from "./platform-schedule-config.service";

export const PLATFORM_SCHEDULE_DISABLED_BY_KILL_SWITCH =
  "PLATFORM_EGRESS_SCHEDULE_DISABLED_BY_KILL_SWITCH" as const;

export class PlatformScheduleKillSwitchError extends ExecutionControlError {
  constructor() {
    super(PLATFORM_SCHEDULE_DISABLED_BY_KILL_SWITCH);
    this.name = "PlatformScheduleKillSwitchError";
  }
}

function deterministicUuid(seed: string): string {
  const digest = createHash("sha256").update(seed, "utf8").digest();
  // RFC 4122 version 5 / variant 1 bit layout so strict UUID regexes accept it.
  digest[6] = (digest[6]! & 0x0f) | 0x50;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Computes the exact `PlatformAutomationReadinessReport` shape in
 * `PLATFORM_AUTHORITY_MODE=internal_db` without requiring 7-day
 * `deployment-binding.json`, 5 RSA keyrings, or R4 JWKS polling.
 *
 * Fails closed (`WRITER_UNAVAILABLE` / `not_ready`) if `platform_schedule_config`
 * is missing or unreachable in PostgreSQL.
 */
export async function inspectInternalDbPlatformAuthorityReadiness(
  configService: Pick<PlatformScheduleConfigService, "assertHealthy"> | undefined,
): Promise<PlatformAutomationReadinessReport> {
  const policyAsset = loadVerifiedPlatformAuthorityPolicyAsset();
  const ok = async () => ({ status: "ok" as const });
  const dbReady = async () => {
    if (!configService) {
      return {
        status: "failed" as const,
        code: "PLATFORM_SCHEDULE_CONFIG_UNAVAILABLE",
      };
    }
    try {
      await configService.assertHealthy();
      return { status: "ok" as const };
    } catch {
      return {
        status: "failed" as const,
        code: "PLATFORM_SCHEDULE_CONFIG_UNAVAILABLE",
      };
    }
  };

  return new PlatformAutomationReadinessService({
    technicalContract: PLATFORM_EXECUTION_TECHNICAL_CONTRACT_V1,
    policyAsset,
    quote: ok,
    temporalProof: ok,
    issuer: ok,
    writer: dbReady,
    revocationDelivery: ok,
    egressFence: dbReady,
  }).inspect();
}

export interface InternalDbScheduleAdmissionScope {
  readonly scheduleId: string;
  readonly purpose: string;
  readonly requestSha256: string;
}

/**
 * Lightweight `PlatformRunAdmissionPort` implementation for
 * `PLATFORM_AUTHORITY_MODE=internal_db`.
 *
 * Admits a platform schedule run iff `platform_schedule_config.enabled === true`
 * in PostgreSQL; throws non-retryable `PLATFORM_SCHEDULE_DISABLED_BY_KILL_SWITCH`
 * otherwise. Zero RS256 Grant round-trips, zero 7-day binding files.
 */
export class InternalDbPlatformScheduleAdmission {
  constructor(
    private readonly configService: Pick<
      PlatformScheduleConfigService,
      "isEnabled"
    >,
  ) {}

  async admit(input: {
    readonly executionScope: InternalDbScheduleAdmissionScope;
    readonly workflowId: string;
    readonly workflowRunId: string;
  }): Promise<{ readonly authorityId: string; readonly replay: boolean }> {
    const scheduleId = input.executionScope.scheduleId;
    if (!isCanonicalPlatformScheduleId(scheduleId)) {
      throw new ExecutionBudgetGrantError("EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH");
    }
    let enabled: boolean;
    try {
      enabled = await this.configService.isEnabled(scheduleId);
    } catch {
      throw new ExecutionBudgetGrantError(
        "EXECUTION_BUDGET_VERIFICATION_UNAVAILABLE",
      );
    }
    if (!enabled) {
      throw new PlatformScheduleKillSwitchError();
    }
    const authorityId = deterministicUuid(
      `internal_db:${scheduleId}:${input.workflowId}:${input.workflowRunId}`,
    );
    return { authorityId, replay: false };
  }
}

/**
 * Database-backed Kill Switch egress fence port for
 * `PLATFORM_AUTHORITY_MODE=internal_db`.
 *
 * Re-checks `platform_schedule_config.enabled === true` before EVERY physical
 * wire dispatch (`authorize` and `claimSend`), so flipping a schedule off in DB
 * stops outbound calls immediately even mid-run.
 */
export class InternalDbPlatformEgressFencePort
  implements PlatformEgressFencePort
{
  constructor(
    private readonly configService: Pick<
      PlatformScheduleConfigService,
      "isEnabled"
    >,
  ) {}

  private async assertScheduleEnabled(binding: PlatformEgressBinding): Promise<void> {
    if (binding.subjectKind === "source_channel") {
      return;
    }
    let enabled: boolean;
    try {
      enabled = await this.configService.isEnabled(binding.scheduleId);
    } catch {
      throw new PlatformEgressFenceError("PLATFORM_EGRESS_FENCE_UNAVAILABLE");
    }
    if (!enabled) {
      throw new PlatformEgressFenceError(
        PLATFORM_SCHEDULE_DISABLED_BY_KILL_SWITCH,
      );
    }
  }

  async authorize(
    binding: PlatformEgressBinding,
    _operation: PlatformEgressOperation,
  ): Promise<PlatformEgressAuthorization> {
    await this.assertScheduleEnabled(binding);
    return { attemptId: randomUUID() };
  }

  async claimSend(
    binding: PlatformEgressBinding,
    authorization: PlatformEgressAuthorization,
    _operation: PlatformEgressOperation,
  ): Promise<PlatformEgressDispatchCapability> {
    await this.assertScheduleEnabled(binding);
    let dispatched = false;
    return {
      attemptId: authorization.attemptId,
      dispatch: async <T>(executePhysicalWire: () => Promise<T>): Promise<T> => {
        if (dispatched) {
          throw new PlatformEgressFenceError("PLATFORM_EGRESS_SEND_CAS_REJECTED");
        }
        dispatched = true;
        return executePhysicalWire();
      },
    };
  }

  async acknowledged(
    _attemptId: string,
    _meta: Readonly<Record<string, unknown>>,
  ): Promise<void> {}

  async unknown(
    _attemptId: string,
    _meta: Readonly<Record<string, unknown>>,
  ): Promise<void> {}

  async acknowledgedChannelCrawl(
    _attemptId: string,
    _meta: Readonly<Record<string, unknown>>,
  ): Promise<void> {}

  async unknownChannelCrawl(
    _attemptId: string,
    _meta: Readonly<Record<string, unknown>>,
  ): Promise<void> {}
}

/**
 * Stateless platform `BudgetStore` for `PLATFORM_AUTHORITY_MODE=internal_db`.
 *
 * Avoids RS256 `ExecutionBudgetAuthority` / `ToolBudgetAccount` DB rows while
 * still enforcing the DB Kill Switch via `platform_schedule_config` on every
 * schedule open / activity attestation / reservation.
 */
export function createInternalDbPlatformBudgetStore(
  configService: Pick<PlatformScheduleConfigService, "isEnabled">,
): BudgetStore {
  const hashToSchedule = new Map<string, string>(
    PLATFORM_EXECUTION_TECHNICAL_CONTRACT_V1.rows.map((row) => [
      row.scheduleRequestSha256,
      row.scheduleId,
    ]),
  );

  async function assertAccountEnabled(
    accountKey: string,
  ): Promise<void> {
    const parts = accountKey.split(":");
    const requestSha256 =
      parts.length >= 3 && parts[0] === "platform" ? parts[1] : undefined;
    const scheduleId = requestSha256
      ? hashToSchedule.get(requestSha256)
      : undefined;
    if (!scheduleId) {
      throw new ExecutionBudgetGrantError("EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH");
    }
    let enabled: boolean;
    try {
      enabled = await configService.isEnabled(scheduleId);
    } catch {
      throw new ExecutionBudgetGrantError(
        "EXECUTION_BUDGET_VERIFICATION_UNAVAILABLE",
      );
    }
    if (!enabled) {
      throw new PlatformScheduleKillSwitchError();
    }
  }

  function authorization(authorityId: string): BudgetAccountAuthorization {
    return Object.freeze({
      accountId: randomUUID(),
      authorityId,
      authorizedCapMicrousd: BYPASS_TECHNICAL_CAP_MICROUSD,
      generation: 1,
    });
  }

  return {
    async open(input) {
      if (input.scopeKey !== "platform") {
        throw new ExecutionBudgetGrantError("EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH");
      }
      await assertAccountEnabled(input.accountKey);
      return authorization(input.authorityId);
    },
    async attestAuthorized(input) {
      if (input.scopeKey !== "platform") {
        throw new ExecutionBudgetGrantError("EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH");
      }
      await assertAccountEnabled(input.accountKey);
      return authorization(input.authorityId);
    },
    async reserve(input) {
      if (input.workspaceId !== "platform") {
        throw new ExecutionBudgetGrantError("EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH");
      }
      await assertAccountEnabled(input.accountKey);
      return {
        workspaceId: input.workspaceId,
        accountKey: input.accountKey,
        operationId: randomUUID(),
        estimatedMicrousd: input.estimatedMicrousd,
        replay: false,
      };
    },
    async settle(_reservation, observedMicrousd) {
      return {
        chargedMicrousd: observedMicrousd,
        observedMicrousd,
        capVariance: false,
        replay: false,
      };
    },
    async markResultUnknown(reservation) {
      return {
        reservedMicrousd: reservation.estimatedMicrousd,
        replay: false,
      };
    },
    async loadResultUnknownArtifact() {
      return null;
    },
    async settleArtifactManifest(_reservation, observedMicrousd) {
      return {
        chargedMicrousd: observedMicrousd,
        observedMicrousd,
        capVariance: false,
        replay: false,
        domainAckStatus: "APPLIED",
      };
    },
    async release() {
      return {
        chargedMicrousd: 0n,
        observedMicrousd: 0n,
        capVariance: false,
        replay: false,
      };
    },
    async status() {
      return {
        remainingMicrousd: BYPASS_TECHNICAL_CAP_MICROUSD,
        exhausted: false,
        open: true,
      };
    },
    async close() {},
  };
}
