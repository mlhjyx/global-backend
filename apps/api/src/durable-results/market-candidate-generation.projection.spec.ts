import { describe, expect, it } from "vitest";
import {
  getModelResultProjectionSchema,
  registerModelResultProjections,
} from "./model-result-projections";
import { TypedProjectionRegistry } from "./typed-projection.registry";
import type { TypedProjectionSchema } from "./durable-result-strategy";
const SCHEMA = "market-candidates-generation/v1" as TypedProjectionSchema;
const O = "33333333-3333-4333-8333-333333333333";
function statement() {
  return {
    text: "Hypothesis",
    knowledgeState: "INFERENCE",
    basisKeys: [],
    impact: "Needs evidence",
  };
}
function raw() {
  return {
    data: {
      outcome: "CANDIDATES_PROPOSED",
      candidates: [
        {
          proposal: {
            supplyOrCapability: { offeringId: O, description: "Conditional" },
            buyerOrganizationCountry: null,
            projectCountry: null,
            application: statement(),
            organizationRole: statement(),
            fitExplanation: statement(),
            entryConditions: [],
            support: [],
            counterEvidence: [{ ...statement(), knowledgeState: "CONFLICT" }],
            gaps: [],
            recommendation: {
              status: "NOT_RECOMMENDED",
              reason: "Counter-evidence",
            },
            nextVerification: ["Verify"],
          },
        },
      ],
    },
    provider: "synthetic-provider",
    model: "synthetic-model",
  };
}
function registry() {
  return registerModelResultProjections(new TypedProjectionRegistry());
}

describe("generation ModelResult typed projection", () => {
  it("registers the exact producer/schema mapping without an untyped or v0 fallback", () => {
    expect(getModelResultProjectionSchema("market.candidates.generate")).toBe(
      "market-candidates-generation/v1",
    );
    expect(registry().has(SCHEMA)).toBe(true);
  });
  it("restores and reprojects the complete model envelope with identical digest, order, nulls and counter-evidence", () => {
    const input = {
      ...raw(),
      reportedModel: "synthetic-upstream",
      modelResolutionSource: "upstream_response",
      usage: { inputTokens: 8, outputTokens: 5, costUsd: 0.001 },
      callCount: 1,
    };
    const before = structuredClone(input),
      store = registry(),
      projection = store.project(SCHEMA, input),
      restored = store.restore(projection);
    expect(restored).toEqual(before);
    expect(input).toEqual(before);
    expect(store.project(SCHEMA, restored).digest).toBe(projection.digest);
  });
  it("round-trips an explicit empty result without converting a refusal into an empty artifact", () => {
    const input = {
        ...raw(),
        data: { outcome: "COMPLETED_EMPTY", candidates: [] },
      },
      store = registry();
    expect(store.restore(store.project(SCHEMA, input))).toEqual(input);
    expect(() =>
      store.project(SCHEMA, { ...raw(), data: { refusal: "no" } }),
    ).toThrow();
  });
  it.each([
    "candidateId",
    "verified",
    "actor",
    "buyerCompany",
    "personalEmail",
  ])(
    "rejects undeclared authority or buyer property %s instead of stripping it",
    (field) => {
      const input = raw();
      Object.assign(input.data.candidates[0], { [field]: "fake" });
      expect(() => registry().project(SCHEMA, input)).toThrow();
    },
  );
  it("does not execute a model envelope getter and rejects a tampered digest on restore", () => {
    let reads = 0;
    const input = raw();
    Object.defineProperty(input, "model", {
      enumerable: true,
      get() {
        reads++;
        return "fake";
      },
    });
    expect(() => registry().project(SCHEMA, input)).toThrow();
    expect(reads).toBe(0);
    const store = registry(),
      projection = store.project(SCHEMA, raw());
    expect(() =>
      store.restore({ ...projection, digest: "f".repeat(64) }),
    ).toThrow("TYPED_PROJECTION_INVALID");
  });
  it("keeps the unchanged shared 119KiB envelope boundary independent of the stricter 64KiB domain hook", () => {
    // This schema-valid capacity fixture is not a legitimate domain output: the service's 64KiB gate rejects it.
    const input = raw();
    input.data.candidates[0].proposal.nextVerification = [];
    const independent = () => ({
      data: input,
      digest: "0".repeat(64),
      schema: "market-candidates-generation/v1",
      schemaVersion: "generic-operation-projection/v2",
    });
    while (
      Buffer.byteLength(JSON.stringify(independent()), "utf8") + 2003 <
      119 * 1024
    )
      input.data.candidates[0].proposal.nextVerification.push("a".repeat(2000));
    input.data.candidates[0].proposal.nextVerification.push("");
    const missing =
      119 * 1024 - Buffer.byteLength(JSON.stringify(independent()), "utf8");
    input.data.candidates[0].proposal.nextVerification[
      input.data.candidates[0].proposal.nextVerification.length - 1
    ] = "a".repeat(missing);
    expect(Buffer.byteLength(JSON.stringify(independent()), "utf8")).toBe(
      119 * 1024,
    );
    const store = registry(),
      projection = store.project(SCHEMA, input);
    expect(Buffer.byteLength(JSON.stringify(projection), "utf8")).toBe(
      119 * 1024,
    );
    input.data.candidates[0].proposal.nextVerification[
      input.data.candidates[0].proposal.nextVerification.length - 1
    ] += "a";
    expect(() => store.project(SCHEMA, input)).toThrow(
      "TYPED_PROJECTION_TOO_LARGE",
    );
  });
});
