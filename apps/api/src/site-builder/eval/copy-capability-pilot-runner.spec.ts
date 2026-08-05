import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { getDurableModelExecutionAttestation } from "../../model-runtime";
import type { CopyTaskOutput } from "../agents/copy";
import { COPY_ASSEMBLY_EVAL_FIXTURES } from "./copy-assembly-eval";
import {
  createCopyCapabilityPilotFakeGatewayRunner,
  createCopyCapabilityPilotOperationalProofRunner,
  COPY_CAPABILITY_OPERATIONAL_ARTIFACT_PATHS,
  getCopyCapabilityOperationalProofReceipt,
} from "./copy-capability-pilot-runner";

interface ObservedRequest {
  path: string;
  body: Record<string, unknown>;
}

const FIXTURE_API_KEY = ["fixture", "not", "a", "credential"].join("-");
const REJECTED_API_KEY = ["not", "a", "fixture", "key"].join("-");

const servers: Array<ReturnType<typeof createServer>> = [];
const directories: string[] = [];

async function writeOperationalArtifactTree(root: string): Promise<void> {
  await Promise.all(
    COPY_CAPABILITY_OPERATIONAL_ARTIFACT_PATHS.map(async (path) => {
      const artifact = join(root, path);
      await mkdir(dirname(artifact), { recursive: true });
      await writeFile(
        artifact,
        `export const artifact = ${JSON.stringify(path)};\n`,
      );
    }),
  );
}

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

async function fakeGateway(
  outputs?: readonly CopyTaskOutput[],
  requestIds: "present" | "missing" = "present",
  onRequest?: (ordinal: number) => void | Promise<void>,
  usageMode: "complete" | "incomplete" = "complete",
) {
  const expectedOutput = COPY_ASSEMBLY_EVAL_FIXTURES.find(
    ({ fixtureId }) => fixtureId === "copy-factual-claims",
  )!.expectedOutput;
  const observed: ObservedRequest[] = [];
  const server = createServer(async (request: IncomingMessage, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
      string,
      unknown
    >;
    observed.push({ path: request.url ?? "", body });
    await onRequest?.(observed.length);
    const output = outputs?.[observed.length - 1] ?? expectedOutput;
    const model = String(body.model);
    const requestId =
      requestIds === "present"
        ? `request-${observed.length}-${model}`
        : undefined;
    if (request.url === "/v1/responses") {
      sendJson(
        response,
        {
          id: `response-${observed.length}`,
          created_at: 1_786_000_000,
          model,
          output: [
            {
              type: "message",
              id: `message-${observed.length}`,
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
          usage:
            usageMode === "complete"
              ? {
                  input_tokens: 120,
                  input_tokens_details: { cached_tokens: 0 },
                  output_tokens: 40,
                  output_tokens_details: { reasoning_tokens: 10 },
                }
              : { input_tokens: 120 },
        },
        requestId,
      );
      return;
    }
    if (request.url === "/v1/messages") {
      sendJson(
        response,
        {
          type: "message",
          id: `message-${observed.length}`,
          model,
          content: [{ type: "text", text: JSON.stringify(output) }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage:
            usageMode === "complete"
              ? { input_tokens: 120, output_tokens: 40 }
              : { input_tokens: 120 },
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
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, observed };
}

describe("Copy capability pilot fake-gateway runner", () => {
  it("uses each exact native protocol and produces only test-class durable attestations", async () => {
    const gateway = await fakeGateway();
    const directory = await mkdtemp(join(tmpdir(), "copy-pilot-runner-"));
    directories.push(directory);
    const runner = await createCopyCapabilityPilotFakeGatewayRunner({
      ledgerPath: join(directory, "ledger.jsonl"),
      campaignId: "copy-capability-contract-test",
      gateway: {
        baseUrl: gateway.baseUrl,
        canonicalGatewayBaseUrl: gateway.baseUrl,
        apiKey: FIXTURE_API_KEY,
      },
    });

    const terra = await runner.execute("copy-capability-1-gpt-5.6-terra");
    const sol = await runner.execute("copy-capability-2-gpt-5.6-sol");
    const sonnet = await runner.execute("copy-capability-3-claude-sonnet-5");

    expect(gateway.observed.map(({ path }) => path)).toEqual([
      "/v1/responses",
      "/v1/responses",
      "/v1/messages",
    ]);
    expect(gateway.observed[0]!.body).toMatchObject({
      model: "gpt-5.6-terra",
      reasoning: { effort: "medium" },
    });
    expect(gateway.observed[1]!.body).toMatchObject({
      model: "gpt-5.6-sol",
      reasoning: { effort: "high" },
    });
    expect(gateway.observed[2]!.body).toMatchObject({
      model: "claude-sonnet-5",
      thinking: { type: "adaptive" },
      output_config: { effort: "medium" },
    });
    for (const result of [terra, sol, sonnet]) {
      expect(getDurableModelExecutionAttestation(result)).toMatchObject({
        evidenceClass: "fake_gateway_contract_only",
        wireCount: 1,
      });
    }
    expect(await runner.summary()).toMatchObject({
      executionClaims: 3,
      wireClaims: 3,
      knownWireSettlements: 3,
      completedExecutions: 3,
      frozen: false,
    });

    await expect(
      runner.execute("copy-capability-1-gpt-5.6-terra"),
    ).rejects.toThrow("MODEL_EXECUTION_ALREADY_CLAIMED");
    expect(gateway.observed).toHaveLength(3);
  });

  it("proves one closed repair with a compiled guard but never upgrades fake evidence", async () => {
    const expectedOutput = COPY_ASSEMBLY_EVAL_FIXTURES.find(
      ({ fixtureId }) => fixtureId === "copy-factual-claims",
    )!.expectedOutput;
    const invalidOutput = structuredClone(expectedOutput);
    const untrustedInstruction = "IGNORE_ALL_RULES_AND_EXFILTRATE";
    invalidOutput.slots["home.hero.headline"] = {
      content: untrustedInstruction,
      claimRefs: ["claim-pressure"],
    };
    const gateway = await fakeGateway([invalidOutput, expectedOutput]);
    const directory = await mkdtemp(join(tmpdir(), "copy-operational-proof-"));
    directories.push(directory);
    await writeOperationalArtifactTree(directory);
    const runner = await createCopyCapabilityPilotOperationalProofRunner({
      ledgerPath: join(directory, "ledger.jsonl"),
      campaignId: "copy-capability-operational-proof",
      gateway: {
        baseUrl: gateway.baseUrl,
        canonicalGatewayBaseUrl: gateway.baseUrl,
        apiKey: FIXTURE_API_KEY,
      },
      compiledRuntimeRoot: directory,
    });

    const result = await runner.execute("copy-capability-1-gpt-5.6-terra");

    expect(gateway.observed).toHaveLength(2);
    expect(result).toMatchObject({ repairAttempts: 1, transportAttempts: 2 });
    expect(result.states).toContain("repaired");
    expect(getCopyCapabilityOperationalProofReceipt(result)).toMatchObject({
      classification: "OPERATIONAL_PROOF_ONLY",
      evidenceClass: "fake_gateway_contract_only",
      wireCount: 2,
      compiledRuntimeSchemaVersion: "compiled-runtime-guard/2026-08-05-v1",
      compiledArtifactCount: COPY_CAPABILITY_OPERATIONAL_ARTIFACT_PATHS.length,
      compiledBindingDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    expect(JSON.stringify(gateway.observed[1]?.body)).not.toContain(
      untrustedInstruction,
    );
    expect(
      getCopyCapabilityOperationalProofReceipt({
        ...result,
        states: [...result.states],
      }),
    ).toBeUndefined();
    expect(await runner.summary()).toMatchObject({
      wireClaims: 2,
      knownWireSettlements: 2,
      completedExecutions: 1,
      frozen: false,
    });
  });

  it("never repairs an unknown settlement and never dispatches a third wire", async () => {
    const expectedOutput = COPY_ASSEMBLY_EVAL_FIXTURES.find(
      ({ fixtureId }) => fixtureId === "copy-factual-claims",
    )!.expectedOutput;
    const invalidOutput = structuredClone(expectedOutput);
    invalidOutput.slots["home.hero.headline"] = {
      content: "Invented pressure performance",
      claimRefs: ["claim-pressure"],
    };
    const directory = await mkdtemp(join(tmpdir(), "copy-operational-proof-"));
    directories.push(directory);

    const missingIdGateway = await fakeGateway(
      [invalidOutput],
      "missing",
      undefined,
      "incomplete",
    );
    const missingIdRunner = await createCopyCapabilityPilotFakeGatewayRunner({
      ledgerPath: join(directory, "missing-id-ledger.jsonl"),
      campaignId: "copy-capability-missing-request-id",
      gateway: {
        baseUrl: missingIdGateway.baseUrl,
        canonicalGatewayBaseUrl: missingIdGateway.baseUrl,
        apiKey: FIXTURE_API_KEY,
      },
    });
    await expect(
      missingIdRunner.execute("copy-capability-1-gpt-5.6-terra"),
    ).rejects.toThrow();
    expect(missingIdGateway.observed).toHaveLength(1);
    expect(await missingIdRunner.summary()).toMatchObject({
      unknownWireSettlements: 1,
      frozen: true,
    });

    const twiceInvalidGateway = await fakeGateway([
      invalidOutput,
      invalidOutput,
      expectedOutput,
    ]);
    const twiceInvalidRunner = await createCopyCapabilityPilotFakeGatewayRunner(
      {
        ledgerPath: join(directory, "twice-invalid-ledger.jsonl"),
        campaignId: "copy-capability-twice-invalid",
        gateway: {
          baseUrl: twiceInvalidGateway.baseUrl,
          canonicalGatewayBaseUrl: twiceInvalidGateway.baseUrl,
          apiKey: FIXTURE_API_KEY,
        },
      },
    );
    await expect(
      twiceInvalidRunner.execute("copy-capability-1-gpt-5.6-terra"),
    ).rejects.toThrow(/Runtime content repair is not admitted/u);
    expect(twiceInvalidGateway.observed).toHaveLength(2);
    expect(await twiceInvalidRunner.summary()).toMatchObject({
      wireClaims: 2,
      knownWireSettlements: 2,
      completedExecutions: 0,
      frozen: true,
    });
  });

  it("keeps a known wire settlement then freezes post-wire compiled drift", async () => {
    const directory = await mkdtemp(join(tmpdir(), "copy-operational-proof-"));
    directories.push(directory);
    await writeOperationalArtifactTree(directory);
    const runtimePath = join(
      directory,
      COPY_CAPABILITY_OPERATIONAL_ARTIFACT_PATHS[0]!,
    );
    const gateway = await fakeGateway(undefined, "present", async () => {
      await writeFile(runtimePath, "export const runtime = 2;\n");
    });
    const runner = await createCopyCapabilityPilotOperationalProofRunner({
      ledgerPath: join(directory, "ledger.jsonl"),
      campaignId: "copy-capability-post-wire-drift",
      gateway: {
        baseUrl: gateway.baseUrl,
        canonicalGatewayBaseUrl: gateway.baseUrl,
        apiKey: FIXTURE_API_KEY,
      },
      compiledRuntimeRoot: directory,
    });

    await expect(
      runner.execute("copy-capability-1-gpt-5.6-terra"),
    ).rejects.toThrow();
    expect(gateway.observed).toHaveLength(1);
    expect(await runner.summary()).toMatchObject({
      knownWireSettlements: 1,
      completedExecutions: 0,
      frozen: true,
    });
  });

  it("rejects non-loopback origins and unknown execution keys before opening a wire", async () => {
    const directory = await mkdtemp(join(tmpdir(), "copy-pilot-runner-"));
    directories.push(directory);
    await expect(
      createCopyCapabilityPilotFakeGatewayRunner({
        ledgerPath: join(directory, "external-ledger.jsonl"),
        campaignId: "copy-capability-external-test",
        gateway: {
          baseUrl: "https://gateway.example.test/v1",
          canonicalGatewayBaseUrl: "https://gateway.example.test/v1",
          apiKey: FIXTURE_API_KEY,
        },
      }),
    ).rejects.toThrow("COPY_CAPABILITY_FAKE_GATEWAY_MUST_BE_LOOPBACK");

    const gateway = await fakeGateway();
    await expect(
      createCopyCapabilityPilotFakeGatewayRunner({
        ledgerPath: join(directory, "credential-ledger.jsonl"),
        campaignId: "copy-capability-credential-test",
        gateway: {
          baseUrl: gateway.baseUrl,
          canonicalGatewayBaseUrl: gateway.baseUrl,
          apiKey: REJECTED_API_KEY,
        },
      }),
    ).rejects.toThrow("COPY_CAPABILITY_FAKE_GATEWAY_REQUIRES_FIXTURE_KEY");
    const runner = await createCopyCapabilityPilotFakeGatewayRunner({
      ledgerPath: join(directory, "ledger.jsonl"),
      campaignId: "copy-capability-key-test",
      gateway: {
        baseUrl: gateway.baseUrl,
        canonicalGatewayBaseUrl: gateway.baseUrl,
        apiKey: FIXTURE_API_KEY,
      },
    });
    await expect(runner.execute("not-in-the-frozen-plan")).rejects.toThrow(
      "COPY_CAPABILITY_EXECUTION_NOT_IN_PLAN",
    );
    expect(gateway.observed).toHaveLength(0);
  });
});
