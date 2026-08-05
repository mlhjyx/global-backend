import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { getDurableModelExecutionAttestation } from "../../model-runtime";
import { COPY_ASSEMBLY_EVAL_FIXTURES } from "./copy-assembly-eval";
import { createCopyCapabilityPilotFakeGatewayRunner } from "./copy-capability-pilot-runner";

interface ObservedRequest {
  path: string;
  body: Record<string, unknown>;
}

const FIXTURE_API_KEY = ["fixture", "not", "a", "credential"].join("-");
const REJECTED_API_KEY = ["not", "a", "fixture", "key"].join("-");

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

function sendJson(
  response: ServerResponse,
  body: unknown,
  requestId: string,
): void {
  response.writeHead(200, {
    "content-type": "application/json",
    "x-oneapi-request-id": requestId,
  });
  response.end(JSON.stringify(body));
}

async function fakeGateway() {
  const output = COPY_ASSEMBLY_EVAL_FIXTURES.find(
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
    const model = String(body.model);
    const requestId = `request-${observed.length}-${model}`;
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
