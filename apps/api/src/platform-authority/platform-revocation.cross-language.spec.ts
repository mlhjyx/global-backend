import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createLocalJWKSet, compactVerify } from "jose";
import { expect, it } from "vitest";
import { PlatformAuthorityFenceAckClaimsSchema, PLATFORM_AUTHORITY_FENCE_ACK_TYPE } from "@global/contracts/execution-budget";
import { PlatformRevocationVerifier } from "./platform-revocation-verifier";
import { createPlatformRevocationVerifier } from "./platform-revocation-verifier.composition";

const artifactPath = process.env.PLATFORM_REVOCATION_JAVA_TEST_ARTIFACT;
it.runIf(Boolean(artifactPath))("verifies GrowthOS Java-produced command and dedicated ACK across processes", async () => {
  let artifact;
  try { artifact = JSON.parse(readFileSync(artifactPath!, "utf8")); }
  catch { throw new Error("CROSS_LANGUAGE_TEST_ARTIFACT_INVALID"); }
  for (const ring of [artifact.command_jwks, artifact.ack_jwks]) {
    for (const key of ring.keys) {
      const containsPrivateMaterial = Object.keys(key).some(field => ["d", "p", "q", "dp", "dq", "qi", "k"].includes(field));
      expect(containsPrivateMaterial).toBe(false);
    }
  }
  const verifier = new PlatformRevocationVerifier({ issuer: "https://growthos.example",
    keyResolver: createLocalJWKSet(artifact.command_jwks), now: () => artifact.now });
  const command = await verifier.inspect(artifact.command_jws);
  expect(command.expired).toBe(false);
  expect(command.tokenSha256).toBe(artifact.command_sha256);
  const ack = await compactVerify(artifact.ack_jws, createLocalJWKSet(artifact.ack_jwks), { algorithms: ["RS256"] });
  expect(ack.protectedHeader.typ).toBe(PLATFORM_AUTHORITY_FENCE_ACK_TYPE);
  const claims = PlatformAuthorityFenceAckClaimsSchema.parse(JSON.parse(new TextDecoder().decode(ack.payload)));
  expect(claims.iss).toBe("https://backend.example");
  expect(claims.command_sha256).toBe(command.tokenSha256);
  expect(claims.revocation_jti).toBe(command.claims.revocation_jti);
  expect(claims.schedule_id).toBe(command.claims.schedule_id);
  expect(claims.fence_sequence).toBe(command.claims.fence_sequence);
  await expect(verifier.inspect(artifact.ack_jws)).rejects.toThrow("PLATFORM_REVOCATION_INVALID");
  expect(createHash("sha256").update(artifact.command_jws).digest("hex")).toBe(command.tokenSha256);

  // Exercise the real bounded JWKS factory with public test keys, without external network.
  const configured = createPlatformRevocationVerifier({
    APP_ENVIRONMENT: "development", NODE_ENV: "development",
    EXECUTION_BUDGET_GRANT_JWKS_URI: "https://growthos.example/execution-budget-jwks.json",
    EXECUTION_BUDGET_GRANT_ISSUER: "https://growthos.example",
    EXECUTION_BUDGET_GRANT_AUDIENCE: "global-backend:execution-budget",
    EXECUTION_BUDGET_GRANT_ALGORITHMS: "RS256",
  }, { now: () => artifact.now,
    fetcher: async (_url, init) => {
      expect(init.redirect).toBe("error");
      return new Response(JSON.stringify(artifact.command_jwks), { status: 200 });
    } });
  expect(configured).not.toBeNull();
  expect((await configured!.inspect(artifact.command_jws)).tokenSha256).toBe(command.tokenSha256);
});
