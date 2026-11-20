import { BadRequestException } from "@nestjs/common";
import {
  manufacturerNetworkExecutionSnapshot,
  readManufacturerNetworkExecutionBody,
} from "./manufacturer-network-execution";

/** Attribution validation still precedes Grant verification/consumption; this helper performs no I/O. */
export function prepareDiscoveryExecutionMetadata(
  planId: string,
  attemptId: string | undefined,
  manufacturerNetworkRevision: "manufacturer-network/v1" | undefined,
  taskRef: { taskId: string; taskRunId: string } | undefined,
) {
  if (taskRef !== undefined) {
    const uuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
    if (
      typeof taskRef !== "object" ||
      taskRef === null ||
      !uuid.test(taskRef.taskId ?? "") ||
      !uuid.test(taskRef.taskRunId ?? "")
    ) {
      throw new BadRequestException({
        error: {
          code: "TASK_REF_INVALID",
          message: "taskRef must be {taskId, taskRunId} with UUIDs",
        },
      });
    }
  }
  const executeBody =
    attemptId === undefined && manufacturerNetworkRevision === undefined
      ? undefined
      : readManufacturerNetworkExecutionBody({
          ...(attemptId === undefined ? {} : { attemptId }),
          ...(manufacturerNetworkRevision === undefined
            ? {}
            : { manufacturerNetworkRevision }),
        });
  const executionSnapshot = manufacturerNetworkExecutionSnapshot(
    planId,
    executeBody,
  );
  return { executeBody, executionSnapshot };
}
