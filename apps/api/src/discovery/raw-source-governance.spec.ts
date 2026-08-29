// Test intent source-mined from tugjvnh@70885cdb; rewritten for current main.
import { describe, expect, it } from "vitest";
import {
  detectHistoricalUsaSpendingRestrictedFields,
  partitionGovernedRawRecords,
} from "./raw-source-governance";

describe("Raw Source restricted-processing governance", () => {
  it("detects only the exact retired procurement keys and never returns their values", () => {
    expect(
      detectHistoricalUsaSpendingRestrictedFields({
        attributes: {
          procurement: {
            recipient_name: "must not escape",
            description: "must not escape",
            query_match: true,
          },
        },
      }),
    ).toEqual(["recipient_name", "description"]);
    expect(
      detectHistoricalUsaSpendingRestrictedFields({
        attributes: {
          procurement: {
            query_keywords: ["description"],
            description_retained: false,
          },
        },
      }),
    ).toEqual([]);
  });

  it("partitions immutable records by id without reading or rewriting their payloads", () => {
    const restricted = {
      id: "raw-restricted",
      payload: { personal: "unchanged" },
    };
    const safe = { id: "raw-safe", payload: { safe: true } };
    const before = JSON.stringify([restricted, safe]);

    expect(
      partitionGovernedRawRecords(
        [restricted, safe],
        new Set(["raw-restricted", "raw-restricted"]),
      ),
    ).toEqual({ consumable: [safe], restricted: [restricted] });
    expect(JSON.stringify([restricted, safe])).toBe(before);
  });
});
