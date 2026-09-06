import { ExecutionControlError } from "../execution-budget/execution-control-error";

export const PLATFORM_EGRESS_FENCE_UNAVAILABLE =
  "PLATFORM_EGRESS_FENCE_UNAVAILABLE" as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const OPERATION_KEY = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u;
const SCHEDULES = new Set([
  "acq-sweep",
  "patents-cache-refresh",
  "intent-sweep",
  "sanctions-refresh",
]);

export class PlatformEgressFenceError extends ExecutionControlError {
  constructor(code: string) {
    super(code);
    this.name = "PlatformEgressFenceError";
  }
}

export interface PlatformEgressBinding {
  readonly authorityId: string;
  readonly scheduleId: string;
  readonly workflowId: string;
  readonly workflowRunId: string;
  readonly scheduleRequestSha256: string;
  readonly technicalPolicyRevision: string;
  readonly accountKey: string;
  readonly expiresAt: Date;
}

export interface PlatformEgressAuthorization {
  readonly attemptId: string;
}

export interface PlatformEgressDispatchCapability {
  readonly attemptId: string;
  /** The port returns this one-use capability only after its durable SENDING CAS. */
  readonly dispatch: <T>(executePhysicalWire: () => Promise<T>) => Promise<T>;
}

export interface PlatformEgressFencePort {
  /** Transaction 1: lock authority/account/policy generation and create AUTHORIZED attempt. */
  authorize(
    binding: PlatformEgressBinding,
    operationKey: string,
  ): Promise<PlatformEgressAuthorization>;
  /** Transaction 2: repeat revocation/expiry/policy checks and perform AUTHORIZED→SENDING CAS. */
  claimSend(
    binding: PlatformEgressBinding,
    authorization: PlatformEgressAuthorization,
    operationKey: string,
  ): Promise<PlatformEgressDispatchCapability>;
  acknowledged(attemptId: string, meta: Readonly<Record<string, unknown>>): Promise<void>;
  unknown(attemptId: string, meta: Readonly<Record<string, unknown>>): Promise<void>;
}

function invalid(code: string): never {
  throw new PlatformEgressFenceError(code);
}

function validateBinding(binding: PlatformEgressBinding): void {
  if (
    !binding ||
    typeof binding !== "object" ||
    !UUID.test(binding.authorityId) ||
    !SCHEDULES.has(binding.scheduleId) ||
    typeof binding.workflowId !== "string" ||
    !OPERATION_KEY.test(binding.workflowId) ||
    !UUID.test(binding.workflowRunId) ||
    !SHA256.test(binding.scheduleRequestSha256) ||
    !SHA256.test(binding.technicalPolicyRevision) ||
    typeof binding.accountKey !== "string" ||
    binding.accountKey !== `platform:${binding.scheduleRequestSha256}:${binding.workflowRunId}` ||
    !(binding.expiresAt instanceof Date) ||
    !Number.isFinite(binding.expiresAt.getTime())
  ) {
    invalid("PLATFORM_EGRESS_BINDING_INVALID");
  }
}

function validateOperation(operationKey: string): void {
  if (typeof operationKey !== "string" || !OPERATION_KEY.test(operationKey)) {
    invalid("PLATFORM_EGRESS_OPERATION_KEY_INVALID");
  }
}

/**
 * The only product-level Platform dispatch entry point. The default has no
 * in-memory fallback; a durable PostgreSQL-backed port must be injected by the
 * managed runtime before any physical wire can be reached.
 */
export class PlatformEgressFence {
  constructor(private readonly port?: PlatformEgressFencePort) {}

  async authorizeAndDispatchPlatformEgress<T>(
    binding: PlatformEgressBinding,
    operationKey: string,
    executePhysicalWire: () => Promise<T>,
  ): Promise<T> {
    validateBinding(binding);
    validateOperation(operationKey);
    if (!this.port) invalid(PLATFORM_EGRESS_FENCE_UNAVAILABLE);

    const authorization = await this.port.authorize(binding, operationKey);
    const capability: PlatformEgressDispatchCapability =
      await this.port.claimSend(binding, authorization, operationKey);

    try {
      const result = await capability.dispatch(executePhysicalWire);
      await this.port.acknowledged(capability.attemptId, {
        state: "ACKNOWLEDGED",
      });
      return result;
    } catch (error) {
      await this.port.unknown(capability.attemptId, {
        state: "UNKNOWN",
        reason: "PHYSICAL_CALL_OR_ACK_UNKNOWN",
      });
      throw error;
    }
  }
}
