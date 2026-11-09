import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DRYRUN_MESSAGES,
  DRYRUN_TOOLS,
  estimateDryrunCost,
  finalAnswerFixture,
  followUpMessages,
  identityMismatchFixture,
  runWebToolCallsDryrun,
  scriptedChatCompletions,
  toolRequestFixture,
  validateDryrunInputs,
  type ChatWithToolsWire,
} from "./chat-tools-dryrun";
import { OpenAICompatibleProvider } from "./providers/openai-compatible.provider";
import type { ChatResponse, GenerateChatWithToolsInput } from "./types";

afterEach(() => vi.unstubAllGlobals());

const provider = () =>
  new OpenAICompatibleProvider({
    id: "dryrun",
    baseUrl: "https://gateway.invalid/v1",
    apiKey: "dryrun-key",
    model: "default-model",
  });

describe("WEB-1 真实 wire 验证的离线半边（dry-run）", () => {
  it("内置夹具通过输入校验；provider 走通 tool_calls 解析、回放与身份门负例", async () => {
    const scripted = scriptedChatCompletions([
      toolRequestFixture("default-model"),
      finalAnswerFixture("default-model"),
      identityMismatchFixture(),
    ]);
    vi.stubGlobal("fetch", scripted.fetchImpl);

    const report = await runWebToolCallsDryrun(provider(), {
      model: "default-model",
      priceCentsPerMtok: 100,
    });

    expect(report.inputViolations).toEqual([]);
    expect(report.rounds.map((round) => [round.name, round.ok])).toEqual([
      ["tool_request", true],
      ["final_answer", true],
      ["identity_gate_negative", true],
    ]);
    expect(report.cost).toMatchObject({
      paidCalls: 2,
      reserveCentsPerCall: 20,
      reserveUpperBoundCents: 40,
      tokenCentsByRound: [1, 1],
      tokenEstimateCents: 2,
    });

    // 两轮真实请求 + 一轮身份负例，均只打到脚本化 wire（零网络）。
    expect(scripted.requests).toHaveLength(3);
    const [first, second] = scripted.requests;
    expect(first!.body).toMatchObject({ tool_choice: "auto", model: "default-model" });
    expect((first!.body.tools as unknown[]).length).toBe(DRYRUN_TOOLS.length);
    const replay = second!.body.messages as Record<string, unknown>[];
    const assistant = replay.find((message) => message.role === "assistant");
    const toolResults = replay.filter((message) => message.role === "tool");
    expect(assistant?.tool_calls).toHaveLength(2);
    expect(toolResults.map((message) => message.tool_call_id)).toEqual([
      "call_dryrun_search",
      "call_dryrun_fetch",
    ]);
  });

  it("第 1 轮没有 tool_use 时报告失败且不伪造回放", async () => {
    const wire: ChatWithToolsWire = {
      generateChatWithTools: async (): Promise<{ data: ChatResponse }> => ({
        data: { text: "direct answer", toolUses: [], stopReason: "end" },
      }),
    };
    const report = await runWebToolCallsDryrun(wire, {
      model: "default-model",
      priceCentsPerMtok: 100,
    });
    expect(report.rounds[0]).toMatchObject({ name: "tool_request", ok: false });
    expect(report.rounds[1]).toMatchObject({ name: "final_answer", ok: false });
  });

  it("身份门负例若不拒绝（返回一致模型）则报告失败", async () => {
    const wire: ChatWithToolsWire = {
      generateChatWithTools: async (
        input: GenerateChatWithToolsInput,
      ): Promise<{ data: ChatResponse }> => ({
        data:
          input.messages.some((message) => message.role === "tool")
            ? { text: "answer", toolUses: [], stopReason: "end" }
            : {
                text: "",
                toolUses: [
                  { id: "call_1", name: "web_search", input: { query: "q" } },
                  { id: "call_2", name: "web_fetch", input: { url: "https://example.org" } },
                ],
                stopReason: "tool_use",
              },
      }),
    };
    const report = await runWebToolCallsDryrun(wire, {
      model: "default-model",
      priceCentsPerMtok: 100,
    });
    expect(report.rounds.map((round) => [round.name, round.ok])).toEqual([
      ["tool_request", true],
      ["final_answer", true],
      ["identity_gate_negative", false],
    ]);
  });

  it("输入校验拒绝非法 tool 名、重复 id 与无主的工具结果", () => {
    expect(
      validateDryrunInputs({ messages: [...DRYRUN_MESSAGES], tools: [...DRYRUN_TOOLS] }),
    ).toEqual([]);

    const badTools = validateDryrunInputs({
      messages: [...DRYRUN_MESSAGES],
      tools: [
        { name: "bad name!", description: "x", inputSchema: { type: "object" } },
        { name: "web_search", description: "x", inputSchema: { type: "object" } },
        { name: "web_search", description: "x", inputSchema: { type: "object" } },
        { name: "broken", description: "x", inputSchema: { type: 123 } },
      ],
    });
    expect(badTools).toEqual(
      expect.arrayContaining([
        expect.stringContaining("tool name 非法"),
        expect.stringContaining("tool name 重复：web_search"),
        expect.stringContaining("inputSchema 不可编译"),
      ]),
    );

    const orphanToolResult = validateDryrunInputs({
      messages: [{ role: "tool", toolUseId: "call_missing", content: "{}" }],
      tools: [],
    });
    expect(orphanToolResult).toEqual([
      expect.stringContaining("没有对应的 assistant tool_use"),
    ]);

    const duplicateUse = validateDryrunInputs({
      messages: [
        {
          role: "assistant",
          content: "",
          toolUses: [
            { id: "call_dup", name: "web_search", input: {} },
            { id: "call_dup", name: "web_search", input: {} },
          ],
        },
      ],
      tools: [],
    });
    expect(duplicateUse).toEqual([expect.stringContaining("tool_use id 重复 call_dup")]);
  });

  it("回放消息序列通过校验（assistant toolUses + 两段结果按 id 对应）", () => {
    const messages = followUpMessages([
      { id: "call_a", name: "web_search", input: { query: "q" } },
      { id: "call_b", name: "web_fetch", input: { url: "https://example.org" } },
    ]);
    expect(validateDryrunInputs({ messages, tools: [...DRYRUN_TOOLS] })).toEqual([]);
  });

  it("费用估算：按目录价取整、每轮至少 1¢、预留按次口径", () => {
    expect(estimateDryrunCost({ priceCentsPerMtok: 100 })).toMatchObject({
      paidCalls: 2,
      reserveCentsPerCall: 20,
      reserveUpperBoundCents: 40,
      tokenCentsByRound: [1, 1],
      tokenEstimateCents: 2,
      priceCentsPerMtok: 100,
    });
    // 高价目录（如按 1 美元=100¢ 的 pro 档口径拉满）：按 token 精确放大。
    expect(
      estimateDryrunCost({ priceCentsPerMtok: 1_000_000 }).tokenCentsByRound,
    ).toEqual([458, 695]);
    expect(
      estimateDryrunCost({
        priceCentsPerMtok: 100,
        rounds: [{ promptTokens: 0, completionTokens: 0 }],
      }).tokenCentsByRound,
    ).toEqual([1]);
    expect(
      estimateDryrunCost({ priceCentsPerMtok: 100, reserveCentsPerCall: 5 })
        .reserveUpperBoundCents,
    ).toBe(10);
  });
});
