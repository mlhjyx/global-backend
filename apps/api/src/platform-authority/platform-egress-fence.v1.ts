import { ExecutionControlError } from "../execution-budget/execution-control-error";
import { snapshotPlatformEgressOperation, type PlatformEgressOperation } from "./platform-egress-operation";

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

export interface PlatformScheduleEgressBinding {
  /** Absent means the schedule binding (historical callers). */
  readonly subjectKind?: "schedule";
  readonly authorityId: string;
  readonly scheduleId: string;
  readonly workflowId: string;
  readonly workflowRunId: string;
  readonly scheduleRequestSha256: string;
  /**
   * Optional at the activity boundary. The durable port resolves the exact
   * immutable revision from the admitted authority before invoking the SQL
   * CAS, so callers cannot invent a policy revision.
   */
  readonly technicalPolicyRevision?: string;
  readonly accountKey: string;
  /** Optional local hint; PostgreSQL rechecks the authoritative expiry. */
  readonly expiresAt?: Date;
}

/** P4-P4: per-request channel-crawl binding, parallel to the schedule shape. */
export interface PlatformChannelCrawlEgressBinding {
  readonly subjectKind: "source_channel";
  readonly authorityId: string;
  readonly channelId: string;
  readonly crawlRunId: string;
  readonly requestSha256: string;
  readonly technicalPolicyRevision?: string;
  readonly accountKey: string;
  readonly expiresAt?: Date;
}

export type PlatformEgressBinding =
  | PlatformScheduleEgressBinding
  | PlatformChannelCrawlEgressBinding;

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
    operation: PlatformEgressOperation,
  ): Promise<PlatformEgressAuthorization>;
  /** Transaction 2: repeat revocation/expiry/policy checks and perform AUTHORIZED→SENDING CAS. */
  claimSend(
    binding: PlatformEgressBinding,
    authorization: PlatformEgressAuthorization,
    operation: PlatformEgressOperation,
  ): Promise<PlatformEgressDispatchCapability>;
  acknowledged(attemptId: string, meta: Readonly<Record<string, unknown>>): Promise<void>;
  unknown(attemptId: string, meta: Readonly<Record<string, unknown>>): Promise<void>;
  /** Crawl attempts live in their own durable table; the port must expose its transitions. */
  acknowledgedChannelCrawl?(attemptId: string, meta: Readonly<Record<string, unknown>>): Promise<void>;
  unknownChannelCrawl?(attemptId: string, meta: Readonly<Record<string, unknown>>): Promise<void>;
}

function invalid(code: string): never {
  throw new PlatformEgressFenceError(code);
}

function validateBinding(binding: PlatformEgressBinding): void {
  if (binding && typeof binding === "object" && binding.subjectKind === "source_channel") {
    if (
      !UUID.test(binding.authorityId) ||
      !UUID.test(binding.channelId) ||
      !UUID.test(binding.crawlRunId) ||
      !SHA256.test(binding.requestSha256) ||
      (binding.technicalPolicyRevision !== undefined &&
        !SHA256.test(binding.technicalPolicyRevision)) ||
      typeof binding.accountKey !== "string" ||
      binding.accountKey !==
        `platform:${binding.requestSha256}:${binding.crawlRunId}` ||
      (binding.expiresAt !== undefined &&
        (!(binding.expiresAt instanceof Date) ||
          !Number.isFinite(binding.expiresAt.getTime())))
    ) {
      invalid("PLATFORM_EGRESS_BINDING_INVALID");
    }
    return;
  }
  if (
    !binding ||
    typeof binding !== "object" ||
    binding.subjectKind !== undefined ||
    !UUID.test(binding.authorityId) ||
    !SCHEDULES.has(binding.scheduleId) ||
    typeof binding.workflowId !== "string" ||
    !OPERATION_KEY.test(binding.workflowId) ||
    !UUID.test(binding.workflowRunId) ||
    !SHA256.test(binding.scheduleRequestSha256) ||
    (binding.technicalPolicyRevision !== undefined &&
      !SHA256.test(binding.technicalPolicyRevision)) ||
    typeof binding.accountKey !== "string" ||
    binding.accountKey !== `platform:${binding.scheduleRequestSha256}:${binding.workflowRunId}` ||
    (binding.expiresAt !== undefined &&
      (!(binding.expiresAt instanceof Date) ||
        !Number.isFinite(binding.expiresAt.getTime())))
  ) {
    invalid("PLATFORM_EGRESS_BINDING_INVALID");
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
    operation: PlatformEgressOperation,
    executePhysicalWire: () => Promise<T>,
  ): Promise<T> {
    validateBinding(binding);
    if (!operation || typeof operation.operationKey !== "string" || !OPERATION_KEY.test(operation.operationKey)) {
      invalid("PLATFORM_EGRESS_OPERATION_KEY_INVALID");
    }
    const immutableOperation = snapshotPlatformEgressOperation(operation);
    if (!this.port) invalid(PLATFORM_EGRESS_FENCE_UNAVAILABLE);

    const authorization = await this.port.authorize(binding, immutableOperation);
    const capability: PlatformEgressDispatchCapability =
      await this.port.claimSend(binding, authorization, immutableOperation);

    const crawl = binding.subjectKind === "source_channel";
    const acknowledged = crawl
      ? this.port.acknowledgedChannelCrawl?.bind(this.port)
      : this.port.acknowledged.bind(this.port);
    const unknown = crawl
      ? this.port.unknownChannelCrawl?.bind(this.port)
      : this.port.unknown.bind(this.port);
    if (!acknowledged || !unknown) invalid(PLATFORM_EGRESS_FENCE_UNAVAILABLE);
    try {
      const result = await capability.dispatch(executePhysicalWire);
      await acknowledged(capability.attemptId, { state: "ACKNOWLEDGED" });
      return result;
    } catch (error) {
      await unknown(capability.attemptId, {
        state: "UNKNOWN",
        reason: "PHYSICAL_CALL_OR_ACK_UNKNOWN",
      });
      throw error;
    }
  }
}
