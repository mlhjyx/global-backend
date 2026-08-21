import { describe, expect, it } from "vitest";
import {
  CATALOG_RESULT_PROJECTION_DEFINITIONS,
  CATALOG_RESULT_PROJECTION_SCHEMAS,
} from "../durable-results/catalog-result-projections";
import {
  SOURCE_RESULT_PROJECTION_DEFINITIONS,
  SOURCE_RESULT_PROJECTION_SCHEMAS,
} from "../durable-results/source-result-projections";
import { isDurableResultStrategy } from "../durable-results/durable-result-strategy";
import { registerBuiltinTools } from "./builtin-tools";
import { type Tool } from "./tool-contract";
import { ToolRegistry } from "./tool-registry";
import { registerSourceTools } from "./source-tools";

function tool(overrides: Partial<Tool> = {}): Tool {
  return {
    id: "test.tool",
    version: "1.0.0",
    category: "search",
    cost: { unit: "call", estimatedCents: 0, external: false },
    rateLimit: { rps: 1, concurrency: 1 },
    compliance: {
      sourcePolicy: "none",
      respectsRobots: false,
      personalData: false,
      allowedPurpose: ["discovery"],
      reversible: true,
      authRequired: false,
      risk: "low",
    },
    capabilities: { produces: [], accepts: [] },
    idempotencyKey: () => "test.tool:key",
    healthCheck: async () => ({ healthy: true }),
    execute: async () => ({ data: {}, costCents: 0 }),
    ...overrides,
  } as Tool;
}

describe("ToolRegistry durable result strategy admission", () => {
  it("rejects a Tool that omits its durable result strategy", () => {
    expect(() => new ToolRegistry().register(tool())).toThrow(
      "TOOL_DURABLE_RESULT_STRATEGY_REQUIRED",
    );
  });

  it("rejects a paid external Tool falsely declared as no physical call", () => {
    expect(() =>
      new ToolRegistry().register(
        tool({
          id: "external.tool",
          cost: { unit: "call", estimatedCents: 0, external: true },
          durableResultStrategy: { kind: "no_physical_call" },
        } as Partial<Tool>),
      ),
    ).toThrow("TOOL_DURABLE_RESULT_STRATEGY_INVALID");
  });

  it("accepts a proven local deterministic Tool declared as no physical call", () => {
    expect(() =>
      new ToolRegistry().register(
        tool({
          id: "local.tool",
          durableResultStrategy: { kind: "no_physical_call" },
        } as Partial<Tool>),
      ),
    ).not.toThrow();
  });

  it("registers every product Tool with one valid strategy and every typed schema has a projector", () => {
    const registry = registerSourceTools(
      registerBuiltinTools(new ToolRegistry()),
    );
    const tools = registry.all();
    const typedSchemas = new Set([
      ...CATALOG_RESULT_PROJECTION_DEFINITIONS.map(
        (definition) => definition.schema,
      ),
      ...SOURCE_RESULT_PROJECTION_DEFINITIONS.map(
        (definition) => definition.schema,
      ),
    ]);
    const declaredTypedSchemas = new Set([
      ...Object.values(CATALOG_RESULT_PROJECTION_SCHEMAS),
      ...Object.values(SOURCE_RESULT_PROJECTION_SCHEMAS),
    ]);

    expect(tools).toHaveLength(18);
    for (const registered of tools) {
      const strategy = Reflect.get(registered, "durableResultStrategy");
      expect(isDurableResultStrategy(strategy), registered.id).toBe(true);
      if (
        strategy &&
        typeof strategy === "object" &&
        strategy.kind === "typed_projection"
      ) {
        expect(declaredTypedSchemas.has(strategy.schema), registered.id).toBe(
          true,
        );
        expect(typedSchemas.has(strategy.schema), registered.id).toBe(true);
      }
    }
  });
});
