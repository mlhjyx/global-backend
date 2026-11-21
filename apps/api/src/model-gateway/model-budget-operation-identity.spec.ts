import { describe, expect, it } from "vitest";
import { modelBudgetOperationKey } from "./model-budget-operation-identity";
const GOLDENS = [
  {
    op: "generateText",
    input: {
      task: "taxonomy.normalize",
      model: "m",
      prompt: "中😀",
    },
    context: {
      workspaceId: "11111111-1111-4111-8111-111111111111",
      runId: "account-1",
      correlationId: "c-1",
    },
    expected:
      "7e0c98427aad49d3a5e2c341ab9727ba4a5388d4aabe0c101219d2bb31428a9d",
  },
  {
    op: "generateStructured",
    input: {
      task: "market.candidates.generate",
      model: "m",
      prompt: "p",
      system: "s",
      schema: {
        type: "object",
        properties: {
          outcome: {
            type: "string",
          },
        },
      },
    },
    context: {
      workspaceId: "11111111-1111-4111-8111-111111111111",
      runId: "account-2",
      correlationId: "generation-1",
    },
    expected:
      "f3e319a77051ade50b24cfc3abfa51fca60ac46637b5605babdfba4de65ac958",
  },
  {
    op: "chatWithTools",
    input: {
      task: "taxonomy.normalize",
      messages: [
        {
          role: "user",
          content: "x",
        },
      ],
      tools: [],
    },
    context: {
      workspaceId: "11111111-1111-4111-8111-111111111111",
    },
    expected:
      "b53b77787d1c7df5daef19136c9066699cce7f214d567ba3031afbc8598b2c75",
  },
] as const;

describe("ordinary model budget identity preserves the actual existing ordered byte contract", () => {
  it.each(GOLDENS)(
    "preserves the independent pre-extraction key for $op",
    ({ op, input, context, expected }) => {
      expect(modelBudgetOperationKey(op, input, context)).toBe(expected);
    },
  );
  it("uses the same account default and does not add budget/token options omitted by the old key", () => {
    const base = GOLDENS[1];
    expect(
      modelBudgetOperationKey(
        base.op,
        { ...base.input, maxTokens: 12, maxCostCents: 40 },
        base.context,
      ),
    ).toBe(base.expected);
    expect(
      modelBudgetOperationKey(base.op, base.input, {
        ...base.context,
        runId: undefined,
      }),
    ).not.toBe(base.expected);
  });
  it("distinguishes every real identity material and preserves JSON insertion order rather than canonicalizing it", () => {
    const base = GOLDENS[1];
    const original = base.expected;
    for (const [field, value] of [
      ["task", "other"],
      ["model", "other"],
      ["prompt", "other"],
      ["system", "other"],
    ] as const)
      expect(
        modelBudgetOperationKey(
          base.op,
          { ...base.input, [field]: value },
          base.context,
        ),
      ).not.toBe(original);
    expect(
      modelBudgetOperationKey(
        base.op,
        {
          ...base.input,
          schema: {
            properties: { outcome: { type: "string" } },
            type: "object",
          },
        },
        base.context,
      ),
    ).not.toBe(original);
    expect(
      modelBudgetOperationKey(base.op, base.input, {
        ...base.context,
        correlationId: "other",
      }),
    ).not.toBe(original);
  });
});
