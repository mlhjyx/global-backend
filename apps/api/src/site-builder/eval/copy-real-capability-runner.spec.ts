import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createRequire } from "node:module";
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import { canonicalDigest } from "../../model-runtime/context-engine";
import { COPY_CAPABILITY_PILOT_PLAN } from "./copy-capability-pilot";
import { COPY_REAL_CAPABILITY_ADMISSION_SOURCE } from "./copy-real-capability-admission";
import { COPY_ASSEMBLY_EVAL_FIXTURES } from "./copy-assembly-eval";
import {
  copyPilotLedgerIdentityDigest,
  copyPilotReservationDigest,
  createCopyRealCapabilityRunner as createSourceRunner,
} from "./copy-real-capability-runner";
import { prepareCopyPilotLedgerIdentity } from "./copy-pilot-ledger-identity";

const EXEC_FILE = promisify(execFile);
const REQUIRE = createRequire(import.meta.url);
const REPOSITORY_ROOT = resolve(__dirname, "../../../../..");
const COMPILED_RUNNER_PATH = join(
  REPOSITORY_ROOT,
  "apps/api/dist/site-builder/eval/copy-real-capability-runner.js",
);
const TEST_GATEWAY_AUTHORIZATION = createHash("sha256")
  .update(import.meta.url)
  .digest("hex");
const directories: string[] = [];
const servers: Array<ReturnType<typeof createServer>> = [];

function git(repositoryRoot: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim();
}

afterEach(async () => {
  await Promise.all([
    ...directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
    ...servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolveClose, reject) =>
            server.close((error) => (error ? reject(error) : resolveClose())),
          ),
      ),
  ]);
});

function sendJson(
  response: ServerResponse,
  body: unknown,
  requestId?: string,
): void {
  response.writeHead(200, {
    "content-type": "application/json",
    ...(requestId == null ? {} : { "x-oneapi-request-id": requestId }),
  });
  response.end(JSON.stringify(body));
}

async function realRunnerGateway() {
  const authorizationValue = TEST_GATEWAY_AUTHORIZATION;
  const expected = COPY_ASSEMBLY_EVAL_FIXTURES.find(
    ({ fixtureId }) => fixtureId === "copy-factual-claims",
  )!.expectedOutput;
  const invalid = structuredClone(expected);
  invalid.slots["home.hero.headline"] = {
    content: "Invented unsupported performance claim",
    claimRefs: ["claim-pressure"],
  };
  const callsByAlias = new Map<string, number>();
  const logs: Record<string, unknown>[] = [];
  const observedModelBodies: Record<string, unknown>[] = [];
  const channelByAlias = new Map([
    ["gpt-5.6-terra", 20],
    ["gpt-5.6-sol", 21],
    ["claude-sonnet-5", 22],
  ]);
  const server = createServer(async (request: IncomingMessage, response) => {
    if (
      request.headers.authorization !== `Bearer ${authorizationValue}` &&
      request.headers["x-api-key"] !== authorizationValue
    ) {
      response.writeHead(401).end();
      return;
    }
    if (request.url === "/api/usage/token") {
      sendJson(response, {
        data: {
          unlimited_quota: false,
          model_limits_enabled: true,
          model_limits: {
            "gpt-5.6-terra": 1,
            "gpt-5.6-sol": 1,
            "claude-sonnet-5": 1,
          },
          total_granted: 10_000,
          total_available: 9_900,
        },
      });
      return;
    }
    const modelLookup = request.url?.match(/^\/v1\/models\/(.+)$/u);
    if (modelLookup) {
      sendJson(response, { id: decodeURIComponent(modelLookup[1]!) });
      return;
    }
    if (request.url === "/api/log/token") {
      sendJson(response, { data: logs });
      return;
    }
    if (request.url !== "/v1/responses" && request.url !== "/v1/messages") {
      response.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
      string,
      unknown
    >;
    observedModelBodies.push(body);
    const alias = String(body.model);
    const ordinal = (callsByAlias.get(alias) ?? 0) + 1;
    callsByAlias.set(alias, ordinal);
    const requestId = `request-real-${alias.replaceAll(".", "-")}-${ordinal}`;
    const output =
      alias === "gpt-5.6-sol" && ordinal === 1 ? invalid : expected;
    if (alias !== "claude-sonnet-5") {
      logs.push({
        request_id: requestId,
        type: 2,
        model_name: alias,
        channel: channelByAlias.get(alias),
        quota: 100,
        prompt_tokens: 120,
        completion_tokens: 40,
      });
    }
    if (request.url === "/v1/responses") {
      sendJson(
        response,
        {
          id: `response-${ordinal}`,
          created_at: 1_786_000_000,
          model: alias,
          output: [
            {
              type: "message",
              id: `message-${ordinal}`,
              role: "assistant",
              content: [
                {
                  type: "output_text",
                  text: JSON.stringify(output),
                  annotations: [],
                },
              ],
            },
          ],
          usage: {
            input_tokens: 120,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens: 40,
            output_tokens_details: { reasoning_tokens: 10 },
          },
        },
        requestId,
      );
      return;
    }
    sendJson(
      response,
      {
        type: "message",
        id: `message-${ordinal}`,
        model: alias,
        content: [{ type: "text", text: JSON.stringify(output) }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 120, output_tokens: 40 },
      },
      requestId,
    );
  });
  await new Promise<void>((resolveListen) =>
    server.listen(0, "127.0.0.1", resolveListen),
  );
  servers.push(server);
  const address = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${address.port}`,
    authorizationValue,
    observedModelBodies,
  };
}

async function compiledExecutionRepository() {
  const root = await mkdtemp(join(tmpdir(), "copy-real-runner-repo-"));
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
    writeFile(join(root, "source.txt"), "copy real runtime source\n"),
  ]);
  git(root, "init", "-q");
  git(root, "config", "user.email", "copy-real@example.test");
  git(root, "config", "user.name", "Copy Real Test");
  git(root, "add", "source.txt");
  git(root, "commit", "-qm", "fixed runtime source");
  const fixedSourceCommit = git(root, "rev-parse", "HEAD");
  const files = [
    {
      role: "runtime_source",
      path: "source.txt",
      sha256: createHash("sha256")
        .update("copy real runtime source\n")
        .digest("hex"),
    },
  ];
  const manifest = {
    schemaVersion: "site-builder-copy-real-capability-manifest/2026-08-05-v1",
    manifestId: "site-builder-copy-real-capability/integration-v3",
    fixedSourceCommit,
    sourceBundleDigest: canonicalDigest(files),
    planDigest: canonicalDigest(COPY_CAPABILITY_PILOT_PLAN),
    dispatchAuthorization: "NOT_AUTHORIZED",
    taskId: "site_builder.copy",
    plannedExecutions: 3,
    maximumWireCalls: 6,
    maximumRepairCallsPerExecution: 1,
    executions: COPY_REAL_CAPABILITY_ADMISSION_SOURCE.executions,
  };
  const withoutDigest = {
    schemaVersion:
      "site-builder-copy-real-capability-manifest-prep/2026-08-05-v1",
    artifactId:
      "site-builder-copy-real-capability-manifest-prep/integration-v3",
    classification: "FIXED_SOURCE_CREATE_ONLY",
    fixedSourceCommit,
    createOnly: true,
    dispatchAuthorization: "NOT_AUTHORIZED",
    dispatchCapable: false,
    observedNetworkCalls: 0,
    observedModelWireCalls: 0,
    observedModelCost: { CNY: 0, USD: 0 },
    manifest,
    sourceBundle: {
      schemaVersion:
        "site-builder-copy-real-capability-source-bundle/2026-08-05-v1",
      files,
      digest: canonicalDigest(files),
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
  git(root, "commit", "-qm", "fixed source manifest");
  git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
  return { root, manifestPath, manifest };
}

function admission() {
  const now = Date.now();
  const issuedAt = new Date(now - 60_000).toISOString();
  const expiresAt = new Date(now + 60 * 60_000).toISOString();
  const manifest = {
    schemaVersion:
      "site-builder-copy-real-capability-manifest/2026-08-05-v1" as const,
    manifestId: "site-builder-copy-real-capability/runner-test-v3",
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
    attestationId: "copy-runner-credential-test-v2",
    capturedAt: issuedAt,
    expiresAt,
    gatewayOrigin: "http://127.0.0.1:3001",
    bearerTokenSha256: "c".repeat(64),
    purpose: "site_builder_copy_capability_pilot" as const,
    quotaMode: "limited" as const,
    quotaCapPoints: 10_000,
    remainingQuotaPoints: 10_000,
    maximumQuotaPointsPerWire: 1_000,
    reservedQuotaPoints: 6_000,
    scopeExact: true as const,
    repairPayloadPolicy: "bounded_structured_prior_output_64k" as const,
    executions: COPY_REAL_CAPABILITY_ADMISSION_SOURCE.executions,
    channels: COPY_REAL_CAPABILITY_ADMISSION_SOURCE.executions.map(
      ({ alias, protocol }, index) => ({
        alias,
        protocol,
        channelId: index + 10,
      }),
    ),
    resolverId: "copy-runner-settlement-resolver-v2",
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
  const authorizationWithoutReservation = {
    schemaVersion:
      "site-builder-copy-pilot-dispatch-authorization/2026-08-05-v1" as const,
    authorizationId: "copy-runner-authorization-test-v3",
    status: "AUTHORIZED" as const,
    issuedAt,
    expiresAt,
    manifestDigest: canonicalDigest(manifest),
    credentialAttestationDigest: canonicalDigest(credential),
    settlementObserverDigest: canonicalDigest(settlement),
    ledgerIdentityDigest: "d".repeat(64),
    reservationId: "copy-runner-reservation-test-v3",
    reservationStatus: "RESERVED" as const,
    maximumExecutions: 3 as const,
    maximumWireCalls: 6 as const,
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
    authorization: {
      ...authorizationWithoutReservation,
      reservationDigest: copyPilotReservationDigest(
        authorizationWithoutReservation,
      ),
    },
  };
}

describe("Copy real capability runner admission", () => {
  it("binds the authorization to exact ledger paths and reservation fields", async () => {
    const directory = await mkdtemp(join(tmpdir(), "copy-runner-binding-"));
    directories.push(directory);
    const input = {
      ledgerPath: join(directory, "ledger.jsonl"),
      authorizationClaimPath: join(directory, "authorization.claim.json"),
      ledgerMarkerPath: join(directory, "ledger.marker.jsonl"),
      campaignId: "copy-real-capability-test",
    };

    await prepareCopyPilotLedgerIdentity({
      ...input,
      markerPath: input.ledgerMarkerPath,
    });
    const digest = await copyPilotLedgerIdentityDigest(input);
    expect(digest).toMatch(/^[0-9a-f]{64}$/u);
    await expect(
      copyPilotLedgerIdentityDigest({
        ...input,
        ledgerPath: join(directory, "other-ledger.jsonl"),
      }),
    ).rejects.toThrow("COPY_PILOT_LEDGER_IDENTITY_MISMATCH");
    const authorization = admission().authorization;
    const { reservationDigest, ...withoutDigest } = authorization;
    expect(copyPilotReservationDigest(withoutDigest)).toBe(reservationDigest);
    expect(
      copyPilotReservationDigest({
        ...withoutDigest,
        maximumWireCalls: 7 as never,
      }),
    ).not.toBe(reservationDigest);
  });

  it("rejects source loading from TypeScript before opening a ledger or client", async () => {
    const directory = await mkdtemp(join(tmpdir(), "copy-runner-source-"));
    directories.push(directory);
    await expect(
      createSourceRunner({
        ledgerPath: join(directory, "ledger.jsonl"),
        authorizationClaimPath: join(directory, "authorization.claim.json"),
        ledgerMarkerPath: join(directory, "ledger.marker.jsonl"),
        campaignId: "copy-real-source-rejected",
        admission: admission(),
        verifiedSource: Object.freeze({}),
        trustedGateway: Object.freeze({}),
      }),
    ).rejects.toThrow("COPY_REAL_CAPABILITY_COMPILED_ENTRYPOINT_REQUIRED");
  });

  it("guards every repository-local module loaded by the compiled real runner", async () => {
    const script = `
      const { relative, resolve } = require("node:path");
      const root = ${JSON.stringify(REPOSITORY_ROOT)};
      const entrypoint = ${JSON.stringify(COMPILED_RUNNER_PATH)};
      const loaded = require(entrypoint);
      const guarded = new Set(loaded.COPY_REAL_CAPABILITY_ARTIFACT_PATHS);
      const missing = Object.keys(require.cache)
        .filter((path) => path.startsWith(root + "/") && !path.includes("/node_modules/"))
        .map((path) => relative(root, resolve(path)).replaceAll("\\\\", "/"))
        .filter((path) => path.endsWith(".js") && !guarded.has(path))
        .sort();
      process.stdout.write(JSON.stringify(missing));
    `;
    const { stdout } = await EXEC_FILE(process.execPath, ["-e", script]);
    expect(JSON.parse(stdout) as string[]).toEqual([]);
  });

  it("runs settled success and one closed repair, then freezes unknown settlement", async () => {
    const [repository, gateway] = await Promise.all([
      compiledExecutionRepository(),
      realRunnerGateway(),
    ]);
    const runnerPath = join(
      repository.root,
      "apps/api/dist/site-builder/eval/copy-real-capability-runner.js",
    );
    const sourcePath = join(
      repository.root,
      "apps/api/dist/site-builder/eval/copy-pilot-source-verifier.js",
    );
    const gatewayPath = join(
      repository.root,
      "apps/api/dist/site-builder/eval/copy-pilot-trusted-gateway.js",
    );
    const markerPath = join(
      repository.root,
      "apps/api/dist/site-builder/eval/copy-pilot-ledger-identity.js",
    );
    const digestPath = join(
      repository.root,
      "apps/api/dist/model-runtime/context-engine.js",
    );
    const evidenceDirectory = join(repository.root, "evidence");
    await mkdir(evidenceDirectory);
    const script = `
      const { createHash } = require("node:crypto");
      const { readFileSync } = require("node:fs");
      const runnerModule = require(${JSON.stringify(runnerPath)});
      const sourceModule = require(${JSON.stringify(sourcePath)});
      const gatewayModule = require(${JSON.stringify(gatewayPath)});
      const markerModule = require(${JSON.stringify(markerPath)});
      const { canonicalDigest } = require(${JSON.stringify(digestPath)});
      (async () => {
        const artifact = JSON.parse(readFileSync(${JSON.stringify(repository.manifestPath)}, "utf8"));
        const now = Date.now();
        const issuedAt = new Date(now - 60_000).toISOString();
        const expiresAt = new Date(now + 60 * 60_000).toISOString();
        const ledgerPath = ${JSON.stringify(join(evidenceDirectory, "ledger.jsonl"))};
        const authorizationClaimPath = ${JSON.stringify(join(evidenceDirectory, "authorization.claim.json"))};
        const ledgerMarkerPath = ${JSON.stringify(join(evidenceDirectory, "ledger.marker.jsonl"))};
        const campaignId = "copy-real-integration-v3";
        const prepared = await markerModule.prepareCopyPilotLedgerIdentity({
          ledgerPath,
          authorizationClaimPath,
          markerPath: ledgerMarkerPath,
          campaignId,
        });
        const credential = {
          schemaVersion: "site-builder-copy-pilot-credential-attestation/2026-08-05-v3",
          attestationId: "copy-real-integration-credential-v2",
          capturedAt: issuedAt,
          expiresAt,
          gatewayOrigin: ${JSON.stringify(gateway.origin)},
          bearerTokenSha256: createHash("sha256").update(${JSON.stringify(gateway.authorizationValue)}).digest("hex"),
          purpose: "site_builder_copy_capability_pilot",
          quotaMode: "limited",
          quotaCapPoints: 10000,
          remainingQuotaPoints: 9900,
          maximumQuotaPointsPerWire: 1000,
          reservedQuotaPoints: 6000,
          scopeExact: true,
          repairPayloadPolicy: "bounded_structured_prior_output_64k",
          executions: artifact.manifest.executions,
          channels: artifact.manifest.executions.map((entry, index) => ({
            alias: entry.alias,
            protocol: entry.protocol,
            channelId: index + 20,
          })),
          resolverId: "copy-real-integration-resolver-v2",
        };
        const settlement = {
          schemaVersion: "site-builder-copy-pilot-settlement-observer/2026-08-05-v1",
          resolverId: credential.resolverId,
          status: "READY",
          observation: "request_bound_new_api_consume_log",
          requestIdentityHeader: "x-oneapi-request-id",
          requiredObservationPerPhysicalCall: true,
          maximumPollDurationMs: 1000,
          unknownSettlementPolicy: "freeze_campaign",
        };
        const authorizationWithoutReservation = {
          schemaVersion: "site-builder-copy-pilot-dispatch-authorization/2026-08-05-v1",
          authorizationId: "copy-real-integration-authorization-v3",
          status: "AUTHORIZED",
          issuedAt,
          expiresAt,
          manifestDigest: canonicalDigest(artifact.manifest),
          credentialAttestationDigest: canonicalDigest(credential),
          settlementObserverDigest: canonicalDigest(settlement),
          ledgerIdentityDigest: prepared.ledgerIdentityDigest,
          reservationId: "copy-real-integration-reservation-v3",
          reservationStatus: "RESERVED",
          maximumExecutions: 3,
          maximumWireCalls: 6,
          maximumRepairCallsPerExecution: 1,
        };
        const authorization = {
          ...authorizationWithoutReservation,
          reservationDigest: runnerModule.copyPilotReservationDigest(authorizationWithoutReservation),
        };
        const admission = {
          manifest: artifact.manifest,
          sourceVerification: {
            fixedSourceCommit: artifact.manifest.fixedSourceCommit,
            sourceBundleDigest: artifact.manifest.sourceBundleDigest,
            fixedCommitReachableFromExecutionHead: true,
            trackedSourceBytesMatch: true,
            compiledContractsMatch: true,
          },
          credential,
          settlement,
          authorization,
        };
        const verifiedSource = await sourceModule.createCopyPilotVerifiedSource({
          repositoryRoot: ${JSON.stringify(repository.root)},
          manifestArtifactPath: ${JSON.stringify(repository.manifestPath)},
        });
        const trustedGateway = await gatewayModule.createCopyPilotTrustedGateway({
          admission,
          bearerToken: ${JSON.stringify(gateway.authorizationValue)},
        });
        const runner = await runnerModule.createCopyRealCapabilityRunner({
          ledgerPath,
          authorizationClaimPath,
          ledgerMarkerPath,
          campaignId,
          admission,
          verifiedSource,
          trustedGateway,
        });
        const terra = await runner.execute("copy-capability-1-gpt-5.6-terra");
        const sol = await runner.execute("copy-capability-2-gpt-5.6-sol");
        let sonnetError;
        try {
          await runner.execute("copy-capability-3-claude-sonnet-5");
        } catch (error) {
          sonnetError = String(error && error.message);
        }
        process.stdout.write(JSON.stringify({
          terra: runnerModule.getCopyRealCapabilityReceipt(terra),
          sol: runnerModule.getCopyRealCapabilityReceipt(sol),
          sonnetError,
          summary: await runner.summary(),
        }));
      })().catch((error) => {
        process.stderr.write(error && error.stack ? error.stack : String(error));
        process.exitCode = 1;
      });
    `;
    const { stdout } = await EXEC_FILE(process.execPath, ["-e", script], {
      maxBuffer: 4 * 1024 * 1024,
    });
    const result = JSON.parse(stdout) as {
      terra: {
        classification: string;
        evidenceClass: string;
        wireCount: number;
        repaired: boolean;
      };
      sol: {
        classification: string;
        evidenceClass: string;
        wireCount: number;
        repaired: boolean;
      };
      sonnetError: string;
      summary: {
        completedExecutions: number;
        knownWireSettlements: number;
        unknownWireSettlements: number;
        frozen: boolean;
      };
    };
    expect(result.terra).toMatchObject({
      classification: "DISPATCH_PREFLIGHT_RECEIPT_ONLY",
      evidenceClass: "copy_gateway_settlement_candidate",
      wireCount: 1,
      repaired: false,
    });
    expect(result.sol).toMatchObject({
      classification: "DISPATCH_PREFLIGHT_RECEIPT_ONLY",
      evidenceClass: "copy_gateway_settlement_candidate",
      wireCount: 2,
      repaired: true,
    });
    expect(result.sonnetError).toMatch(/settlement is unknown/u);
    expect(result.summary).toMatchObject({
      completedExecutions: 2,
      knownWireSettlements: 3,
      unknownWireSettlements: 1,
      frozen: true,
    });
    expect(gateway.observedModelBodies).toHaveLength(4);
    expect(JSON.stringify(result)).not.toContain("real_gateway_settled");
    expect(JSON.stringify(gateway.observedModelBodies[2])).toContain(
      "Invented unsupported performance claim",
    );
  });

  it("compiled runner rejects forged source and gateway handles before dispatch", async () => {
    const directory = await mkdtemp(join(tmpdir(), "copy-runner-forged-"));
    directories.push(directory);
    const compiled = REQUIRE(
      COMPILED_RUNNER_PATH,
    ) as typeof import("./copy-real-capability-runner");
    await expect(
      compiled.createCopyRealCapabilityRunner({
        ledgerPath: join(directory, "ledger.jsonl"),
        authorizationClaimPath: join(directory, "authorization.claim.json"),
        ledgerMarkerPath: join(directory, "ledger.marker.jsonl"),
        campaignId: "copy-real-forged-rejected",
        admission: admission(),
        verifiedSource: Object.freeze({}),
        trustedGateway: Object.freeze({}),
      }),
    ).rejects.toThrow("COPY_PILOT_VERIFIED_SOURCE_REQUIRED");
  });
});
