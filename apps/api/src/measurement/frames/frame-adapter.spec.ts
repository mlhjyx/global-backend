import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  FrameAdapter,
  FrameAdapterContext,
  FrameSnapshotLineage,
  LocalQueryFrameLineageReceipt,
  runFrameAdapter,
} from "./frame-adapter";
import { defineFrameAdapterContract } from "./frame-adapter.contract";
import { createFixtureFrameAdapter, fixtureOptionsFromDocument } from "./fixture-frame-adapter";

const FIXTURE = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/frame-fixture.v1.json", import.meta.url)), "utf8"),
) as unknown;

const FIXED_NOW = new Date("2026-11-09T00:00:00.000Z");

function makeContext(overrides: Partial<FrameAdapterContext> = {}): FrameAdapterContext {
  return {
    asOf: "2026-11-09T00:00:00.000Z",
    now: () => new Date(FIXED_NOW),
    ...overrides,
  };
}

function fixtureAdapter(): FrameAdapter {
  return createFixtureFrameAdapter(fixtureOptionsFromDocument(FIXTURE));
}

defineFrameAdapterContract({
  name: "fixture-frame-adapter",
  createAdapter: fixtureAdapter,
  makeContext,
  expectations: { minimumEntities: 3 },
});

describe("fixture frame adapter", () => {
  it("excludes non-active registrations and accounts for them", async () => {
    const bundle = await runFrameAdapter(fixtureAdapter(), makeContext());
    expect(bundle.state).toBe("READY");
    expect(bundle.parse?.rowCount).toBe(4);
    expect(bundle.parse?.entities.map((entity) => entity.entityKey)).toEqual([
      "FIX-FN-000003",
      "FIX-HRB-000001",
      "FIX-HRB-000002",
    ]);
    expect(bundle.parse?.exclusions).toEqual({ total: 1, byReason: { status_not_active: 1 } });
  });

  it("rejects an empty fixture document", () => {
    expect(() => fixtureOptionsFromDocument({ frameKey: "x", records: [] })).toThrow(/non-empty records/);
    expect(() => fixtureOptionsFromDocument({ records: [] })).toThrow(/frameKey/);
    expect(() => createFixtureFrameAdapter({ frameKey: "x", records: [] })).toThrow(/at least one record/);
  });
});

describe("frame adapter driver failure paths", () => {
  it("rejects a snapshot whose frameKey does not match the adapter identity", async () => {
    const base = fixtureAdapter();
    const mismatched: FrameAdapter = {
      ...base,
      fetchSnapshot: async (ctx) => ({ ...(await base.fetchSnapshot(ctx)), frameKey: "another-frame" }),
    };
    const bundle = await runFrameAdapter(mismatched, makeContext());
    expect(bundle.state).toBe("FAILED");
    expect(bundle.failure?.code).toBe("SNAPSHOT_INVALID");
    expect(bundle.transitions).toEqual(["FETCHING", "FAILED"]);
  });

  it("wraps parse errors and row-count mismatches", async () => {
    const base = fixtureAdapter();
    const throwing: FrameAdapter = {
      ...base,
      parse: async () => {
        throw new Error("bad payload");
      },
    };
    const failed = await runFrameAdapter(throwing, makeContext());
    expect(failed.failure?.code).toBe("PARSE_FAILED");
    expect(failed.transitions).toEqual(["FETCHING", "PARSING", "FAILED"]);

    const miscounting: FrameAdapter = {
      ...base,
      parse: async (raw, ctx) => ({ ...(await base.parse(raw, ctx)), rowCount: raw.rowCount + 1 }),
    };
    const mismatch = await runFrameAdapter(miscounting, makeContext());
    expect(mismatch.failure?.code).toBe("PARSE_ROW_COUNT_MISMATCH");
    expect(mismatch.transitions).toEqual(["FETCHING", "PARSING", "FAILED"]);
  });

  it("wraps validation errors as FAILED/VALIDATION_ERROR", async () => {
    const base = fixtureAdapter();
    const throwing: FrameAdapter = {
      ...base,
      validate: async () => {
        throw new Error("checks crashed");
      },
    };
    const bundle = await runFrameAdapter(throwing, makeContext());
    expect(bundle.state).toBe("FAILED");
    expect(bundle.failure?.code).toBe("VALIDATION_ERROR");
    expect(bundle.transitions).toEqual(["FETCHING", "PARSING", "VALIDATING", "FAILED"]);
  });

  it("enforces the maxBytes budget at fetch time", async () => {
    const bundle = await runFrameAdapter(fixtureAdapter(), makeContext({ maxBytes: 32 }));
    expect(bundle.state).toBe("FAILED");
    expect(bundle.failure?.code).toBe("FETCH_FAILED");
    expect(bundle.failure?.message).toMatch(/maxBytes/);
  });
});

describe("A 方案 local_query lineage slot (types only)", () => {
  it("accepts a registry.query receipt as a frame snapshot lineage variant", () => {
    const receipt: LocalQueryFrameLineageReceipt = {
      producer: "registry.query",
      frameKey: "de-offeneregister",
      createdAt: "2026-11-09T00:00:00.000Z",
      // P2 血缘契约尚未落地：receipt 保持不透明，本 PR 不实现接入。
      receipt: { pendingContract: "p2-lineage" },
    };
    const lineage: FrameSnapshotLineage = receipt;
    expect(lineage.producer).toBe("registry.query");
    if (lineage.producer === "registry.query") {
      expect(lineage.frameKey).toBe("de-offeneregister");
    }
  });
});
