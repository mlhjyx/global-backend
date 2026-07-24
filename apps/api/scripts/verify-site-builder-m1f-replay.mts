import "dotenv/config";
import { fileURLToPath } from "node:url";
import { Connection, WorkflowClient } from "@temporalio/client";
import { Worker } from "@temporalio/worker";

function workflowIds(argv: string[]): string[] {
  const ids = argv
    .filter((value) => value.startsWith("--workflow-id="))
    .map((value) => value.slice("--workflow-id=".length))
    .filter(Boolean);
  if (ids.length === 0) {
    throw new Error(
      "pass at least one immutable history as --workflow-id=<id>",
    );
  }
  return [...new Set(ids)];
}

const address = process.env.TEMPORAL_ADDRESS ?? "127.0.0.1:7233";
const namespace = process.env.TEMPORAL_NAMESPACE ?? "default";
const connection = await Connection.connect({ address });
try {
  const client = new WorkflowClient({ connection, namespace });
  const results = [];
  for (const workflowId of workflowIds(process.argv.slice(2))) {
    const history = await client.getHandle(workflowId).fetchHistory();
    await Worker.runReplayHistory(
      {
        workflowsPath: fileURLToPath(
          new URL("../src/temporal/workflows.ts", import.meta.url),
        ),
      },
      history,
      workflowId,
    );
    results.push({
      workflowId,
      eventCount: history.events?.length ?? 0,
      replay: "passed",
    });
  }
  console.log(
    JSON.stringify(
      {
        schemaVersion: "site-builder-m1f-replay-verification/v1",
        temporalSdk: "1.20.3",
        address,
        namespace,
        results,
      },
      null,
      2,
    ),
  );
} finally {
  await connection.close();
}
