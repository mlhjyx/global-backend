import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Client, Connection } from '@temporalio/client';

/** Thin wrapper so services (e.g. the relay) can start workflows via DI. */
@Injectable()
export class TemporalClient implements OnModuleInit, OnModuleDestroy {
  private connection?: Connection;
  client!: Client;
  private bootstrapAttempted = false;
  private connect = (): Promise<Connection> =>
    Connection.connect({
      address: process.env.TEMPORAL_ADDRESS ?? '127.0.0.1:7233',
    });

  async onModuleInit(): Promise<void> {
    this.bootstrapAttempted = true;
    await this.reconnect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.connection?.close();
    this.connection = undefined;
    this.client = undefined as unknown as Client;
  }

  async reconnect(): Promise<boolean> {
    if (this.connection) return true;
    try {
      this.connection = await this.connect();
      this.client = new Client({
        connection: this.connection,
        namespace: process.env.TEMPORAL_NAMESPACE ?? 'default',
      });
      return true;
    } catch {
      this.connection = undefined;
      this.client = undefined as unknown as Client;
      console.error(
        '[temporal] control-plane connection unavailable; readiness remains closed',
      );
      return false;
    }
  }

  async probe(): Promise<
    | { connected: true }
    | { connected: false; code: 'TEMPORAL_NOT_INITIALIZED' | 'TEMPORAL_CONTROL_PLANE_UNAVAILABLE' }
  > {
    const connection = this.connection;
    if (!connection) {
      if (!this.bootstrapAttempted) {
        return { connected: false, code: 'TEMPORAL_NOT_INITIALIZED' };
      }
      if (!(await this.reconnect())) {
        return {
          connected: false,
          code: 'TEMPORAL_CONTROL_PLANE_UNAVAILABLE',
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
      if (typeof this.connection?.close === 'function') {
        await this.connection.close().catch(() => undefined);
      }
      this.connection = undefined;
      this.client = undefined as unknown as Client;
      return { connected: false, code: 'TEMPORAL_CONTROL_PLANE_UNAVAILABLE' };
    }
  }
}
