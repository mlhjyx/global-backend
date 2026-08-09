import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { canonicalDigest } from "../../model-runtime/context-engine";
import { COPY_ASSEMBLY_EVAL_FIXTURES } from "./copy-assembly-eval";
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
import {
  COPY_PILOT_COMPILED_BUILD_COMMANDS,
  type CopyPilotVerifiedSource,
} from "./copy-pilot-source-verifier";
import {
  COPY_REAL_CAPABILITY_ARTIFACT_PATHS,
  createCopySonnetRecoveryRunner,
} from "./copy-real-capability-runner";
import { COPY_SONNET_RECOVERY_DUPLICATE_PREVENTION } from "./copy-sonnet-recovery-contract";

const TOKEN = createHash("sha256")
  .update(import.meta.url)
  .digest("hex");
const TOKEN_DIGEST = createHash("sha256").update(TOKEN).digest("hex");
const REQUIRE = createRequire(import.meta.url);
const REPOSITORY_ROOT = resolve(__dirname, "../../../../..");
const servers: Array<ReturnType<typeof createServer>> = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all([
    ...servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          ),
      ),
    ...directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  ]);
});

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
  }).trim();
}

function sendJson(
  response: ServerResponse,
  value: unknown,
  requestId?: string,
): void {
  response.writeHead(200, {
    "content-type": "application/json",
    ...(requestId == null ? {} : { "x-oneapi-request-id": requestId }),
  });
  response.end(JSON.stringify(value));
}

async function readJson(
  request: IncomingMessage,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
    string,
    unknown
  >;
}

async function recoveryGateway(
  catalog: readonly string[] = ["claude-sonnet-5"],
  messagesMode: "valid" | "valid_copy" | "invalid_200" = "valid",
) {
  let liveCatalog = [...catalog];
  const logs: Record<string, unknown>[] = [];
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
        data: liveCatalog.map((id) => ({ id })),
      });
      return;
    }
    if (request.url === "/api/log/token") {
      observed.push({ path: request.url });
      sendJson(response, { data: logs });
      return;
    }
    if (request.url === "/v1/messages") {
      const body = await readJson(request);
      observed.push({ path: request.url, body });
      if (messagesMode === "invalid_200") {
        sendJson(
          response,
          {
            type: "message",
            id: "message-copy-sonnet-invalid-200",
            model: "claude-sonnet-5",
            content: [
              {
                type: "text",
                text: { invalid: "sensitive-copy-must-not-enter-ledger" },
                private_note: "sensitive-copy-must-not-enter-ledger",
              },
            ],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: {
              input_tokens: 0,
              output_tokens: 94,
              cache_creation_input_tokens: 1_199,
              cache_read_input_tokens: 0,
              private_usage: "sensitive-copy-must-not-enter-ledger",
            },
            private_note: "sensitive-copy-must-not-enter-ledger",
          },
          "request-copy-sonnet-invalid-200",
        );
        return;
      }
      const requestId = "request-copy-sonnet-recovery";
      logs.push({
        request_id: requestId,
        type: 2,
        model_name: "claude-sonnet-5",
        channel: 22,
        quota: 100,
        prompt_tokens: 120,
        completion_tokens: 40,
        other: {
          usage_semantic: "anthropic",
          cache_creation_tokens: 0,
          cache_tokens: 0,
        },
      });
      const output =
        messagesMode === "valid_copy"
          ? COPY_ASSEMBLY_EVAL_FIXTURES.find(
              ({ fixtureId }) => fixtureId === "copy-factual-claims",
            )!.expectedOutput
          : { ok: true };
      sendJson(
        response,
        {
          type: "message",
          id: "message-copy-sonnet-recovery",
          model: "claude-sonnet-5",
          content: [{ type: "text", text: JSON.stringify(output) }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 120, output_tokens: 40 },
        },
        requestId,
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
    setCatalog: (next: readonly string[]) => {
      liveCatalog = [...next];
    },
  };
}

async function compiledRecoveryRepository() {
  const root = await mkdtemp(join(tmpdir(), "copy-sonnet-recovery-repo-"));
  directories.push(root);
  await Promise.all([
    mkdir(join(root, "apps", "api"), { recursive: true }),
    mkdir(join(root, "packages", "contracts"), { recursive: true }),
    mkdir(join(root, "docs", "evidence"), { recursive: true }),
  ]);
  await Promise.all([
    cp(join(REPOSITORY_ROOT, "apps/api/dist"), join(root, "apps/api/dist"), {
      recursive: true,
    }),
    cp(
      join(REPOSITORY_ROOT, "packages/contracts/dist"),
      join(root, "packages/contracts/dist"),
      { recursive: true },
    ),
    symlink(
      join(REPOSITORY_ROOT, "node_modules"),
      join(root, "node_modules"),
      "dir",
    ),
    writeFile(join(root, "source.txt"), "Copy Sonnet recovery source\n"),
  ]);
  git(root, "init", "-q");
  git(root, "config", "user.email", "copy-recovery@example.test");
  git(root, "config", "user.name", "Copy Recovery Test");
  git(root, "add", "source.txt");
  git(root, "commit", "-qm", "fixed recovery source");
  const fixedSourceCommit = git(root, "rev-parse", "HEAD");
  const files = [
    {
      role: "runtime_source",
      path: "source.txt",
      sha256: createHash("sha256")
        .update("Copy Sonnet recovery source\n")
        .digest("hex"),
    },
  ];
  const sourceBundleDigest = canonicalDigest(files);
  const manifest = {
    schemaVersion:
      "site-builder-copy-sonnet-recovery-runtime-manifest/2026-08-08-v1" as const,
    manifestId: "site-builder-copy-sonnet-recovery-runtime/integration-v1",
    recoveryManifestArtifactDigest: "a".repeat(64),
    recoveryManifestDigest: "b".repeat(64),
    fixedSourceCommit,
    sourceBundleDigest,
    planDigest: COPY_SONNET_RECOVERY_ADMISSION_SOURCE.planDigest,
    dispatchAuthorization: "NOT_AUTHORIZED" as const,
    taskId: "site_builder.copy" as const,
    plannedExecutions: 1 as const,
    maximumWireCalls: 2 as const,
    maximumRepairCallsPerExecution: 1 as const,
    executions: COPY_SONNET_RECOVERY_ADMISSION_SOURCE.executions,
  };
  const artifactPaths = [
    ...COPY_REAL_CAPABILITY_ARTIFACT_PATHS,
    "apps/api/dist/site-builder/eval/copy-sonnet-recovery-manifest-prep.js",
  ]
    .filter((path, index, paths) => paths.indexOf(path) === index)
    .sort();
  const compiledArtifacts = await Promise.all(
    artifactPaths.map(async (path) => ({
      path,
      sha256: createHash("sha256")
        .update(await readFile(join(root, path)))
        .digest("hex"),
    })),
  );
  const withoutDigest = {
    schemaVersion:
      "site-builder-copy-sonnet-recovery-runtime-binding-prep/2026-08-08-v1",
    artifactId:
      "site-builder-copy-sonnet-recovery-runtime-binding-prep/integration-v1",
    classification: "FIXED_SOURCE_CREATE_ONLY_SONNET_RECOVERY_RUNTIME",
    fixedSourceCommit,
    preparationHeadCommit: fixedSourceCommit,
    requiredMergeMethod: "merge_commit",
    createOnly: true,
    dispatchAuthorization: "NOT_AUTHORIZED",
    dispatchCapable: false,
    observedNetworkCalls: 0,
    observedModelWireCalls: 0,
    observedModelCost: { CNY: 0, USD: 0 },
    duplicatePrevention: COPY_SONNET_RECOVERY_DUPLICATE_PREVENTION,
    manifest,
    sourceBundle: {
      schemaVersion:
        "site-builder-copy-sonnet-recovery-runtime-source-bundle/2026-08-08-v1",
      files,
      digest: sourceBundleDigest,
    },
    compiledRuntimeExpectation: {
      schemaVersion: "compiled-runtime-expectation/2026-08-08-v1",
      buildSourceCommit: fixedSourceCommit,
      sourceBundleDigest,
      buildCommands: COPY_PILOT_COMPILED_BUILD_COMMANDS,
      artifactCount: compiledArtifacts.length,
      artifacts: compiledArtifacts,
      artifactTreeDigest: canonicalDigest(compiledArtifacts),
    },
  };
  const manifestPath = join(root, "docs", "evidence", "manifest.json");
  await writeFile(
    manifestPath,
    `${JSON.stringify({
      ...withoutDigest,
      artifactDigest: canonicalDigest(withoutDigest),
    })}\n`,
  );
  git(root, "add", "docs/evidence/manifest.json");
  git(root, "commit", "-qm", "record recovery binding");
  git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
  return { root, manifestPath, manifest };
}

function admission(
  origin: string,
  options: {
    manifest?: CopySonnetRecoveryAdmissionInput["manifest"];
    campaignId?: string;
    ledgerIdentityDigest?: string;
  } = {},
): CopySonnetRecoveryAdmissionInput {
  const now = Date.now();
  const issuedAt = new Date(now - 60_000).toISOString();
  const expiresAt = new Date(now + 60 * 60_000).toISOString();
  const manifest = options.manifest ?? {
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
    campaignId: options.campaignId ?? "copy-sonnet-recovery-campaign-test",
    authorizationId: "copy-sonnet-recovery-child-auth-test",
    reservationId: "copy-sonnet-recovery-child-reservation-test",
    ledgerIdentityDigest: options.ledgerIdentityDigest ?? "e".repeat(64),
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
      reservationDigest:
        copySonnetRecoveryReservationDigest(childWithoutDigest),
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

  it("rejects max-output drift before any model request", async () => {
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
          prompt: "This oversized request must not reach the model endpoint.",
          outputSchema: {
            type: "object",
            properties: { ok: { type: "boolean" } },
            required: ["ok"],
            additionalProperties: false,
          },
          outputSchemaName: "copy_sonnet_recovery_output",
          reasoning: { effort: "medium" },
          maxOutputTokens: 1_201,
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

  it("durably freezes Sonnet recovery when live scope drifts before dispatch", async () => {
    const repository = await compiledRecoveryRepository();
    const directory = await mkdtemp(
      join(tmpdir(), "copy-sonnet-recovery-pre-dispatch-drift-"),
    );
    directories.push(directory);
    const campaignId = "copy-sonnet-recovery-pre-dispatch-drift-test";
    const paths = {
      ledgerPath: join(directory, "ledger.jsonl"),
      authorizationClaimPath: join(directory, "authorization.claim.jsonl"),
      ledgerMarkerPath: join(directory, "ledger.marker.jsonl"),
      campaignId,
    };
    const markerModule = REQUIRE(
      join(
        repository.root,
        "apps/api/dist/site-builder/eval/copy-pilot-ledger-identity.js",
      ),
    ) as typeof import("./copy-pilot-ledger-identity");
    const sourceModule = REQUIRE(
      join(
        repository.root,
        "apps/api/dist/site-builder/eval/copy-pilot-source-verifier.js",
      ),
    ) as typeof import("./copy-pilot-source-verifier");
    const gatewayModule = REQUIRE(
      join(
        repository.root,
        "apps/api/dist/site-builder/eval/copy-pilot-trusted-gateway.js",
      ),
    ) as typeof import("./copy-pilot-trusted-gateway");
    const runnerModule = REQUIRE(
      join(
        repository.root,
        "apps/api/dist/site-builder/eval/copy-real-capability-runner.js",
      ),
    ) as typeof import("./copy-real-capability-runner");
    const prepared = await markerModule.prepareCopyPilotLedgerIdentity({
      ...paths,
      markerPath: paths.ledgerMarkerPath,
    });
    const live = await recoveryGateway();
    const admitted = admission(live.origin, {
      manifest: repository.manifest,
      campaignId,
      ledgerIdentityDigest: prepared.ledgerIdentityDigest,
    });
    const verifiedSource = await sourceModule.createCopyPilotVerifiedSource({
      repositoryRoot: repository.root,
      manifestArtifactPath: repository.manifestPath,
    });
    const trustedGateway = await gatewayModule.createCopyPilotTrustedGateway({
      admission: admitted,
      bearerToken: TOKEN,
    });
    const runner = await runnerModule.createCopySonnetRecoveryRunner({
      ...paths,
      admission: admitted,
      verifiedSource,
      trustedGateway,
    });

    live.setCatalog([]);
    await expect(runner.execute(admitted.selectedExecutionKey)).rejects.toThrow(
      "COPY_PILOT_LIVE_SCOPE_OR_QUOTA_MISMATCH",
    );

    expect(await runner.summary()).toMatchObject({
      frozen: true,
      executionClaims: 0,
      wireClaims: 0,
    });
    live.setCatalog(["claude-sonnet-5"]);
    await expect(runner.execute(admitted.selectedExecutionKey)).rejects.toThrow(
      "REAL_MODEL_EXECUTION_CAMPAIGN_FROZEN",
    );
    expect(live.observed.some(({ path }) => path === "/v1/messages")).toBe(
      false,
    );
  });

  it("accepts Git-reviewed evidence for the v14 recovery execution identity", async () => {
    const repository = await compiledRecoveryRepository();
    const directory = await mkdtemp(
      join(tmpdir(), "copy-sonnet-recovery-git-acceptance-"),
    );
    directories.push(directory);
    const campaignId = "copy-sonnet-recovery-v14-git-acceptance-test";
    const paths = {
      ledgerPath: join(directory, "ledger.jsonl"),
      authorizationClaimPath: join(directory, "authorization.claim.jsonl"),
      ledgerMarkerPath: join(directory, "ledger.marker.jsonl"),
      campaignId,
    };
    const markerModule = REQUIRE(
      join(
        repository.root,
        "apps/api/dist/site-builder/eval/copy-pilot-ledger-identity.js",
      ),
    ) as typeof import("./copy-pilot-ledger-identity");
    const sourceModule = REQUIRE(
      join(
        repository.root,
        "apps/api/dist/site-builder/eval/copy-pilot-source-verifier.js",
      ),
    ) as typeof import("./copy-pilot-source-verifier");
    const gatewayModule = REQUIRE(
      join(
        repository.root,
        "apps/api/dist/site-builder/eval/copy-pilot-trusted-gateway.js",
      ),
    ) as typeof import("./copy-pilot-trusted-gateway");
    const runnerModule = REQUIRE(
      join(
        repository.root,
        "apps/api/dist/site-builder/eval/copy-real-capability-runner.js",
      ),
    ) as typeof import("./copy-real-capability-runner");
    const acceptanceModule = REQUIRE(
      join(
        repository.root,
        "apps/api/dist/model-runtime/git-reviewed-evidence-acceptance.js",
      ),
    ) as typeof import("../../model-runtime/git-reviewed-evidence-acceptance");
    const prepared = await markerModule.prepareCopyPilotLedgerIdentity({
      ...paths,
      markerPath: paths.ledgerMarkerPath,
    });
    const live = await recoveryGateway(["claude-sonnet-5"], "valid_copy");
    const admitted = admission(live.origin, {
      manifest: repository.manifest,
      campaignId,
      ledgerIdentityDigest: prepared.ledgerIdentityDigest,
    });
    const verifiedSource = await sourceModule.createCopyPilotVerifiedSource({
      repositoryRoot: repository.root,
      manifestArtifactPath: repository.manifestPath,
    });
    const trustedGateway = await gatewayModule.createCopyPilotTrustedGateway({
      admission: admitted,
      bearerToken: TOKEN,
    });
    const runner = await runnerModule.createCopySonnetRecoveryRunner({
      ...paths,
      admission: admitted,
      verifiedSource,
      trustedGateway,
    });
    const execution = await runner.execute(admitted.selectedExecutionKey);
    const challenge =
      runnerModule.createCopyGitEvidenceAcceptanceChallenge(execution);
    const artifact = runnerModule.createCopyGitEvidenceAcceptanceArtifact({
      artifactId: "copy-sonnet-recovery-v14-acceptance-514",
      challenge,
    });
    const artifactPath = join(
      repository.root,
      "docs/evidence/copy-sonnet-recovery-v14-acceptance.json",
    );
    await acceptanceModule.writeGitReviewedEvidenceAcceptanceArtifact({
      artifactPath,
      artifact,
    });
    const mainBranch = git(
      repository.root,
      "rev-parse",
      "--abbrev-ref",
      "HEAD",
    );
    git(repository.root, "checkout", "-qb", "acceptance/copy-sonnet-v14");
    git(
      repository.root,
      "add",
      "docs/evidence/copy-sonnet-recovery-v14-acceptance.json",
    );
    git(repository.root, "commit", "-qm", "test: accept v14 recovery evidence");
    git(repository.root, "checkout", "-q", mainBranch);
    git(
      repository.root,
      "merge",
      "--no-ff",
      "acceptance/copy-sonnet-v14",
      "-m",
      "Merge pull request #514 from test/acceptance-copy-sonnet-v14",
    );
    git(repository.root, "update-ref", "refs/remotes/origin/main", "HEAD");
    const acceptance =
      await acceptanceModule.verifyGitReviewedEvidenceAcceptanceArtifact({
        repositoryRoot: repository.root,
        artifactPath,
      });
    const accepted = await (
      runner as unknown as {
        acceptGitReviewedEvidence(input: {
          acceptance: typeof acceptance;
        }): Promise<unknown>;
      }
    ).acceptGitReviewedEvidence({ acceptance });

    expect(
      runnerModule.getCopyGitAcceptedExecutionAttestation(accepted as never),
    ).toMatchObject({
      classification: "GIT_REVIEWED_REAL_EVIDENCE",
      executionId: "copy-sonnet-recovery-v14-claude-sonnet-5",
      alias: "claude-sonnet-5",
      protocol: "anthropic_messages",
      reasoning: "medium",
    });
    expect(await runner.summary()).toMatchObject({
      completedExecutions: 1,
      knownWireSettlements: 1,
      unknownWireSettlements: 0,
      gitEvidenceAcceptances: 1,
      frozen: false,
    });
  });

  it("persists only the redacted Messages response shape after an invalid HTTP 200", async () => {
    const repository = await compiledRecoveryRepository();
    const directory = await mkdtemp(
      join(tmpdir(), "copy-sonnet-recovery-invalid-200-"),
    );
    directories.push(directory);
    const campaignId = "copy-sonnet-recovery-invalid-200-test";
    const paths = {
      ledgerPath: join(directory, "ledger.jsonl"),
      authorizationClaimPath: join(directory, "authorization.claim.jsonl"),
      ledgerMarkerPath: join(directory, "ledger.marker.jsonl"),
      campaignId,
    };
    const markerModule = REQUIRE(
      join(
        repository.root,
        "apps/api/dist/site-builder/eval/copy-pilot-ledger-identity.js",
      ),
    ) as typeof import("./copy-pilot-ledger-identity");
    const sourceModule = REQUIRE(
      join(
        repository.root,
        "apps/api/dist/site-builder/eval/copy-pilot-source-verifier.js",
      ),
    ) as typeof import("./copy-pilot-source-verifier");
    const gatewayModule = REQUIRE(
      join(
        repository.root,
        "apps/api/dist/site-builder/eval/copy-pilot-trusted-gateway.js",
      ),
    ) as typeof import("./copy-pilot-trusted-gateway");
    const runnerModule = REQUIRE(
      join(
        repository.root,
        "apps/api/dist/site-builder/eval/copy-real-capability-runner.js",
      ),
    ) as typeof import("./copy-real-capability-runner");
    const prepared = await markerModule.prepareCopyPilotLedgerIdentity({
      ...paths,
      markerPath: paths.ledgerMarkerPath,
    });
    const live = await recoveryGateway(["claude-sonnet-5"], "invalid_200");
    const admitted = admission(live.origin, {
      manifest: repository.manifest,
      campaignId,
      ledgerIdentityDigest: prepared.ledgerIdentityDigest,
    });
    const verifiedSource = await sourceModule.createCopyPilotVerifiedSource({
      repositoryRoot: repository.root,
      manifestArtifactPath: repository.manifestPath,
    });
    const trustedGateway = await gatewayModule.createCopyPilotTrustedGateway({
      admission: admitted,
      bearerToken: TOKEN,
    });
    const runner = await runnerModule.createCopySonnetRecoveryRunner({
      ...paths,
      admission: admitted,
      verifiedSource,
      trustedGateway,
    });

    await expect(runner.execute(admitted.selectedExecutionKey)).rejects.toThrow(
      /settlement is unknown/u,
    );

    const rawLedger = await readFile(paths.ledgerPath, "utf8");
    const observation = rawLedger
      .trim()
      .split("\n")
      .map(
        (line) =>
          (
            JSON.parse(line) as {
              event: Record<string, unknown>;
            }
          ).event,
      )
      .find(({ kind }) => kind === "wire_observed");
    expect(observation).toMatchObject({
      kind: "wire_observed",
      settlement: "unknown",
      requestId: "request-copy-sonnet-invalid-200",
      reason: expect.stringMatching(
        /native_api_failure_http_200:log_unavailable/u,
      ),
      responseShape: {
        schemaVersion: "native-model-response-shape/2026-08-09-v1",
        topLevelKeys: [
          "content",
          "id",
          "model",
          "stop_reason",
          "stop_sequence",
          "type",
          "usage",
        ],
        contentBlockTypes: ["text"],
        usageKeys: [
          "cache_creation_input_tokens",
          "cache_read_input_tokens",
          "input_tokens",
          "output_tokens",
        ],
        validationPaths: ["content[0].text"],
      },
    });
    expect(rawLedger).not.toContain("sensitive-copy-must-not-enter-ledger");
    expect(rawLedger).not.toContain("private_note");
    expect(rawLedger).not.toContain("private_usage");
    expect(await runner.summary()).toMatchObject({
      wireClaims: 1,
      knownWireSettlements: 0,
      unknownWireSettlements: 1,
      frozen: true,
    });
  });
});
