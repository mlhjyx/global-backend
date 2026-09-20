import {
  generateKeyPairSync,
  randomBytes,
  sign,
  type KeyObject,
} from "node:crypto";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createServer, request } from "node:https";
import type { AddressInfo } from "node:net";
import { PLATFORM_AUTHORITY_REVOCATION_TYPE } from "@global/contracts/execution-budget";

/** Isolated TLS/key fixtures, excluded from the production build. No retained service. */
export async function revocationFixture() {
  const directory = mkdtempSync(join(tmpdir(), "revocation-http-"));
  const certificate = join(directory, "tls.pem"),
    key = join(directory, "tls.key");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      certificate,
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ],
    { stdio: "ignore" },
  );
  const names = [
    "execution",
    "identity",
    "site",
    "capability",
    "temporal",
    "ack",
  ] as const;
  const pairs = Object.fromEntries(
    names.map((name) => [
      name,
      generateKeyPairSync("rsa", { modulusLength: 2048 }),
    ]),
  ) as Record<
    (typeof names)[number],
    { privateKey: KeyObject; publicKey: KeyObject }
  >;
  const documents = new Map<string, unknown>(
    names.map((name) => [
      "/" + name,
      {
        keys: [
          {
            ...pairs[name].publicKey.export({ format: "jwk" }),
            kid: name + "-key",
            use: "sig",
            alg: "RS256",
          },
        ],
      },
    ]),
  );
  const server = createServer(
    { key: readFileSync(key), cert: readFileSync(certificate) },
    (req, res) => {
      const document = documents.get(req.url!);
      if (!document) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "Content-Type": "application/jwk-set+json" });
      res.end(
        typeof document === "string" ? document : JSON.stringify(document),
      );
    },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const signing = join(directory, "ack-signing"),
    cipher = join(directory, "ack-cipher");
  writeFileSync(
    signing,
    `platform-fence-ack-signing-keyring/v1\nack-key ACTIVE ${pairs.ack.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64")}\n`,
    { mode: 0o600 },
  );
  writeFileSync(
    cipher,
    `platform-fence-ack-cipher-keyring/v1\ncipher-key ACTIVE ${randomBytes(32).toString("base64")}\n`,
    { mode: 0o600 },
  );
  const env = {
    APP_ENVIRONMENT: "test",
    NODE_ENV: "test",
    EXECUTION_BUDGET_GRANT_ISSUER: "https://growthos.example",
    EXECUTION_BUDGET_GRANT_AUDIENCE: "global-backend:execution-budget",
    EXECUTION_BUDGET_GRANT_ALGORITHMS: "RS256",
    EXECUTION_BUDGET_GRANT_JWKS_URI: origin + "/execution",
    AUTH_JWKS_URI: origin + "/identity",
    SITE_BUILD_BUDGET_GRANT_JWKS_URI: origin + "/site",
    PLATFORM_CAPABILITY_JWKS_URI: origin + "/capability",
    TEMPORAL_MACHINE_JWKS_URI: origin + "/temporal",
    PLATFORM_FENCE_ACK_SIGNING_KEYRING_FILE: signing,
    PLATFORM_FENCE_ACK_CIPHER_KEYRING_FILE: cipher,
    PLATFORM_FENCE_ACK_ISSUER: "https://backend.example",
    PLATFORM_REVOCATION_TRUST_CA_FILE: certificate,
    PLATFORM_REVOCATION_RATE_LIMIT: "10",
    PLATFORM_REVOCATION_RATE_WINDOW_MS: "60000",
  };
  const clock = { now: Math.floor(Date.now() / 1000) };
  const claims = {
    schema_version: "PlatformExecutionBudgetAuthorityRevoked/v1",
    iss: env.EXECUTION_BUDGET_GRANT_ISSUER,
    aud: env.EXECUTION_BUDGET_GRANT_AUDIENCE,
    revocation_jti: "11111111-1111-4111-8111-111111111111",
    target_issuer: env.EXECUTION_BUDGET_GRANT_ISSUER,
    target_jti: "22222222-2222-4222-8222-222222222222",
    schedule_id: "acq-sweep",
    workflow_run_id: "33333333-3333-4333-8333-333333333333",
    fence_sequence: "1",
    reason_code: "POLICY_DISABLED",
    iat: clock.now,
    nbf: clock.now,
    exp: clock.now + 300,
  };
  const command = (
    body: Record<string, unknown> = claims,
    type: string = PLATFORM_AUTHORITY_REVOCATION_TYPE,
  ) => {
    const input = `${Buffer.from(JSON.stringify({ alg: "RS256", kid: "execution-key", typ: type })).toString("base64url")}.${Buffer.from(JSON.stringify(body)).toString("base64url")}`;
    return `${input}.${sign("RSA-SHA256", Buffer.from(input), pairs.execution.privateKey).toString("base64url")}`;
  };
  return {
    directory,
    certificate,
    key,
    env,
    clock,
    claims,
    pairs,
    documents,
    command,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
export function tlsRequest(
  url: string,
  ca: Buffer,
  body?: string,
  headers: Record<string, string> = {},
  method = "POST",
) {
  return new Promise<{
    status: number;
    headers: import("node:http").IncomingHttpHeaders;
    body: string;
  }>((resolve, reject) => {
    const req = request(
      url,
      {
        ca,
        rejectUnauthorized: true,
        agent: false,
        method,
        headers: {
          ...(body === undefined
            ? {}
            : {
                "Content-Type": "application/jose",
                "Content-Length": String(Buffer.byteLength(body)),
              }),
          ...headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (data) => chunks.push(Buffer.from(data)));
        res.on("error", reject);
        res.on("end", () =>
          resolve({
            status: res.statusCode!,
            headers: res.headers,
            body: Buffer.concat(chunks).toString(),
          }),
        );
      },
    );
    req.on("error", reject);
    req.setTimeout(4000, () => req.destroy(new Error("TEST_TIMEOUT")));
    req.end(body);
  });
}
