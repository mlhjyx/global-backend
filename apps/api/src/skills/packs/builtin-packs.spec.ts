import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BUILTIN_PACKS } from "./generated/builtin-pack-catalog";
import { loadBuiltinPacks } from "./load-builtin-packs";
import { mergeComplianceRules } from "./pack-merge";

/**
 * Pack 内容目录以 pack.json + PACK.md 为唯一真源；本 spec 保证：
 * ① 全部内容包通过四类 Schema 与语义校验；② 生成目录与磁盘一致（改了内容忘记
 * `pnpm packs:generate` → 这里 RED）；③ 冲突裁决在当前内容上无未记录拒绝。
 */
const CONTENT_ROOT = join(import.meta.dirname, "content");

describe("builtin pack content", () => {
  const loaded = loadBuiltinPacks(CONTENT_ROOT);

  it("validates every pack against its type schema", () => {
    expect(loaded.issues.filter((issue) => issue.severity === "error")).toEqual([]);
  });

  it("ships the first-batch content set", () => {
    expect(loaded.records.map((record) => record.packKey)).toEqual([
      "compliance.eu_dual_use_screen",
      "data_source.public_web_only",
      "growth_motion.competitive_intelligence",
      "growth_motion.customer_research",
      "growth_motion.dach_distributor",
      "growth_motion.pricing",
      "industry.metal_fabrication",
    ]);
  });

  it("keeps the committed generated catalog in sync with the on-disk content", () => {
    expect(BUILTIN_PACKS).toEqual(loaded.records);
  });

  it("keeps every pack versioned, sourced and exit-planned", () => {
    for (const record of loaded.records) {
      expect(record.manifest.version, record.packKey).toMatch(/^\d+\.\d+\.\d+$/u);
      expect(record.manifest.sources.length, record.packKey).toBeGreaterThan(0);
      expect(record.manifest.exitPlan.length, record.packKey).toBeGreaterThan(0);
      expect(record.content.length, record.packKey).toBeGreaterThan(0);
      expect(record.manifestDigest, record.packKey).toMatch(/^[0-9a-f]{64}$/u);
    }
  });

  it("resolves the current compliance rules without unrecorded conflicts", () => {
    const merge = mergeComplianceRules(loaded.records.map((record) => record.manifest));
    expect(merge.effective.length).toBeGreaterThan(0);
    // 当前内容没有相互覆盖的规则；新增冲突时必须被显式记录（rejected）。
    for (const rejected of merge.rejected) {
      expect(rejected.reason).toMatch(/higher_priority_forbid|stricter_effect_wins/u);
      expect(rejected.blockedBy.length).toBeGreaterThan(0);
    }
  });

  it("ships an authored deterministic eval manifest for every pack", () => {
    for (const record of loaded.records) {
      expect(record.evals, record.packKey).toBeDefined();
      expect(record.evals?.evals.length, record.packKey).toBeGreaterThanOrEqual(5);
      expect(record.evalsDigest, record.packKey).toMatch(/^[0-9a-f]{64}$/u);
    }
  });

  it("keeps non-proprietary content packs carrying a notice", () => {
    for (const record of loaded.records) {
      if (record.manifest.license !== "Proprietary") {
        expect((record.manifest.notice ?? "").length, record.packKey).toBeGreaterThanOrEqual(20);
      }
    }
  });
});
