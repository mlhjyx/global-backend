import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createRequire } from "node:module";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import { canonicalDigest } from "../../model-runtime/context-engine";
import { COPY_TASK } from "../agents/copy";
import { COPY_CAPABILITY_PILOT_PLAN } from "./copy-capability-pilot";
import {
  COPY_REAL_CAPABILITY_ADMISSION_SOURCE,
  copyPilotChildReservationDigest,
  type CopyRealCapabilityAdmissionInput,
} from "./copy-real-capability-admission";
import { COPY_ASSEMBLY_EVAL_FIXTURES } from "./copy-assembly-eval";
import {
  COPY_REAL_CAPABILITY_ARTIFACT_PATHS,
  createCopyGitEvidenceAcceptanceChallenge,
  copyPilotLedgerIdentityDigest,
  copyPilotReservationDigest,
  createCopyRealCapabilityRunner as createSourceRunner,
  getCopyGitAcceptedExecutionAttestation,
} from "./copy-real-capability-runner";
import { prepareCopyPilotLedgerIdentity } from "./copy-pilot-ledger-identity";
import { COPY_PILOT_COMPILED_BUILD_COMMANDS } from "./copy-pilot-source-verifier";

const EXEC_FILE = promisify(execFile);
const REQUIRE = createRequire(import.meta.url);
const REPOSITORY_ROOT = resolve(__dirname, "../../../../..");
const COMPILED_RUNNER_PATH = join(
  REPOSITORY_ROOT,
  "apps/api/dist/site-builder/eval/copy-real-capability-runner.js",
);
const COMPILED_GIT_ACCEPTANCE_PATH = join(
  REPOSITORY_ROOT,
  "apps/api/dist/model-runtime/git-reviewed-evidence-acceptance.js",
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

function sendOpenAiChatCompletionsStream(
  response: ServerResponse,
  input: {
    requestId: string;
    alias: string;
    output: unknown;
    inputTokens: number;
    outputTokens: number;
  },
): void {
  const id = `chatcmpl-${input.requestId}`;
  const chunks = [
    {
      id,
      object: "chat.completion.chunk",
      created: 1_786_000_000,
      model: input.alias,
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            content: JSON.stringify(input.output),
          },
          finish_reason: null,
        },
      ],
    },
    {
      id,
      object: "chat.completion.chunk",
      created: 1_786_000_000,
      model: input.alias,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: {
        prompt_tokens: input.inputTokens,
        completion_tokens: input.outputTokens,
        total_tokens: input.inputTokens + input.outputTokens,
        prompt_tokens_details: { cached_tokens: 0 },
        completion_tokens_details: { reasoning_tokens: 10 },
      },
    },
  ];
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    "x-oneapi-request-id": input.requestId,
  });
  for (const chunk of chunks) {
    response.write(`data: ${JSON.stringify(chunk)}\n\n`);
  }
  response.end("data: [DONE]\n\n");
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
  const observedModelRequests: Array<{
    path: string;
    body: Record<string, unknown>;
  }> = [];
  const control = { sharedDrift: false };
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
            "gpt-5.6-terra": true,
            "gpt-5.6-sol": true,
            "claude-sonnet-5": true,
          },
          total_granted: 10_000,
          total_available: control.sharedDrift ? 3_000 : 9_900,
        },
      });
      return;
    }
    if (request.url === "/test/fail-shared") {
      control.sharedDrift = true;
      sendJson(response, { ok: true });
      return;
    }
    if (request.url === "/v1/models") {
      sendJson(response, {
        object: "list",
        data: [
          { id: "gpt-5.6-terra" },
          { id: "gpt-5.6-sol" },
          { id: "claude-sonnet-5" },
        ],
      });
      return;
    }
    if (request.url === "/api/log/token") {
      sendJson(response, { data: logs });
      return;
    }
    if (
      request.url !== "/v1/chat/completions" &&
      request.url !== "/v1/messages"
    ) {
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
    observedModelRequests.push({ path: request.url, body });
    const alias = String(body.model);
    const ordinal = (callsByAlias.get(alias) ?? 0) + 1;
    callsByAlias.set(alias, ordinal);
    const requestId = `request-real-${alias.replaceAll(".", "-")}-${ordinal}`;
    const output =
      alias === "gpt-5.6-sol" && ordinal === 1 ? invalid : expected;
    if (alias === "gpt-5.6-terra") {
      response.writeHead(524, {
        "content-type": "application/json",
        "x-oneapi-request-id": requestId,
      });
      response.end(JSON.stringify({ error: { message: "upstream timeout" } }));
      return;
    }
    if (alias !== "gpt-5.6-terra") {
      logs.push({
        request_id: requestId,
        type: 2,
        model_name: alias,
        channel: channelByAlias.get(alias),
        quota: 100,
        prompt_tokens: 120,
        completion_tokens: 40,
        ...(alias === "claude-sonnet-5"
          ? {
              other: {
                usage_semantic: "anthropic",
                cache_creation_tokens: 0,
                cache_tokens: 0,
              },
            }
          : {}),
      });
    }
    if (request.url === "/v1/chat/completions") {
      if (body.stream !== true) {
        response.writeHead(400).end();
        return;
      }
      sendOpenAiChatCompletionsStream(response, {
        requestId,
        alias,
        output,
        inputTokens: 120,
        outputTokens: 40,
      });
      return;
    }
    sendJson(
      response,
      {
        type: "message",
        id: `message-${ordinal}`,
        model: alias,
        content: [
          {
            type: "tool_use",
            id: `toolu-${ordinal}`,
            name: "json",
            input: output,
          },
        ],
        stop_reason: "tool_use",
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
    observedModelRequests,
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
  const compiledArtifacts = await Promise.all(
    [...COPY_REAL_CAPABILITY_ARTIFACT_PATHS].sort().map(async (path) => ({
      path,
      sha256: createHash("sha256")
        .update(await readFile(join(root, path)))
        .digest("hex"),
    })),
  );
  const withoutDigest = {
    schemaVersion:
      "site-builder-copy-real-capability-manifest-prep/2026-08-05-v1",
    artifactId:
      "site-builder-copy-real-capability-manifest-prep/integration-v3",
    classification: "FIXED_SOURCE_CREATE_ONLY",
    fixedSourceCommit,
    preparationHeadCommit: fixedSourceCommit,
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
    compiledRuntimeExpectation: {
      schemaVersion: "compiled-runtime-expectation/2026-08-08-v1",
      buildSourceCommit: fixedSourceCommit,
      sourceBundleDigest: canonicalDigest(files),
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
  git(root, "commit", "-qm", "fixed source manifest");
  git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
  return { root, manifestPath, manifest };
}

function admission(selectedIndex = 0): CopyRealCapabilityAdmissionInput {
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
      "site-builder-copy-pilot-settlement-observer/2026-08-06-v2" as const,
    resolverId: credential.resolverId,
    status: "READY" as const,
    observation: "request_bound_new_api_consume_log" as const,
    requestIdentityHeader: "x-oneapi-request-id" as const,
    requiredObservationPerPhysicalCall: true as const,
    maximumPollDurationMs: 2_000,
    unknownSettlementPolicy: "freeze_selected_child_campaign" as const,
  };
  const children = COPY_CAPABILITY_PILOT_PLAN.childCampaigns.map(
    (child, index) => ({
      ...child,
      campaignId: `copy-runner-child-campaign-${index + 1}`,
      authorizationId: `copy-runner-child-authorization-${index + 1}`,
      reservationId: `copy-runner-child-reservation-${index + 1}`,
      ledgerIdentityDigest: String(index + 1).repeat(64),
      reservedQuotaPoints: 2_000,
    }),
  );
  const authorization = {
    schemaVersion:
      "site-builder-copy-pilot-global-dispatch-authorization/2026-08-06-v2" as const,
    authorizationId: "copy-runner-global-authorization-test-v4",
    status: "AUTHORIZED" as const,
    issuedAt,
    expiresAt,
    manifestDigest: canonicalDigest(manifest),
    credentialAttestationDigest: canonicalDigest(credential),
    settlementObserverDigest: canonicalDigest(settlement),
    reservationStatus: "RESERVED" as const,
    maximumExecutions: 3 as const,
    maximumWireCalls: 6 as const,
    maximumRepairCallsPerExecution: 1 as const,
    unknownSettlementPolicy: "freeze_selected_child_campaign" as const,
    sharedDriftPolicy: "freeze_all_child_campaigns" as const,
    children,
  };
  const selected = children[selectedIndex]!;
  const childWithoutDigest = {
    schemaVersion:
      "site-builder-copy-pilot-child-dispatch-authorization/2026-08-06-v1" as const,
    globalAuthorizationDigest: canonicalDigest(authorization),
    childSlotId: selected.childSlotId,
    executionKey: selected.executionKey,
    campaignId: selected.campaignId,
    authorizationId: selected.authorizationId,
    status: "AUTHORIZED" as const,
    issuedAt,
    expiresAt,
    manifestDigest: authorization.manifestDigest,
    credentialAttestationDigest: authorization.credentialAttestationDigest,
    settlementObserverDigest: authorization.settlementObserverDigest,
    ledgerIdentityDigest: selected.ledgerIdentityDigest,
    reservationId: selected.reservationId,
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
      reservationDigest: copyPilotChildReservationDigest(childWithoutDigest),
    },
    selectedExecutionKey: selected.executionKey,
  };
}

describe("Copy real capability runner admission", () => {
  it("rejects forged candidate and Git-accepted execution objects", () => {
    expect(() =>
      createCopyGitEvidenceAcceptanceChallenge(Object.freeze({}) as never),
    ).toThrow("COPY_GIT_EVIDENCE_CANDIDATE_REQUIRED");
    expect(
      getCopyGitAcceptedExecutionAttestation(
        Object.freeze({
          classification: "OPAQUE_COPY_GIT_ACCEPTED_EXECUTION",
        }),
      ),
    ).toBeUndefined();
  });

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
    const authorization = admission().childAuthorization;
    const { reservationDigest, ...withoutDigest } = authorization;
    expect(copyPilotReservationDigest(withoutDigest)).toBe(reservationDigest);
    expect(
      copyPilotReservationDigest({
        ...withoutDigest,
        maximumWireCalls: 3 as never,
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

  it("retires Ed25519 from the compiled runner dependency and guard surface", async () => {
    const script = `
      const runner = require(${JSON.stringify(COMPILED_RUNNER_PATH)});
      const loaded = Object.keys(require.cache);
      process.stdout.write(JSON.stringify({
        guarded: runner.COPY_REAL_CAPABILITY_ARTIFACT_PATHS,
        loaded,
      }));
    `;
    const { stdout } = await EXEC_FILE(process.execPath, ["-e", script]);
    const result = JSON.parse(stdout) as {
      guarded: string[];
      loaded: string[];
    };
    expect(result.guarded).toContain(
      "apps/api/dist/model-runtime/git-reviewed-evidence-acceptance.js",
    );
    expect(result.guarded.join("\n")).not.toContain("copy-operator-evidence");
    expect(result.loaded.join("\n")).not.toContain("copy-operator-evidence");
  });

  it("freezes the compiled Git acceptance exports against CommonJS replacement", () => {
    const acceptance = REQUIRE(COMPILED_GIT_ACCEPTANCE_PATH) as Record<
      string,
      unknown
    >;
    const getter = acceptance.getGitReviewedEvidenceAcceptanceAttestation;

    expect(Object.isFrozen(acceptance)).toBe(true);
    expect(
      Reflect.set(
        acceptance,
        "getGitReviewedEvidenceAcceptanceAttestation",
        () => ({ artifactId: "forged" }),
      ),
    ).toBe(false);
    expect(acceptance.getGitReviewedEvidenceAcceptanceAttestation).toBe(getter);
  });

  it("captures the receipt digest function before CommonJS export drift", async () => {
    const contextPath = join(
      REPOSITORY_ROOT,
      "apps/api/dist/model-runtime/context-engine.js",
    );
    const script = `
      const runner = require(${JSON.stringify(COMPILED_RUNNER_PATH)});
      const context = require(${JSON.stringify(contextPath)});
      const reservation = {
        schemaVersion: "site-builder-copy-pilot-child-dispatch-authorization/2026-08-06-v1",
        globalAuthorizationDigest: "0".repeat(64),
        childSlotId: "copy-child-slot-1",
        executionKey: "copy-capability-1-gpt-5.6-terra",
        campaignId: "copy-digest-capture-campaign",
        authorizationId: "copy-digest-capture-auth",
        status: "AUTHORIZED",
        issuedAt: "2026-08-06T00:00:00.000Z",
        expiresAt: "2026-08-06T01:00:00.000Z",
        reservationId: "copy-digest-capture-reservation",
        manifestDigest: "a".repeat(64),
        credentialAttestationDigest: "b".repeat(64),
        settlementObserverDigest: "c".repeat(64),
        ledgerIdentityDigest: "d".repeat(64),
        reservationStatus: "RESERVED",
        maximumExecutions: 1,
        maximumWireCalls: 2,
        maximumRepairCallsPerExecution: 1,
      };
      const before = runner.copyPilotReservationDigest(reservation);
      context.canonicalDigest = () => "e".repeat(64);
      const after = runner.copyPilotReservationDigest(reservation);
      process.stdout.write(JSON.stringify({ before, after }));
    `;
    const { stdout } = await EXEC_FILE(process.execPath, ["-e", script]);
    const result = JSON.parse(stdout) as { before: string; after: string };
    expect(result.after).toBe(result.before);
    expect(result.after).not.toBe("e".repeat(64));
  });

  it("isolates unknown settlement to one child while sibling campaigns complete", async () => {
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
    const acceptancePath = join(
      repository.root,
      "apps/api/dist/model-runtime/git-reviewed-evidence-acceptance.js",
    );
    const pilotPath = join(
      repository.root,
      "apps/api/dist/site-builder/eval/copy-capability-pilot.js",
    );
    const evidenceDirectory = join(repository.root, "evidence");
    await mkdir(evidenceDirectory);
    const acceptanceStatePath = join(
      evidenceDirectory,
      "persisted-acceptance-state.json",
    );
    const freshAcceptanceScript = `
      const { readFileSync } = require("node:fs");
      const pilotModule = require(${JSON.stringify(pilotPath)});
      const originalPlan = pilotModule.COPY_CAPABILITY_PILOT_PLAN;
      pilotModule.COPY_CAPABILITY_PILOT_PLAN = Object.freeze({
        ...originalPlan,
        planId: "post-dispatch-current-plan-drift",
      });
      const runnerModule = require(${JSON.stringify(runnerPath)});
      const acceptanceModule = require(${JSON.stringify(acceptancePath)});
      const { canonicalDigest } = require(${JSON.stringify(digestPath)});
      const rawState = readFileSync(${JSON.stringify(acceptanceStatePath)}, "utf8");
      const state = JSON.parse(rawState);
      const persistedArtifact = JSON.parse(readFileSync(state.acceptanceArtifactPath, "utf8"));
      let fetchCalls = 0;
      global.fetch = () => {
        fetchCalls += 1;
        throw new Error("COPY_EVIDENCE_ONLY_NETWORK_FORBIDDEN");
      };
      (async () => {
        const gitAcceptance = await acceptanceModule.verifyGitReviewedEvidenceAcceptanceArtifact({
          repositoryRoot: state.repositoryRoot,
          artifactPath: state.acceptanceArtifactPath,
        });
        const forgedGitAcceptance =
          await acceptanceModule.verifyGitReviewedEvidenceAcceptanceArtifact({
            repositoryRoot: state.repositoryRoot,
            artifactPath: state.forgedAcceptanceArtifactPath,
          });
        const forgedCompiledAcceptance =
          await acceptanceModule.verifyGitReviewedEvidenceAcceptanceArtifact({
            repositoryRoot: state.repositoryRoot,
            artifactPath: state.forgedCompiledArtifactPath,
          });
        const forgedNestedAcceptance =
          await acceptanceModule.verifyGitReviewedEvidenceAcceptanceArtifact({
            repositoryRoot: state.repositoryRoot,
            artifactPath: state.forgedNestedArtifactPath,
          });
        const forgedPlanFieldAcceptances = {};
        for (const [key, artifactPath] of Object.entries(
          state.forgedPlanFieldArtifactPaths,
        )) {
          forgedPlanFieldAcceptances[key] =
            await acceptanceModule.verifyGitReviewedEvidenceAcceptanceArtifact({
              repositoryRoot: state.repositoryRoot,
              artifactPath,
            });
        }
        const sonnetRunner = await runnerModule.reopenCopyGitEvidenceAcceptanceRunner({
          ...state.paths[2],
        });
        const solRunner = await runnerModule.reopenCopyGitEvidenceAcceptanceRunner({
          ...state.paths[1],
        });
        let forgedAcceptanceError;
        try {
          await sonnetRunner.acceptGitReviewedEvidence({ acceptance: Object.freeze({}) });
        } catch (error) {
          forgedAcceptanceError = String(error && error.message);
        }
        let forgedSettlementChainError;
        try {
          await sonnetRunner.acceptGitReviewedEvidence({
            acceptance: forgedGitAcceptance,
          });
        } catch (error) {
          forgedSettlementChainError = String(error && error.message);
        }
        let forgedCompiledRuntimeError;
        try {
          await sonnetRunner.acceptGitReviewedEvidence({
            acceptance: forgedCompiledAcceptance,
          });
        } catch (error) {
          forgedCompiledRuntimeError = String(error && error.message);
        }
        let forgedNestedSecretError;
        try {
          await sonnetRunner.acceptGitReviewedEvidence({
            acceptance: forgedNestedAcceptance,
          });
        } catch (error) {
          forgedNestedSecretError = String(error && error.message);
        }
        const forgedPlanFieldErrors = {};
        for (const [key, acceptance] of Object.entries(
          forgedPlanFieldAcceptances,
        )) {
          try {
            await sonnetRunner.acceptGitReviewedEvidence({ acceptance });
          } catch (error) {
            forgedPlanFieldErrors[key] = String(error && error.message);
          }
        }
        let crossCandidateAcceptanceError;
        try {
          await solRunner.acceptGitReviewedEvidence({ acceptance: gitAcceptance });
        } catch (error) {
          crossCandidateAcceptanceError = String(error && error.message);
        }
        let legacyAdmissionInputError;
        try {
          await runnerModule.reopenCopyGitEvidenceAcceptanceRunner({
            ...state.paths[2],
            admission: { forbidden: "evidence-only-reopen-does-not-take-admission" },
          });
        } catch (error) {
          legacyAdmissionInputError = String(error && error.message);
        }
        let bearerInputError;
        try {
          await runnerModule.reopenCopyGitEvidenceAcceptanceRunner({
            ...state.paths[2],
            bearerToken: "forbidden-on-evidence-only-reopen",
          });
        } catch (error) {
          bearerInputError = String(error && error.message);
        }
        let acceptanceBearerInputError;
        try {
          await sonnetRunner.acceptGitReviewedEvidence({
            acceptance: gitAcceptance,
            bearerToken: "forbidden-on-evidence-only-acceptance",
          });
        } catch (error) {
          acceptanceBearerInputError = String(error && error.message);
        }
        const accepted = await sonnetRunner.acceptGitReviewedEvidence({
          acceptance: gitAcceptance,
        });
        const acceptedRetry = await sonnetRunner.acceptGitReviewedEvidence({
          acceptance: gitAcceptance,
        });
        const acceptedAttestation =
          runnerModule.getCopyGitAcceptedExecutionAttestation(accepted);
        const acceptedRetryAttestation =
          runnerModule.getCopyGitAcceptedExecutionAttestation(acceptedRetry);
        const originalWeakMapGet = WeakMap.prototype.get;
        WeakMap.prototype.get = () => ({ classification: "FORGED" });
        const ambientAcceptedAttestation =
          runnerModule.getCopyGitAcceptedExecutionAttestation(accepted);
        WeakMap.prototype.get = originalWeakMapGet;
        process.stdout.write(JSON.stringify({
          acceptedAttestation,
          acceptedRetryAttestation,
          ambientAcceptedAttestation,
          forgedAcceptanceError,
          forgedSettlementChainError,
          forgedCompiledRuntimeError,
          forgedNestedSecretError,
          forgedPlanFieldErrors,
          crossCandidateAcceptanceError,
          legacyAdmissionInputError,
          bearerInputError,
          acceptanceBearerInputError,
          proofExpiredBeforeAcceptance:
            Date.parse(state.authorizationExpiresAt) <= Date.now(),
          currentPlanDrifted: pilotModule.COPY_CAPABILITY_PILOT_PLAN.planId !== originalPlan.planId,
          currentPlanDigestDrifted:
            canonicalDigest(pilotModule.COPY_CAPABILITY_PILOT_PLAN) !==
            persistedArtifact.candidateReceipt.ledgerCampaign.planDigest,
          fetchCalls,
          runnerKeys: Object.keys(sonnetRunner).sort(),
          summary: await sonnetRunner.summary(),
          persistedStateContainsBearer:
            rawState.includes("forbidden-on-evidence-only-reopen") ||
            rawState.includes('"bearerToken":') ||
            rawState.includes('"apiKey":'),
        }));
      })().catch((error) => {
        process.stderr.write(error && error.stack ? error.stack : String(error));
        process.exitCode = 1;
      });
    `;
    const script = `
      const { createHash } = require("node:crypto");
      const { execFileSync } = require("node:child_process");
      const { readFileSync, writeFileSync } = require("node:fs");
      const runnerModule = require(${JSON.stringify(runnerPath)});
      const sourceModule = require(${JSON.stringify(sourcePath)});
      const gatewayModule = require(${JSON.stringify(gatewayPath)});
      const markerModule = require(${JSON.stringify(markerPath)});
      const acceptanceModule = require(${JSON.stringify(acceptancePath)});
      const { canonicalDigest } = require(${JSON.stringify(digestPath)});
      (async () => {
        const artifact = JSON.parse(readFileSync(${JSON.stringify(repository.manifestPath)}, "utf8"));
        const RealDate = Date;
        const dispatchNow = RealDate.now() - 2 * 60 * 60_000;
        class DispatchDate extends RealDate {
          constructor(...args) {
            super(...(args.length === 0 ? [dispatchNow] : args));
          }
          static now() {
            return dispatchNow;
          }
        }
        global.Date = DispatchDate;
        const now = Date.now();
        const issuedAt = new Date(now - 60_000).toISOString();
        const expiresAt = new Date(now + 60 * 60_000).toISOString();
        const childPlans = require(${JSON.stringify(
          join(
            repository.root,
            "apps/api/dist/site-builder/eval/copy-capability-pilot.js",
          ),
        )}).COPY_CAPABILITY_PILOT_PLAN.childCampaigns;
        const paths = childPlans.map((child, index) => ({
          ledgerPath: ${JSON.stringify(evidenceDirectory)} + "/ledger-" + (index + 1) + ".jsonl",
          authorizationClaimPath: ${JSON.stringify(evidenceDirectory)} + "/authorization-" + (index + 1) + ".claim.json",
          ledgerMarkerPath: ${JSON.stringify(evidenceDirectory)} + "/ledger-" + (index + 1) + ".marker.jsonl",
          campaignId: "copy-real-child-campaign-" + (index + 1),
        }));
        const prepared = await Promise.all(paths.map((entry) =>
          markerModule.prepareCopyPilotLedgerIdentity({
            ledgerPath: entry.ledgerPath,
            authorizationClaimPath: entry.authorizationClaimPath,
            markerPath: entry.ledgerMarkerPath,
            campaignId: entry.campaignId,
          })
        ));
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
          schemaVersion: "site-builder-copy-pilot-settlement-observer/2026-08-06-v2",
          resolverId: credential.resolverId,
          status: "READY",
          observation: "request_bound_new_api_consume_log",
          requestIdentityHeader: "x-oneapi-request-id",
          requiredObservationPerPhysicalCall: true,
          maximumPollDurationMs: 1000,
          unknownSettlementPolicy: "freeze_selected_child_campaign",
        };
        const children = childPlans.map((child, index) => ({
          ...child,
          campaignId: paths[index].campaignId,
          authorizationId: "copy-real-child-authorization-" + (index + 1),
          reservationId: "copy-real-child-reservation-" + (index + 1),
          ledgerIdentityDigest: prepared[index].ledgerIdentityDigest,
          reservedQuotaPoints: 2000,
        }));
        const authorization = {
          schemaVersion: "site-builder-copy-pilot-global-dispatch-authorization/2026-08-06-v2",
          authorizationId: "copy-real-global-authorization-v4",
          status: "AUTHORIZED",
          issuedAt,
          expiresAt,
          manifestDigest: canonicalDigest(artifact.manifest),
          credentialAttestationDigest: canonicalDigest(credential),
          settlementObserverDigest: canonicalDigest(settlement),
          reservationStatus: "RESERVED",
          maximumExecutions: 3,
          maximumWireCalls: 6,
          maximumRepairCallsPerExecution: 1,
          unknownSettlementPolicy: "freeze_selected_child_campaign",
          sharedDriftPolicy: "freeze_all_child_campaigns",
          children,
        };
        const admissions = children.map((selected) => {
          const childWithoutDigest = {
            schemaVersion: "site-builder-copy-pilot-child-dispatch-authorization/2026-08-06-v1",
            globalAuthorizationDigest: canonicalDigest(authorization),
            childSlotId: selected.childSlotId,
            executionKey: selected.executionKey,
            campaignId: selected.campaignId,
            authorizationId: selected.authorizationId,
            status: "AUTHORIZED",
            issuedAt,
            expiresAt,
            manifestDigest: authorization.manifestDigest,
            credentialAttestationDigest: authorization.credentialAttestationDigest,
            settlementObserverDigest: authorization.settlementObserverDigest,
            ledgerIdentityDigest: selected.ledgerIdentityDigest,
            reservationId: selected.reservationId,
            reservationStatus: "RESERVED",
            maximumExecutions: 1,
            maximumWireCalls: 2,
            maximumRepairCallsPerExecution: 1,
          };
          return {
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
            childAuthorization: {
              ...childWithoutDigest,
              reservationDigest: runnerModule.copyPilotReservationDigest(childWithoutDigest),
            },
            selectedExecutionKey: selected.executionKey,
          };
        });
        const verifiedSource = await sourceModule.createCopyPilotVerifiedSource({
          repositoryRoot: ${JSON.stringify(repository.root)},
          manifestArtifactPath: ${JSON.stringify(repository.manifestPath)},
        });
        const trustedGateways = await Promise.all(admissions.map((admission) =>
          gatewayModule.createCopyPilotTrustedGateway({
            admission,
            bearerToken: ${JSON.stringify(gateway.authorizationValue)},
          })
        ));
        const runners = await Promise.all(admissions.map((admission, index) =>
          runnerModule.createCopyRealCapabilityRunner({
            ...paths[index],
            admission,
            verifiedSource,
            trustedGateway: trustedGateways[index],
          })
        ));
        let unboundChildError;
        try {
          await runners[0].execute("copy-capability-1-gpt-5.6-terra");
        } catch (error) {
          unboundChildError = String(error && error.message);
        }
        const originalWeakMapGet = WeakMap.prototype.get;
        let ambientWeakMapBypassError;
        WeakMap.prototype.get = () => "copy-capability-1-gpt-5.6-terra";
        try {
          await runners[0].execute("copy-capability-1-gpt-5.6-terra");
        } catch (error) {
          ambientWeakMapBypassError = String(error && error.message);
        } finally {
          WeakMap.prototype.get = originalWeakMapGet;
        }
        let duplicateBatchError;
        try {
          runnerModule.createCopyRealCapabilityCampaignRunner({
            runners: [runners[0], runners[0], runners[2]],
          });
        } catch (error) {
          duplicateBatchError = String(error && error.message);
        }
        const campaignRunner = runnerModule.createCopyRealCapabilityCampaignRunner({
          runners,
        });
        const solRunner = runners[1];
        let wrongChildError;
        try {
          await runners[0].execute("copy-capability-2-gpt-5.6-sol");
        } catch (error) {
          wrongChildError = String(error && error.message);
        }
        runners[1] = runners[0];
        let terraError;
        try {
          await campaignRunner.execute("copy-capability-1-gpt-5.6-terra");
        } catch (error) {
          terraError = String(error && error.message);
        }
        const sol = await campaignRunner.execute("copy-capability-2-gpt-5.6-sol");
        const sonnet = await campaignRunner.execute("copy-capability-3-claude-sonnet-5");
        global.Date = RealDate;
        const sonnetChallenge = runnerModule.createCopyGitEvidenceAcceptanceChallenge(sonnet);
        const acceptanceArtifact = runnerModule.createCopyGitEvidenceAcceptanceArtifact({
          artifactId: "copy-capability-sonnet-acceptance-401",
          challenge: sonnetChallenge,
        });
        const acceptanceArtifactPath = ${JSON.stringify(repository.root)} + "/docs/evidence/copy-sonnet-acceptance.json";
        await acceptanceModule.writeGitReviewedEvidenceAcceptanceArtifact({
          artifactPath: acceptanceArtifactPath,
          artifact: acceptanceArtifact,
        });
        const forgedReceipt = structuredClone(sonnetChallenge.receipt);
        forgedReceipt.settlementChain.wires[0].observation.quota += 1;
        const forgedChallenge = {
          schemaVersion: sonnetChallenge.schemaVersion,
          candidateReceiptDigest: canonicalDigest(forgedReceipt),
          receipt: forgedReceipt,
        };
        let forgedChallengeError;
        try {
          runnerModule.createCopyGitEvidenceAcceptanceArtifact({
            artifactId: "copy-capability-sonnet-forged-challenge",
            challenge: forgedChallenge,
          });
        } catch (error) {
          forgedChallengeError = String(error && error.message);
        }
        const forgedAcceptanceArtifact =
          acceptanceModule.createGitReviewedEvidenceAcceptanceArtifact({
            artifactId: "copy-capability-sonnet-forged-acceptance-402",
            acceptedEvidenceClass: "git_reviewed_gateway_settlement_accepted",
            taskId: "site_builder.copy",
            evidenceKind: "capability_pilot",
            candidateReceipt: forgedReceipt,
            subject: acceptanceArtifact.subject,
          });
        const forgedAcceptanceArtifactPath = ${JSON.stringify(repository.root)} + "/docs/evidence/copy-sonnet-forged-acceptance.json";
        await acceptanceModule.writeGitReviewedEvidenceAcceptanceArtifact({
          artifactPath: forgedAcceptanceArtifactPath,
          artifact: forgedAcceptanceArtifact,
        });
        const forgedCompiledReceipt = structuredClone(sonnetChallenge.receipt);
        forgedCompiledReceipt.compiledRuntimeDigest = "f".repeat(64);
        const forgedCompiledAcceptanceArtifact =
          acceptanceModule.createGitReviewedEvidenceAcceptanceArtifact({
            artifactId: "copy-capability-sonnet-forged-compiled-403",
            acceptedEvidenceClass: "git_reviewed_gateway_settlement_accepted",
            taskId: "site_builder.copy",
            evidenceKind: "capability_pilot",
            candidateReceipt: forgedCompiledReceipt,
            subject: {
              ...acceptanceArtifact.subject,
              compiledRuntimeDigest: forgedCompiledReceipt.compiledRuntimeDigest,
            },
          });
        const forgedCompiledArtifactPath = ${JSON.stringify(repository.root)} + "/docs/evidence/copy-sonnet-forged-compiled.json";
        await acceptanceModule.writeGitReviewedEvidenceAcceptanceArtifact({
          artifactPath: forgedCompiledArtifactPath,
          artifact: forgedCompiledAcceptanceArtifact,
        });
        const forgedNestedReceipt = structuredClone(sonnetChallenge.receipt);
        forgedNestedReceipt.settlementChain.wires[0].observation.requestId =
          "raw-request-id-must-not-enter-evidence";
        const forgedNestedAcceptanceArtifact =
          acceptanceModule.createGitReviewedEvidenceAcceptanceArtifact({
            artifactId: "copy-capability-sonnet-forged-nested-404",
            acceptedEvidenceClass: "git_reviewed_gateway_settlement_accepted",
            taskId: "site_builder.copy",
            evidenceKind: "capability_pilot",
            candidateReceipt: forgedNestedReceipt,
            subject: acceptanceArtifact.subject,
          });
        const forgedNestedArtifactPath = ${JSON.stringify(repository.root)} + "/docs/evidence/copy-sonnet-forged-nested.json";
        await acceptanceModule.writeGitReviewedEvidenceAcceptanceArtifact({
          artifactPath: forgedNestedArtifactPath,
          artifact: forgedNestedAcceptanceArtifact,
        });
        const forbiddenChallengeErrors = {};
        for (const [key, mutate] of Object.entries({
          bearerToken: (receipt) => { receipt.bearerToken = "forbidden"; },
          [["api", "Key"].join("")]: (receipt) => {
            Reflect.set(receipt, ["api", "Key"].join(""), "forbidden");
          },
          requestId: (receipt) => { receipt.settlementChain.wires[0].observation.requestId = "forbidden"; },
          prompt: (receipt) => { receipt.prompt = "forbidden"; },
          output: (receipt) => { receipt.settlementChain.wires[0].observation.output = "forbidden"; },
          rawOutput: (receipt) => { receipt.settlementChain.rawOutput = "forbidden"; },
          unknownNested: (receipt) => { receipt.settlementChain.wires[0].unknownNested = true; },
        })) {
          const candidate = structuredClone(sonnetChallenge.receipt);
          mutate(candidate);
          try {
            runnerModule.createCopyGitEvidenceAcceptanceArtifact({
              artifactId: "copy-capability-forbidden-" + key,
              challenge: {
                schemaVersion: sonnetChallenge.schemaVersion,
                candidateReceiptDigest: canonicalDigest(candidate),
                receipt: candidate,
              },
            });
          } catch (error) {
            forbiddenChallengeErrors[key] = String(error && error.message);
          }
        }
        const forgedPlanFieldArtifactPaths = {};
        const forgedPlanFieldRelativePaths = [];
        for (const [key, mutate] of Object.entries({
          inputDigest: (receipt) => { receipt.inputDigest = "a".repeat(64); },
          contextDigest: (receipt) => { receipt.contextDigest = "b".repeat(64); },
          promptDigest: (receipt) => { receipt.promptDigest = "c".repeat(64); },
          fixtureId: (receipt) => { receipt.fixtureId = "copy-forged-fixture"; },
          childSlotId: (receipt) => { receipt.childSlotId = "copy-forged-child-slot"; },
          reasoning: (receipt) => { receipt.reasoning = "high"; },
          unknownNested: (receipt) => {
            receipt.settlementChain.wires[0].unknownNested = true;
          },
        })) {
          const candidate = structuredClone(sonnetChallenge.receipt);
          mutate(candidate);
          const artifactForField =
            acceptanceModule.createGitReviewedEvidenceAcceptanceArtifact({
              artifactId: "copy-capability-sonnet-forged-field-" + key,
              acceptedEvidenceClass: "git_reviewed_gateway_settlement_accepted",
              taskId: "site_builder.copy",
              evidenceKind: "capability_pilot",
              candidateReceipt: candidate,
              subject: {
                ...acceptanceArtifact.subject,
                ...(key === "reasoning" ? { reasoning: candidate.reasoning } : {}),
              },
            });
          const relativePath = "docs/evidence/copy-sonnet-forged-field-" + key + ".json";
          const artifactPath = ${JSON.stringify(repository.root)} + "/" + relativePath;
          await acceptanceModule.writeGitReviewedEvidenceAcceptanceArtifact({
            artifactPath,
            artifact: artifactForField,
          });
          forgedPlanFieldArtifactPaths[key] = artifactPath;
          forgedPlanFieldRelativePaths.push(relativePath);
        }
        const git = (...args) => execFileSync("git", args, {
          cwd: ${JSON.stringify(repository.root)},
          encoding: "utf8",
        }).trim();
        const mainBranch = git("rev-parse", "--abbrev-ref", "HEAD");
        git("checkout", "-qb", "acceptance/copy-sonnet");
        git("add", "docs/evidence/copy-sonnet-acceptance.json");
        git("commit", "-qm", "test: accept Copy Sonnet evidence");
        git("checkout", "-q", mainBranch);
        git(
          "merge",
          "--no-ff",
          "acceptance/copy-sonnet",
          "-m",
          "Merge pull request #401 from test/acceptance-copy-sonnet",
        );
        git("update-ref", "refs/remotes/origin/main", "HEAD");
        git("checkout", "-qb", "acceptance/copy-sonnet-forged");
        git(
          "add",
          "docs/evidence/copy-sonnet-forged-acceptance.json",
          "docs/evidence/copy-sonnet-forged-compiled.json",
          "docs/evidence/copy-sonnet-forged-nested.json",
          ...forgedPlanFieldRelativePaths,
        );
        git("commit", "-qm", "test: add forged Copy settlement artifact");
        git("checkout", "-q", mainBranch);
        git(
          "merge",
          "--no-ff",
          "acceptance/copy-sonnet-forged",
          "-m",
          "Merge pull request #402 from test/acceptance-copy-sonnet-forged",
        );
        git("update-ref", "refs/remotes/origin/main", "HEAD");
        let liveReopenExpiredError;
        try {
          await runnerModule.createCopyRealCapabilityRunner({
            ...paths[2],
            admission: admissions[2],
            verifiedSource,
            trustedGateway: trustedGateways[2],
          });
        } catch (error) {
          liveReopenExpiredError = String(error && error.message);
        }
        await fetch(${JSON.stringify(gateway.origin)} + "/test/fail-shared", {
          headers: { authorization: "Bearer " + ${JSON.stringify(gateway.authorizationValue)} },
        });
        writeFileSync(
          ${JSON.stringify(acceptanceStatePath)},
          JSON.stringify({
            repositoryRoot: ${JSON.stringify(repository.root)},
            acceptanceArtifactPath,
            forgedAcceptanceArtifactPath,
            forgedCompiledArtifactPath,
            forgedNestedArtifactPath,
            forgedPlanFieldArtifactPaths,
            paths,
            authorizationExpiresAt: expiresAt,
          }),
          { mode: 0o600 },
        );
        const freshAcceptance = JSON.parse(execFileSync(
          process.execPath,
          ["-e", ${JSON.stringify(freshAcceptanceScript)}],
          { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
        ));
        const summariesBeforeSharedDrift = await campaignRunner.summaries();
        global.Date = DispatchDate;
        let sharedDriftError;
        try {
          await campaignRunner.execute("copy-capability-3-claude-sonnet-5");
        } catch (error) {
          sharedDriftError = String(error && error.message);
        } finally {
          global.Date = RealDate;
        }
        const acceptanceArtifactText = readFileSync(acceptanceArtifactPath, "utf8");
        const terraWireObservation = readFileSync(paths[0].ledgerPath, "utf8")
          .trim()
          .split("\\n")
          .map((line) => JSON.parse(line).event)
          .find((event) => event.kind === "wire_observed");
        process.stdout.write(JSON.stringify({
          unboundChildError,
          ambientWeakMapBypassError,
          duplicateBatchError,
          wrongChildError,
          terraError,
          terraWireObservation,
          liveReopenExpiredError,
          forgedChallengeError,
          forbiddenChallengeErrors,
          ...freshAcceptance,
          acceptanceArtifactContainsBearer: acceptanceArtifactText.includes(${JSON.stringify(gateway.authorizationValue)}),
          acceptanceArtifactContainsSecretField:
            /"(?:bearerToken|apiKey|requestId|prompt|output|rawOutput)"\\s*:/u.test(
              acceptanceArtifactText,
            ),
          sharedDriftError,
          sol: runnerModule.getCopyRealCapabilityReceipt(sol),
          solChallenge: runnerModule.createCopyGitEvidenceAcceptanceChallenge(sol),
          sonnet: runnerModule.getCopyRealCapabilityReceipt(sonnet),
          sonnetChallenge,
          summariesBeforeSharedDrift,
          summariesAfterSharedDrift: await campaignRunner.summaries(),
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
      unboundChildError: string;
      ambientWeakMapBypassError: string;
      duplicateBatchError: string;
      wrongChildError: string;
      terraError: string;
      terraWireObservation: {
        kind: string;
        settlement: string;
        requestId: string | null;
        reason: string;
      };
      forgedAcceptanceError: string;
      forgedSettlementChainError: string;
      forgedCompiledRuntimeError: string;
      forgedNestedSecretError: string;
      forgedPlanFieldErrors: Record<string, string>;
      crossCandidateAcceptanceError: string;
      legacyAdmissionInputError: string;
      liveReopenExpiredError: string;
      forgedChallengeError: string;
      forbiddenChallengeErrors: Record<string, string>;
      bearerInputError: string;
      acceptanceBearerInputError: string;
      proofExpiredBeforeAcceptance: boolean;
      currentPlanDrifted: boolean;
      currentPlanDigestDrifted: boolean;
      fetchCalls: number;
      runnerKeys: string[];
      persistedStateContainsBearer: boolean;
      summary: {
        completedExecutions: number;
        knownWireSettlements: number;
        unknownWireSettlements: number;
        gitEvidenceAcceptances: number;
        frozen: boolean;
      };
      acceptanceArtifactContainsBearer: boolean;
      acceptanceArtifactContainsSecretField: boolean;
      sharedDriftError: string;
      acceptedAttestation: {
        classification: string;
        evidenceClass: string;
        evidenceKind: string;
        acceptanceId: string;
        artifactDigest: string;
        artifactCommit: string;
        mergeCommit: string;
        pullRequestNumber: number;
        candidateReceiptDigest: string;
        candidateLedgerDigest: string;
        evidenceLedgerDigest: string;
        executionId: string;
        outputDigest: string;
        alias: string;
        protocol: string;
        reasoning: string;
        fixedSourceCommit: string;
        sourceBundleDigest: string;
        manifestDigest: string;
        compiledRuntimeDigest: string;
        compiledBindingDigest: string;
        settlementObserverDigest: string;
        knownSettlementDigest: string;
      };
      acceptedRetryAttestation: {
        evidenceLedgerDigest: string;
      };
      ambientAcceptedAttestation: {
        classification: string;
        artifactDigest: string;
      };
      sol: {
        classification: string;
        evidenceClass: string;
        wireCount: number;
        repaired: boolean;
        childSlotId: string;
        globalAuthorizationDigest: string;
        childAuthorizationDigest: string;
      };
      solChallenge: {
        candidateReceiptDigest: string;
      };
      sonnet: {
        classification: string;
        evidenceClass: string;
        wireCount: number;
        repaired: boolean;
        fixtureId: string;
        repeatIndex: null;
        planDigest: string;
        inputDigest: string;
        contextDigest: string;
        promptDigest: string;
        knownSettlementDigest: string;
        settlementChain: {
          schemaVersion: string;
          executionClaim: { planDigest: string };
          wires: Array<{
            wireIndex: number;
            claim: { wireId: string; requestDigest: string };
            observation: {
              settlement: string;
              requestIdDigest: string;
              resolvedAlias: string;
              protocol: string;
              outputDigest: string;
              receiptDigest: string;
              quota: number;
            };
          }>;
          completion: { outputDigest: string };
          digest: string;
        };
        childSlotId: string;
        globalAuthorizationDigest: string;
        childAuthorizationDigest: string;
      };
      sonnetChallenge: {
        candidateReceiptDigest: string;
      };
      summariesBeforeSharedDrift: Array<{
        completedExecutions: number;
        knownWireSettlements: number;
        unknownWireSettlements: number;
        gitEvidenceAcceptances: number;
        frozen: boolean;
      }>;
      summariesAfterSharedDrift: Array<{
        completedExecutions: number;
        knownWireSettlements: number;
        unknownWireSettlements: number;
        gitEvidenceAcceptances: number;
        frozen: boolean;
      }>;
    };
    expect(result.unboundChildError).toBe(
      "COPY_REAL_CAPABILITY_BATCH_RUNNER_REQUIRED",
    );
    expect(result.ambientWeakMapBypassError).toBe(
      "COPY_REAL_CAPABILITY_BATCH_RUNNER_REQUIRED",
    );
    expect(result.duplicateBatchError).toBe(
      "COPY_REAL_CAPABILITY_CHILD_BATCH_MISMATCH",
    );
    expect(result.wrongChildError).toBe(
      "COPY_REAL_CAPABILITY_BATCH_RUNNER_REQUIRED",
    );
    expect(result.terraError).toMatch(/settlement is unknown/u);
    expect(result.terraWireObservation).toMatchObject({
      kind: "wire_observed",
      settlement: "unknown",
      requestId: "request-real-gpt-5-6-terra-1",
      reason: expect.stringMatching(
        /native_api_failure_http_524:log_unavailable/u,
      ),
    });
    expect(result.terraWireObservation.reason.length).toBeLessThanOrEqual(160);
    expect(result.terraWireObservation.reason).not.toContain(
      "upstream timeout",
    );
    expect(gateway.observedModelRequests[0]).toEqual({
      path: "/v1/chat/completions",
      body: expect.objectContaining({
        model: "gpt-5.6-terra",
        stream: true,
        reasoning_effort: "medium",
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "copy_capability_output",
            strict: true,
            schema: COPY_TASK.outputSchema,
          },
        },
      }),
    });
    expect(result.forgedAcceptanceError).toBe(
      "COPY_GIT_EVIDENCE_ACCEPTANCE_REQUIRED",
    );
    expect(result.forgedSettlementChainError).toBe(
      "COPY_GIT_EVIDENCE_CANDIDATE_MISMATCH",
    );
    expect(result.forgedCompiledRuntimeError).toBe(
      "COPY_GIT_EVIDENCE_CANDIDATE_MISMATCH",
    );
    expect(result.forgedNestedSecretError).toBe(
      "COPY_GIT_EVIDENCE_CANDIDATE_MISMATCH",
    );
    expect(result.forgedPlanFieldErrors).toEqual({
      inputDigest: "COPY_GIT_EVIDENCE_CANDIDATE_MISMATCH",
      contextDigest: "COPY_GIT_EVIDENCE_CANDIDATE_MISMATCH",
      promptDigest: "COPY_GIT_EVIDENCE_CANDIDATE_MISMATCH",
      fixtureId: "COPY_GIT_EVIDENCE_CANDIDATE_MISMATCH",
      childSlotId: "COPY_GIT_EVIDENCE_CANDIDATE_MISMATCH",
      reasoning: "COPY_GIT_EVIDENCE_CANDIDATE_MISMATCH",
      unknownNested: "COPY_GIT_EVIDENCE_CANDIDATE_MISMATCH",
    });
    expect(result.crossCandidateAcceptanceError).toBe(
      "COPY_GIT_EVIDENCE_CANDIDATE_MISMATCH",
    );
    expect(result.legacyAdmissionInputError).toBe(
      "COPY_GIT_EVIDENCE_REOPEN_INPUT_INVALID",
    );
    expect(result.liveReopenExpiredError).toBe(
      "COPY_REAL_CAPABILITY_PROOF_EXPIRED",
    );
    expect(result.forgedChallengeError).toBe(
      "COPY_GIT_EVIDENCE_CANDIDATE_MISMATCH",
    );
    expect(result.forbiddenChallengeErrors).toEqual({
      bearerToken: "COPY_GIT_EVIDENCE_CANDIDATE_MISMATCH",
      [["api", "Key"].join("")]: "COPY_GIT_EVIDENCE_CANDIDATE_MISMATCH",
      requestId: "COPY_GIT_EVIDENCE_CANDIDATE_MISMATCH",
      prompt: "COPY_GIT_EVIDENCE_CANDIDATE_MISMATCH",
      output: "COPY_GIT_EVIDENCE_CANDIDATE_MISMATCH",
      rawOutput: "COPY_GIT_EVIDENCE_CANDIDATE_MISMATCH",
      unknownNested: "COPY_GIT_EVIDENCE_CANDIDATE_MISMATCH",
    });
    expect(result.bearerInputError).toBe(
      "COPY_GIT_EVIDENCE_REOPEN_INPUT_INVALID",
    );
    expect(result.acceptanceBearerInputError).toBe(
      "COPY_GIT_EVIDENCE_ACCEPTANCE_INPUT_INVALID",
    );
    expect(result.proofExpiredBeforeAcceptance).toBe(true);
    expect(result.currentPlanDrifted).toBe(true);
    expect(result.currentPlanDigestDrifted).toBe(true);
    expect(result.fetchCalls).toBe(0);
    expect(result.runnerKeys).toEqual(["acceptGitReviewedEvidence", "summary"]);
    expect(result.persistedStateContainsBearer).toBe(false);
    expect(result.summary).toMatchObject({
      completedExecutions: 1,
      knownWireSettlements: 1,
      unknownWireSettlements: 0,
      gitEvidenceAcceptances: 1,
      frozen: false,
    });
    expect(result.acceptanceArtifactContainsBearer).toBe(false);
    expect(result.acceptanceArtifactContainsSecretField).toBe(false);
    expect(result.acceptedAttestation).toMatchObject({
      classification: "GIT_REVIEWED_REAL_EVIDENCE",
      evidenceClass: "git_reviewed_gateway_settlement_accepted",
      evidenceKind: "capability_pilot",
      acceptanceId: "copy-capability-sonnet-acceptance-401",
      pullRequestNumber: 401,
      executionId: "copy-capability-3-claude-sonnet-5",
      alias: "claude-sonnet-5",
      protocol: "anthropic_messages",
      reasoning: "medium",
    });
    expect([
      result.acceptedAttestation.artifactDigest,
      result.acceptedAttestation.candidateReceiptDigest,
      result.acceptedAttestation.candidateLedgerDigest,
      result.acceptedAttestation.evidenceLedgerDigest,
      result.acceptedAttestation.outputDigest,
      result.acceptedAttestation.sourceBundleDigest,
      result.acceptedAttestation.manifestDigest,
      result.acceptedAttestation.compiledRuntimeDigest,
      result.acceptedAttestation.compiledBindingDigest,
      result.acceptedAttestation.settlementObserverDigest,
      result.acceptedAttestation.knownSettlementDigest,
    ]).toEqual(
      Array.from({ length: 11 }, () =>
        expect.stringMatching(/^[0-9a-f]{64}$/u),
      ),
    );
    expect([
      result.acceptedAttestation.artifactCommit,
      result.acceptedAttestation.mergeCommit,
      result.acceptedAttestation.fixedSourceCommit,
    ]).toEqual(
      Array.from({ length: 3 }, () => expect.stringMatching(/^[0-9a-f]{40}$/u)),
    );
    expect(result.acceptedRetryAttestation.evidenceLedgerDigest).toBe(
      result.acceptedAttestation.evidenceLedgerDigest,
    );
    expect(result.ambientAcceptedAttestation).toEqual(
      result.acceptedAttestation,
    );
    expect(result.sharedDriftError).toBe(
      "COPY_PILOT_LIVE_SCOPE_OR_QUOTA_MISMATCH",
    );
    expect(result.sonnet).toMatchObject({
      classification: "DISPATCH_PREFLIGHT_RECEIPT_ONLY",
      evidenceClass: "copy_gateway_settlement_candidate",
      wireCount: 1,
      repaired: false,
      fixtureId: "copy-factual-claims",
      repeatIndex: null,
      taskId: "site_builder.copy",
      childSlotId: "copy-capability-child-3-claude-sonnet-5",
    });
    expect(result.sonnetChallenge.candidateReceiptDigest).toMatch(
      /^[0-9a-f]{64}$/u,
    );
    expect(result.sonnet.settlementChain).toMatchObject({
      schemaVersion: "real-model-known-settlement-evidence/2026-08-07-v1",
      executionClaim: { planDigest: result.sonnet.planDigest },
      completion: { outputDigest: result.acceptedAttestation.outputDigest },
      digest: result.sonnet.knownSettlementDigest,
      wires: [
        {
          wireIndex: 1,
          observation: {
            settlement: "known",
            resolvedAlias: "claude-sonnet-5",
            protocol: "anthropic_messages",
          },
        },
      ],
    });
    expect(result.sonnet.settlementChain.wires[0]?.observation).toMatchObject({
      requestIdDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
      outputDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
      receiptDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
      quota: expect.any(Number),
    });
    expect([
      result.sonnet.planDigest,
      result.sonnet.inputDigest,
      result.sonnet.contextDigest,
      result.sonnet.promptDigest,
      result.sonnet.globalAuthorizationDigest,
      result.sonnet.childAuthorizationDigest,
      result.sonnet.knownSettlementDigest,
    ]).toEqual([
      expect.stringMatching(/^[0-9a-f]{64}$/u),
      expect.stringMatching(/^[0-9a-f]{64}$/u),
      expect.stringMatching(/^[0-9a-f]{64}$/u),
      expect.stringMatching(/^[0-9a-f]{64}$/u),
      expect.stringMatching(/^[0-9a-f]{64}$/u),
      expect.stringMatching(/^[0-9a-f]{64}$/u),
      expect.stringMatching(/^[0-9a-f]{64}$/u),
    ]);
    expect(result.sol).toMatchObject({
      classification: "DISPATCH_PREFLIGHT_RECEIPT_ONLY",
      evidenceClass: "copy_gateway_settlement_candidate",
      wireCount: 2,
      repaired: true,
      childSlotId: "copy-capability-child-2-gpt-5.6-sol",
    });
    expect(result.solChallenge.candidateReceiptDigest).toMatch(
      /^[0-9a-f]{64}$/u,
    );
    expect(result.solChallenge.candidateReceiptDigest).not.toBe(
      result.sonnetChallenge.candidateReceiptDigest,
    );
    expect(result.summariesBeforeSharedDrift).toHaveLength(3);
    expect(result.summariesBeforeSharedDrift[0]).toMatchObject({
      completedExecutions: 0,
      knownWireSettlements: 0,
      unknownWireSettlements: 1,
      frozen: true,
    });
    expect(result.summariesBeforeSharedDrift[1]).toMatchObject({
      completedExecutions: 1,
      knownWireSettlements: 2,
      unknownWireSettlements: 0,
      gitEvidenceAcceptances: 0,
      frozen: false,
    });
    expect(result.summariesBeforeSharedDrift[2]).toMatchObject({
      completedExecutions: 1,
      knownWireSettlements: 1,
      unknownWireSettlements: 0,
      gitEvidenceAcceptances: 1,
      frozen: false,
    });
    expect(result.summariesAfterSharedDrift).toHaveLength(3);
    expect(result.summariesAfterSharedDrift.every(({ frozen }) => frozen)).toBe(
      true,
    );
    expect(gateway.observedModelBodies).toHaveLength(4);
    expect(gateway.observedModelRequests.map(({ path }) => path)).toEqual([
      "/v1/chat/completions",
      "/v1/chat/completions",
      "/v1/chat/completions",
      "/v1/messages",
    ]);
    expect(gateway.observedModelRequests.at(-1)?.body).toMatchObject({
      tools: [
        {
          name: "json",
          input_schema: COPY_TASK.outputSchema,
        },
      ],
      tool_choice: { type: "any", disable_parallel_tool_use: true },
    });
    expect(gateway.observedModelRequests.at(-1)?.body).not.toHaveProperty(
      "output_config.format",
    );
    expect(JSON.stringify(result)).not.toContain("real_gateway_settled");
    expect(JSON.stringify(gateway.observedModelBodies[2])).toContain(
      "Invented unsupported performance claim",
    );
  }, 15_000);

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
