import { describe, expect, it } from "vitest";
import {
  PlatformAuthorityTargetLookupRequestSchema,
  PlatformAuthorityTargetObservationSchema,
  PlatformAuthorityTargetReaderClaimsSchema,
} from "@global/contracts/platform-authority/target-lookup";
import {
  PlatformAuthorityFenceAckClaimsSchema,
  PlatformAuthorityRevocationClaimsSchema,
} from "../../../../packages/contracts/src/platform-authority/revocation";

const request = {
  target_issuer: "https://growthos.example",
  target_jti: "22222222-2222-4222-8222-222222222222",
  schedule_id: "acq-sweep",
  workflow_run_id: "33333333-3333-4333-8333-333333333333",
  nonce: "0123456789abcdef0123456789abcdef",
};
const observation = {
  schema_version: "platform-authority-target-observation/v1",
  ...request,
  found: true,
  observed_at: 1788830000,
};
const claims = {
  iss: "https://growthos.example",
  aud: "global-backend:platform-authority-target-read",
  sub: "growthos:control-plane",
  scope: "platform-authority.target.read",
  jti: "11111111-1111-4111-8111-111111111111",
  iat: 1788830000,
  nbf: 1788830000,
  exp: 1788830300,
};

describe("platform target lookup payload contracts (not authentication or fence evidence)", () => {
  it("preserves the exact request, positive observation and dedicated service token values", () => {
    expect(PlatformAuthorityTargetLookupRequestSchema.parse(request)).toEqual(
      request,
    );
    expect(PlatformAuthorityTargetObservationSchema.parse(observation)).toEqual(
      observation,
    );
    expect(PlatformAuthorityTargetReaderClaimsSchema.parse(claims)).toEqual(
      claims,
    );
  });

  it.each([
    { workspace_id: "tenant" },
    { namespace: "platform-automation" },
    { endpoint: "https://other.example" },
    { target_jti: "bad" },
    { target_jti: "22222222-2222-0222-8222-222222222222" },
    { workflow_run_id: "33333333-3333-4333-7333-333333333333" },
    { workflow_run_id: "33333333-3333-4333-8333-33333333333A" },
    { schedule_id: "unknown" },
    { schedule_id: "acq-sweep " },
    { nonce: "0123456789ABCDEF0123456789ABCDEF" },
    { nonce: "a".repeat(31) },
    { nonce: "a".repeat(33) },
    { nonce: "g".repeat(32) },
    { nonce: null },
  ])(
    "rejects expanded or malformed tuple/nonce %j in requests and observations",
    (mutation) => {
      expect(
        PlatformAuthorityTargetLookupRequestSchema.safeParse({
          ...request,
          ...mutation,
        }).success,
      ).toBe(false);
      expect(
        PlatformAuthorityTargetObservationSchema.safeParse({
          ...observation,
          ...mutation,
        }).success,
      ).toBe(false);
    },
  );

  it.each([
    "not-a-url",
    "ftp://growthos.example",
    "http://remote.example",
    "https://user:pass@growthos.example",
    "https://growthos.example?query=1",
    "https://growthos.example#fragment",
    "https://growthos.example\n",
    "https://growthos.example\u0000",
    "https://growthos.example\u007f",
    "",
    "x".repeat(2049),
  ])("reuses the existing issuer rejection boundary: %s", (issuer) => {
    expect(
      PlatformAuthorityTargetLookupRequestSchema.safeParse({
        ...request,
        target_issuer: issuer,
      }).success,
    ).toBe(false);
    expect(
      PlatformAuthorityTargetReaderClaimsSchema.safeParse({
        ...claims,
        iss: issuer,
      }).success,
    ).toBe(false);
  });

  it.each([
    "acq-sweep",
    "intent-sweep",
    "sanctions-refresh",
    "patents-cache-refresh",
  ])(
    "accepts existing schedule identity %s without asserting policy enablement",
    (schedule_id) => {
      expect(
        PlatformAuthorityTargetLookupRequestSchema.parse({
          ...request,
          schedule_id,
        }).schedule_id,
      ).toBe(schedule_id);
    },
  );

  it.each([
    "http://127.0.0.1:18081",
    "http://localhost:18081",
    "https://growthos.example/path",
  ])(
    "preserves revocation issuer syntax without authorizing a lookup transport origin: %s",
    (target_issuer) => {
      expect(
        PlatformAuthorityTargetLookupRequestSchema.parse({
          ...request,
          target_issuer,
        }).target_issuer,
      ).toBe(target_issuer);
    },
  );

  it.each([
    { found: false },
    { found: "true" },
    { found: undefined },
    { schema_version: "PlatformExecutionBudgetFenceAcknowledged/v1" },
    { authority_id: "44444444-4444-4444-8444-444444444444" },
    { state: "DISABLED_EFFECTIVE" },
    { observed_at: -1 },
    { observed_at: 1.5 },
    { observed_at: "1788830000" },
    { observed_at: 253402300800 },
    { observed_at: Number.MAX_SAFE_INTEGER + 1 },
    { observed_at: Number.POSITIVE_INFINITY },
    { observed_at: Number.NaN },
  ])(
    "does not fabricate not-found/fence success or accept invalid observation time %j",
    (mutation) => {
      expect(
        PlatformAuthorityTargetObservationSchema.safeParse({
          ...observation,
          ...mutation,
        }).success,
      ).toBe(false);
    },
  );

  it.each([
    { aud: "global-backend" },
    { aud: "global-backend:platform-technical-quote" },
    { aud: ["global-backend:platform-authority-target-read"] },
    { scope: "platform-technical-quote.read" },
    { scope: "platform-authority.target.read admin" },
    { scope: ["platform-authority.target.read"] },
    { sub: "" },
    { sub: null },
    { sub: 1 },
    { jti: "bad" },
    { jti: "11111111-1111-4111-8111-11111111111A" },
    { role: "ADMIN" },
    { target_issuer: request.target_issuer },
    { jku: "https://attacker.example" },
    { nbf: claims.iat - 1 },
    { nbf: claims.exp },
    { exp: claims.iat },
    { exp: claims.iat + 301 },
    { iat: -1 },
    { iat: 1.5 },
    { nbf: "1788830000" },
    { exp: Number.MAX_SAFE_INTEGER + 1 },
    { iat: Number.NEGATIVE_INFINITY },
    { exp: Number.NaN },
    { iat: 253402300799, nbf: 253402300799, exp: 253402300800 },
  ])(
    "rejects wrong-purpose, expanded or temporally malformed service claims %j",
    (mutation) => {
      expect(
        PlatformAuthorityTargetReaderClaimsSchema.safeParse({
          ...claims,
          ...mutation,
        }).success,
      ).toBe(false);
    },
  );

  it("requires every declared field rather than filling defaults or dropping unknown fields", () => {
    for (const [schema, value] of [
      [PlatformAuthorityTargetLookupRequestSchema, request],
      [PlatformAuthorityTargetObservationSchema, observation],
      [PlatformAuthorityTargetReaderClaimsSchema, claims],
    ] as const) {
      for (const field of Object.keys(value)) {
        const incomplete = { ...value } as Record<string, unknown>;
        delete incomplete[field];
        expect(schema.safeParse(incomplete).success, field).toBe(false);
      }
      for (const invalid of [null, [], "{}", { ...value, extra: true }])
        expect(schema.safeParse(invalid).success).toBe(false);
    }
  });

  it("validates payload arithmetic only; trust, fixed deployment identity, freshness and request binding belong to consumers", () => {
    for (const times of [
      { iat: 0, nbf: 0, exp: 1 },
      { iat: 253402300499, nbf: 253402300798, exp: 253402300799 },
    ])
      expect(
        PlatformAuthorityTargetReaderClaimsSchema.parse({
          ...claims,
          ...times,
        }),
      ).toEqual({ ...claims, ...times });
    expect(
      PlatformAuthorityTargetReaderClaimsSchema.parse({
        ...claims,
        sub: "another-deployment-subject",
      }).sub,
    ).toBe("another-deployment-subject");
    for (const observed_at of [0, 253402300799])
      expect(
        PlatformAuthorityTargetObservationSchema.parse({
          ...observation,
          observed_at,
        }).observed_at,
      ).toBe(observed_at);
    expect(
      PlatformAuthorityTargetObservationSchema.parse({
        ...observation,
        nonce: "f".repeat(32),
      }).nonce,
    ).toBe("f".repeat(32));
    expect(
      PlatformAuthorityRevocationClaimsSchema.safeParse(claims).success,
    ).toBe(false);
    expect(
      PlatformAuthorityFenceAckClaimsSchema.safeParse(observation).success,
    ).toBe(false);
  });
});
