import {
  patched,
  proxyLocalActivities,
  workflowInfo,
  type WorkflowInboundCallsInterceptor,
  type WorkflowInterceptors,
} from '@temporalio/workflow';
import type { WorkflowRunReceiptInput } from '../runtime-ops/runtime-ops.service';

const RECEIPT_PATCH = 'workflow-run-receipt-v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

interface ReceiptActivities {
  recordWorkflowRunReceipt(input: WorkflowRunReceiptInput): Promise<void>;
}

const receipts = proxyLocalActivities<ReceiptActivities>({
  startToCloseTimeout: '10 seconds',
  retry: { maximumAttempts: 5, initialInterval: '1 second', maximumInterval: '5 seconds' },
});

function workspaceIdFromArgs(args: readonly unknown[]): string | null {
  const first = args[0];
  if (!first || typeof first !== 'object' || Array.isArray(first)) return null;
  const value = (first as Record<string, unknown>).workspaceId;
  return typeof value === 'string' && UUID.test(value) ? value : null;
}

function machineErrorCode(error: unknown): string {
  if (
    error instanceof Error &&
    error.name === 'BudgetExceededError'
  ) {
    return 'BUDGET_EXCEEDED';
  }
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && ERROR_CODE.test(code)) return code;
  }
  return 'WORKFLOW_FAILED';
}

function completedBudgetTruncated(result: unknown): boolean {
  return (
    typeof result === 'object' &&
    result !== null &&
    !Array.isArray(result) &&
    (result as Record<string, unknown>).budgetTruncated === true
  );
}

function receiptInput(
  phase: WorkflowRunReceiptInput['phase'],
  args: readonly unknown[],
  error?: unknown,
  budgetTruncated = false,
): WorkflowRunReceiptInput {
  const info = workflowInfo();
  const errorCode = phase === 'FAILED' ? machineErrorCode(error) : null;
  return {
    workspaceId: workspaceIdFromArgs(args),
    workflowId: info.workflowId,
    runId: info.runId,
    workflowType: info.workflowType,
    taskQueue: info.taskQueue,
    phase,
    stage: phase.toLowerCase(),
    stats: {},
    errorCode,
    budgetTruncated:
      phase === 'FAILED'
        ? (errorCode?.includes('BUDGET') ?? false)
        : budgetTruncated,
    retryAttempt: info.attempt,
  };
}

const inbound: WorkflowInboundCallsInterceptor = {
  async execute(input, next): Promise<unknown> {
    // Temporal patch markers make this safe for old histories: absent marker on
    // replay returns false, so no new Local Activity command is introduced.
    if (!patched(RECEIPT_PATCH)) return next(input);
    await receipts.recordWorkflowRunReceipt(receiptInput('STARTED', input.args));
    try {
      const result = await next(input);
      await receipts.recordWorkflowRunReceipt(
        receiptInput(
          'COMPLETED',
          input.args,
          undefined,
          completedBudgetTruncated(result),
        ),
      );
      return result;
    } catch (error) {
      await receipts.recordWorkflowRunReceipt(receiptInput('FAILED', input.args, error));
      throw error;
    }
  },
};

export function interceptors(): WorkflowInterceptors {
  return { inbound: [inbound] };
}
