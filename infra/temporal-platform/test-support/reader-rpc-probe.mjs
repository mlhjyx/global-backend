import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { isAbsolute, join } from "node:path";

const [
  repositoryRoot,
  tokenPath,
  caPath,
  address,
  serverName,
  scheduleId,
  workflowId,
  runId,
] = process.argv.slice(2);
if (
  !repositoryRoot ||
  !isAbsolute(repositoryRoot) ||
  !tokenPath ||
  !caPath ||
  !address ||
  !serverName ||
  !scheduleId ||
  !workflowId ||
  !runId ||
  !/^[A-Za-z0-9.-]+:[0-9]{2,5}$/u.test(address) ||
  !/^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/u.test(serverName) ||
  !/^[A-Za-z0-9][A-Za-z0-9._-]{2,190}$/u.test(scheduleId) ||
  !/^[A-Za-z0-9][A-Za-z0-9._:-]{2,190}$/u.test(workflowId) ||
  !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(runId)
) {
  throw new Error("reader RPC probe input is invalid");
}

const require = createRequire(join(repositoryRoot, "apps/api/package.json"));
const { Connection } = require("@temporalio/client");
const [tokenBytes, ca] = await Promise.all([
  readFile(tokenPath),
  readFile(caPath),
]);
if (tokenBytes.byteLength < 32 || tokenBytes.byteLength > 16_384) {
  throw new Error("reader token size is invalid");
}
const token = tokenBytes.toString("utf8").trim();
if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(token)) {
  throw new Error("reader token format is invalid");
}

const connection = Connection.lazy({
  address,
  apiKey: token,
  connectTimeout: "5s",
  tls: { serverNameOverride: serverName, serverRootCACertificate: ca },
});
const execution = { workflowId, runId };
try {
  await connection.withDeadline(Date.now() + 10_000, () =>
    connection.workflowService.describeSchedule({
      namespace: "platform-automation",
      scheduleId,
    }),
  );
  await connection.withDeadline(Date.now() + 10_000, () =>
    connection.workflowService.describeWorkflowExecution({
      namespace: "platform-automation",
      execution,
    }),
  );
  await connection.withDeadline(Date.now() + 10_000, () =>
    connection.workflowService.getWorkflowExecutionHistory({
      namespace: "platform-automation",
      execution,
      waitNewEvent: false,
      skipArchival: true,
    }),
  );
} finally {
  await connection.close();
}
process.stdout.write(
  "reader direct DescribeSchedule/DescribeWorkflowExecution/GetWorkflowExecutionHistory passed\n",
);
