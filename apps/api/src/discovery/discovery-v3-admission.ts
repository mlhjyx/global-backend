import { BadRequestException, ConflictException, GoneException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type { DiscoveryRun, Prisma } from '@prisma/client';
import type { RequestContext } from '../auth/request-context';
import type { PrismaService } from '../prisma/prisma.service';
import {
  discoveryV3Attempt, discoveryV3RequestSha256, discoveryV3Uuid,
  type ManufacturerRevision,
} from '../auth/discovery-v3-admission-contract';
import { DISCOVERY_COMPANY_MATERIALIZATION_CONTRACT_VERSION } from './discovery-company-materialization-ctx';

export const DISCOVERY_V3_ADMISSION_WINDOW_MS = 180 * 60_000;
export const DISCOVERY_V3_RUNTIME = Symbol('DISCOVERY_V3_RUNTIME');
export interface DiscoveryV3Runtime {
  readonly legacyAdmissionDisabled?: boolean;
  /** Availability must come from a Worker that supplies the entire native execution path. */
  readyForNewAdmission(): Promise<boolean>;
}

const TERMINAL_RUN_STATUSES = ['DONE', 'PARTIAL', 'FAILED', 'CANCELLED'];
const v3RunSelect = {
  id: true, planId: true, icpId: true, status: true, executionContractVersion: true,
  v3AttemptId: true, v3RequestSha256: true, v3RequestedBy: true,
} satisfies Prisma.DiscoveryRunSelect;
type V3RunSelection = Pick<DiscoveryRun, keyof typeof v3RunSelect>;

export async function getDiscoveryV3PlanContext(
  prisma: Pick<PrismaService, 'withWorkspace'>, workspaceId: string, planId: string,
) {
  const plan = await prisma.withWorkspace(workspaceId, (tx) => tx.discoveryQueryPlan.findUnique({
    where: { id: planId, workspaceId }, select: { id: true, icpId: true, status: true },
  }));
  if (!plan) throw new NotFoundException({ error: { code: 'NOT_FOUND', message: 'query plan not found' } });
  return plan;
}

export async function lockLegacyDiscoveryPlan(tx: Prisma.TransactionClient, workspaceId: string, planId: string): Promise<void> {
  await tx.$queryRaw`
    SELECT id FROM public.discovery_query_plan
    WHERE id=${planId}::uuid AND workspace_id=${workspaceId}::uuid FOR UPDATE
  `;
  const [admission] = await tx.$queryRaw<Array<{ fenced: boolean }>>`
    SELECT EXISTS (
      SELECT 1 FROM public.discovery_run run WHERE run.plan_id=${planId}::uuid
        AND run.workspace_id=${workspaceId}::uuid AND run.execution_contract_version=3
    ) AS fenced
  `;
  if (admission?.fenced) throw conflict('DISCOVERY_LEGACY_ADMISSION_CLOSED', 'plan already uses discovery v3');
}

export type DiscoveryV3AdmissionRequest = {
  readonly attemptId?: string;
  readonly manufacturerNetworkRevision?: ManufacturerRevision;
  readonly admissionReadOnly?: boolean;
};

function prepareRequest(ctx: RequestContext, planId: string, input: DiscoveryV3AdmissionRequest) {
  let workspaceId: string;
  let normalizedPlanId: string;
  let attemptId: string;
  try {
    workspaceId = discoveryV3Uuid(ctx.workspaceId);
    normalizedPlanId = discoveryV3Uuid(planId);
    attemptId = discoveryV3Attempt(workspaceId, normalizedPlanId, input.attemptId);
  } catch {
    throw new BadRequestException({ error: { code: 'DISCOVERY_V3_INVALID_ATTEMPT', message: 'invalid discovery execution attempt' } });
  }
  const signedBinding = ctx.discoveryV3Task;
  const expectedIcpId = signedBinding?.expectedIcpId;
  const taskRef = signedBinding ? {
    workspaceId: signedBinding.workspaceId, planId: signedBinding.planId, attemptId: signedBinding.attemptId,
    taskId: signedBinding.taskId, taskRunId: signedBinding.taskRunId, requestSha256: signedBinding.requestSha256,
  } : undefined;
  const requestSha256 = discoveryV3RequestSha256({
    workspaceId, planId: normalizedPlanId, actorId: ctx.userId, attemptId,
    manufacturerNetworkRevision: input.manufacturerNetworkRevision, task: signedBinding,
  });
  if (signedBinding && (signedBinding.workspaceId !== workspaceId || signedBinding.planId !== normalizedPlanId ||
      signedBinding.attemptId !== attemptId || signedBinding.requestSha256 !== requestSha256)) {
    throw new BadRequestException({ error: { code: 'DISCOVERY_V3_TASK_BINDING_MISMATCH', message: 'signed task binding does not match the request' } });
  }
  return { workspaceId, planId: normalizedPlanId, attemptId, requestSha256, taskRef, expectedIcpId };
}

function conflict(code: string, message: string): ConflictException {
  return new ConflictException({ error: { code, message } });
}

function response(run: V3RunSelection, replayed: boolean) {
  return {
    runId: run.id, planId: run.planId, icpId: run.icpId, status: run.status,
    executionContractVersion: 3, attemptId: run.v3AttemptId, requestSha256: run.v3RequestSha256, replayed,
  };
}

export async function admitDiscoveryV3(
  prisma: Pick<PrismaService, 'withWorkspace'>,
  ctx: RequestContext,
  planId: string,
  input: DiscoveryV3AdmissionRequest,
  options: { taskQueue: string; runtime?: DiscoveryV3Runtime },
) {
  const { workspaceId, planId: planKey, attemptId, requestSha256, taskRef, expectedIcpId } = prepareRequest(ctx, planId, input);
  // This check performs no writes. Already committed requests remain readable during shutdown.
  const readyForNewAdmission = await options.runtime?.readyForNewAdmission().catch(() => false) ?? false;
  return prisma.withWorkspace(workspaceId, async (tx) => {
    const [plan] = await tx.$queryRaw<Array<{ id: string; icpId: string; status: string; queries: Prisma.JsonArray }>>`
      SELECT id, icp_id AS "icpId", status, queries
      FROM public.discovery_query_plan WHERE workspace_id=${workspaceId}::uuid AND id=${planKey}::uuid
      FOR UPDATE
    `;
    if (!plan) throw new NotFoundException({ error: { code: 'NOT_FOUND', message: 'query plan not found' } });
    if (expectedIcpId && plan.icpId !== expectedIcpId) {
      throw new BadRequestException({ error: { code: 'DISCOVERY_V3_TASK_BINDING_MISMATCH', message: 'query plan is outside the signed task ICP' } });
    }

    const replay = await tx.discoveryRun.findFirst({
      where: { workspaceId, planId: planKey, executionContractVersion: 3, v3AttemptId: attemptId },
      select: v3RunSelect,
    });
    if (replay) {
      if (replay.v3RequestSha256 !== requestSha256 || replay.v3RequestedBy !== ctx.userId) {
        throw conflict('DISCOVERY_ATTEMPT_REQUEST_CONFLICT', 'attempt is already bound to a different request');
      }
      return response(replay, true);
    }
    if (input.admissionReadOnly || ctx.discoveryV3Task?.admissionMode === 'read-only') {
      const expiry = ctx.discoveryV3Task?.dispatchNotAfter;
      if (expiry) {
        const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT statement_timestamp()::timestamptz(3) AS now`;
        if (clock.now.getTime() >= Date.parse(expiry)) {
          throw new GoneException({ error: { code: 'DISCOVERY_V3_ATTEMPT_EXPIRED_NOT_ACCEPTED', message: 'the expired attempt was never admitted' } });
        }
      }
      throw new NotFoundException({
        error: { code: 'DISCOVERY_V3_ATTEMPT_NOT_ACCEPTED', message: 'discovery attempt not admitted' },
      });
    }
    if (!readyForNewAdmission) {
      throw new ServiceUnavailableException({ error: { code: 'RUNTIME_ADMISSION_CLOSED', message: 'discovery v3 Worker is not ready' } });
    }
    if (plan.status !== 'READY' && plan.status !== 'EXECUTED') {
      throw conflict('INVALID_STATE', 'confirm the query plan before executing');
    }
    if (!Array.isArray(plan.queries)) throw conflict('INVALID_STATE', 'invalid query plan');

    const active = await tx.discoveryRun.findFirst({
      where: { workspaceId, planId: planKey, status: { notIn: TERMINAL_RUN_STATUSES } },
      select: { executionContractVersion: true },
    });
    if (active) {
      throw conflict(active.executionContractVersion === 2 ? 'DISCOVERY_LEGACY_EXECUTION_UNRESOLVED' : 'DISCOVERY_EXECUTION_IN_PROGRESS',
        'an earlier execution of this plan is still unresolved');
    }
    const prior = await tx.discoveryRun.findFirst({ where: { workspaceId, planId: planKey }, select: { id: true } });
    if ((prior || plan.status === 'EXECUTED') && input.attemptId === undefined) {
      throw conflict('RERUN_REQUIRES_ATTEMPT', 'rerun requires a new attemptId');
    }

    const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT statement_timestamp()::timestamptz(3) AS now`;
    const admittedAt = clock.now;
    if (ctx.discoveryV3Task?.dispatchNotAfter && admittedAt.getTime() >= Date.parse(ctx.discoveryV3Task.dispatchNotAfter)) {
      throw new ConflictException({ error: { code: 'DISCOVERY_V3_DISPATCH_AUTHORIZATION_EXPIRED', message: 'dispatch authorization expired' } });
    }
    const expiresAt = new Date(admittedAt.getTime() + DISCOVERY_V3_ADMISSION_WINDOW_MS);
    const run = await tx.discoveryRun.create({
      data: {
        workspaceId, planId: planKey, icpId: plan.icpId, status: 'QUEUED',
        materializationContractVersion: DISCOVERY_COMPANY_MATERIALIZATION_CONTRACT_VERSION,
        executionContractVersion: 3, v3AttemptId: attemptId, v3RequestSha256: requestSha256,
        v3RequestedBy: ctx.userId, v3FirstAdmission: !prior, v3TaskQueue: options.taskQueue,
        v3AdmittedAt: admittedAt, v3DispatchExpiresAt: expiresAt,
        v3PlanQueries: plan.queries as Prisma.InputJsonArray,
        v3ManufacturerRevision: input.manufacturerNetworkRevision,
        ...(taskRef ? { taskRef: { ...taskRef } } : {}),
      },
      select: v3RunSelect,
    });
    await tx.outboxEvent.create({
      data: {
        workspaceId, eventType: 'DiscoveryRunRequested', schemaVersion: 3,
        aggregateType: 'DiscoveryRun', aggregateId: run.id,
        payload: {
          executionContractVersion: 3, workspaceId, runId: run.id, planId: planKey, icpId: plan.icpId,
          attemptId, requestSha256, taskQueue: options.taskQueue, dispatchExpiresAt: expiresAt.toISOString(),
          ...(input.manufacturerNetworkRevision ? { manufacturerNetworkRevision: input.manufacturerNetworkRevision } : {}),
        },
      },
    });
    return response(run, false);
  });
}
