/**
 * R0 Temporal live probe：验证本机 Server 与锁定 SDK 对 workflow ID policy 的真实语义。
 * 使用无人消费的专用 task queue，不触发任何业务 activity/DB 写入。
 *
 * 跑：node --import tsx scripts/verify-site-builder-temporal-idempotency.mts
 */
import {
  Client,
  Connection,
  WorkflowExecutionAlreadyStartedError,
  WorkflowIdConflictPolicy,
  WorkflowIdReusePolicy,
} from "@temporalio/client";
import { randomUUID } from "node:crypto";

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`assertion failed: ${message}`);
  console.log(`  ✅ ${message}`);
}

async function main(): Promise<void> {
  const connection = await Connection.connect({
    address: process.env.TEMPORAL_ADDRESS ?? "127.0.0.1:7233",
  });
  const client = new Client({
    connection,
    namespace: process.env.TEMPORAL_NAMESPACE ?? "default",
  });
  const workflowId = `r0-idempotency-probe-${randomUUID()}`;
  const options = {
    taskQueue: "r0-idempotency-probe-unserved",
    workflowId,
    args: [] as [],
    workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE,
    workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
  };

  try {
    console.log("① running duplicate → USE_EXISTING");
    const first = await client.workflow.start(
      "r0IdempotencyPolicyProbeWorkflow",
      options,
    );
    const runningDuplicate = await client.workflow.start(
      "r0IdempotencyPolicyProbeWorkflow",
      options,
    );
    check(
      first.firstExecutionRunId === runningDuplicate.firstExecutionRunId,
      "running duplicate 返回同一 execution-chain head",
    );

    console.log("② closed duplicate → REJECT_DUPLICATE + describe recovery");
    await first.terminate("R0 idempotency policy probe complete");
    let alreadyStarted: WorkflowExecutionAlreadyStartedError | undefined;
    try {
      await client.workflow.start("r0IdempotencyPolicyProbeWorkflow", options);
    } catch (error) {
      if (error instanceof WorkflowExecutionAlreadyStartedError)
        alreadyStarted = error;
      else throw error;
    }
    check(
      alreadyStarted?.workflowId === workflowId,
      "closed duplicate 被 REJECT_DUPLICATE 拒绝",
    );

    const description = await client.workflow.getHandle(workflowId).describe();
    const recoveredFirstRunId =
      description.raw.workflowExecutionInfo?.firstRunId || description.runId;
    check(
      recoveredFirstRunId === first.firstExecutionRunId,
      "describe 可恢复原 execution-chain head（ACK-loss 修复路径）",
    );
    console.log("\n🎉 R0 Temporal live policy probe 全绿。");
  } finally {
    // The normal path already terminates it; this is best-effort protection for assertion failures.
    try {
      await client.workflow.getHandle(workflowId).terminate("R0 probe cleanup");
    } catch {
      // Closed/not-found is expected.
    }
    await connection.close();
  }
}

main().catch((error) => {
  console.error("💥 R0 Temporal live probe failed:", error);
  process.exit(1);
});
