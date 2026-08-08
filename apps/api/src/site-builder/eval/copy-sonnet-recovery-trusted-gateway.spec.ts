import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { canonicalDigest } from "../../model-runtime/context-engine";
import {
  COPY_SONNET_RECOVERY_ADMISSION_SOURCE,
  copySonnetRecoveryReservationDigest,
  type CopySonnetRecoveryAdmissionInput,
} from "./copy-sonnet-recovery-admission";
import {
  createCopyPilotTrustedGateway,
  createCopyPilotTrustedGatewayBindings,
  type CopyPilotTrustedGateway,
} from "./copy-pilot-trusted-gateway";
import { type CopyPilotVerifiedSource } from "./copy-pilot-source-verifier";
import { createCopySonnetRecoveryRunner } from "./copy-real-capability-runner";

const TOKEN = createHash("sha256").update(import.meta.url).digest("hex");
const TOKEN_DIGEST = createHash("sha256").update(TOKEN).digest("hex");
const servers: Array<ReturnType<typeof createServer>> = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        ),
    ),
  );
});

function sendJson(response: ServerResponse, value: unknown, requestId?: string): void {
  response.writeHead(200, {
    "content-type": "application/json",
    ...(requestId == null ? {} : { "x-oneapi-request-id": requestId }),
  });
  response.end(JSON.stringify(value));
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

async function recoveryGateway(catalog: readonly string[] = ["claude-sonnet-5"]) {
  const observed: Array<{ path: string; body?: Record<string, unknown> }> = [];
  const server = createServer(async (request, response) => {
    if (
      request.headers.authorization !== `Bearer ${TOKEN}` &&
      request.headers["x-api-key"] !== TOKEN
    ) {
      response.writeHead(401).end();
      return;
    }
    if (request.url === "/api/usage/token") {
      observed.push({ path: request.url });
      sendJson(response, {
        data: {
          unlimited_quota: false,
          model_limits_enabled: true,
          model_limits: { "claude-sonnet-5": true },
          total_granted: 1_000,
          total_available: 1_000,
        },
      });
      return;
    }
    if (request.url === "/v1/models") {
      observed.push({ path: request.url });
      sendJson(response, {
        object: "list",
        data: catalog.map((id) => ({ id })),
      });
      return;
    }
    if (request.url === "/v1/messages") {
      const body = await readJson(request);
      observed.push({ path: request.url, body });
      sendJson(
        response,
        {
          type: "message",
          id: "message-copy-sonnet-recovery",
          model: "claude-sonnet-5",
          content: [{ type: "text", text: JSON.stringify({ ok: true }) }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 5 },
        },
        "request-copy-sonnet-recovery",
      );
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const address = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${address.port}`,
    observed,
  };
}

function admission(origin: string): CopySonnetRecoveryAdmissionInput {
  const now = Date.now();
  const issuedAt = new Date(now - 60_000).toISOString();
  const expiresAt = new Date(now + 60 * 60_000).toISOString();
  const manifest = {
    schemaVersion:
      "site-builder-copy-sonnet-recovery-runtime-manifest/2026-08-08-v1" as const,
    manifestId: "site-builder-copy-sonnet-recovery-runtime/test-v1",
    recoveryManifestArtifactDigest: "a".repeat(64),
    recoveryManifestDigest: "b".repeat(64),
    fixedSourceCommit: "c".repeat(40),
    sourceBundleDigest: "d".repeat(64),
    planDigest: COPY_SONNET_RECOVERY_ADMISSION_SOURCE.planDigest,
    dispatchAuthorization: "NOT_AUTHORIZED" as const,
    taskId: "site_builder.copy" as const,
    plannedExecutions: 1 as const,
    maximumWireCalls: 2 as const,
    maximumRepairCallsPerExecution: 1 as const,
    executions: COPY_SONNET_RECOVERY_ADMISSION_SOURCE.executions,
  };
  const credential = {
    schemaVersion:
      "site-builder-copy-sonnet-recovery-credential-attestation/2026-08-08-v1" as const,
    attestationId: "copy-sonnet-recovery-credential-test",
    capturedAt: issuedAt,
    expiresAt,
    gatewayOrigin: origin,
    bearerTokenSha256: TOKEN_DIGEST,
    purpose: "site_builder_copy_sonnet_recovery" as const,
    quotaMode: "limited" as const,
    quotaCapPoints: 1_000,
    remainingQuotaPoints: 1_000,
    maximumQuotaPointsPerWire: 500,
    reservedQuotaPoints: 1_000,
    scopeExact: true as const,
    repairPayloadPolicy: "bounded_structured_prior_output_64k" as const,
    executions: COPY_SONNET_RECOVERY_ADMISSION_SOURCE.executions,
    channels: [
      {
        alias: "claude-sonnet-5",
        protocol: "anthropic_messages" as const,
        channelId: 22,
      },
    ],
    resolverId: "copy-sonnet-recovery-resolver-test",
  };
  const settlement = {
    schemaVersion:
      "site-builder-copy-sonnet-recovery-settlement-observer/2026-08-08-v1" as const,
    resolverId: credential.resolverId,
    status: "READY" as const,
    observation: "request_bound_new_api_consume_log" as const,
    requestIdentityHeader: "x-oneapi-request-id" as const,
    requiredObservationPerPhysicalCall: true as const,
    maximumPollDurationMs: 2_000,
    unknownSettlementPolicy: "freeze_selected_child_campaign" as const,
  };
  const child = {
    ...COPY_SONNET_RECOVERY_ADMISSION_SOURCE.childCampaign,
    campaignId: "copy-sonnet-recovery-campaign-test",
    authorizationId: "copy-sonnet-recovery-child-auth-test",
    reservationId: "copy-sonnet-recovery-child-reservation-test",
    ledgerIdentityDigest: "e".repeat(64),
    reservedQuotaPoints: 1_000,
  };
  const authorization = {
    schemaVersion:
      "site-builder-copy-sonnet-recovery-dispatch-authorization/2026-08-08-v1" as const,
    authorizationId: "copy-sonnet-recovery-global-auth-test",
    status: "AUTHORIZED" as const,
    issuedAt,
    expiresAt,
    manifestDigest: canonicalDigest(manifest),
    credentialAttestationDigest: canonicalDigest(credential),
    settlementObserverDigest: canonicalDigest(settlement),
    reservationStatus: "RESERVED" as const,
    maximumExecutions: 1 as const,
    maximumWireCalls: 2 as const,
    maximumRepairCallsPerExecution: 1 as const,
    unknownSettlementPolicy: "freeze_selected_child_campaign" as const,
    sharedDriftPolicy: "freeze_selected_child_campaign" as const,
    children: [child] as const,
  };
  const childWithoutDigest = {
    schemaVersion:
      "site-builder-copy-sonnet-recovery-child-dispatch-authorization/2026-08-08-v1" as const,
    globalAuthorizationDigest: canonicalDigest(authorization),
    childSlotId: child.childSlotId,
    executionKey: child.executionKey,
    campaignId: child.campaignId,
    authorizationId: child.authorizationId,
    status: "AUTHORIZED" as const,
    issuedAt,
    expiresAt,
    manifestDigest: authorization.manifestDigest,
    credentialAttestationDigest: authorization.credentialAttestationDigest,
    settlementObserverDigest: authorization.settlementObserverDigest,
    ledgerIdentityDigest: child.ledgerIdentityDigest,
    reservationId: child.reservationId,
    reservationStatus: "RESERVED" as const,
    maximumExecutions: 1 as const,
    maximumWireCalls: 2 as const,
    maximumRepairCallsPerExecution: 1 as const,
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
    authorization,
    childAuthorization: {
      ...childWithoutDigest,
      reservationDigest: copySonnetRecoveryReservationDigest(childWithoutDigest),
    },
    selectedExecutionKey: child.executionKey,
  };
}

describe("Copy Sonnet recovery trusted gateway", () => {
  it("refuses the TypeScript source entrypoint before ledger or gateway use", async () => {
    await expect(
      createCopySonnetRecoveryRunner({
        ledgerPath: "/not-read/ledger.jsonl",
        authorizationClaimPath: "/not-read/claim.jsonl",
        ledgerMarkerPath: "/not-read/marker.jsonl",
        campaignId: "copy-sonnet-recovery-compiled-entrypoint-test",
        admission: admission("http://127.0.0.1:3001"),
        verifiedSource: Object.freeze({}) as CopyPilotVerifiedSource,
        trustedGateway: Object.freeze({}) as CopyPilotTrustedGateway,
      }),
    ).rejects.toThrow("COPY_REAL_CAPABILITY_COMPILED_ENTRYPOINT_REQUIRED");
  });

  it("admits an exact Sonnet-only token and preserves native Messages", async () => {
    const live = await recoveryGateway();
    const handle = await createCopyPilotTrustedGateway({
      admission: admission(live.origin),
      bearerToken: TOKEN,
    });
    const bindings = createCopyPilotTrustedGatewayBindings(handle);

    const result = await bindings.execute<{ ok: boolean }>(
      "anthropic_messages",
      {
        alias: "claude-sonnet-5",
        system: "Return JSON only.",
        prompt: "Confirm Sonnet recovery.",
        outputSchema: {
          type: "object",
          properties: { ok: { type: "boolean" } },
          required: ["ok"],
          additionalProperties: false,
        },
        outputSchemaName: "copy_sonnet_recovery_output",
        reasoning: { effort: "medium" },
        maxOutputTokens: 1_200,
        abortSignal: AbortSignal.timeout(2_000),
      },
    );

    expect(result).toMatchObject({
      protocol: "anthropic-messages",
      requestedModel: "claude-sonnet-5",
      reportedModel: "claude-sonnet-5",
      requestId: "request-copy-sonnet-recovery",
      output: { ok: true },
    });
    expect(live.observed).toEqual([
      { path: "/api/usage/token" },
      { path: "/v1/models" },
      {
        path: "/v1/messages",
        body: expect.objectContaining({
          model: "claude-sonnet-5",
          max_tokens: 1_200,
          thinking: { type: "adaptive" },
          output_config: expect.objectContaining({ effort: "medium" }),
        }),
      },
    ]);
  });

  it("rejects reasoning drift before any model request", async () => {
    const live = await recoveryGateway();
    const handle = await createCopyPilotTrustedGateway({
      admission: admission(live.origin),
      bearerToken: TOKEN,
    });
    const bindings = createCopyPilotTrustedGatewayBindings(handle);

    await expect(
      Promise.resolve().then(() =>
        bindings.execute<{ ok: boolean }>("anthropic_messages", {
          alias: "claude-sonnet-5",
          prompt: "This request must not reach the model endpoint.",
          outputSchema: {
            type: "object",
            properties: { ok: { type: "boolean" } },
            required: ["ok"],
            additionalProperties: false,
          },
          outputSchemaName: "copy_sonnet_recovery_output",
          reasoning: { effort: "high" },
          maxOutputTokens: 1_200,
          abortSignal: AbortSignal.timeout(2_000),
        }),
      ),
    ).rejects.toThrow("COPY_PILOT_CHILD_SCOPE_MISMATCH");
    expect(live.observed.map(({ path }) => path)).toEqual([
      "/api/usage/token",
      "/v1/models",
    ]);
  });

  it("rejects a broadened live catalog before any model request", async () => {
    const live = await recoveryGateway(["claude-sonnet-5", "gpt-5.6-terra"]);
    await expect(
      createCopyPilotTrustedGateway({
        admission: admission(live.origin),
        bearerToken: TOKEN,
      }),
    ).rejects.toThrow("COPY_PILOT_LIVE_SCOPE_OR_QUOTA_MISMATCH");
    expect(live.observed.map(({ path }) => path)).toEqual([
      "/api/usage/token",
      "/v1/models",
    ]);
  });
});
