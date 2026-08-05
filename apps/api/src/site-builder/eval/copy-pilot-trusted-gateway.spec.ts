import { createHash } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

import { canonicalDigest } from "../../model-runtime";
import { COPY_CAPABILITY_PILOT_PLAN } from "./copy-capability-pilot";
import {
  COPY_REAL_CAPABILITY_ADMISSION_SOURCE,
  type CopyRealCapabilityAdmissionInput,
} from "./copy-real-capability-admission";
import {
  createCopyPilotTrustedGateway,
  createCopyPilotTrustedGatewayBindings,
  assertCopyPilotTrustedGatewayCurrent,
  getCopyPilotTrustedCredentialAttestation,
} from "./copy-pilot-trusted-gateway";

const AUTHORIZATION_VALUE = createHash("sha256")
  .update(import.meta.url)
  .digest("hex");
const AUTHORIZATION_DIGEST = createHash("sha256")
  .update(AUTHORIZATION_VALUE)
  .digest("hex");
const servers: Array<ReturnType<typeof createServer>> = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          ),
      ),
  );
});

function sendJson(response: ServerResponse, body: unknown): void {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function gateway(input?: {
  unlimited?: boolean;
  allowlist?: readonly string[];
  modelLimit?: unknown;
  totalAvailable?: number;
}) {
  const observed: string[] = [];
  const aliases =
    input?.allowlist ??
    COPY_REAL_CAPABILITY_ADMISSION_SOURCE.executions.map(({ alias }) => alias);
  const server = createServer((request, response) => {
    observed.push(request.url ?? "");
    if (request.headers.authorization !== `Bearer ${AUTHORIZATION_VALUE}`) {
      response.writeHead(401).end();
      return;
    }
    if (request.url === "/api/usage/token") {
      sendJson(response, {
        data: {
          unlimited_quota: input?.unlimited ?? false,
          model_limits_enabled: true,
          model_limits: Object.fromEntries(
            aliases.map((alias) => [alias, input?.modelLimit ?? 1]),
          ),
          total_granted: 10_000,
          total_available: input?.totalAvailable ?? 9_900,
        },
      });
      return;
    }
    if (request.url === "/api/log/token") {
      sendJson(response, {
        data: [
          {
            request_id: "req-copy-terra-001",
            type: 2,
            model_name: "gpt-5.6-terra",
            channel: 20,
            quota: 100,
            prompt_tokens: 50,
            completion_tokens: 10,
          },
        ],
      });
      return;
    }
    const match = request.url?.match(/^\/v1\/models\/(.+)$/u);
    if (match) {
      sendJson(response, { id: decodeURIComponent(match[1]!) });
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const address = server.address() as AddressInfo;
  return { origin: `http://127.0.0.1:${address.port}`, observed };
}

function admission(origin: string): CopyRealCapabilityAdmissionInput {
  const now = Date.now();
  const capturedAt = new Date(now - 60_000).toISOString();
  const expiresAt = new Date(now + 60 * 60_000).toISOString();
  const manifest = {
    schemaVersion:
      "site-builder-copy-real-capability-manifest/2026-08-05-v1" as const,
    manifestId: "site-builder-copy-real-capability/test-v3",
    fixedSourceCommit: "a".repeat(40),
    sourceBundleDigest: "b".repeat(64),
    planDigest: canonicalDigest(COPY_CAPABILITY_PILOT_PLAN),
    dispatchAuthorization: "NOT_AUTHORIZED" as const,
    taskId: "site_builder.copy" as const,
    plannedExecutions: 3 as const,
    maximumWireCalls: 6 as const,
    maximumRepairCallsPerExecution: 1 as const,
    executions: COPY_REAL_CAPABILITY_ADMISSION_SOURCE.executions,
  };
  const credential = {
    schemaVersion:
      "site-builder-copy-pilot-credential-attestation/2026-08-05-v3" as const,
    attestationId: "copy-pilot-credential-test-v2",
    capturedAt,
    expiresAt,
    gatewayOrigin: origin,
    bearerTokenSha256: AUTHORIZATION_DIGEST,
    purpose: "site_builder_copy_capability_pilot" as const,
    quotaMode: "limited" as const,
    quotaCapPoints: 10_000,
    remainingQuotaPoints: 9_900,
    maximumQuotaPointsPerWire: 1_000,
    reservedQuotaPoints: 6_000,
    scopeExact: true as const,
    repairPayloadPolicy: "bounded_structured_prior_output_64k" as const,
    executions: COPY_REAL_CAPABILITY_ADMISSION_SOURCE.executions,
    channels: COPY_REAL_CAPABILITY_ADMISSION_SOURCE.executions.map(
      ({ alias, protocol }, index) => ({
        alias,
        protocol,
        channelId: index + 20,
      }),
    ),
    resolverId: "copy-pilot-request-bound-resolver-v2",
  };
  const settlement = {
    schemaVersion:
      "site-builder-copy-pilot-settlement-observer/2026-08-05-v1" as const,
    resolverId: credential.resolverId,
    status: "READY" as const,
    observation: "request_bound_new_api_consume_log" as const,
    requestIdentityHeader: "x-oneapi-request-id" as const,
    requiredObservationPerPhysicalCall: true as const,
    maximumPollDurationMs: 2_000,
    unknownSettlementPolicy: "freeze_campaign" as const,
  };
  return {
    manifest,
    sourceVerification: {
      fixedSourceCommit: manifest.fixedSourceCommit,
      sourceBundleDigest: manifest.sourceBundleDigest,
      fixedCommitReachableFromExecutionHead: true,
      trackedSourceBytesMatch: true,
      compiledContractsMatch: true,
    },
    credential,
    settlement,
    authorization: {
      schemaVersion:
        "site-builder-copy-pilot-dispatch-authorization/2026-08-05-v1",
      authorizationId: "copy-pilot-authorization-test-v3",
      status: "AUTHORIZED",
      issuedAt: capturedAt,
      expiresAt,
      manifestDigest: canonicalDigest(manifest),
      credentialAttestationDigest: canonicalDigest(credential),
      settlementObserverDigest: canonicalDigest(settlement),
      ledgerIdentityDigest: "c".repeat(64),
      reservationId: "copy-pilot-reservation-test-v3",
      reservationDigest: "d".repeat(64),
      reservationStatus: "RESERVED",
      maximumExecutions: 3,
      maximumWireCalls: 6,
      maximumRepairCallsPerExecution: 1,
    },
  };
}

describe("Copy pilot trusted gateway", () => {
  it("creates an opaque trusted handle only after live finite exact-scope checks", async () => {
    const live = await gateway();
    const envelope = admission(live.origin);
    const handle = await createCopyPilotTrustedGateway({
      admission: envelope,
      bearerToken: AUTHORIZATION_VALUE,
    });

    expect(live.observed).toEqual([
      "/api/usage/token",
      "/v1/models/claude-sonnet-5",
      "/v1/models/gpt-5.6-sol",
      "/v1/models/gpt-5.6-terra",
    ]);
    expect(Object.keys(handle)).toEqual([]);
    expect(JSON.stringify(handle)).toBe("{}");
    expect(getCopyPilotTrustedCredentialAttestation(handle)).toEqual(
      envelope.credential,
    );
    const bindings = createCopyPilotTrustedGatewayBindings(handle);
    expect(bindings.channelIdFor("gpt-5.6-sol", "openai_responses")).toBe(21);
    expect(bindings.execute).toBeTypeOf("function");
    expect(bindings.resolve).toBeTypeOf("function");
    expect(JSON.stringify(bindings)).toBe("{}");
  });

  it("rejects token digest mismatch before any network request", async () => {
    const live = await gateway();
    await expect(
      createCopyPilotTrustedGateway({
        admission: admission(live.origin),
        bearerToken: `${AUTHORIZATION_VALUE}-wrong`,
      }),
    ).rejects.toThrow("COPY_PILOT_CREDENTIAL_TOKEN_MISMATCH");
    expect(live.observed).toEqual([]);
  });

  it("brands request-bound settlement only inside the admitted gateway handle", async () => {
    const live = await gateway();
    const handle = await createCopyPilotTrustedGateway({
      admission: admission(live.origin),
      bearerToken: AUTHORIZATION_VALUE,
    });
    const bindings = createCopyPilotTrustedGatewayBindings(handle);
    const settlement = await bindings.resolve({
      requestId: "req-copy-terra-001",
      alias: "gpt-5.6-terra",
      protocol: "openai_responses",
      expectedChannelId: 20,
      usage: { inputTokens: 50, outputTokens: 10 },
      maxOutputTokens: 4_000,
      maximumQuotaPoints: 1_000,
    });

    expect(settlement.status).toBe("settled");
    expect(bindings.trustedSettlementProof(settlement)).toMatchObject({
      alias: "gpt-5.6-terra",
      authorizationDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
      credentialAttestationDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    expect(
      bindings.trustedSettlementProof(structuredClone(settlement)),
    ).toBeUndefined();
  });

  it("rejects a retained trusted handle after its authorization expires", async () => {
    const live = await gateway();
    const envelope = admission(live.origin);
    const handle = await createCopyPilotTrustedGateway({
      admission: envelope,
      bearerToken: AUTHORIZATION_VALUE,
    });
    vi.useFakeTimers();
    vi.setSystemTime(
      new Date(Date.parse(envelope.authorization.expiresAt) + 1),
    );

    await expect(assertCopyPilotTrustedGatewayCurrent(handle)).rejects.toThrow(
      "COPY_REAL_CAPABILITY_PROOF_EXPIRED",
    );
  });

  it("rechecks live scope before a retained handle can dispatch", async () => {
    const settings: { unlimited?: boolean; totalAvailable?: number } = {
      unlimited: false,
      totalAvailable: 9_900,
    };
    const live = await gateway(settings);
    const handle = await createCopyPilotTrustedGateway({
      admission: admission(live.origin),
      bearerToken: AUTHORIZATION_VALUE,
    });

    settings.unlimited = true;
    await expect(assertCopyPilotTrustedGatewayCurrent(handle)).rejects.toThrow(
      "COPY_PILOT_LIVE_SCOPE_OR_QUOTA_MISMATCH",
    );

    settings.unlimited = false;
    settings.totalAvailable = 3_899;
    await expect(assertCopyPilotTrustedGatewayCurrent(handle)).rejects.toThrow(
      "COPY_PILOT_LIVE_SCOPE_OR_QUOTA_MISMATCH",
    );
  });

  it.each([
    [{ unlimited: true }, "COPY_PILOT_LIVE_SCOPE_OR_QUOTA_MISMATCH"],
    [
      {
        allowlist: [
          "gpt-5.6-terra",
          "gpt-5.6-sol",
          "claude-sonnet-5",
          "unexpected-model",
        ],
      },
      "COPY_PILOT_LIVE_SCOPE_OR_QUOTA_MISMATCH",
    ],
    [{ modelLimit: 0 }, "COPY_PILOT_LIVE_SCOPE_OR_QUOTA_MISMATCH"],
    [{ modelLimit: "1" }, "COPY_PILOT_LIVE_SCOPE_OR_QUOTA_MISMATCH"],
  ] as const)(
    "fails closed for broadened or unlimited live credentials",
    async (settings, code) => {
      const live = await gateway(settings);
      await expect(
        createCopyPilotTrustedGateway({
          admission: admission(live.origin),
          bearerToken: AUTHORIZATION_VALUE,
        }),
      ).rejects.toThrow(code);
    },
  );
});
