import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Client, Connection } from "@temporalio/client";
import {
  createRuntimeMachineTokenClient,
  temporalTlsConfiguration,
} from "../platform-authority/machine-token-runtime";
import type { MachineTokenClient } from "../platform-authority/machine-token-client";
import { currentRuntimeReleaseIdentity } from "../runtime/runtime-release-identity";
import {
  resolveCustomerTemporalConfig,
  resolveCustomerTemporalTlsEnv,
  validateCustomerTemporalReadiness,
  type CustomerTemporalReadinessReport,
} from "./temporal-config";
import { resolveTemporalPayloadCodec } from "./payload-codec";

/** Thin wrapper so services (e.g. the relay) can start workflows via DI. */
@Injectable()
export class TemporalClient implements OnModuleInit, OnModuleDestroy {
  private connection?: Connection;
  client!: Client;
  private bootstrapAttempted = false;
  private connecting?: Promise<boolean>;
  private destroyed = false;
  private machineToken?: MachineTokenClient;
  private connect = async (): Promise<Connection> => {
    this.machineToken?.close();
    const readiness = validateCustomerTemporalReadiness(process.env);
    if (!readiness.ok) {
      throw new Error(
        `TEMPORAL_CUSTOMER_CONFIG_INVALID:${readiness.issues.join(",")}`,
      );
    }
    const release = await currentRuntimeReleaseIdentity();
    if (!release.attested)
      throw new Error("RUNTIME_RELEASE_IDENTITY_UNAVAILABLE");
    const runtimeIdentity = release.artifact_digest.replace(/^sha256:/, "");
    const { client } = await createRuntimeMachineTokenClient(
      "temporal-customer-client",
      runtimeIdentity,
    );
    this.machineToken = client;
    try {
      return await Connection.connect({
        ...(await temporalTlsConfiguration(
          resolveCustomerTemporalTlsEnv(process.env),
        )),
        apiKey: () => client.currentToken(),
      });
    } catch (error) {
      client.close();
      throw error;
    }
  };

  /** Exposes current customer Temporal dual-mode readiness without mutating connection state. */
  inspectCustomerConfiguration(
    env: NodeJS.ProcessEnv = process.env,
  ): CustomerTemporalReadinessReport {
    return validateCustomerTemporalReadiness(env);
  }

  async onModuleInit(): Promise<void> {
    this.bootstrapAttempted = true;
    await this.reconnect();
  }

  async onModuleDestroy(): Promise<void> {
    this.destroyed = true;
    this.machineToken?.close();
    await this.connection?.close();
    this.connection = undefined;
    this.client = undefined as unknown as Client;
  }

  async reconnect(): Promise<boolean> {
    if (this.destroyed) return false;
    if (this.connection) return true;
    this.connecting ??= this.reconnectOnce().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  private async reconnectOnce(): Promise<boolean> {
    try {
      const connection = await this.connect();
      if (this.destroyed) {
        this.machineToken?.close();
        await connection.close();
        return false;
      }
      const config = resolveCustomerTemporalConfig(process.env);
      const payloadCodec = resolveTemporalPayloadCodec(process.env);
      this.connection = connection;
      this.client = new Client({
        connection: this.connection,
        namespace: config.namespace,
        ...(payloadCodec ? { dataConverter: { payloadCodecs: [payloadCodec] } } : {}),
      });
      return true;
    } catch {
      this.connection = undefined;
      this.client = undefined as unknown as Client;
      console.error(
        "[temporal] control-plane connection unavailable; readiness remains closed",
      );
      return false;
    }
  }

  async probe(): Promise<
    | { connected: true }
    | {
        connected: false;
        code: "TEMPORAL_NOT_INITIALIZED" | "TEMPORAL_CONTROL_PLANE_UNAVAILABLE";
      }
  > {
    const connection = this.connection;
    if (!connection) {
      if (!this.bootstrapAttempted) {
        return { connected: false, code: "TEMPORAL_NOT_INITIALIZED" };
      }
      if (!(await this.reconnect())) {
        return {
          connected: false,
          code: "TEMPORAL_CONTROL_PLANE_UNAVAILABLE",
        };
      }
    }
    try {
      const activeConnection = this.connection!;
      await activeConnection.withDeadline(Date.now() + 2_000, () =>
        activeConnection.workflowService.getSystemInfo({}),
      );
      return { connected: true };
    } catch {
      if (typeof this.connection?.close === "function") {
        await this.connection.close().catch(() => undefined);
      }
      this.connection = undefined;
      this.client = undefined as unknown as Client;
      return { connected: false, code: "TEMPORAL_CONTROL_PLANE_UNAVAILABLE" };
    }
  }
}
