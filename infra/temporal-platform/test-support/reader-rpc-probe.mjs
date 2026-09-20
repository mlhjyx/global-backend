import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { connect as tlsConnect } from "node:tls";
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
  certPath,
  keyPath,
  publicServerName,
  internodeCaPath,
  internodeAddress,
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
  !certPath ||
  !keyPath ||
  !publicServerName ||
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
const [crt, key] = await Promise.all([readFile(certPath), readFile(keyPath)]);
if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(token)) {
  throw new Error("reader token format is invalid");
}

const connection = Connection.lazy({
  address,
  apiKey: token,
  connectTimeout: "5s",
  tls: {
    serverNameOverride: serverName,
    serverRootCACertificate: ca,
    clientCertPair: { crt, key },
  },
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
  for (const [method, request] of [
    [
      "createSchedule",
      {
        namespace: "platform-automation",
        scheduleId: "reader-must-not-create",
      },
    ],
    ["describeWorkflowExecution", { namespace: "default", execution }],
    ["describeNamespace", { namespace: "platform-automation" }],
  ]) {
    await assert.rejects(
      connection.withDeadline(Date.now() + 5000, () =>
        connection.workflowService[method](request),
      ),
      (error) => error?.code === 7 || error?.code === 16,
    );
  }
  const noCertificate = Connection.lazy({
    address,
    apiKey: token,
    tls: { serverNameOverride: publicServerName, serverRootCACertificate: ca },
  });
  try {
    await assert.rejects(
      noCertificate.withDeadline(Date.now() + 5000, () =>
        noCertificate.workflowService.describeSchedule({
          namespace: "platform-automation",
          scheduleId,
        }),
      ),
      (error) => error?.code === 7 || error?.code === 16,
    );
  } finally {
    await noCertificate.close();
  }
  process.stdout.write(
    "READER_MTLS_BOUNDARY_PASS public-no-cert/write/cross-namespace/describe-namespace denied\n",
  );
  if (internodeAddress) {
    const internodeCA = await readFile(internodeCaPath);
    assert.match(internodeAddress, /^[A-Za-z0-9.-]+:[0-9]{2,5}$/u);
    const [host, port] = internodeAddress.split(":");
    // Probe the actual TLS alert directly: gRPC retry middleware converts
    // handshake rejection into a deadline and cannot prove the rejection reason.
    await new Promise((resolve, reject) => {
      let done = false;
      const socket = tlsConnect({
        host,
        port: Number(port),
        servername: publicServerName,
        ca: internodeCA,
        cert: crt,
        key,
        rejectUnauthorized: true,
      });
      const finish = (error) => {
        if (done) return;
        done = true;
        clearTimeout(timeout);
        socket.destroy();
        error ? reject(error) : resolve();
      };
      const timeout = setTimeout(
        () => finish(new Error("reader internode TLS probe timed out")),
        5000,
      );
      socket.once("secureConnect", () =>
        socket.write("PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n"),
      );
      socket.once("error", (error) => {
        if (
          /certificate.required|bad.certificate|certificate.unknown|unknown.ca/iu.test(
            `${error.code ?? ""} ${error.message ?? ""}`,
          )
        )
          finish();
        else
          finish(
            new Error("reader internode rejection was not a certificate alert"),
          );
      });
      socket.once("close", () =>
        finish(new Error("reader certificate was not proven rejected")),
      );
    });
    process.stdout.write(
      "READER_INTERNODE_MTLS_REJECTED reader-client-certificate\n",
    );
  }
} finally {
  await connection.close();
}
process.stdout.write(
  "reader direct DescribeSchedule/DescribeWorkflowExecution/GetWorkflowExecutionHistory passed\n",
);
