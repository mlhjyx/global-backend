import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PlatformRevocationTrustRuntime } from "./platform-revocation-trust.runtime";
import { revocationFixture } from "./platform-revocation-http.test-fixture";

describe("revocation runtime real HTTPS and key-family admission", () => {
  let fixture: Awaited<ReturnType<typeof revocationFixture>>;
  beforeAll(async () => {
    fixture = await revocationFixture();
  }, 15000);
  afterAll(async () => fixture?.close());
  it("loads purpose keyrings and authenticates command only after actual independent family reads", async () => {
    const runtime = new PlatformRevocationTrustRuntime(
      fixture.env,
      () => fixture.clock.now,
    );
    const opened = await runtime.open(new AbortController().signal);
    expect((await opened.verifier.inspect(fixture.command())).claims).toEqual(
      fixture.claims,
    );
    expect(opened.material.jwks.keys.map((k) => k.kid)).toEqual(["ack-key"]);
    runtime.onModuleDestroy();
  });
  it("fails closed for missing configuration, wrong CA and reused signing material", async () => {
    await expect(
      new PlatformRevocationTrustRuntime({}).open(new AbortController().signal),
    ).rejects.toThrow("PLATFORM_REVOCATION_UNAVAILABLE");
    const original = fixture.documents.get("/identity");
    fixture.documents.set("/identity", {
      keys: [
        {
          ...fixture.pairs.ack.publicKey.export({ format: "jwk" }),
          kid: "other-key",
          use: "sig",
          alg: "RS256",
        },
      ],
    });
    try {
      await expect(
        new PlatformRevocationTrustRuntime(fixture.env).open(
          new AbortController().signal,
        ),
      ).rejects.toThrow("PLATFORM_REVOCATION_UNAVAILABLE");
    } finally {
      fixture.documents.set("/identity", original);
    }
    await expect(
      new PlatformRevocationTrustRuntime({
        ...fixture.env,
        PLATFORM_REVOCATION_TRUST_CA_FILE: fixture.key,
      }).open(new AbortController().signal),
    ).rejects.toThrow();
  });
  it("does not accept execution/identity key reuse even when ACK itself is separate", async () => {
    const original = fixture.documents.get("/identity");
    fixture.documents.set("/identity", {
      keys: [
        {
          ...fixture.pairs.execution.publicKey.export({ format: "jwk" }),
          kid: "identity-key",
          use: "sig",
          alg: "RS256",
        },
      ],
    });
    try {
      await expect(
        new PlatformRevocationTrustRuntime(fixture.env).open(
          new AbortController().signal,
        ),
      ).rejects.toThrow("PLATFORM_REVOCATION_UNAVAILABLE");
    } finally {
      fixture.documents.set("/identity", original);
    }
  });
});
