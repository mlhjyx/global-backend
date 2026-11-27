import { ApplicationFailure, Context } from '@temporalio/activity';
import type { DiscoveryRun, Prisma } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { discoveryV3RunMatchesDispatch, isDiscoveryV3DispatchExpired, readDiscoveryV3RunForUpdate } from '../discovery/discovery-v3-run-state';
import { finalizeDiscoveryV3 } from '../discovery/discovery-v3-terminal';
import { parkDiscoveryV3OpenOperations } from '../discovery/discovery-v3-operations';
import { DISCOVERY_V3_WORKFLOW, parseDiscoveryV3Dispatch, type DiscoveryV3Dispatch } from '../runtime/discovery-v3-dispatch-contract';
import { formatTenantWorkflowId } from './tenant-workflow-id';

export type DiscoveryV3WorkerActivities = {
  dispatchDiscoveryV3(command: DiscoveryV3Dispatch): Promise<void>;
  cancelDiscoveryV3(command: DiscoveryV3Dispatch): Promise<void>;
  failDiscoveryV3(command: DiscoveryV3Dispatch): Promise<void>;
};

export interface DiscoveryV3WorkerExecutor {
  /** Commits business results on this admitted run and returns its verified outcome. */
  execute(command: DiscoveryV3Dispatch, signal: AbortSignal, workerAttempt: number): Promise<{
    status: 'DONE' | 'PARTIAL';
    summary: Prisma.InputJsonObject;
  }>;
}

function stop(code: string): never {
  throw ApplicationFailure.nonRetryable(code, code);
}

function assertBoundDispatch(run: DiscoveryRun | null, command: DiscoveryV3Dispatch): asserts run is DiscoveryRun {
  if (!discoveryV3RunMatchesDispatch(run, command)) {
    stop('DISCOVERY_V3_DISPATCH_BINDING_MISMATCH');
  }
}

export async function claimDiscoveryV3Dispatch(
  prisma: Pick<PrismaService, 'withWorkspace'>,
  command: DiscoveryV3Dispatch,
  workflowId: string,
  executorAvailable: boolean,
  workerAttempt = 1,
): Promise<boolean> {
  if (workflowId !== formatTenantWorkflowId(command.workspaceId, 'discovery', command.runId)) {
    stop('DISCOVERY_V3_WRONG_WORKFLOW');
  }
  if (!Number.isSafeInteger(workerAttempt) || workerAttempt < 1) stop('DISCOVERY_V3_INVALID_WORKER_ATTEMPT');
  return prisma.withWorkspace(command.workspaceId, async (tx) => {
    const run = await readDiscoveryV3RunForUpdate(tx, command.workspaceId, command.runId);
    assertBoundDispatch(run, command);
    const takeover = run.status === 'RUNNING' && run.v3WorkerAttempt !== null && workerAttempt > run.v3WorkerAttempt;
    if (!takeover && (run.status !== 'QUEUED' || run.v3WorkerAcceptedAt)) return false;
    const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT statement_timestamp()::timestamptz(3) AS now`;
    if (isDiscoveryV3DispatchExpired(run.v3DispatchExpiresAt, clock.now)) {
      await finalizeDiscoveryV3(tx, run, clock.now, 'FAILED', 'DISCOVERY_V3_DISPATCH_EXPIRED');
      return false;
    }
    if (!executorAvailable) stop('DISCOVERY_V3_EXECUTOR_UNAVAILABLE');
    if (takeover) await parkDiscoveryV3OpenOperations(tx, command, clock.now);
    await tx.discoveryRun.update({
      where: { id: run.id }, data: {
        status: 'RUNNING', v3WorkerAcceptedAt: run.v3WorkerAcceptedAt ?? clock.now, v3WorkerAttempt: workerAttempt,
      },
    });
    return true;
  });
}

export function createDiscoveryV3WorkerActivities(
  prisma: Pick<PrismaService, 'withWorkspace'>,
  executor?: DiscoveryV3WorkerExecutor,
  reconcileGateway?: (command: DiscoveryV3Dispatch, signal: AbortSignal) => Promise<void>,
): DiscoveryV3WorkerActivities {
  const verifiedCommand = (value: unknown): DiscoveryV3Dispatch => {
    let command: DiscoveryV3Dispatch;
    try { command = parseDiscoveryV3Dispatch(value); } catch { return stop('DISCOVERY_V3_INVALID_COMMAND'); }
    const info = Context.current().info;
    if (info.workflowType !== DISCOVERY_V3_WORKFLOW || info.taskQueue !== command.taskQueue ||
        info.workflowExecution?.workflowId !== formatTenantWorkflowId(command.workspaceId, 'discovery', command.runId)) {
      return stop('DISCOVERY_V3_WRONG_WORKFLOW');
    }
    return command;
  };
  const reconcile = async (command: DiscoveryV3Dispatch) => {
    try {
      await reconcileGateway?.(command, Context.current().cancellationSignal);
    } catch {
      // The terminal fact and original pending probes remain available for later readback.
      Context.current().log.warn('DISCOVERY_V3_GATEWAY_RECONCILIATION_PENDING');
    }
  };
  const stopRun = async (value: DiscoveryV3Dispatch, status: 'CANCELLED' | 'FAILED', reason: string): Promise<void> => {
    const command = verifiedCommand(value);
    await prisma.withWorkspace(command.workspaceId, async (tx) => {
      const run = await readDiscoveryV3RunForUpdate(tx, command.workspaceId, command.runId);
      assertBoundDispatch(run, command);
      const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT statement_timestamp()::timestamptz(3) AS now`;
      await finalizeDiscoveryV3(tx, run, clock.now, status, reason);
    });
    await reconcile(command);
  };
  return {
    async dispatchDiscoveryV3(value) {
      const command = verifiedCommand(value);
      const context = Context.current();
      const workflowId = context.info.workflowExecution!.workflowId;
      const accepted = await claimDiscoveryV3Dispatch(prisma, command, workflowId, Boolean(executor), context.info.attempt);
      if (!accepted || !executor) {
        if (executor) await reconcile(command);
        return;
      }
      context.heartbeat();
      const timer = setInterval(() => context.heartbeat(), 10_000);
      try {
        context.cancellationSignal.throwIfAborted();
        const outcome = await executor.execute(command, context.cancellationSignal, context.info.attempt);
        context.cancellationSignal.throwIfAborted();
        await prisma.withWorkspace(command.workspaceId, async (tx) => {
          const run = await readDiscoveryV3RunForUpdate(tx, command.workspaceId, command.runId);
          assertBoundDispatch(run, command);
          if (run.v3WorkerAttempt !== context.info.attempt) return;
          context.cancellationSignal.throwIfAborted();
          const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT statement_timestamp()::timestamptz(3) AS now`;
          await finalizeDiscoveryV3(tx, run, clock.now, outcome.status, undefined, outcome.summary);
        });
        await reconcile(command);
      } finally {
        clearInterval(timer);
      }
    },
    cancelDiscoveryV3: (value) => stopRun(value, 'CANCELLED', 'DISCOVERY_V3_CANCELLED'),
    failDiscoveryV3: (value) => stopRun(value, 'FAILED', 'DISCOVERY_V3_EXECUTION_INTERRUPTED'),
  };
}
