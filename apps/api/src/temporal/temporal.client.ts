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
}
