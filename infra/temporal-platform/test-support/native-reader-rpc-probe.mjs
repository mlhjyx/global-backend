import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { isAbsolute, join } from "node:path";

const [repositoryRoot, tokenPath, caPath, certPath, keyPath, address, serverName, scheduleId, workflowId, runId, adminTokenPath] = process.argv.slice(2);
if ([repositoryRoot, tokenPath, caPath, certPath, keyPath, address, serverName, scheduleId, workflowId, runId, adminTokenPath].some((value) => !value) ||
  !isAbsolute(repositoryRoot) || !isAbsolute(tokenPath) || !isAbsolute(caPath) || !isAbsolute(certPath) || !isAbsolute(keyPath) ||
  !/^[A-Za-z0-9.-]+:[0-9]{2,5}$/u.test(address) || !/^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/u.test(serverName) ||
  !/^[A-Za-z0-9][A-Za-z0-9._:-]{2,190}$/u.test(scheduleId) || !/^[A-Za-z0-9][A-Za-z0-9._:-]{2,190}$/u.test(workflowId) ||
  !/^[0-9a-f-]{36}$/u.test(runId)) {
  throw new Error("native reader probe input is invalid");
}

const require = createRequire(join(repositoryRoot, "apps/api/package.json"));
const { Connection } = require("@temporalio/client");
const [tokenBytes, ca, cert, key, adminTokenBytes] = await Promise.all([
  readFile(tokenPath), readFile(caPath), readFile(certPath), readFile(keyPath), readFile(adminTokenPath),
]);
const token = tokenBytes.toString("utf8").trim();
const adminToken = adminTokenBytes.toString("utf8").trim();
if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(token) || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(adminToken)) {
  throw new Error("native reader token format is invalid");
}
const makeConnection = (apiKey, withCertificate) => Connection.lazy({
  address,
  ...(apiKey ? { apiKey } : {}),
  tls: { serverNameOverride: serverName, serverRootCACertificate: ca, ...(withCertificate ? { clientCertPair: { crt: cert, key } } : {}) },
});
const connection = makeConnection(token, true);
const service = connection.workflowService;
const expectNotFound = async (label, action, conn = connection) => {
  try {
    await conn.withDeadline(Date.now() + 10_000, action);
  } catch (error) {
    if (error?.code === 5 || /not.?found|does not exist/iu.test(String(error?.message ?? ""))) {
      process.stdout.write(`READER_RPC_AUTHORIZED ${label}\n`);
      return;
    }
    throw new Error(`reader RPC ${label} did not reach the resource boundary`);
  }
  process.stdout.write(`READER_RPC_AUTHORIZED ${label}\n`);
};
const expectDenied = async (label, action, conn = connection) => {
  try {
    await conn.withDeadline(Date.now() + 10_000, action);
  } catch (error) {
    if (error?.code === 7 || /permission.?denied|not.?authorized|unauthenticated/iu.test(String(error?.message ?? ""))) {
      process.stdout.write(`READER_RPC_DENIED ${label}\n`);
      return;
    }
    throw error;
  }
  throw new Error(`reader RPC ${label} unexpectedly succeeded`);
};
await expectNotFound("DescribeSchedule", () => service.describeSchedule({ namespace: "platform-automation", scheduleId }));
await expectNotFound("DescribeWorkflowExecution", () => service.describeWorkflowExecution({ namespace: "platform-automation", execution: { workflowId, runId } }));
await expectNotFound("GetWorkflowExecutionHistory", () => service.getWorkflowExecutionHistory({ namespace: "platform-automation", execution: { workflowId, runId }, maximumPageSize: 1 }));
await expectDenied("cross-namespace", () => service.describeSchedule({ namespace: "platform-automation-denied", scheduleId }));
await expectDenied("reader-write", () => service.startWorkflowExecution({ namespace: "platform-automation", workflowId, taskQueue: { name: "reader-denied" }, workflowType: { name: "ReaderDenied" } }));
await connection.close();
const adminConnection = makeConnection(adminToken, true);
await expectDenied("reader-certificate-with-admin-token", () => adminConnection.workflowService.describeSchedule({ namespace: "platform-automation", scheduleId }), adminConnection);
await adminConnection.close();
const noTokenConnection = makeConnection("", true);
await expectDenied("no-jwt", () => noTokenConnection.workflowService.describeSchedule({ namespace: "platform-automation", scheduleId }), noTokenConnection);
await noTokenConnection.close();
const noCertificateConnection = makeConnection(token, false);
try {
  await noCertificateConnection.workflowService.describeSchedule({ namespace: "platform-automation", scheduleId });
  throw new Error("no-client-certificate unexpectedly crossed frontend mTLS");
} catch (error) {
  if (!/certificate|required|handshake|unavailable|transport/iu.test(String(error?.message ?? ""))) throw error;
  process.stdout.write("READER_TLS_DENIED no-client-certificate\n");
}
await noCertificateConnection.close();
process.stdout.write("native reader RPC authorization matrix passed\n");
