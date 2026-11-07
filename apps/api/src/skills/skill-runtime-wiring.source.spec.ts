import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 进程入口没有单元 harness（worker / dev-fast-lane 直接起 Temporal Worker），
 * 源级守卫钉住 S0 接线：managed worker 必须注入 DB 解析器并 seed 目录；fast lane
 * 只注入解析器（不 seed、不持有 owner 数据写权限）；调用点必须使用注册的技能键。
 */
const TEMPORAL = join(import.meta.dirname, "..", "temporal");
const read = (name: string): string => readFileSync(join(TEMPORAL, name), "utf8");

function call(source: string, anchor: string): string {
  const start = source.indexOf(anchor);
  if (start < 0) throw new Error(`missing ${anchor}`);
  let depth = 0;
  for (let index = source.indexOf("(", start); index < source.length; index += 1) {
    if (source[index] === "(") depth += 1;
    if (source[index] === ")") depth -= 1;
    if (depth === 0) return source.slice(start, index + 1).replace(/\s+/gu, " ");
  }
  throw new Error(`unbalanced ${anchor}`);
}

describe("skill runtime worker wiring", () => {
  const worker = read("worker.ts");
  const lane = read("dev-fast-lane-worker.ts");

  it("builds a DB-backed resolver in both workers", () => {
    expect(worker).toContain("createDbSkillResolver(");
    expect(worker).toContain("new PrismaSkillRegistryStore(prisma)");
    expect(lane).toContain("createDbSkillResolver(");
    expect(lane).toContain("new PrismaSkillRegistryStore(prisma)");
  });

  it("seeds the skill catalog in the managed worker only (owner writes stay there)", () => {
    expect(worker).toContain("seedSkillCatalog(ownerDb)");
    expect(worker).toContain("SKILL_CATALOG_SEED_UNAVAILABLE");
    expect(lane).not.toContain("seedSkillCatalog");
  });

  it("passes the resolver into every fit/understanding activity factory", () => {
    for (const anchor of [
      "createUnderstandingActivities(",
      "createDiscoveryActivities(",
      "createRun2Activities(",
      "createRun2PipelineActivities(",
    ]) {
      expect(call(worker, anchor), anchor).toContain("skills: skillResolver");
    }
    for (const anchor of ["createUnderstandingActivities(", "createDiscoveryActivities("]) {
      expect(call(lane, anchor), anchor).toContain("skills: skillResolver");
    }
  });

  it("keeps the managed worker and fast lane understanding/discovery wiring textually identical", () => {
    for (const anchor of ["createUnderstandingActivities(", "createDiscoveryActivities("]) {
      expect(call(lane, anchor), anchor).toBe(call(worker, anchor));
    }
  });

  it("routes every packaged callsite through its registered skill key", () => {
    const understanding = read("understanding.activities.ts");
    expect(understanding).toContain("'company.understanding.extract'");
    expect(understanding).toContain("'company.understanding.extract_offerings'");
    expect(understanding).toContain("executeSkillWithRuntime(");
    const fitJudge = readFileSync(join(TEMPORAL, "..", "discovery", "fit-judge.ts"), "utf8");
    expect(fitJudge).toContain("'discovery.qualify_fit'");
    expect(fitJudge).toContain("executeSkillWithRuntime<FitOutput>(");
    expect(fitJudge).toContain("err instanceof SkillUnavailableError");
  });
});
