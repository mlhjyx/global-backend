import { readFile } from "node:fs/promises";
import { connect } from "node:tls";

const [caPath, address, serverName] = process.argv.slice(2);
if (
  !caPath ||
  !address ||
  !serverName ||
  !/^[A-Za-z0-9.-]+:[0-9]{2,5}$/u.test(address) ||
  !/^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/u.test(serverName)
) {
  throw new Error("internal mTLS probe input is invalid");
}

const separator = address.lastIndexOf(":");
const host = address.slice(0, separator);
const port = Number(address.slice(separator + 1));
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
  throw new Error("internal mTLS probe port is invalid");
}

const ca = await readFile(caPath);
if (ca.byteLength < 64 || ca.byteLength > 64 * 1_024) {
  throw new Error("internal mTLS probe CA size is invalid");
}

await new Promise((resolve, reject) => {
  let complete = false;
  const finish = (callback) => {
    if (complete) return;
    complete = true;
    clearTimeout(timeout);
    socket.destroy();
    callback();
  };
  const timeout = setTimeout(() => {
    finish(() => reject(new Error("internal mTLS probe timed out")));
  }, 5_000);
  const socket = connect({
    host,
    port,
    servername: serverName,
    ca,
    rejectUnauthorized: true,
  });
  socket.once("secureConnect", () => {
    // TLS 1.3 can notify the client that its half of the handshake completed
    // immediately before the server sends its mandatory-certificate alert.
    socket.write("PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n");
  });
  socket.once("error", (error) => {
    const code = typeof error.code === "string" ? error.code : "";
    const message = typeof error.message === "string" ? error.message : "";
    if (
      /certificate.required|bad.certificate|certificate.unknown/iu.test(
        `${code} ${message}`,
      )
    ) {
      finish(resolve);
      return;
    }
    finish(() =>
      reject(
        new Error(
          `internal endpoint failed for a reason other than client-certificate rejection (${code || "unknown"})`,
        ),
      ),
    );
  });
  socket.once("close", () => {
    finish(() =>
      reject(
        new Error(
          "internal endpoint did not prove mandatory client certificate",
        ),
      ),
    );
  });
});

process.stdout.write("INTERNAL_MTLS_REJECTED no-client-certificate\n");
