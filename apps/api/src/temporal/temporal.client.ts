import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Client, Connection } from '@temporalio/client';

/** Thin wrapper so services (e.g. the relay) can start workflows via DI. */
@Injectable()
export class TemporalClient implements OnModuleInit, OnModuleDestroy {
  private connection?: Connection;
  client!: Client;

  async onModuleInit(): Promise<void> {
    this.connection = await Connection.connect({
      address: process.env.TEMPORAL_ADDRESS ?? '127.0.0.1:7233',
    });
    this.client = new Client({
      connection: this.connection,
      namespace: process.env.TEMPORAL_NAMESPACE ?? 'default',
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.connection?.close();
  }

  /** Bounded connectivity proof for API readiness; response contents are never exposed. */
  async checkSystemInfo(options: {
    readonly timeoutMs: number;
    readonly signal?: AbortSignal;
  }): Promise<void> {
    const connection = this.connection;
    if (!connection) throw new Error('Temporal connection is not initialized');
    if (
      !Number.isInteger(options.timeoutMs) ||
      options.timeoutMs <= 0 ||
      options.timeoutMs > 10_000
    ) {
      throw new Error(
        'Temporal health timeout must be an integer between 1 and 10000ms',
      );
    }

    const request = () =>
      connection.workflowService.getSystemInfo({}).then(() => undefined);
    await connection.withDeadline(Date.now() + options.timeoutMs, () =>
      options.signal
        ? connection.withAbortSignal(options.signal, request)
        : request(),
    );
  }
}
