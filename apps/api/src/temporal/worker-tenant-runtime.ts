import { join } from 'node:path';
import { Worker, type WorkerOptions } from '@temporalio/worker';
import { resolveTemporalPayloadCodec } from './payload-codec';
import {
  resolveCustomerTemporalConfig,
  resolveCustomerTemporalTlsEnv,
} from './temporal-config';
import { resolveWorkerCustomerTaskQueues } from './tenant-task-queues';
import { UNDERSTANDING_TASK_QUEUE } from './understanding.constants';

function resolveDiagnosticFailureConverterPath(): string {
  try {
    return require.resolve('./diagnostic-failure-converter');
  } catch {
    return join(__dirname, 'diagnostic-failure-converter.ts');
  }
}

export interface CustomerWorkerRuntimeSpec {
  readonly namespace: string;
  readonly tlsEnv: NodeJS.ProcessEnv;
  readonly primaryTaskQueue: string;
  readonly auxiliaryTaskQueues: readonly string[];
  readonly payloadCodecOption: {
    readonly payloadCodecs?: NonNullable<NonNullable<WorkerOptions['dataConverter']>['payloadCodecs']>;
  };
  readonly dataConverter: NonNullable<WorkerOptions['dataConverter']>;
}

/**
 * Resolves customer worker Temporal runtime settings (unified Postgres namespace,
 * dual-queue split polling queues, and optional AES-256-GCM PayloadCodec).
 */
export function resolveCustomerWorkerRuntimeSpec(
  env: NodeJS.ProcessEnv = process.env,
): CustomerWorkerRuntimeSpec {
  const config = resolveCustomerTemporalConfig(env);
  const payloadCodec = resolveTemporalPayloadCodec(env);
  const queues = resolveWorkerCustomerTaskQueues(env);
  const primaryTaskQueue = queues[0] ?? UNDERSTANDING_TASK_QUEUE;
  const auxiliaryTaskQueues = queues.slice(1);
  const payloadCodecOption = payloadCodec ? { payloadCodecs: [payloadCodec] } : {};
  return {
    namespace: config.namespace,
    tlsEnv: resolveCustomerTemporalTlsEnv(env),
    primaryTaskQueue,
    auxiliaryTaskQueues,
    payloadCodecOption,
    dataConverter: {
      failureConverterPath: resolveDiagnosticFailureConverterPath(),
      ...payloadCodecOption,
    },
  };
}

export interface MultiQueueWorkerHandle {
  run(): Promise<void>;
  shutdown(): void;
}

/**
 * Wraps the primary `understanding` worker with any split-queue workers
 * (`interactive-onboarding`, `batch-discovery`) so lifecycle heartbeats and
 * graceful shutdown coordinate all queues atomically.
 */
export function combineQueueWorkers(
  primary: Pick<Worker, 'run' | 'shutdown'>,
  auxiliary: readonly Pick<Worker, 'run' | 'shutdown'>[],
): MultiQueueWorkerHandle {
  if (auxiliary.length === 0) return primary;
  const all = [primary, ...auxiliary];
  return {
    async run(): Promise<void> {
      try {
        await Promise.all(all.map((worker) => worker.run()));
      } catch (error) {
        for (const worker of all) {
          try {
            worker.shutdown();
          } catch {
            // Best-effort peer shutdown if one queue worker aborts.
          }
        }
        throw error;
      }
    },
    shutdown(): void {
      for (const worker of all) {
        try {
          worker.shutdown();
        } catch {
          // Worker may already be draining or stopped.
        }
      }
    },
  };
}

export async function attachAuxiliaryCustomerWorkers(
  primary: Pick<Worker, 'run' | 'shutdown'>,
  baseOptions: Omit<WorkerOptions, 'taskQueue' | 'identity'>,
  baseIdentity: string,
  runtime: CustomerWorkerRuntimeSpec,
): Promise<MultiQueueWorkerHandle> {
  if (runtime.auxiliaryTaskQueues.length === 0) return primary;
  const auxiliary: Worker[] = [];
  for (const taskQueue of runtime.auxiliaryTaskQueues) {
    auxiliary.push(
      await Worker.create({
        ...baseOptions,
        taskQueue,
        identity: `${baseIdentity}:${taskQueue}`,
      }),
    );
  }
  return combineQueueWorkers(primary, auxiliary);
}
