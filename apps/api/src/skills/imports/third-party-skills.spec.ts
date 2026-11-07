import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";

/**
 * 第三方技能目录一致性（S1 导入管线前置，零模型 CI 层）：
 * ① 机器清单符合其 JSON Schema；② 每个来源的 CHECKSUMS.sha256 逐文件校验；
 * ③ 每个技能的快照文件存在，且清单的 snapshotSha256 等于首文件哈希（目录约定）；
 * ④ 首批选定的技能名都在清单内。
 */
const ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));
const CATALOG_ROOT = join(ROOT, "docs/governance/third-party-skills");

interface CatalogSkill {
  readonly id: string;
  readonly name: string;
  readonly sourceId: string;
  readonly snapshotPath: string;
  readonly snapshotFiles: readonly string[];
  readonly snapshotSha256: string;
}

interface CatalogSource {
  readonly id: string;
  readonly commit: string;
}

interface Catalog {
  readonly schemaVersion: string;
  readonly sources: readonly CatalogSource[];
  readonly skills: readonly CatalogSkill[];
  readonly firstBatchSelection: { readonly skills: readonly string[] };
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

describe("third-party skill import catalog", () => {
  const catalog = JSON.parse(
    readFileSync(join(CATALOG_ROOT, "THIRD_PARTY_SKILLS.json"), "utf8"),
  ) as Catalog;
  const schema = JSON.parse(
    readFileSync(join(CATALOG_ROOT, "THIRD_PARTY_SKILLS.schema.json"), "utf8"),
  ) as object;

  it("matches its machine schema", () => {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(ajv);
    const validate = ajv.compile(schema);
    const valid = validate(catalog);
    expect(validate.errors ?? []).toEqual([]);
    expect(valid).toBe(true);
  });

  it("pins every source and verifies each CHECKSUMS.sha256 line", () => {
    expect(catalog.sources.length).toBeGreaterThan(0);
    for (const source of catalog.sources) {
      expect(source.commit, source.id).toMatch(/^[0-9a-f]{40}$/u);
      const root = join(CATALOG_ROOT, "snapshots", source.id);
      const checksums = readFileSync(join(root, "CHECKSUMS.sha256"), "utf8");
      const lines = checksums
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      expect(lines.length, source.id).toBeGreaterThan(0);
      for (const line of lines) {
        const match = /^([0-9a-f]{64})\s+\.\/(.+)$/u.exec(line);
        expect(match, `${source.id}: ${line}`).not.toBeNull();
        const [, expected, relative] = match as RegExpExecArray;
        if (relative === "CHECKSUMS.sha256") continue; // 自引用行无法自证
        const file = join(root, relative);
        expect(existsSync(file), `${source.id}/${relative}`).toBe(true);
        expect(sha256File(file), `${source.id}/${relative}`).toBe(expected);
      }
    }
  });

  it("keeps every skill snapshot present and digest-pinned", () => {
    expect(catalog.skills.length).toBeGreaterThan(0);
    for (const skill of catalog.skills) {
      expect(skill.snapshotFiles.length, skill.id).toBeGreaterThan(0);
      const sourceRoot = join(CATALOG_ROOT, "snapshots", skill.sourceId);
      for (const relative of skill.snapshotFiles) {
        expect(existsSync(join(sourceRoot, relative)), `${skill.id}/${relative}`).toBe(true);
      }
      const first = join(sourceRoot, skill.snapshotFiles[0]);
      expect(sha256File(first), skill.id).toBe(skill.snapshotSha256);
      expect(skill.snapshotPath, skill.id).toContain(skill.snapshotFiles[0]);
    }
  });

  it("selects the ten first-batch skills recorded in FIRST-BATCH.md", () => {
    const ids = new Set(catalog.skills.map((skill) => skill.id));
    const names = new Set(catalog.skills.map((skill) => skill.name));
    const selected = catalog.firstBatchSelection.skills;
    expect(selected).toHaveLength(10);
    for (const entry of selected) {
      expect(ids.has(entry) || names.has(entry), entry).toBe(true);
    }
  });
});
