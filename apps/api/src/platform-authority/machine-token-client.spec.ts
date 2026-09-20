import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { setTimeout as delay } from "node:timers/promises";
import { createServer, type Server } from "node:https";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { CompactSign, exportJWK, generateKeyPair } from "jose";
import {
  MachineTokenClient,
  type MachineTokenClientConfiguration,
} from "./machine-token-client";

let directory: string;
let server: Server;
let config: MachineTokenClientConfiguration;
let now = 1_790_000_000_000;
let mints = 0;
let mode:
  | "ok"
  | "unavailable"
  | "wrong-nonce"
  | "redirect"
  | "oversize"
  | "slow"
  | "split-deadline" = "ok";
const opened: MachineTokenClient[] = [];

afterEach(() => {
  for (const instance of opened.splice(0)) instance.close();
  vi.useRealTimers();
});

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "parity-machine-mtls-"));
  const run = (args: string[]) =>
    execFileSync("openssl", args, { cwd: directory, stdio: "ignore" });
  run([
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "1",
    "-subj",
    "/CN=Ephemeral Machine Test CA",
    "-keyout",
    "ca.key",
    "-out",
    "ca.pem",
    "-addext",
    "basicConstraints=critical,CA:TRUE",
  ]);
  for (const role of ["server", "client"]) {
    run([
      "req",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-subj",
      `/CN=${role}`,
      "-keyout",
      `${role}.key`,
      "-out",
      `${role}.csr`,
      "-addext",
      role === "server"
        ? "subjectAltName=IP:127.0.0.1"
        : "extendedKeyUsage=clientAuth",
    ]);
    run([
      "x509",
      "-req",
      "-in",
      `${role}.csr`,
      "-CA",
      "ca.pem",
      "-CAkey",
      "ca.key",
      "-CAcreateserial",
      "-days",
      "1",
      "-copy_extensions",
      "copy",
      "-out",
      `${role}.pem`,
    ]);
  }
  const ca = await readFile(join(directory, "ca.pem"));
  const pair = await generateKeyPair("RS256", { modulusLength: 2048 });
  const jwks = {
    keys: [
      {
        ...(await exportJWK(pair.publicKey)),
        alg: "RS256",
        kid: "active",
        use: "sig",
      },
    ],
  };
  server = createServer(
    {
      ca,
      key: await readFile(join(directory, "server.key")),
      cert: await readFile(join(directory, "server.pem")),
      requestCert: true,
      rejectUnauthorized: true,
    },
    (request, response) => {
      void (async () => {
        response.setHeader("content-type", "application/json");
        if (request.url === "/jwks") {
          if (mode === "split-deadline") await delay(1200);
          response.end(JSON.stringify(jwks));
          return;
        }
        mints += 1;
        if (mode === "unavailable") {
          response.writeHead(503);
          response.end("{}");
          return;
        }
        if (mode === "redirect") {
          response.writeHead(302, { location: "/jwks" });
          response.end();
          return;
        }
        if (mode === "oversize") {
          response.end(" ".repeat(24 * 1024 + 1));
          return;
        }
        if (mode === "slow") return;
        if (mode === "split-deadline") await delay(1200);
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString()) as {
          profile: string;
          nonce: string;
        };
        const issuedAt = Math.floor(now / 1000);
        const token = await new CompactSign(
          Buffer.from(
            JSON.stringify({
              iss: "https://growthos.test",
              aud: "temporal-runtime",
              sub: "customer-worker",
              jti: randomUUID(),
              profile: body.profile,
              permissions: ["default:worker"],
              iat: issuedAt,
              nbf: issuedAt,
              exp: issuedAt + 300,
            }),
          ),
        )
          .setProtectedHeader({
            alg: "RS256",
            typ: "temporal-runtime+jwt",
            kid: "active",
          })
          .sign(pair.privateKey);
        response.end(
          JSON.stringify({
            schemaVersion: "platform-machine-token/v1",
            profile: body.profile,
            nonce: mode === "wrong-nonce" ? "ff".repeat(16) : body.nonce,
            subject: "customer-worker",
            issuedAt,
            expiresAt: issuedAt + 300,
            configurationRevision: "ab".repeat(32),
            token,
          }),
        );
      })().catch(() => {
        response.destroy();
      });
    },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  config = {
    endpoint: `https://127.0.0.1:${port}/api/internal/v1/platform-machine-tokens`,
    jwksUri: `https://127.0.0.1:${port}/jwks`,
    ca,
    certificate: await readFile(join(directory, "client.pem")),
    privateKey: await readFile(join(directory, "client.key")),
    runtimeIdentity: "12".repeat(32),
    configurationRevision: "ab".repeat(32),
    issuer: "https://growthos.test",
    audience: "temporal-runtime",
    subject: "customer-worker",
    profile: "temporal-customer-worker",
  };
}, 20_000);
beforeEach(() => {
  for (const client of opened.splice(0)) client.close();
  now = 1_790_000_000_000;
  mode = "ok";
  mints = 0;
});
afterAll(async () => {
  for (const client of opened) client.close();
  server?.closeAllConnections();
  if (server)
    await new Promise<void>((resolve) => server.close(() => resolve()));
  if (directory) await rm(directory, { recursive: true, force: true });
});
function client(overrides: Partial<MachineTokenClientConfiguration> = {}) {
  const instance = new MachineTokenClient(
    { ...config, ...overrides },
    () => now,
  );
  opened.push(instance);
  return instance;
}
const hash = (token: string) =>
  createHash("sha256").update(token).digest("hex");

describe("machine token mTLS client", () => {
  it("revokes the in-memory handoff when clock trust becomes unavailable", async () => {
    const instance = client();
    const states: boolean[] = [];
    instance.subscribe((credential) => states.push(credential !== null));
    await instance.getToken();
    now = Number.NaN;
    expect(() => instance.currentToken()).toThrow(
      "PLATFORM_MACHINE_TOKEN_UNAVAILABLE",
    );
    expect(states.at(-1)).toBe(false);
  });
  it("never delivers a token after an earlier credential consumer shuts the runtime down", async () => {
    const instance = client();
    const observed: string[] = [];
    instance.subscribe((credential) => {
      if (credential) instance.close();
    });
    instance.subscribe((credential) =>
      observed.push(credential ? "token" : "empty"),
    );
    await expect(instance.getToken().then(() => undefined)).rejects.toThrow(
      "PLATFORM_MACHINE_TOKEN_UNAVAILABLE",
    );
    expect(observed).not.toContain("token");
  });
  it("notifies accepted rotation and expiry while synchronous RPC reads never mint", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const instance = client();
    const notifications: string[] = [];
    const unsubscribe = instance.subscribe((credential) =>
      notifications.push(credential ? hash(credential.token) : "expired"),
    );
    expect(() => instance.currentToken()).toThrow(
      "PLATFORM_MACHINE_TOKEN_UNAVAILABLE",
    );
    expect(mints).toBe(0);
    const accepted = hash(await instance.getToken());
    expect(hash(instance.currentToken())).toBe(accepted);
    expect(notifications).toEqual(["expired", accepted]);
    mode = "unavailable";
    now += 300_000;
    await vi.advanceTimersByTimeAsync(300_000);
    expect(() => instance.currentToken()).toThrow(
      "PLATFORM_MACHINE_TOKEN_UNAVAILABLE",
    );
    expect(notifications.at(-1)).toBe("expired");
    unsubscribe();
  });
  it("closes admission if a synchronous credential consumer rejects rotation", async () => {
    const instance = client();
    instance.subscribe((credential) => {
      if (credential) throw new Error("consumer failed");
    });
    await expect(instance.getToken().then(() => undefined)).rejects.toThrow(
      "PLATFORM_MACHINE_TOKEN_UNAVAILABLE",
    );
    expect(() => instance.currentToken()).toThrow(
      "PLATFORM_MACHINE_TOKEN_UNAVAILABLE",
    );
  });
  it("refreshes automatically through the same TLS endpoint without a getToken trigger", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const instance = client();
    const first = hash(await instance.getToken());
    now += 240_000;
    await vi.advanceTimersByTimeAsync(240_000);
    const deadline = performance.now() + 1500;
    while (mints < 2 && performance.now() < deadline) await delay(10);
    expect(mints).toBe(2);
    const renewed = hash(await instance.getToken());
    expect(renewed).not.toBe(first);
    expect(mints).toBe(2);
  });
  it("rebootstraps a new runtime instead of retaining the predecessor memory token", async () => {
    const first = client();
    const token = hash(await first.getToken());
    first.close();
    const second = client({ runtimeIdentity: "34".repeat(32) });
    expect(hash(await second.getToken())).not.toBe(token);
    expect(mints).toBe(2);
  });
  it("aborts an in-flight mint on shutdown and never installs its result", async () => {
    mode = "slow";
    const instance = client();
    const result = instance.getToken().then(
      () => "unexpected-token",
      (error: Error) => error.message,
    );
    const deadline = performance.now() + 1000;
    while (mints < 1 && performance.now() < deadline) await delay(10);
    expect(mints).toBe(1);
    instance.close();
    expect(await result).toBe("PLATFORM_MACHINE_TOKEN_UNAVAILABLE");
    await expect(instance.getToken().then(() => undefined)).rejects.toThrow(
      "PLATFORM_MACHINE_TOKEN_UNAVAILABLE",
    );
  });
  it("shares the total deadline across mint and JWKS rather than restarting the clock", async () => {
    mode = "split-deadline";
    await expect(
      client()
        .getToken()
        .then(() => undefined),
    ).rejects.toThrow("PLATFORM_MACHINE_TOKEN_UNAVAILABLE");
    expect(mints).toBe(1);
  });
  it("bootstraps through real mTLS and shares one physical mint across concurrent callers", async () => {
    const instance = client();
    const values = await Promise.all(
      Array.from({ length: 20 }, () => instance.getToken()),
    );
    expect(new Set(values.map(hash)).size).toBe(1);
    expect(mints).toBe(1);
    await instance.getToken();
    expect(mints).toBe(1);
  });
  it("refreshes in the last minute and retains an old token only within its original expiry", async () => {
    const instance = client();
    const first = hash(await instance.getToken());
    now += 240_000;
    const second = hash(await instance.getToken());
    expect(second).not.toBe(first);
    expect(mints).toBe(2);
    mode = "unavailable";
    now += 240_000;
    expect(hash(await instance.getToken())).toBe(second);
    now += 60_000;
    await expect(instance.getToken().then(() => undefined)).rejects.toThrow(
      "PLATFORM_MACHINE_TOKEN_UNAVAILABLE",
    );
  });
  it.each(["wrong-nonce", "redirect", "oversize"] as const)(
    "fails closed on %s without returning a token",
    async (value) => {
      mode = value;
      await expect(
        client()
          .getToken()
          .then(() => undefined),
      ).rejects.toThrow("PLATFORM_MACHINE_TOKEN_UNAVAILABLE");
    },
  );
  it("rejects missing client credentials instead of silently using JWT-only transport", async () => {
    await expect(
      client({ certificate: Buffer.alloc(0), privateKey: Buffer.alloc(0) })
        .getToken()
        .then(() => undefined),
    ).rejects.toThrow("PLATFORM_MACHINE_TOKEN_UNAVAILABLE");
    expect(mints).toBe(0);
  });
  it("bounds the entire operation when the peer never responds", async () => {
    mode = "slow";
    const started = performance.now();
    await expect(
      client()
        .getToken()
        .then(() => undefined),
    ).rejects.toThrow("PLATFORM_MACHINE_TOKEN_UNAVAILABLE");
    expect(performance.now() - started).toBeLessThan(2600);
  });
  it("invalidates memory credentials when the owning runtime shuts down", async () => {
    const instance = client();
    await instance.getToken();
    instance.close();
    await expect(instance.getToken().then(() => undefined)).rejects.toThrow(
      "PLATFORM_MACHINE_TOKEN_UNAVAILABLE",
    );
    expect(mints).toBe(1);
  });
  it("does not extend a cached credential when the wall clock moves backward", async () => {
    const instance = client();
    await instance.getToken();
    now -= 1000;
    await expect(instance.getToken().then(() => undefined)).rejects.toThrow(
      "PLATFORM_MACHINE_TOKEN_UNAVAILABLE",
    );
  });
  it("rejects a plain HTTP bootstrap configuration before opening a connection", async () => {
    await expect(
      client({ endpoint: config.endpoint.replace("https:", "http:") })
        .getToken()
        .then(() => undefined),
    ).rejects.toThrow("PLATFORM_MACHINE_TOKEN_UNAVAILABLE");
    expect(mints).toBe(0);
  });
  it("requires the configured server CA even with a valid client certificate", async () => {
    await expect(
      client({ ca: config.certificate })
        .getToken()
        .then(() => undefined),
    ).rejects.toThrow("PLATFORM_MACHINE_TOKEN_UNAVAILABLE");
    expect(mints).toBe(0);
  });
});
