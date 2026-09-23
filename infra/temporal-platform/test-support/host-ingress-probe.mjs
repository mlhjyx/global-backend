// Runs in a network_mode: host container, exactly like the managed Backend, and
// reaches Temporal only through the loopback port published by the relay.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { isAbsolute, join } from "node:path";
import { connect as tlsConnect } from "node:tls";

const [repositoryRoot, tokenPath, caPath, address, serverName, scheduleId] =
  process.argv.slice(2);
if (
  !repositoryRoot ||
  !isAbsolute(repositoryRoot) ||
  !tokenPath ||
  !caPath ||
  !/^127\.0\.0\.1:[0-9]{2,5}$/u.test(address ?? "") ||
  Number(address.split(":")[1]) < 1024 ||
  !/^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/u.test(serverName ?? "") ||
  !/^[A-Za-z0-9][A-Za-z0-9._-]{2,190}$/u.test(scheduleId ?? "")
) {
  throw new Error("host ingress probe input is invalid");
}

const require = createRequire(join(repositoryRoot, "apps/api/package.json"));
const { Connection } = require("@temporalio/client");
const [tokenBytes, ca] = await Promise.all([
  readFile(tokenPath),
  readFile(caPath),
]);
if (tokenBytes.byteLength < 32 || tokenBytes.byteLength > 16_384) {
  throw new Error("host ingress token size is invalid");
}
const token = tokenBytes.toString("utf8").trim();
if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(token)) {
  throw new Error("host ingress token format is invalid");
}
const [host, port] = address.split(":");

// The relay must be byte-transparent: the TLS peer is Temporal's frontend,
// verified against the client CA and the expected name, never the relay.
function handshake(servername) {
  return new Promise((resolve, reject) => {
    let done = false;
    const socket = tlsConnect({
      host,
      port: Number(port),
      servername,
      ca,
      ALPNProtocols: ["h2"],
      rejectUnauthorized: true,
    });
    const finish = (error, value) => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      socket.destroy();
      error ? reject(error) : resolve(value);
    };
    const timeout = setTimeout(
      () => finish(new Error("host ingress TLS probe timed out")),
      5000,
    );
    socket.once("secureConnect", () =>
      finish(undefined, {
        alpn: socket.alpnProtocol,
        subjectAltName: socket.getPeerCertificate().subjectaltname ?? "",
      }),
    );
    socket.once("error", (error) => finish(error));
    socket.once("close", () =>
      finish(new Error("host ingress closed before TLS completed")),
    );
  });
}

const peer = await handshake(serverName);
assert.equal(peer.alpn, "h2");
assert(peer.subjectAltName.split(", ").includes(`DNS:${serverName}`));
await assert.rejects(
  handshake("task4c-wrong-name.invalid"),
  (error) => error?.code === "ERR_TLS_CERT_ALTNAME_INVALID",
);

const tls = { serverNameOverride: serverName, serverRootCACertificate: ca };
const authorized = Connection.lazy({
  address,
  apiKey: token,
  connectTimeout: "5s",
  tls,
});
const anonymous = Connection.lazy({ address, connectTimeout: "5s", tls });
try {
  const described = await authorized.withDeadline(Date.now() + 10_000, () =>
    authorized.workflowService.describeSchedule({
      namespace: "platform-automation",
      scheduleId,
    }),
  );
  assert(
    described.schedule,
    "host ingress DescribeSchedule returned no schedule",
  );
  await assert.rejects(
    anonymous.withDeadline(Date.now() + 5000, () =>
      anonymous.workflowService.describeSchedule({
        namespace: "platform-automation",
        scheduleId,
      }),
    ),
    (error) => error?.code === 7 || error?.code === 16,
  );
} finally {
  await Promise.all([authorized.close(), anonymous.close()]);
}
process.stdout.write(
  "HOST_INGRESS_PASS loopback TLS passthrough, authorized DescribeSchedule, unauthenticated denied\n",
);
