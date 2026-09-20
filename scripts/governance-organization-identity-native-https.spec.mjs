import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import https from "node:https";
import tls from "node:tls";
import dns from "node:dns/promises";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import os from "node:os";
import { performance } from "node:perf_hooks";

const api = () => import("./governance-organization-identity-native-https.mjs");
const sha = "a".repeat(40),
  body = JSON.stringify({ name: "main", commit: { sha }, protected: true });
const input = () => Buffer.from(["synthetic", "local", "value"].join("_"));
let root, good, bad;
before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "identity-native-tls-"));
  async function cert(name) {
    const key = path.join(root, name + ".key"),
      cert = path.join(root, name + ".crt");
    await promisify(execFile)(
      "/usr/bin/openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "1",
        "-keyout",
        key,
        "-out",
        cert,
        "-subj",
        "/CN=" + name,
        "-addext",
        "subjectAltName=DNS:" + name,
      ],
      { env: {}, timeout: 10000, maxBuffer: 16384 },
    );
    return { key: await readFile(key), cert: await readFile(cert) };
  }
  good = await cert("api.github.com");
  bad = await cert("wrong.example");
});
after(async () => {
  await rm(root, { recursive: true, force: true });
});
async function server(
  t,
  handler,
  {
    certificate = good,
    raw = false,
    answers = [{ address: "93.184.216.34", family: 4 }],
    peer = "93.184.216.34",
    lookupDelay = 0,
    inspectOptions,
  } = {},
) {
  let requests = 0,
    transports = 0,
    lookups = 0;
  const calls = [],
    pinnedLookupObservations = [];
  let pinnedLookup;
  const s = raw
    ? tls.createServer(certificate, (socket) =>
        socket.once("data", () => {
          requests++;
          handler(socket);
        }),
      )
    : https.createServer(certificate, (req, res) => {
        requests++;
        handler(req, res);
      });
  s.on("tlsClientError", () => {});
  const sockets = new Set();
  s.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve) => s.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => s.close(resolve));
  });
  t.mock.method(dns, "lookup", async (host, options) => {
    lookups++;
    assert.equal(host, "api.github.com");
    assert.deepEqual(options, { all: true, verbatim: true });
    if (lookupDelay) await new Promise((r) => setTimeout(r, lookupDelay));
    return answers;
  });
  const original = https.request;
  t.mock.method(https, "request", (options, callback) => {
    transports++;
    assert.equal(options.servername, "api.github.com");
    assert.equal(options.autoSelectFamily, false);
    assert.equal(options.family, answers[0].family);
    pinnedLookup = options.lookup;
    pinnedLookup("api.github.com", {}, (error, address, family) =>
      pinnedLookupObservations.push({
        error: error?.message ?? null,
        address,
        family,
      }),
    );
    pinnedLookup("api.github.com", { all: true }, (error, addresses) =>
      pinnedLookupObservations.push({
        error: error?.message ?? null,
        addresses,
      }),
    );
    pinnedLookup("untrusted.example", {}, (error) =>
      pinnedLookupObservations.push({ error: error?.message ?? null }),
    );
    inspectOptions?.(options);
    calls.push({
      host: options.hostname,
      path: options.path,
      port: options.port,
      method: options.method,
      rejectUnauthorized: options.rejectUnauthorized,
      maxHeaderSize: options.maxHeaderSize,
    });
    const req = original(
      {
        ...options,
        hostname: "127.0.0.1",
        port: s.address().port,
        lookup: (_host, _options, cb) => cb(null, "127.0.0.1", 4),
      },
      callback,
    );
    req.on("socket", (socket) =>
      Object.defineProperty(socket, "remoteAddress", {
        get: () => peer,
        configurable: true,
      }),
    );
    return req;
  });
  return {
    certificate,
    get requests() {
      return requests;
    },
    get transports() {
      return transports;
    },
    get lookups() {
      return lookups;
    },
    calls,
    pinnedLookupObservations,
    get pinnedLookup() {
      return pinnedLookup;
    },
  };
}
test("real TLS success returns only fixed observation metadata with exact request options", async (t) => {
  const f = await server(t, (req, res) => {
    assert.equal(req.headers["accept-encoding"], "identity");
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(body);
  });
  const { readProtectedMainHttps } = await api();
  const r = await readProtectedMainHttps(input(), good.cert, 1000);
  assert.equal(r.status, "PASS");
  assert.equal(r.admissionGranted, false);
  assert.deepEqual(r.observation, { headSha: sha, protected: true });
  assert.equal(r.rawBodyBytes, Buffer.byteLength(body));
  assert.equal(f.lookups, 1);
  assert.equal(f.requests, 1);
  assert.deepEqual(f.pinnedLookupObservations, [
    { error: null, address: "93.184.216.34", family: 4 },
    { error: null, addresses: [{ address: "93.184.216.34", family: 4 }] },
    { error: "PINNED_LOOKUP_REFUSED" },
  ]);
  f.pinnedLookup("api.github.com", {}, (error) =>
    assert.equal(error?.message, "PINNED_LOOKUP_REFUSED"),
  );
  assert.deepEqual(f.calls, [
    {
      host: "api.github.com",
      path: "/repos/mlhjyx/global-backend/branches/main",
      port: 443,
      method: "GET",
      rejectUnauthorized: true,
      maxHeaderSize: 8192,
    },
  ]);
  assert.equal(JSON.stringify(r).includes("synthetic"), false);
});
test("redirect response is rejected without a second request", async (t) => {
  const f = await server(t, (_req, res) => {
    res.writeHead(302, { Location: "https://api.github.com/redirect-target" });
    res.end();
  });
  const { readProtectedMainHttps } = await api();
  assert.equal(
    (await readProtectedMainHttps(input(), good.cert, 1000)).code,
    "NATIVE_HTTPS_STATUS_REJECTED",
  );
  assert.equal(f.requests, 1);
  assert.equal(f.transports, 1);
});
test("raw body exact 64 KiB succeeds, chunked excess fails before projection", async (t) => {
  let rawBytes = 65536;
  await server(t, (_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(body + " ".repeat(rawBytes - Buffer.byteLength(body)));
  });
  const { readProtectedMainHttps } = await api();
  assert.equal(
    (await readProtectedMainHttps(input(), good.cert, 1000)).status,
    "PASS",
  );
  rawBytes = 65537;
  assert.equal(
    (await readProtectedMainHttps(input(), good.cert, 1000)).code,
    "NATIVE_HTTPS_BODY_LIMIT",
  );
  rawBytes = 2097257;
  assert.equal(
    (await readProtectedMainHttps(input(), good.cert, 1000)).code,
    "NATIVE_HTTPS_BODY_LIMIT",
  );
});
test("declared oversize, compressed response, invalid UTF-8, duplicate keys and wrong observation fail closed", async (t) => {
  let kind;
  await server(t, (_req, res) => {
    const headers = { "Content-Type": "application/json" };
    if (kind === "length") headers["Content-Length"] = "65537";
    if (kind === "encoding") headers["Content-Encoding"] = "gzip";
    if (kind === "quote")
      headers["Content-Type"] = 'application/json; charset="utf-8';
    res.writeHead(200, headers);
    res.end(
      kind === "utf8"
        ? Buffer.from([255])
        : kind === "duplicate"
          ? '{"name":"main","name":"main","commit":{"sha":"' +
            sha +
            '"},"protected":true}'
          : kind === "wrong"
            ? body.replace("true", "false")
            : body,
    );
  });
  const { readProtectedMainHttps } = await api();
  for (kind of ["length", "encoding", "utf8", "duplicate", "wrong", "quote"]) {
    const r = await readProtectedMainHttps(input(), good.cert, 1000);
    assert.equal(r.status, "HOLD", kind);
    assert.deepEqual(Object.keys(r).sort(), [
      "admissionGranted",
      "code",
      "status",
    ]);
  }
});
test("private, mixed, empty and excessive DNS results never reach the transport", async (t) => {
  const answers = [];
  const f = await server(t, () => assert.fail("no request expected"), {
    answers,
  });
  const { readProtectedMainHttps } = await api();
  for (const values of [
    [],
    [{ address: "127.0.0.1", family: 4 }],
    [
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.1", family: 4 },
    ],
    Array.from({ length: 17 }, () => ({ address: "93.184.216.34", family: 4 })),
  ]) {
    answers.splice(0, answers.length, ...values);
    assert.equal(
      (await readProtectedMainHttps(input(), good.cert, 500)).code,
      "NATIVE_HTTPS_DNS_UNSAFE",
    );
  }
  assert.equal(f.transports, 0);
});
test("late DNS after timeout cannot dispatch and DNS errors are redacted", async (t) => {
  const f = await server(t, () => assert.fail("no request expected"), {
    lookupDelay: 100,
  });
  const { readProtectedMainHttps } = await api();
  assert.equal(
    (await readProtectedMainHttps(input(), good.cert, 20)).code,
    "NATIVE_HTTPS_DNS_TIMEOUT",
  );
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(f.transports, 0);
  t.mock.method(dns, "lookup", async () => {
    throw Error("synthetic-private");
  });
  assert.equal(
    (await readProtectedMainHttps(input(), good.cert, 100)).code,
    "NATIVE_HTTPS_DNS_FAILED",
  );
});
test("IP mismatch aborts before request headers are sent", async (t) => {
  const f = await server(t, () => assert.fail("no HTTP request expected"), {
    peer: "93.184.216.35",
  });
  const { readProtectedMainHttps } = await api();
  assert.equal(
    (await readProtectedMainHttps(input(), good.cert, 1000)).code,
    "NATIVE_HTTPS_PEER_MISMATCH",
  );
  assert.equal(f.requests, 0);
});
test("TLS hostname mismatch fails without sending an HTTP request", async (t) => {
  const f = await server(t, () => assert.fail("no HTTP request expected"), {
    certificate: bad,
  });
  const { readProtectedMainHttps } = await api();
  assert.equal(
    (await readProtectedMainHttps(input(), bad.cert, 1000)).status,
    "HOLD",
  );
  assert.equal(f.requests, 0);
});
test("slow headers, endless body and premature response close terminate within the common deadline", async (t) => {
  let kind = "headers";
  await server(t, (_req, res) => {
    if (kind === "headers") return;
    if (kind === "abort") {
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Content-Length": "1000",
      });
      res.write("{");
      res.destroy();
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.write("{");
  });
  const { readProtectedMainHttps } = await api();
  for (kind of ["headers", "body", "abort"])
    assert.equal(
      (await readProtectedMainHttps(input(), good.cert, 80)).status,
      "HOLD",
    );
});
test("malformed and duplicate content lengths and excessive headers are rejected by real HTTP parsing", async (t) => {
  let headers;
  await server(
    t,
    (socket) =>
      socket.end(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n" +
          headers +
          "\r\n" +
          body,
      ),
    { raw: true },
  );
  const { readProtectedMainHttps } = await api();
  for (headers of [
    "Content-Length: -1\r\n",
    "Content-Length: 10\r\nContent-Length: 10\r\n",
    "X-Padding: " + "x".repeat(9000) + "\r\n",
  ])
    assert.equal(
      (await readProtectedMainHttps(input(), good.cert, 500)).status,
      "HOLD",
    );
});
test("invalid input refuses before DNS, and no endpoint override is accepted", async (t) => {
  let lookups = 0;
  t.mock.method(dns, "lookup", async () => {
    lookups++;
    throw Error("not expected");
  });
  const { readProtectedMainHttps } = await api();
  for (const value of [
    null,
    Buffer.alloc(0),
    Buffer.from("bad\n"),
    Buffer.alloc(8193, 65),
  ])
    assert.equal(
      (await readProtectedMainHttps(value, good.cert, 100)).code,
      "NATIVE_HTTPS_INPUT_INVALID",
    );
  assert.equal(
    (
      await readProtectedMainHttps(input(), good.cert, {
        timeoutMs: 100,
        endpoint: "http://127.0.0.1",
      })
    ).code,
    "NATIVE_HTTPS_INPUT_INVALID",
  );
  assert.equal(lookups, 0);
});
test("HTTP error statuses and excessive JSON depth fail with no response or credential data", async (t) => {
  let status = 200,
    deep = false;
  const f = await server(t, (_req, res) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(
      deep
        ? '{"extra":' +
            "[".repeat(129) +
            "0" +
            "]".repeat(129) +
            ',"name":"main","commit":{"sha":"' +
            sha +
            '"},"protected":true}'
        : "synthetic-private-response",
    );
  });
  const { readProtectedMainHttps } = await api();
  for (status of [401, 403, 404, 429, 500]) {
    const r = await readProtectedMainHttps(input(), good.cert, 1000);
    assert.equal(r.code, "NATIVE_HTTPS_STATUS_REJECTED");
    assert.equal(JSON.stringify(r).includes("synthetic-private"), false);
  }
  status = 200;
  deep = true;
  assert.equal(
    (await readProtectedMainHttps(input(), good.cert, 1000)).code,
    "NATIVE_HTTPS_RESPONSE_INVALID",
  );
  assert.equal(f.requests, 6);
});
test("actual pinned lookup covers IPv6 and refuses once the common deadline expires", async (t) => {
  const address = "2001:4860:4860::8888";
  let expiredRefusal = false;
  const f = await server(t, () => assert.fail("no HTTP request expected"), {
    answers: [{ address, family: 6 }],
    inspectOptions: (options) => {
      const now = performance.now.bind(performance),
        clock = t.mock.method(performance, "now", () => now() + 20000);
      try {
        options.lookup("api.github.com", {}, (error) => {
          expiredRefusal = error?.message === "PINNED_LOOKUP_REFUSED";
        });
      } finally {
        clock.mock.restore();
      }
      throw Error("test stops before connector; no IPv6 network route is used");
    },
  });
  const { readProtectedMainHttps } = await api();
  const r = await readProtectedMainHttps(input(), good.cert, 1000);
  assert.equal(r.status, "HOLD");
  assert.equal(expiredRefusal, true);
  assert.equal(f.requests, 0);
  assert.deepEqual(f.pinnedLookupObservations.slice(0, 2), [
    { error: null, address, family: 6 },
    { error: null, addresses: [{ address, family: 6 }] },
  ]);
});
