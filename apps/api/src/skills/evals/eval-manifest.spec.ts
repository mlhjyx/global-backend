import { describe, expect, it } from "vitest";
import { validateEvalManifest } from "./eval-manifest";

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    skillName: "compliance.sanctions_screen",
    evals: Array.from({ length: 5 }, (_, index) => ({
      id: index + 1,
      input: { companyName: `Acme ${index}` },
      assertions: [{ kind: "enum", path: "status", values: ["clear", "potential_match", "not_screened"] }],
    })),
    ...overrides,
  };
}

function codes(candidate: unknown): string[] {
  return validateEvalManifest(candidate).map((issue) => issue.code);
}

describe("validateEvalManifest", () => {
  it("accepts a five-case deterministic manifest", () => {
    expect(validateEvalManifest(manifest())).toEqual([]);
  });

  it("requires at least five cases by default and a skill name", () => {
    expect(codes(manifest({ evals: (manifest()["evals"] as unknown[]).slice(0, 4) }))).toContain(
      "EVAL_CASES_TOO_FEW",
    );
    expect(codes(manifest({ skillName: "" }))).toContain("EVAL_SKILL_NAME_INVALID");
  });

  it("rejects duplicate or missing case ids and missing inputs", () => {
    const base = manifest();
    const evals = base["evals"] as Array<Record<string, unknown>>;
    evals[1] = { ...evals[1], id: evals[0]["id"] };
    expect(codes(base)).toContain("EVAL_CASE_ID_DUPLICATE");

    const noInput = manifest();
    delete (noInput["evals"] as Array<Record<string, unknown>>)[0]["input"];
    expect(codes(noInput)).toContain("EVAL_CASE_INPUT_MISSING");
  });

  it("validates the case tier vocabulary so a typo cannot silently skip both layers", () => {
    const ok = manifest();
    (ok["evals"] as Array<Record<string, unknown>>)[0]["tier"] = "deterministic";
    expect(validateEvalManifest(ok)).toEqual([]);

    const typo = manifest();
    (typo["evals"] as Array<Record<string, unknown>>)[0]["tier"] = "Deterministic";
    expect(codes(typo)).toContain("EVAL_CASE_TIER_INVALID");
  });

  it("rejects unknown assertion kinds and forbidden fields", () => {
    const unknownKind = manifest();
    (unknownKind["evals"] as Array<Record<string, unknown>>)[0]["assertions"] = [
      { kind: "shell_command", value: "rm -rf /" },
    ];
    expect(codes(unknownKind)).toContain("EVAL_ASSERTION_KIND_INVALID");

    const scriptField = manifest();
    (scriptField["evals"] as Array<Record<string, unknown>>)[0]["script"] = "echo hi";
    expect(codes(scriptField)).toContain("EVAL_CASE_FIELD_FORBIDDEN");

    const extraField = manifest();
    (extraField["evals"] as Array<Record<string, unknown>>)[0]["assertions"] = [
      { kind: "contains", value: "ok", command: "sh" },
    ];
    expect(codes(extraField)).toContain("EVAL_ASSERTION_FIELD_FORBIDDEN");
  });

  it("validates per-kind payloads", () => {
    const badRegex = manifest();
    (badRegex["evals"] as Array<Record<string, unknown>>)[0]["assertions"] = [
      { kind: "regex", pattern: "(" },
    ];
    expect(codes(badRegex)).toContain("EVAL_ASSERTION_PATTERN_INVALID");

    const badNumber = manifest();
    (badNumber["evals"] as Array<Record<string, unknown>>)[0]["assertions"] = [
      { kind: "gte", value: "5" },
    ];
    expect(codes(badNumber)).toContain("EVAL_ASSERTION_VALUE_MISSING");

    const badEnum = manifest();
    (badEnum["evals"] as Array<Record<string, unknown>>)[0]["assertions"] = [
      { kind: "enum", values: [] },
    ];
    expect(codes(badEnum)).toContain("EVAL_ASSERTION_VALUES_MISSING");
  });
});
