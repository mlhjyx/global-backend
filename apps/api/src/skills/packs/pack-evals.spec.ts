import { describe, expect, it } from "vitest";
import { BUILTIN_PACKS } from "./generated/builtin-pack-catalog";
import { PackEvalInputError, parseSelectorInput, runPackEvals } from "./pack-evals";

function recordOf(packKey: string) {
  const record = BUILTIN_PACKS.find((candidate) => candidate.packKey === packKey);
  if (!record) throw new Error(`missing ${packKey}`);
  return record;
}

describe("runPackEvals", () => {
  it("passes each pack's authored deterministic evals", async () => {
    for (const record of BUILTIN_PACKS) {
      expect(record.evals, record.packKey).toBeDefined();
      const result = await runPackEvals(record.evals!, {
        packKey: record.packKey,
        version: record.manifest.version,
        manifest: record.manifest,
        content: record.content,
        contentDigest: record.contentDigest,
      });
      expect(result.passed, record.packKey).toBe(true);
      expect(result.cases).toHaveLength(5);
    }
  });

  it("fails when an assertion no longer matches the rendered strategy", async () => {
    const record = recordOf("industry.metal_fabrication");
    const tampered = {
      ...record.evals!,
      evals: record.evals!.evals.map((evalCase, index) =>
        index === 2
          ? {
              ...evalCase,
              assertions: [{ kind: "contains" as const, path: "brief", value: "no-such-anchor" }],
            }
          : evalCase,
      ),
    };
    const result = await runPackEvals(tampered, {
      packKey: record.packKey,
      version: record.manifest.version,
      manifest: record.manifest,
      content: record.content,
      contentDigest: record.contentDigest,
    });
    expect(result.passed).toBe(false);
    expect(result.cases[2].ok).toBe(false);
  });
});

describe("parseSelectorInput", () => {
  it("accepts the documented selector shape and rejects junk", () => {
    expect(parseSelectorInput({ markets: ["DE"], motions: ["pricing"] })).toEqual({
      markets: ["DE"],
      motions: ["pricing"],
    });
    expect(() => parseSelectorInput({ markets: "DE" })).toThrow(PackEvalInputError);
    expect(() => parseSelectorInput({ regions: ["DE"] })).toThrow(PackEvalInputError);
    expect(() => parseSelectorInput(["DE"])).toThrow(PackEvalInputError);
  });
});
