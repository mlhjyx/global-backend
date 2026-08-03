import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { buildRemainingTextNativeFeeCard } from "./remaining-text-native-fee-card";

const repositoryRoot = join(__dirname, "../../../../..");
const manifest = Object.freeze(
  JSON.parse(
    readFileSync(
      join(
        repositoryRoot,
        "docs/evidence/site-builder/m1-g-remaining-text-evaluation-manifest-v1.json",
      ),
      "utf8",
    ),
  ),
);

function catalog(includeMini = true) {
  const model = (
    model_id: string,
    product_line: string,
    input_rate: string,
    output_rate: string,
  ) => ({
    model_id,
    product_line,
    input_rate,
    output_rate,
    cache_read_rate: "0",
    cache_write_rate: "0",
    status: "enabled",
    updated_at: "2026-08-04T00:00:00.000Z",
  });
  return {
    success: true,
    data: {
      models: [
        model("gpt-5.6-terra", "gpt", "2", "12"),
        model("gpt-5.5", "gpt", "5", "30"),
        model("claude-sonnet-5", "claude", "2", "10"),
        model("gpt-5.6-luna", "gpt", "0.2", "1.2"),
        ...(includeMini ? [model("gpt-5.4-mini", "gpt", "0.5", "3")] : []),
      ],
      groups: [
        { name: "gpt-unified", product_line: "gpt", rate_multiplier: "1" },
        { name: "special", product_line: "claude", rate_multiplier: "1.26" },
      ],
    },
  };
}

function input(taskId: Parameters<typeof buildRemainingTextNativeFeeCard>[0]["taskId"]) {
  return {
    repositoryRoot,
    manifest,
    taskId,
    catalog: catalog(),
    capturedAt: "2026-08-04T00:00:00.000Z",
    catalogResponseSha256: "a".repeat(64),
  } as const;
}

describe("remaining text native-currency fee cards", () => {
  it.each([
    ["site_builder.copy", 13, 26],
    ["site_builder.assemble", 73, 146],
    ["site_builder.assembly_fix", 73, 146],
  ] as const)("binds %s to its fixed zero-call execution matrix", (taskId, executions, wires) => {
    const card = buildRemainingTextNativeFeeCard(input(taskId));

    expect(card.taskId).toBe(taskId);
    expect(card.fixedSourceCommitSha).toBe("0891b374321961b8aad13c8b215985ca623a4c0c");
    expect(card.dispatchAuthorization).toBe("NOT_AUTHORIZED");
    expect(card.expectedCost).toBe("not_known_before_usage");
    expect(card.noForeignExchangeConversion).toBe(true);
    expect(card.entries.reduce((total, entry) => total + entry.executionCount, 0)).toBe(executions);
    expect(card.entries.reduce((total, entry) => total + entry.maximumWireCalls, 0)).toBe(wires);
  });

  it("refuses the QA price card when its exact candidate is absent publicly", () => {
    expect(() =>
      buildRemainingTextNativeFeeCard({
        ...input("site_builder.qa_summarize"),
        catalog: catalog(false),
      }),
    ).toThrow("OpenOx price is missing or unpublished: gpt-5.4-mini");
  });

  it("refuses a manifest whose fixed source bundle has drifted", () => {
    const drifted = structuredClone(manifest);
    drifted.tasks[0].sourceFiles[0].sha256 = "b".repeat(64);
    expect(() =>
      buildRemainingTextNativeFeeCard({
        ...input("site_builder.copy"),
        manifest: drifted,
      }),
    ).toThrow();
  });
});
