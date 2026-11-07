import { describe, expect, it } from "vitest";
import { BUILTIN_SKILLS } from "../generated/builtin-skill-catalog";
import type { SkillManifest } from "../skill-manifest";
import { validateImportedSkill } from "./import-rules";

const BASE_RECORD = BUILTIN_SKILLS.find(
  (record) => record.skillKey === "research.account_research",
)!;
const BASE_MANIFEST = BASE_RECORD.manifest;

const GOOD_BODY = [
  "# 账户研究",
  "",
  "正文……",
  "",
  "## NOTICE",
  "",
  "- Upstream: https://github.com/example/skills",
  "- Commit: e050c2ec856373787143d7057663a6ebd1277df3",
  "- License: Apache-2.0（原文见快照目录）",
  "- Modified: 引擎化衍生版，改写输入/输出为任务契约 schema。",
  "",
].join("\n");

function manifestWith(overrides: Partial<SkillManifest["platform"]>, license = "Apache-2.0"): SkillManifest {
  return {
    ...BASE_MANIFEST,
    license,
    platform: { ...BASE_MANIFEST.platform, ...overrides },
  };
}

function codesOf(body: string, input: Partial<Parameters<typeof validateImportedSkill>[0]> = {}) {
  return validateImportedSkill({
    sourceId: "anthropics-knowledge-work-plugins",
    directory: "account-research",
    manifest: BASE_MANIFEST,
    body,
    ...input,
  }).map((issue) => issue.code);
}

describe("validateImportedSkill", () => {
  it("accepts a compliant derivative", () => {
    expect(codesOf(GOOD_BODY)).toEqual([]);
  });

  it("rejects licenses outside the import allowlist", () => {
    expect(
      codesOf(GOOD_BODY, { manifest: manifestWith({}, "AGPL-3.0") }),
    ).toContain("IMPORTED_LICENSE_NOT_ALLOWED");
  });

  it("requires tenant-default: disabled", () => {
    expect(
      codesOf(GOOD_BODY, { manifest: manifestWith({ tenantDefault: "enabled" }) }),
    ).toContain("IMPORTED_TENANT_DEFAULT_INVALID");
  });

  it("requires a kebab-case source id", () => {
    expect(codesOf(GOOD_BODY, { sourceId: "Anthropic Repo" })).toContain("IMPORTED_SOURCE_INVALID");
  });

  it("requires a NOTICE section with provenance lines", () => {
    expect(codesOf("# 正文\n\n没有 NOTICE。")).toContain("IMPORTED_NOTICE_MISSING");
    const incomplete = GOOD_BODY.replace(
      "- Commit: e050c2ec856373787143d7057663a6ebd1277df3",
      "- Commit: deadbeef",
    );
    expect(codesOf(incomplete)).toContain("IMPORTED_NOTICE_INCOMPLETE");
    const licenseMismatch = GOOD_BODY.replace("- License: Apache-2.0", "- License: MIT");
    expect(codesOf(licenseMismatch)).toContain("IMPORTED_NOTICE_INCOMPLETE");
    const noModified = GOOD_BODY.replace("- Modified: 引擎化衍生版，改写输入/输出为任务契约 schema。", "");
    expect(codesOf(noModified)).toContain("IMPORTED_NOTICE_INCOMPLETE");
    const noUpstream = GOOD_BODY.replace("- Upstream: https://github.com/example/skills", "");
    expect(codesOf(noUpstream)).toContain("IMPORTED_NOTICE_INCOMPLETE");
  });

  it("rejects executable content", () => {
    expect(codesOf(`${GOOD_BODY}\n\`\`\`bash\nrm -rf /\n\`\`\`\n`)).toContain(
      "IMPORTED_SCRIPT_CONTENT",
    );
    expect(codesOf(`${GOOD_BODY}\n<script>alert(1)</script>\n`)).toContain("IMPORTED_SCRIPT_CONTENT");
  });

  it("rejects external URLs outside the NOTICE section", () => {
    expect(codesOf(`# 正文\n\n见 https://promo.example.com\n\n${GOOD_BODY}`)).toContain(
      "IMPORTED_EXTERNAL_URL",
    );
    // NOTICE 小节内的溯源链接是允许的（GOOD_BODY 本身即为证）。
    expect(codesOf(GOOD_BODY)).toEqual([]);
  });
});
