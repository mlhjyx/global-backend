import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  exportJWK,
  generateKeyPair,
  jwtVerify,
  SignJWT,
  type JWK,
  type KeyLike,
} from "jose";
import { createCapabilityCache } from "./platform-capability-cache";
import { createCapabilityTransport } from "./platform-capability-transport";

// Test-only producer. It exercises real loopback HTTP and JOSE, not GrowthOS
// deployment, Temporal proof, service credential provisioning or product ready.
const NOW = 1_800_000_000_500;
const ISSUER = "https://control-plane.example.test";
const AUD = "platform-automation-capability-read";
const expected = {
  issuer: ISSUER,
  audience: AUD,
  backendSha: "b".repeat(40),
  growthosSha: "c".repeat(40),
  policyDigest: "d".repeat(64),
};
const schedules = [
  {
    scheduleId: "acq-sweep",
    workflowType: "acquisitionSweepWorkflow",
    taskQueue: "understanding",
    mode: "ENABLED",
  },
] as const;
let servicePrivate: KeyLike;
let servicePublic: KeyLike;
let capabilityPrivate: KeyLike;
let capabilityPublic: JWK;
let server: Server | undefined;
let cache: ReturnType<typeof createCapabilityCache> | undefined;
let now = NOW;
beforeAll(async () => {
  const service = await generateKeyPair("RS256");
  servicePrivate = service.privateKey;
  servicePublic = service.publicKey;
  const capability = await generateKeyPair("RS256", { extractable: true });
  capabilityPrivate = capability.privateKey;
  capabilityPublic = {
    ...(await exportJWK(capability.publicKey)),
    kid: "capability-1",
    alg: "RS256",
    use: "sig",
  };
});
afterEach(async () => {
  cache?.stop();
  cache = undefined;
  now = NOW;
  if (server) {
    const current = server;
    server = undefined;
    current.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      current.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
async function serviceToken(subject = "backend:capability-reader") {
  return new SignJWT({ scope: "platform-automation-capability-read" })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(ISSUER)
    .setAudience(AUD)
    .setSubject(subject)
    .setIssuedAt(Math.floor(NOW / 1000))
    .setExpirationTime(Math.floor(NOW / 1000) + 30)
    .sign(servicePrivate);
}
async function responseToken(nonce: string, signer = capabilityPrivate) {
  const fact = { status: "ok", observedAt: NOW, validUntil: NOW + 1000 };
  return new SignJWT({
    nonce,
    backendSha: expected.backendSha,
    growthosSha: expected.growthosSha,
    policyDigest: expected.policyDigest,
    namespace: "platform-automation",
    rows: schedules.map((row) => ({
      ...row,
      temporalPermission: fact,
      issuer: fact,
      revocationConsumer: fact,
      undeliveredCount: 0,
      oldestUndeliveredCreatedAt: null,
    })),
  })
    .setProtectedHeader({
      alg: "RS256",
      kid: "capability-1",
      typ: "platform-capability+jwt",
    })
    .setIssuer(ISSUER)
    .setAudience(AUD)
    .setIssuedAt(Math.floor(NOW / 1000))
    .setExpirationTime(Math.floor(NOW / 1000) + 30)
    .sign(signer);
}
async function setup(
  options: {
    ordinaryUser?: boolean;
    reply?: (nonce: string) => Promise<string>;
    deny?: () => boolean;
  } = {},
) {
  const seen: { nonce: string; body: Record<string, unknown> }[] = [];
  let denied = 0;
  server = createServer((request, response) => {
    void (async () => {
      if (request.method !== "POST" || request.url !== "/capabilities")
        throw new Error("route");
      const authorization = request.headers.authorization;
      if (!authorization?.startsWith("Bearer ")) throw new Error("auth");
      const verified = await jwtVerify(authorization.slice(7), servicePublic, {
        algorithms: ["RS256"],
        issuer: ISSUER,
        audience: AUD,
        currentDate: new Date(NOW),
      });
      if (
        verified.payload.sub !== "backend:capability-reader" ||
        verified.payload.scope !== "platform-automation-capability-read" ||
        options.deny?.()
      )
        throw new Error("auth");
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const value of request) {
        const bytes = Buffer.from(value);
        size += bytes.length;
        if (size > 4096) throw new Error("size");
        chunks.push(bytes);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
        string,
        unknown
      >;
      if (typeof body.nonce !== "string" || !/^[a-f0-9]{32}$/.test(body.nonce))
        throw new Error("nonce");
      seen.push({ nonce: body.nonce, body });
      const reply = await (options.reply ?? responseToken)(body.nonce);
      response.writeHead(200, {
        "content-type": "application/jose",
        "cache-control": "no-store",
      });
      response.end(reply);
    })().catch(() => {
      denied++;
      response.writeHead(401, { "content-type": "text/plain" });
      response.end("denied");
    });
  });
  await new Promise<void>((resolve, reject) => {
    server!.once("error", reject);
    server!.listen(0, "127.0.0.1", resolve);
  });
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/capabilities`;
  const transport = createCapabilityTransport(
    { ...expected, endpoint, schedules },
    () =>
      serviceToken(
        options.ordinaryUser ? "user:ordinary" : "backend:capability-reader",
      ),
  );
  cache = createCapabilityCache(
    {
      expected,
      schedules,
      jwks: { keys: [capabilityPublic] },
      allowedKids: ["capability-1"],
    },
    transport,
    () => now,
  );
  return { cache, seen, denied: () => denied };
}

describe("capability receiver real HTTP integration", () => {
  it("authenticates requests, binds fresh nonces and expires on the underlying fact", async () => {
    const fixture = await setup();
    expect(fixture.cache.check("acq-sweep").status).toBe("failed");
    await fixture.cache.refresh();
    expect(fixture.cache.check("acq-sweep").status).toBe("ok");
    await fixture.cache.refresh();
    expect(fixture.seen).toHaveLength(2);
    expect(fixture.seen[0].nonce).not.toBe(fixture.seen[1].nonce);
    expect(fixture.seen[0].body).toMatchObject({
      operationId: "platformAutomationCapabilities_v1",
      backendSha: expected.backendSha,
      growthosSha: expected.growthosSha,
      policyDigest: expected.policyDigest,
      namespace: "platform-automation",
      schedules,
    });
    now = NOW + 1000;
    expect(fixture.cache.check("acq-sweep").status).toBe("failed");
    expect(fixture.denied()).toBe(0);
  });
  it("does not accept a valid ordinary-user token as a service identity", async () => {
    const fixture = await setup({ ordinaryUser: true });
    await fixture.cache.refresh();
    expect(fixture.cache.check("acq-sweep").status).toBe("failed");
    expect(fixture.denied()).toBe(1);
    expect(fixture.seen).toHaveLength(0);
  });
  it("rejects capability responses signed by a different otherwise valid key", async () => {
    const fixture = await setup({
      reply: (nonce) => responseToken(nonce, servicePrivate),
    });
    await fixture.cache.refresh();
    expect(fixture.cache.check("acq-sweep").status).toBe("failed");
    expect(fixture.seen).toHaveLength(1);
  });
  it("rejects a previously valid response replayed for a fresh request", async () => {
    let previous = "";
    const fixture = await setup({
      reply: async (nonce) => {
        previous ||= await responseToken(nonce);
        return previous;
      },
    });
    await fixture.cache.refresh();
    expect(fixture.cache.check("acq-sweep").status).toBe("ok");
    await fixture.cache.refresh();
    expect(fixture.cache.check("acq-sweep").status).toBe("failed");
  });
  it("clears a good cache when the service later refuses authentication", async () => {
    let deny = false;
    const fixture = await setup({ deny: () => deny });
    await fixture.cache.refresh();
    expect(fixture.cache.check("acq-sweep").status).toBe("ok");
    deny = true;
    await fixture.cache.refresh();
    expect(fixture.cache.check("acq-sweep").status).toBe("failed");
  });
});
