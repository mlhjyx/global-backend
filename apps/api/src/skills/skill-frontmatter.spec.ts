import { describe, expect, it } from "vitest";
import { parseSkillFrontmatter, SkillFrontmatterError } from "./skill-frontmatter";

/**
 * SKILL.md 的 frontmatter 只接受一个**严格子集**（v0）：块状映射 + 标量 + 一级
 * `metadata` 映射。复杂 YAML（锚点/别名/块标量/流式集合/多行折叠）一律拒绝并给出
 * 明确错误码——平台技能包由我们自己维护，宁可报错也不静默解析成别的意思。
 */
const document = (frontmatter: string, body = "Body\n"): string => `---\n${frontmatter}---\n${body}`;

function codeOf(parse: () => unknown): string {
  try {
    parse();
  } catch (error) {
    if (error instanceof SkillFrontmatterError) return error.code;
    throw error;
  }
  throw new Error("expected a SkillFrontmatterError");
}

describe("parseSkillFrontmatter", () => {
  it("parses plain scalars, quoted strings, integers and a one-level metadata map", () => {
    const parsed = parseSkillFrontmatter(
      document(
        [
          "name: demo-skill",
          'description: "What it does. Use when testing."',
          "license: 'Proprietary'",
          "allowed-tools: crawl4ai.fetch social.search",
          "metadata:",
          "  platform.skill-key: demo.skill",
          "  platform.version: 1.0.0",
          '  platform.human-gate: "true"',
          "",
        ].join("\n"),
        "# Body\n\nText.\n",
      ),
    );

    expect(parsed.frontmatter["name"]).toBe("demo-skill");
    expect(parsed.frontmatter["description"]).toBe("What it does. Use when testing.");
    expect(parsed.frontmatter["license"]).toBe("Proprietary");
    expect(parsed.frontmatter["allowed-tools"]).toBe("crawl4ai.fetch social.search");
    expect(parsed.frontmatter["metadata"]).toEqual({
      "platform.skill-key": "demo.skill",
      "platform.version": "1.0.0",
      "platform.human-gate": "true",
    });
    expect(parsed.body).toBe("# Body\n\nText.");
  });

  it("normalizes CRLF and strips a UTF-8 BOM", () => {
    const content = `\uFEFF---\r\nname: demo-skill\r\ndescription: Use when testing.\r\n---\r\nBody text.\r\n`;
    const parsed = parseSkillFrontmatter(content);
    expect(parsed.frontmatter["name"]).toBe("demo-skill");
    expect(parsed.body).toBe("Body text.");
  });

  it("accepts an empty frontmatter block", () => {
    const parsed = parseSkillFrontmatter("---\n---\nBody.\n");
    expect(parsed.frontmatter).toEqual({});
    expect(parsed.body).toBe("Body.");
  });

  it("requires the document to start with a frontmatter delimiter", () => {
    expect(codeOf(() => parseSkillFrontmatter("name: demo\n"))).toBe("SKILL_FRONTMATTER_MISSING");
  });

  it("rejects an unclosed frontmatter block", () => {
    expect(codeOf(() => parseSkillFrontmatter("---\nname: demo\nbody\n"))).toBe(
      "SKILL_FRONTMATTER_UNCLOSED",
    );
  });

  it("rejects tabs and non-two-space indentation", () => {
    expect(codeOf(() => parseSkillFrontmatter(document("name:\tdemo\n")))).toBe(
      "SKILL_FRONTMATTER_UNSUPPORTED",
    );
    expect(codeOf(() => parseSkillFrontmatter(document("metadata:\n   a: b\n")))).toBe(
      "SKILL_FRONTMATTER_UNSUPPORTED",
    );
    expect(codeOf(() => parseSkillFrontmatter(document("  name: demo\n")))).toBe(
      "SKILL_FRONTMATTER_UNSUPPORTED",
    );
  });

  it("rejects block scalars, flow collections, anchors and tags", () => {
    for (const line of [
      "description: |",
      "description: >",
      "metadata: {a: b}",
      "license: &anchor MIT",
      "license: *alias",
      "license: !tag MIT",
      "allowed-tools: [a.b]",
    ]) {
      expect(codeOf(() => parseSkillFrontmatter(document(`${line}\n`))), line).toBe(
        "SKILL_FRONTMATTER_UNSUPPORTED",
      );
    }
  });

  it("rejects duplicate keys and nested mappings deeper than one level", () => {
    expect(codeOf(() => parseSkillFrontmatter(document("name: a\nname: b\n")))).toBe(
      "SKILL_FRONTMATTER_DUPLICATE_KEY",
    );
    expect(codeOf(() => parseSkillFrontmatter(document("metadata:\n  a: b\n  a: c\n")))).toBe(
      "SKILL_FRONTMATTER_DUPLICATE_KEY",
    );
    expect(codeOf(() => parseSkillFrontmatter(document("metadata:\n    deep: x\n")))).toBe(
      "SKILL_FRONTMATTER_UNSUPPORTED",
    );
  });

  it("rejects a plain scalar that smuggles a nested mapping", () => {
    expect(codeOf(() => parseSkillFrontmatter(document("description: a: b\n")))).toBe(
      "SKILL_FRONTMATTER_SYNTAX",
    );
  });

  it("rejects a key without a value unless it opens the metadata map", () => {
    expect(codeOf(() => parseSkillFrontmatter(document("name:\n")))).toBe(
      "SKILL_FRONTMATTER_SYNTAX",
    );
    expect(codeOf(() => parseSkillFrontmatter(document("metadata: x\n")))).toBe(
      "SKILL_FRONTMATTER_SYNTAX",
    );
  });

  it("rejects indented lines without an open metadata map", () => {
    expect(codeOf(() => parseSkillFrontmatter(document("  orphan: x\n")))).toBe(
      "SKILL_FRONTMATTER_UNSUPPORTED",
    );
  });
});
