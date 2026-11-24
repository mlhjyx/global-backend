import assert from "node:assert/strict";
import test from "node:test";

import {
  parseChangelogFragment,
  renderPrBodyFromFragment,
} from "./pr-body-from-changelog.mjs";

const SAMPLE_FRAGMENT = `---
date: 2026-11-24
pr: 1088
title: Parallelize CI lanes and standardize PR body generation
---

- 起因：单 job 串行执行导致 PR 门禁耗时 ~15 分钟，且缺少从 changelog 片段生成中文 PR 正文的自动化工具。
- 改动：
  - 将 vitest 纯单测拆为 4 分片矩阵并行。
  - 拆分 PostgreSQL 语义门与 Manufacturer MinIO 契约测试并接入 GHCR 缓存。
- 测试：\`pnpm governance:verify\` 与 \`pnpm docs:verify\` 全绿。
- 未做：不改 GitHub ruleset 必需检查清单。
`;

test("parseChangelogFragment extracts frontmatter and required Chinese sections", () => {
  const parsed = parseChangelogFragment(SAMPLE_FRAGMENT);
  assert.equal(parsed.date, "2026-11-24");
  assert.equal(parsed.pr, "1088");
  assert.equal(
    parsed.title,
    "Parallelize CI lanes and standardize PR body generation",
  );
  assert.match(parsed.sections.get("起因") ?? "", /单 job 串行/);
  assert.match(parsed.sections.get("改动") ?? "", /4 分片矩阵/);
  assert.match(parsed.sections.get("测试") ?? "", /governance:verify/);
  assert.match(parsed.sections.get("未做") ?? "", /ruleset/);
});

test("renderPrBodyFromFragment puts product-owner summary first and preserves all template sections", () => {
  const body = renderPrBodyFromFragment(SAMPLE_FRAGMENT, {
    baseSha: "68ed2e9b",
    fragmentPath: "docs/roadmap/changelog.d/2026-11-24-ci-speedup.md",
  });

  const requiredHeadings = [
    "## 给产品负责人的说明",
    "## 概述",
    "## 改动分组",
    "## 文档与阶段回写",
    "## 测试 / 验证",
    "## 指标影响（改动度量口径或数据链路时必填）",
    "## 合规（涉数据源 / 联系人 / 抓取时必填）",
    "## 待续 / 已知风险",
  ];
  let lastIndex = -1;
  for (const heading of requiredHeadings) {
    const idx = body.indexOf(heading);
    assert.ok(idx > lastIndex, `heading out of order or missing: ${heading}`);
    lastIndex = idx;
  }
  assert.match(body, /origin\/main@68ed2e9b/);
  assert.match(
    body,
    /docs\/roadmap\/changelog\.d\/2026-11-24-ci-speedup\.md/,
  );
  assert.match(body, /- 将 vitest 纯单测拆为 4 分片矩阵并行。/);
});

test("parseChangelogFragment rejects missing frontmatter", () => {
  assert.throws(
    () => parseChangelogFragment("- 起因：无 frontmatter\n"),
    /CHANGELOG_FRAGMENT_MISSING_FRONTMATTER/,
  );
});
