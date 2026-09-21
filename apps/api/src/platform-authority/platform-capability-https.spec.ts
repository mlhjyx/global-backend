import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { createServer } from "node:https";
import { CapabilityHttpsClient } from "./platform-capability-https";
import { revocationFixture } from "./platform-revocation-http.test-fixture";

describe("dedicated capability HTTPS public trust boundary", () => {
  let fixture: Awaited<ReturnType<typeof revocationFixture>>;
  beforeAll(async () => {
    fixture = await revocationFixture();
  }, 15000);
  afterAll(async () => fixture?.close());
  it("loads actual independent identity and capability public keys with the explicit CA", async () => {
    const origin = new URL(fixture.env.PLATFORM_CAPABILITY_JWKS_URI).origin;
    const client = new CapabilityHttpsClient({
      origin: origin + "/",
      ca: readFileSync(fixture.certificate),
      identityJwksUri: origin + "/identity",
      capabilityJwksUri: origin + "/capability",
    });
    const keys = await client.loadKeys(new AbortController().signal);
    expect(keys.keys[0].kid).toBe("capability-key");
    client.close();
    await expect(client.loadKeys(new AbortController().signal)).rejects.toThrow(
      "PLATFORM_CAPABILITY_UNAVAILABLE",
    );
  });
  it("rejects actual cross-family SPKI reuse even under another kid", async () => {
    const origin = new URL(fixture.env.PLATFORM_CAPABILITY_JWKS_URI).origin;
    const original = fixture.documents.get("/capability");
    fixture.documents.set("/capability", {
      keys: [
        {
          ...fixture.pairs.identity.publicKey.export({ format: "jwk" }),
          kid: "different",
          alg: "RS256",
          use: "sig",
        },
      ],
    });
    const client = new CapabilityHttpsClient({
      origin: origin + "/",
      ca: readFileSync(fixture.certificate),
      identityJwksUri: origin + "/identity",
      capabilityJwksUri: origin + "/capability",
    });
    try {
      await expect(
        client.loadKeys(new AbortController().signal),
      ).rejects.toThrow("PLATFORM_CAPABILITY_UNAVAILABLE");
    } finally {
      client.close();
      fixture.documents.set("/capability", original);
    }
  });
  it.each([
    "http://127.0.0.1/",
    "https://user@localhost/",
    "https://localhost/path",
    "https://localhost/?x=1",
    "https://localhost/#x",
    "https://localhost/?",
    "https://localhost/#",
    "https://localhost:0/",
  ])("refuses nonfixed origins %s", (origin) => {
    expect(
      () =>
        new CapabilityHttpsClient({
          origin,
          ca: readFileSync(fixture.certificate),
          identityJwksUri: "https://localhost/identity",
          capabilityJwksUri: "https://localhost/capability",
        }),
    ).toThrow();
  });
  it("actually rejects untrusted CA and wrong hostname without disabling TLS verification", async () => {
    const cert = join(fixture.directory, "wrong-host.pem"),
      key = join(fixture.directory, "wrong-host.key");
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
        cert,
        "-days",
        "1",
        "-subj",
        "/CN=wrong.example",
        "-addext",
        "subjectAltName=DNS:wrong.example",
      ],
      { stdio: "ignore" },
    );
    const server = createServer(
      { key: readFileSync(key), cert: readFileSync(cert) },
      (_req, res) => res.end("{}"),
    );
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const badOrigin = `https://127.0.0.1:${(server.address() as { port: number }).port}`;
    const goodOrigin = new URL(fixture.env.PLATFORM_CAPABILITY_JWKS_URI).origin;
    const clients = [
      new CapabilityHttpsClient({
        origin: badOrigin + "/",
        ca: readFileSync(cert),
        identityJwksUri: badOrigin + "/identity",
        capabilityJwksUri: badOrigin + "/capability",
      }),
      new CapabilityHttpsClient({
        origin: goodOrigin + "/",
        ca: readFileSync(cert),
        identityJwksUri: goodOrigin + "/identity",
        capabilityJwksUri: goodOrigin + "/capability",
      }),
    ];
    try {
      for (const client of clients)
        await expect(
          client.loadKeys(new AbortController().signal),
        ).rejects.toThrow("PLATFORM_CAPABILITY_UNAVAILABLE");
    } finally {
      clients.forEach((client) => client.close());
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
