import { createServer, type Server } from "node:https";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID, sign } from "node:crypto";
import { compactVerify, createLocalJWKSet } from "jose";
import { revocationFixture } from "./platform-revocation-http.test-fixture";
import { loadVerifiedPlatformAuthorityPolicyAsset } from "./platform-authority-policy-asset";
import type { RuntimeReleaseIdentity } from "../runtime/runtime-release-identity";
import { CAPABILITY_PATH } from "./platform-capability-https";

/** Test-only real TLS/mTLS/signing fixture, excluded from the product build. */
export async function capabilityRuntimeFixture() {
  const base = await revocationFixture(),
    ca = readFileSync(base.certificate),
    key = readFileSync(base.key);
  const state = {
    mode: "good",
    mints: 0,
    reads: 0,
    authorized: 0,
    factExpiry: Date.now() + 25000,
    lastNonce: "",
    bodyBytes: 0,
  };
  const identity = {
    attested: true,
    build_sha: "a".repeat(40),
    artifact_digest: `sha256:${"b".repeat(64)}`,
    image_digest: `sha256:${"c".repeat(64)}`,
  } as RuntimeReleaseIdentity;
  const root = (family: "identity" | "capability") => ({
    keys: [
      {
        ...base.pairs[family].publicKey.export({ format: "jwk" }),
        kid: family + "-key",
        alg: "RS256",
        use: "sig",
      },
    ],
  });
  const jwt = (
    payload: unknown,
    family: "identity" | "capability",
    typ: string,
  ) => {
    const compact = [{ alg: "RS256", kid: family + "-key", typ }, payload]
      .map((x) => Buffer.from(JSON.stringify(x)).toString("base64url"))
      .join(".");
    return (
      compact +
      "." +
      sign(
        "RSA-SHA256",
        Buffer.from(compact),
        base.pairs[family].privateKey,
      ).toString("base64url")
    );
  };
  const servers: Server[] = [];
  const bootstrap = createServer(
    { key, cert: ca, ca, requestCert: true, rejectUnauthorized: true },
    (req, res) => {
      void (async () => {
        if (req.url === "/identity") {
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(root("identity")));
          return;
        }
        state.mints++;
        if ((req.socket as import("node:tls").TLSSocket).authorized)
          state.authorized++;
        if (state.mode === "mintFailure") {
          res.writeHead(503).end();
          return;
        }
        const chunks = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString());
        const iat = Math.floor(Date.now() / 1000);
        const token = jwt(
          {
            iss: "https://growthos.test",
            aud: "platform-automation-capability-read",
            sub: "backend-api",
            jti: randomUUID(),
            scope: "platform-automation-capability-read",
            iat,
            nbf: iat,
            exp: iat + 300,
          },
          "identity",
          "platform-automation-capability-reader+jwt",
        );
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            schemaVersion: "platform-machine-token/v1",
            profile: body.profile,
            nonce: body.nonce,
            subject: "backend-api",
            issuedAt: iat,
            expiresAt: iat + 300,
            configurationRevision: "d".repeat(64),
            token,
          }),
        );
      })().catch(() => res.destroy());
    },
  );
  servers.push(bootstrap);
  const normal = createServer({ key, cert: ca }, (req, res) => {
    void (async () => {
      if (
        req.url === "/identity" ||
        req.url === "/.well-known/platform-capability-jwks.json"
      ) {
        if (state.mode === "jwksFailure") {
          res.writeHead(503).end();
          return;
        }
        const family = req.url === "/identity" ? "identity" : "capability";
        const document = root(
          state.mode === "crossFamily" ? "identity" : family,
        );
        res.setHeader(
          "Content-Type",
          family === "identity"
            ? "application/json"
            : "application/jwk-set+json",
        );
        res.end(JSON.stringify(document));
        return;
      }
      if (req.url !== CAPABILITY_PATH) {
        res.writeHead(404).end();
        return;
      }
      state.reads++;
      if (state.mode === "slow") return;
      if (state.mode === "redirect") {
        res.writeHead(302, { Location: "/identity" }).end();
        return;
      }
      if (state.mode === "denied") {
        res.writeHead(401).end();
        return;
      }
      const bearer = req.headers.authorization?.slice(7);
      if (!bearer) {
        res.writeHead(401).end();
        return;
      }
      const verified = await compactVerify(
        bearer,
        createLocalJWKSet(root("identity")),
      );
      if (
        verified.protectedHeader.typ !==
        "platform-automation-capability-reader+jwt"
      ) {
        res.writeHead(401).end();
        return;
      }
      const chunks = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const bytes = Buffer.concat(chunks);
      state.bodyBytes = bytes.length;
      const body = JSON.parse(bytes.toString());
      state.lastNonce = body.nonce;
      const now = Date.now(),
        iat = Math.floor(now / 1000),
        policy = loadVerifiedPlatformAuthorityPolicyAsset();
      const fact = {
        status: "ok",
        observedAt: now,
        validUntil: state.factExpiry,
      };
      const rows = policy.policy.rows.map((row) => ({
        scheduleId: row.schedule_id,
        workflowType: row.workflow_type,
        taskQueue: row.task_queue,
        mode: row.desired_mode,
        temporalPermission: fact,
        issuer: fact,
        revocationConsumer: fact,
        undeliveredCount: 0,
        oldestUndeliveredCreatedAt: null,
      }));
      if (state.mode === "enableDisabled")
        rows.find(
          (row) => row.mode === "INTENTIONALLY_DISABLED_NO_EGRESS",
        )!.mode = "ENABLED";
      const token = jwt(
        {
          iss: "https://growthos.test",
          aud: "platform-automation-capability-read",
          iat,
          exp: iat + 30,
          nonce: state.mode === "nonce" ? "0".repeat(32) : body.nonce,
          backendSha: body.backendSha,
          growthosSha: body.growthosSha,
          policyDigest: body.policyDigest,
          namespace: "platform-automation",
          rows,
        },
        "capability",
        "platform-capability+jwt",
      );
      res.setHeader(
        "Content-Type",
        state.mode === "type" ? "text/plain" : "application/jose",
      );
      res.end(state.mode === "oversize" ? "a".repeat(16385) : token);
    })().catch(() => res.destroy());
  });
  servers.push(normal);
  for (const server of servers)
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
  const origin = (server: Server) =>
    `https://127.0.0.1:${(server.address() as { port: number }).port}`;
  const files = {
    ca: join(base.directory, "machine-ca"),
    cert: join(base.directory, "machine-cert"),
    key: join(base.directory, "machine-key"),
  };
  writeFileSync(files.ca, ca, { mode: 0o600 });
  writeFileSync(files.cert, ca, { mode: 0o600 });
  writeFileSync(files.key, key, { mode: 0o600 });
  const env = {
    MACHINE_BOOTSTRAP_ENDPOINT:
      origin(bootstrap) + "/api/internal/v1/platform-machine-tokens",
    MACHINE_BOOTSTRAP_CA_FILE: files.ca,
    MACHINE_BOOTSTRAP_CERT_FILE: files.cert,
    MACHINE_BOOTSTRAP_KEY_FILE: files.key,
    MACHINE_BOOTSTRAP_CONFIGURATION_REVISION: "d".repeat(64),
    CAPABILITY_MACHINE_JWKS_URI: origin(normal) + "/identity",
    CAPABILITY_MACHINE_ISSUER: "https://growthos.test",
    CAPABILITY_MACHINE_AUDIENCE: "platform-automation-capability-read",
    CAPABILITY_MACHINE_SUBJECT: "backend-api",
    PLATFORM_CAPABILITY_ORIGIN: origin(normal) + "/",
    PLATFORM_CAPABILITY_CA_FILE: files.ca,
    PLATFORM_CAPABILITY_JWKS_URI:
      origin(normal) + "/.well-known/platform-capability-jwks.json",
    PLATFORM_CAPABILITY_ISSUER: "https://growthos.test",
    PLATFORM_CAPABILITY_GROWTHOS_SHA: "e".repeat(40),
  };
  return {
    env,
    state,
    identity,
    files,
    base,
    async close() {
      for (const server of servers) {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
      await base.close();
    },
  };
}
