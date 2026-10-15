import { Inject, Injectable, OnModuleDestroy, Optional } from "@nestjs/common";
import { Client, Connection, type WorkflowClient } from "@temporalio/client";
import {
  DEV_FAST_LANE,
  devFastLaneRoute,
  type DevFastLane,
  type DevFastLaneRoute,
} from "../runtime/dev-fast-lane";

const DISABLED: DevFastLane = Object.freeze({ enabled: false });

/**
 * Development fast lane only: the relay's client for the loopback development
 * Temporal that the source-built lane worker polls. The native Temporal
 * authorizes customer machine identities for the 'understanding' queue alone,
 * so lane workflows run on a separate server instead. Connects lazily, so an
 * unavailable development Temporal never affects API startup or readiness;
 * lane commands then wait in the outbox and are retried.
 */
@Injectable()
export class DevFastLaneTemporalClient implements OnModuleDestroy {
  readonly lane: DevFastLane;
  private connection?: Connection;
  private client?: WorkflowClient;
  private connecting?: Promise<WorkflowClient>;
  private destroyed = false;

  constructor(@Optional() @Inject(DEV_FAST_LANE) lane?: DevFastLane) {
    this.lane = lane ?? DISABLED;
  }

  route(eventType: string, workspaceId: string): DevFastLaneRoute | null {
    return devFastLaneRoute(this.lane, eventType, workspaceId);
  }

  async workflow(): Promise<WorkflowClient> {
    const lane = this.lane;
    if (!lane.enabled) throw new Error("DEV_FAST_LANE_DISABLED");
    if (this.destroyed) throw new Error("DEV_FAST_LANE_CLIENT_CLOSED");
    if (this.client) return this.client;
    this.connecting ??= (async () => {
      const connection = await Connection.connect({
        address: lane.temporalAddress,
        connectTimeout: "5 seconds",
      });
      if (this.destroyed) {
        await connection.close().catch(() => undefined);
        throw new Error("DEV_FAST_LANE_CLIENT_CLOSED");
      }
      this.connection = connection;
      this.client = new Client({
        connection,
        namespace: lane.temporalNamespace,
      }).workflow;
      return this.client;
    })().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  async onModuleDestroy(): Promise<void> {
    this.destroyed = true;
    const connection = this.connection;
    this.connection = undefined;
    this.client = undefined;
    await connection?.close().catch(() => undefined);
  }
}
