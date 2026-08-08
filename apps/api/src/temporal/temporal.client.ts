import {
  Inject,
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { Client, Connection, type ConnectionOptions } from '@temporalio/client';
import { RuntimeIdentityService } from '../runtime/runtime-admission';

export const TEMPORAL_CLIENT_DRIVER = Symbol('TEMPORAL_CLIENT_DRIVER');

export interface TemporalClientDriver {
  connect(options: ConnectionOptions): Promise<Connection>;
  createClient(options: ConstructorParameters<typeof Client>[0]): Client;
}

const DEFAULT_TEMPORAL_CLIENT_DRIVER: TemporalClientDriver = Object.freeze({
  connect: (options: ConnectionOptions) => Connection.connect(options),
  createClient: (options: ConstructorParameters<typeof Client>[0]) =>
    new Client(options),
});

/** Thin wrapper so services (e.g. the relay) can start workflows via DI. */
@Injectable()
export class TemporalClient implements OnModuleInit, OnModuleDestroy {
  private connection?: Connection;
  client!: Client;
  private readonly driver: TemporalClientDriver;

  constructor(
    private readonly runtimeIdentity: RuntimeIdentityService,
    @Optional()
    @Inject(TEMPORAL_CLIENT_DRIVER)
    driver?: TemporalClientDriver,
  ) {
    this.driver = driver ?? DEFAULT_TEMPORAL_CLIENT_DRIVER;
  }

  async onModuleInit(): Promise<void> {
    const temporal = this.runtimeIdentity.getProcessSnapshot().safety.temporal;
    // This is intentionally an eager hard startup dependency. A rejection
    // aborts Nest initialization, so the API never binds a listener.
    const connection = await this.driver.connect({
      address: temporal.address,
      connectTimeout: temporal.connectTimeoutMs,
    });
    this.connection = connection;
    this.client = this.driver.createClient({
      connection,
      namespace: temporal.namespace,
    });
  }

  isInitialized(): boolean {
    return this.connection !== undefined && this.client !== undefined;
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
