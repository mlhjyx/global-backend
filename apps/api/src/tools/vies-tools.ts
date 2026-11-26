import {
  checkViesVat,
  type ViesCheckInput,
  type ViesCheckResult,
} from "../adapters/vies";
import { CATALOG_RESULT_PROJECTION_SCHEMAS } from "../durable-results/catalog-result-projections";
import type { Tool } from "./tool-contract";
import type { ToolRegistry } from "./tool-registry";

export type ViesToolInput = ViesCheckInput;
export type ViesToolOutput = ViesCheckResult;

/** vies.check —— 欧盟官方免费 VIES VAT 核验（仅核验法人 VAT 身份，回执剥离原始街道地址）。 */
export const viesCheckTool: Tool<ViesToolInput, ViesToolOutput> = {
  id: "vies.check",
  version: "1.0.0",
  category: "structured_source",
  sourceClass: "company_registry",
  cost: { unit: "call", estimatedCents: 0, external: true },
  rateLimit: { rps: 1, concurrency: 1 },
  compliance: {
    sourcePolicy: "required",
    policyDomain: "ec.europa.eu",
    respectsRobots: false,
    personalData: false,
    allowedPurpose: ["discovery", "enrichment"],
    reversible: true,
    authRequired: false,
    risk: "low",
  },
  capabilities: {
    produces: ["company"],
    accepts: ["keywords"],
    enrichesOnly: true,
  },
  idempotencyKey: (input) =>
    `vies.check:${input.countryCode.trim().toUpperCase()}:${input.vatNumber.replace(/[\s.-]+/gu, "").toUpperCase()}`,
  durableResultStrategy: {
    kind: "typed_projection",
    schema: CATALOG_RESULT_PROJECTION_SCHEMAS["vies.check"],
  },
  healthCheck: async () => ({ healthy: true, detail: "vies" }),
  physicalWireObservation: "before_each_wire",
  execute: async (input, ctx) => ({
    data: await checkViesVat(input, {
      authorizeExternalAction: ctx.authorizeExternalAction,
      beforePhysicalWire: ctx.beforePhysicalWire,
    }),
    costCents: 0,
  }),
};

/** 注册欧盟 VIES VAT 核验工具（由 registerSourceTools 调用，零改动锁定文件 tool-broker.factory.ts）。 */
export function registerViesTools(registry: ToolRegistry): ToolRegistry {
  registry.register(viesCheckTool as Tool);
  return registry;
}
