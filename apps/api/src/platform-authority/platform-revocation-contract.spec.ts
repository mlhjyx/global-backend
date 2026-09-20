import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  PlatformAuthorityRevocationClaimsSchema,
  PlatformAuthorityFenceAckClaimsSchema,
} from "../../../../packages/contracts/src/platform-authority/revocation";

const command = {
  schema_version: "PlatformExecutionBudgetAuthorityRevoked/v1",
  iss: "https://growthos.example",
  aud: "global-backend:execution-budget",
  revocation_jti: "11111111-1111-4111-8111-111111111111",
  target_issuer: "https://growthos.example",
  target_jti: "22222222-2222-4222-8222-222222222222",
  schedule_id: "acq-sweep",
  workflow_run_id: "33333333-3333-4333-8333-333333333333",
  fence_sequence: "1",
  reason_code: "POLICY_DISABLED",
  iat: 1788830000, nbf: 1788830000, exp: 1788830300,
};
const ack = {
  schema_version: "PlatformExecutionBudgetFenceAcknowledged/v1",
  iss: "https://backend.example",
  aud: "growthos:platform-authority-fence-ack",
  jti: "44444444-4444-4444-8444-444444444444",
  revocation_jti: command.revocation_jti,
  command_sha256: "a".repeat(64),
  schedule_id: command.schedule_id,
  fence_sequence: "1",
  backend_generation: "1",
  committed_at: 1788830000,
  in_flight_attempts: "0",
  iat: 1788830000, nbf: 1788830000, exp: 1788830300,
};

describe("signed platform revocation and dedicated ACK payload contracts", () => {
  it("consumes the same payload corpus as the GrowthOS Java signing and ACK kernels", () => {
    const vectors = JSON.parse(readFileSync(new URL("../../../../packages/test-support/fixtures/platform-revocation-ack-v1-vectors.json", import.meta.url), "utf8"));
    expect(vectors.schema_version).toBe("platform-revocation-ack-vectors/v1");
    expect(PlatformAuthorityRevocationClaimsSchema.parse(vectors.command)).toEqual(command);
    expect(PlatformAuthorityFenceAckClaimsSchema.parse(vectors.ack)).toEqual(ack);
  });
  it("accepts exact command and durable ACK shapes without changing values", () => {
    expect(PlatformAuthorityRevocationClaimsSchema.parse(command)).toEqual(command);
    expect(PlatformAuthorityFenceAckClaimsSchema.parse(ack)).toEqual(ack);
  });
  it.each(["0", "01", "-1", "1.0", "1e2", "9223372036854775808", 1, null])(
    "rejects noncanonical or unrepresentable fence sequence %s", (fence_sequence) => {
      expect(PlatformAuthorityRevocationClaimsSchema.safeParse({ ...command, fence_sequence }).success).toBe(false);
      expect(PlatformAuthorityFenceAckClaimsSchema.safeParse({ ...ack, fence_sequence }).success).toBe(false);
    },
  );
  it.each([
    { reason_code: "anything" }, { schedule_id: "unknown" }, { target_jti: "bad" },
    { workflow_run_id: "33333333-3333-4333-8333-33333333333A" },
    { exp: command.iat + 301 }, { nbf: command.iat - 1 }, { exp: command.iat },
    { iat: 1.5 }, { cap_microusd: "100" }, { target_issuer: "https://other.example" },
  ])("rejects malformed or expanded command %j", (mutation) => {
    expect(PlatformAuthorityRevocationClaimsSchema.safeParse({ ...command, ...mutation }).success).toBe(false);
  });
  it.each([
    { aud: command.aud }, { schema_version: command.schema_version },
    { command_sha256: "a".repeat(63) }, { committed_at: ack.iat + 1 },
    { in_flight_attempts: "-1" }, { backend_generation: "0" },
    { exp: ack.iat + 301 }, { state: "DISABLED_EFFECTIVE" },
  ])("rejects substituted or unbound ACK %j", (mutation) => {
    expect(PlatformAuthorityFenceAckClaimsSchema.safeParse({ ...ack, ...mutation }).success).toBe(false);
  });
  it("cannot substitute ACK and revocation payloads for one another", () => {
    expect(PlatformAuthorityRevocationClaimsSchema.safeParse(ack).success).toBe(false);
    expect(PlatformAuthorityFenceAckClaimsSchema.safeParse(command).success).toBe(false);
  });
  it.each(["not-a-url", "ftp://growthos.example", "http://remote.example", "https://user:pass@growthos.example", "https://growthos.example?secret=x", "https://growthos.example#fragment", "https://growthos.example\n"])(
    "rejects unsafe issuer syntax %s", (iss) => {
      expect(PlatformAuthorityRevocationClaimsSchema.safeParse({ ...command, iss, target_issuer: iss }).success).toBe(false);
    },
  );
  it.each(["http://127.0.0.1:18081", "http://localhost:18081"])(
    "allows isolated loopback trust configuration with unchanged contract %s", (iss) => {
      expect(PlatformAuthorityRevocationClaimsSchema.safeParse({ ...command, iss, target_issuer: iss }).success).toBe(true);
    },
  );
});
