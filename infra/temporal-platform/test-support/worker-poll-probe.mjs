import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { isAbsolute, join } from "node:path";

const [
  repositoryRoot,
  tokenPath,
  caPath,
  address,
  serverName,
  namespace,
  taskQueue,
] = process.argv.slice(2);
if (
  !repositoryRoot ||
  !isAbsolute(repositoryRoot) ||
  !tokenPath ||
  !caPath ||
  !address ||
  !serverName ||
  !namespace ||
  !taskQueue ||
  !/^[A-Za-z0-9.-]+:[0-9]{2,5}$/u.test(address) ||
  !/^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/u.test(serverName) ||
  !/^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/u.test(namespace) ||
  !/^[A-Za-z0-9][A-Za-z0-9._-]{2,190}$/u.test(taskQueue)
) {
  throw new Error("worker authorization probe input is invalid");
}

const require = createRequire(join(repositoryRoot, "apps/api/package.json"));
const { Connection } = require("@temporalio/client");

const [tokenBytes, ca] = await Promise.all([
  readFile(tokenPath),
  readFile(caPath),
]);
if (tokenBytes.byteLength < 32 || tokenBytes.byteLength > 16_384) {
  throw new Error("worker authorization token size is invalid");
}
const token = tokenBytes.toString("utf8").trim();
if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(token)) {
  throw new Error("worker authorization token format is invalid");
}

const connection = await Connection.connect({
  address,
  apiKey: token,
  connectTimeout: "5s",
  tls: {
    serverNameOverride: serverName,
    serverRootCACertificate: ca,
  },
});
try {
  const task = await connection.withDeadline(Date.now() + 10_000, () =>
    connection.workflowService.pollWorkflowTaskQueue({
      namespace,
      taskQueue: { name: taskQueue, kind: 1 },
      identity: "task4c-worker-authz-probe",
      workerVersionCapabilities: {
        buildId: "task4c-worker-authz-probe",
        useVersioning: false,
      },
    }),
  );
  if (
    !(task.taskToken instanceof Uint8Array) ||
    task.taskToken.byteLength === 0
  ) {
    throw new Error("worker poll returned no Workflow task token");
  }
  await connection.withDeadline(Date.now() + 5_000, () =>
    connection.workflowService.respondWorkflowTaskFailed({
      namespace,
      taskToken: task.taskToken,
      cause: 14,
      identity: "task4c-worker-authz-probe",
      failure: {
        message: "Task4C disposable authorization probe",
        source: "task4c-disposable-proof",
        nonRetryable: true,
      },
    }),
  );
} finally {
  await connection.close();
}
process.stdout.write(
  "worker PollWorkflowTaskQueue and RespondWorkflowTaskFailed authorization passed\n",
);
