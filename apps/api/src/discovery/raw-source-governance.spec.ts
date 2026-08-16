import { describe, expect, it } from "vitest";
import {
  detectHistoricalUsaSpendingRestrictedFields,
  partitionGovernedRawRecords,
} from "./raw-source-governance";

describe("permanent Raw source governance", () => {
  it("detects only the exact retired USAspending procurement keys", () => {
    expect(
      detectHistoricalUsaSpendingRestrictedFields({
        attributes: {
          procurement: {
            recipient_name: "value must never leave this object",
            description: "value must never leave this object",
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

  it("partitions by Raw id without reading or rewriting payloads", () => {
    const first = { id: "raw-1", payload: { secret: "unchanged" } };
    const second = { id: "raw-2", payload: { safe: true } };
    const before = JSON.stringify([first, second]);

    expect(
      partitionGovernedRawRecords([first, second], new Set(["raw-1", "raw-1"])),
    ).toEqual({ consumable: [second], restricted: [first] });
    expect(JSON.stringify([first, second])).toBe(before);
  });
});
