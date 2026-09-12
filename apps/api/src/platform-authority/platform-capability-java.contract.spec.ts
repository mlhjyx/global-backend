import { readFileSync } from "node:fs";
import { compactVerify, createLocalJWKSet } from "jose";
import { describe, expect, it } from "vitest";
import { verifyCapabilityEnvelope } from "./platform-capability-signature";
import { validateCapabilityRows } from "./platform-capability-rows";

// Frozen output of the actual GrowthOS Java signer, never re-signed in Node.
// Only ephemeral test public keys are retained; no private key or live token.
const stored = JSON.parse(
  readFileSync(
    new URL(
      "../../../../packages/test-support/fixtures/platform-capability-java-v1.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
// Cryptographic vectors retain the three original segments. Joining is not
// re-signing or secret protection: safety comes from ephemeral test provenance.
const fixture = {
  ...stored,
  token: stored.token.join("."),
  wrongAudienceToken: stored.wrongAudienceToken.join("."),
};
const now = 1_800_000_000_500;
const expected = {
  issuer: "https://growthos.example" + String.fromCharCode(0x1b) + "/汉字/😀",
  audience: "platform-automation-capability-read",
  nonce: "d".repeat(32),
  backendSha: "a".repeat(40),
  growthosSha: "b".repeat(40),
  policyDigest: "c".repeat(64),
};
const kids = ["capability-active", "capability-old"];
const schedules = [
  {
    scheduleId: "sanctions-refresh",
    workflowType: "SanctionsWorkflow",
    taskQueue: "platform",
    mode: "ENABLED" as const,
  },
];

describe("GrowthOS Java capability golden contract", () => {
  it("accepts actual Java bytes with lowercase escapes and the earliest fact deadline", async () => {
    expect(fixture.schemaVersion).toBe("platform-capability-java-vector/v1");
    expect(fixture.issuer).toBe(expected.issuer);
    expect(fixture.provenance.javaPatchSha256).toBe(
      "9b0e80db0e72b0d7e2f3daa057fe3940d2969d91b8d4c34965cebedb75292498",
    );
    for (const key of fixture.jwks.keys) {
      expect(Object.keys(key).sort()).toEqual([
        "alg",
        "e",
        "kid",
        "kty",
        "n",
        "use",
      ]);
    }
    const result = await verifyCapabilityEnvelope(
      fixture.token,
      expected,
      fixture.jwks,
      kids,
      now,
    );
    const raw = Buffer.from(fixture.token.split(".")[1], "base64url").toString(
      "utf8",
    );
    expect(raw).toBe(JSON.stringify(JSON.parse(raw)));
    expect(raw).toContain("\\u001b");
    expect(raw).toContain("汉字/😀");
    expect(result.iat).toBe(1_800_000_000);
    expect(result.exp).toBe(1_800_000_030);
    expect(
      validateCapabilityRows(
        result.rows,
        schedules,
        1_800_000_000_000,
        1_800_000_030_000,
        now,
      )[0].validUntil,
    ).toBe(1_800_000_020_000);
  });

  it("rejects a genuinely Java-signed wrong-audience token, not merely a broken signature", async () => {
    const validSignature = await compactVerify(
      fixture.wrongAudienceToken,
      createLocalJWKSet(fixture.jwks),
      { algorithms: ["RS256"] },
    );
    expect(
      JSON.parse(new TextDecoder().decode(validSignature.payload)).aud,
    ).toBe("global-backend:platform-technical-quote");
    await expect(
      verifyCapabilityEnvelope(
        fixture.wrongAudienceToken,
        expected,
        fixture.jwks,
        kids,
        now,
      ),
    ).rejects.toThrow();
  });

  it("rejects corrupted signatures", async () => {
    const parts = fixture.token.split(".");
    const signature = Buffer.from(parts[2], "base64url");
    signature[0] ^= 1;
    parts[2] = signature.toString("base64url");
    await expect(
      verifyCapabilityEnvelope(
        parts.join("."),
        expected,
        fixture.jwks,
        kids,
        now,
      ),
    ).rejects.toThrow();
  });

  it.each(["nonce", "backendSha", "growthosSha", "policyDigest"])(
    "rejects changed %s",
    async (field) => {
      await expect(
        verifyCapabilityEnvelope(
          fixture.token,
          {
            ...expected,
            [field]: "e".repeat(
              field === "nonce" ? 32 : field === "policyDigest" ? 64 : 40,
            ),
          },
          fixture.jwks,
          kids,
          now,
        ),
      ).rejects.toThrow();
    },
  );

  it("rejects a key-family substitution and expiry without extending the facts", async () => {
    await expect(
      verifyCapabilityEnvelope(
        fixture.token,
        expected,
        fixture.jwks,
        ["identity-active"],
        now,
      ),
    ).rejects.toThrow();
    await expect(
      verifyCapabilityEnvelope(
        fixture.token,
        expected,
        fixture.jwks,
        kids,
        1_800_000_030_000,
      ),
    ).rejects.toThrow();
    const result = await verifyCapabilityEnvelope(
      fixture.token,
      expected,
      fixture.jwks,
      kids,
      now,
    );
    expect(() =>
      validateCapabilityRows(
        result.rows,
        schedules,
        1_800_000_000_000,
        1_800_000_030_000,
        1_800_000_020_000,
      ),
    ).toThrow();
  });
});
