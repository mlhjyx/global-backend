import { Inject, Injectable, OnModuleDestroy, Optional } from "@nestjs/common";
import {
  Client,
  Connection,
  isGrpcServiceError,
  type WorkflowClient,
  type WorkflowStartOptions,
} from "@temporalio/client";
import {
  DEV_FAST_LANE,
  devFastLaneRoute,
  type DevFastLane,
  type DevFastLaneRoute,
  type EnabledDevFastLane,
} from "../runtime/dev-fast-lane";

const DISABLED: DevFastLane = Object.freeze({ enabled: false });

/** Budget for reaching the loopback development Temporal once. */
export const DEV_FAST_LANE_CONNECT_TIMEOUT_MS = 5_000;
/**
 * Deadline for one lane workflow start, including the retries of the default
 * gRPC retry interceptor (about 20 seconds without a deadline).
 */
export const DEV_FAST_LANE_START_DEADLINE_MS = 5_000;
/**
 * After the development Temporal could not be reached, the lane makes no
 * further attempt for this long, so an unreachable server costs one bounded
 * attempt per period instead of one per pending command.
 */
export const DEV_FAST_LANE_UNAVAILABLE_COOLDOWN_MS = 30_000;

const GRPC_DEADLINE_EXCEEDED = 4;
const GRPC_UNAVAILABLE = 14;
const MAX_CAUSE_DEPTH = 8;

/** True when the server could not be reached, as opposed to a per-command rejection. */
function isTransportFailure(err: unknown): boolean {
  let cause: unknown = err;
  for (let depth = 0; cause && depth < MAX_CAUSE_DEPTH; depth++) {
    if (
      isGrpcServiceError(cause) &&
      (cause.code === GRPC_DEADLINE_EXCEEDED || cause.code === GRPC_UNAVAILABLE)
    ) {
      return true;
    }
    cause = (cause as { cause?: unknown }).cause;
  }
  return false;
}

function untilAborted<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    operation.catch(() => undefined);
    return Promise.reject(new Error("DEV_FAST_LANE_START_ABORTED"));
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Error("DEV_FAST_LANE_START_ABORTED"));
    signal.addEventListener("abort", abort, { once: true });
    operation.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", abort);
    });
  });
}

type LaneConnection = Readonly<{
  connection: Connection;
  workflow: WorkflowClient;
}>;

/**
 * Development fast lane only: the relay's client for the loopback development
 * Temporal that the source-built lane worker polls. The native Temporal
 * authorizes customer machine identities for the 'understanding' queue alone,
 * so lane workflows run on a separate server instead.
 *
 * The client connects lazily, so an unavailable development Temporal does not
 * affect API startup. Each attempt is bounded: a connect by
 * DEV_FAST_LANE_CONNECT_TIMEOUT_MS, and a start by
 * DEV_FAST_LANE_START_DEADLINE_MS and the caller's abort signal. A channel
 * that fails to connect is closed. A failure to reach the server starts a
 * DEV_FAST_LANE_UNAVAILABLE_COOLDOWN_MS cool-down, during which starts fail at
 * once. The relay skips its lane pass during the cool-down, and lane commands
 * wait in the outbox.
 */
@Injectable()
export class DevFastLaneTemporalClient implements OnModuleDestroy {
  readonly lane: DevFastLane;
  private connected?: LaneConnection;
  private connecting?: Promise<LaneConnection>;
  private unavailableUntil = 0;
  private destroyed = false;

  constructor(@Optional() @Inject(DEV_FAST_LANE) lane?: DevFastLane) {
    this.lane = lane ?? DISABLED;
  }

  route(eventType: string, workspaceId: string): DevFastLaneRoute | null {
    return devFastLaneRoute(this.lane, eventType, workspaceId);
  }

  /** True while a failure to reach the development Temporal holds the lane back. */
  coolingDown(): boolean {
    return Date.now() < this.unavailableUntil;
  }

  async start(
    workflowType: string,
    options: WorkflowStartOptions,
    signal: AbortSignal,
  ): Promise<void> {
    const { connection, workflow } = await untilAborted(
      this.connection(),
      signal,
    );
    // gRPC adds an abort listener per call and never removes it; a per-start
    // signal keeps those listeners off the caller's long-lived signal.
    const callSignal = AbortSignal.any([signal]);
    try {
      await connection.withAbortSignal(callSignal, () =>
        connection.withDeadline(
          Date.now() + DEV_FAST_LANE_START_DEADLINE_MS,
          () => workflow.start(workflowType, options),
        ),
      );
    } catch (err) {
      if (isTransportFailure(err)) await this.markUnavailable(connection);
      throw err;
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.destroyed = true;
    const connection = this.connected?.connection;
    this.connected = undefined;
    await connection?.close().catch(() => undefined);
  }

  private connection(): Promise<LaneConnection> {
    const lane = this.lane;
    if (!lane.enabled) {
      return Promise.reject(new Error("DEV_FAST_LANE_DISABLED"));
    }
    if (this.destroyed) {
      return Promise.reject(new Error("DEV_FAST_LANE_CLIENT_CLOSED"));
    }
    if (this.coolingDown()) {
      return Promise.reject(new Error("DEV_FAST_LANE_TEMPORAL_UNAVAILABLE"));
    }
    if (this.connected) return Promise.resolve(this.connected);
    this.connecting ??= this.open(lane).finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  private async open(lane: EnabledDevFastLane): Promise<LaneConnection> {
    // Connection.connect would leave the channel of a failed connect open;
    // lazy + ensureConnected lets the failure path close it.
    const connection = Connection.lazy({
      address: lane.temporalAddress,
      connectTimeout: DEV_FAST_LANE_CONNECT_TIMEOUT_MS,
    });
    try {
      await connection.ensureConnected();
    } catch (err) {
      await this.markUnavailable(connection);
      throw err;
    }
    if (this.destroyed) {
      await connection.close().catch(() => undefined);
      throw new Error("DEV_FAST_LANE_CLIENT_CLOSED");
    }
    this.connected = {
      connection,
      workflow: new Client({
        connection,
        namespace: lane.temporalNamespace,
      }).workflow,
    };
    return this.connected;
  }

  /** Starts the cool-down and closes the channel, so the next attempt reconnects from scratch. */
  private async markUnavailable(connection: Connection): Promise<void> {
    this.unavailableUntil = Date.now() + DEV_FAST_LANE_UNAVAILABLE_COOLDOWN_MS;
    if (this.connected?.connection === connection) this.connected = undefined;
    await connection.close().catch(() => undefined);
  }
}
