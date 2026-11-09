import { describe, expect, it } from "vitest";
import { canonicalDigest } from "../model-runtime/context-engine";
import { BUILTIN_SKILLS } from "./generated/builtin-skill-catalog";
import { BUILTIN_PACKS } from "./packs/generated/builtin-pack-catalog";
import { buildStrategy, type ResolvedStrategy } from "./packs/pack-resolver";

/**
 * 渲染快照门（S1 设计 §8 / §13 S1-4）：给定固定选择器上下文，把技能将消费的
 * 确定性材料（策略简报 + SKILL.md 正文）渲染成一份材料并钉住摘要。
 * 改 SKILL.md 正文/版本或任一被选中 Pack 的内容都会改变摘要——diff 必须显式重钉，
 * 防止 prompt 材料无声漂移。重钉方法：运行本 spec 读取失败的摘要值并更新下表。
 */
const FIXTURE_SELECTORS = {
  industries: ["metal_fabrication"],
  markets: ["DE"],
  motions: ["distributor_discovery"],
} as const;

/** 重钉记录：2026-11-08 S1-4 首次钉住；同日复审后重钉 sanctions/quoting（阈值/截断/加价语义）。 */
const PINNED_RENDER_DIGESTS: Readonly<Record<string, string>> = {
  "campaign.plan": "5bea069998912ef8b67b73ab7de88d6857f353d20195b352ea765322a5c1eb34",
  "company.understanding.extract": "b17b08f639ec2528610638348de170af2c4277edd66333f27a0e06a8ba4a4ed3",
  "company.understanding.extract_offerings":
    "ceada097f6f665d7af4e7016c578b82ffa50111fd3e2f735bc05c7f4359e8a5b",
  "compliance.sanctions_screen": "53829f13ffef437ee736ffaf84ef2f008cfefa8faa51957f76654bd637b8fc77",
  "discovery.qualify_fit": "b236a8628d650cf26175f1f58701f27e0d258b4bb7ce37ef13f7323bccfbb1ad",
  "discovery.quick_judge": "901cb12cf5ccf6626c83454c8d9146015b4e89cecd5508ab492cbf46c4717014",
  "quoting.incoterms_quote": "347570a7208fda7a022f7e08e66ee3782676732cdbfa14bec87ddb93f3db0f52",
  "research.account_research": "b8e2b27e18bbf33f7dba28d37eb2602bdc83b26f5015e330029b2e90e8bb609b",
  "triage.lead_triage": "a2485db23f4d1c902487f27745a3b252042ee343616573763a198a9e5d412b83",
  "engage.reply_classify": "df843b1058d178579a2cb9ebed318bf6cb1d0543efb28449d4f41e9529cf9d94",
  "outreach.sequence_draft": "1dcf89fc0e64ff4c155052bc67e7e0bc508aba918ffa0a210a088276dd263a62",
};

function strategyFor(skillKey: string): ResolvedStrategy {
  const versions = BUILTIN_PACKS.map((record) => ({
    id: `fixture:${record.packKey}`,
    packageId: "fixture",
    version: record.manifest.version,
    manifest: record.manifest,
    content: record.content,
    manifestDigest: canonicalDigest(record.manifest),
    contentDigest: record.contentDigest,
  }));
  return buildStrategy({ skillKey, ...FIXTURE_SELECTORS }, versions);
}

function renderMaterial(skillKey: string, version: string, body: string): string {
  const strategy = strategyFor(skillKey);
  return [
    `# Skill ${skillKey}@${version}`,
    "## Strategy brief",
    strategy.brief,
    "## SKILL.md body",
    body.trim(),
  ].join("\n\n");
}

describe("skill render snapshot (deterministic prompt material)", () => {
  it("pins the rendered material digest for every shipped skill", () => {
    expect(Object.keys(PINNED_RENDER_DIGESTS).sort()).toEqual(
      BUILTIN_SKILLS.map((record) => record.skillKey).sort(),
    );
    for (const record of BUILTIN_SKILLS) {
      const material = renderMaterial(
        record.skillKey,
        record.manifest.platform.version,
        record.body,
      );
      const digest = canonicalDigest(material);
      expect(digest, `${record.skillKey}（改了正文/Pack 内容就要重钉）`).toBe(
        PINNED_RENDER_DIGESTS[record.skillKey],
      );
    }
  });

  it("renders the same material twice — no ordering or timestamp drift", () => {
    const record = BUILTIN_SKILLS.find(
      (candidate) => candidate.skillKey === "research.account_research",
    )!;
    const first = renderMaterial(record.skillKey, record.manifest.platform.version, record.body);
    const second = renderMaterial(record.skillKey, record.manifest.platform.version, record.body);
    expect(first).toBe(second);
  });

  it("selects the same packs the fixture context advertises", () => {
    const strategy = strategyFor("research.account_research");
    expect(strategy.descriptor.packs.map((pack) => pack.packKey)).toEqual([
      "compliance.eu_dual_use_screen",
      "data_source.public_web_only",
      "growth_motion.dach_distributor",
      "industry.metal_fabrication",
    ]);
    expect(strategy.brief.length).toBeLessThanOrEqual(2_000);
  });
});
