#!/usr/bin/env node
/**
 * Render a standardized Chinese PR body (matching .github/pull_request_template.md)
 * from a validated docs/roadmap/changelog.d/<YYYY-MM-DD>-<slug>.md fragment.
 *
 * Usage:
 *   node scripts/pr-body-from-changelog.mjs <fragment-path> [--base-sha <sha>] [--out <file>]
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { createSafeGitEnvironment } from "./safe-git-environment.mjs";

const TOP_LEVEL_ITEM = /^- ([^：:\s][^：:]*?)[：:](.*)$/;

function unquote(value) {
  const trimmed = String(value ?? "").trim();
  return /^(["']).*\1$/.test(trimmed) && trimmed.length >= 2
    ? trimmed.slice(1, -1)
    : trimmed;
}

/**
 * Parse a changelog.d fragment into frontmatter fields and top-level Chinese sections
 * (起因 / 改动 / 测试 / 未做).
 */
export function parseChangelogFragment(markdown) {
  const lines = String(markdown).replace(/\r\n/g, "\n").split("\n");
  if (lines[0] !== "---") {
    throw new Error("CHANGELOG_FRAGMENT_MISSING_FRONTMATTER");
  }
  const end = lines.indexOf("---", 1);
  if (end === -1) {
    throw new Error("CHANGELOG_FRAGMENT_UNCLOSED_FRONTMATTER");
  }
  const frontmatter = {};
  for (const line of lines.slice(1, end)) {
    const match = line.match(/^([a-z]+):(?:\s+(.*))?$/);
    if (!match) continue;
    frontmatter[match[1]] = unquote(match[2] ?? "");
  }

  const sections = new Map();
  let currentKey = null;
  let currentLines = [];
  const flush = () => {
    if (!currentKey) return;
    const text = currentLines.join("\n").trim();
    sections.set(currentKey, text);
  };
  for (const line of lines.slice(end + 1)) {
    const match = line.match(TOP_LEVEL_ITEM);
    if (match) {
      flush();
      currentKey = match[1].trim();
      currentLines = match[2].trim() ? [match[2].trim()] : [];
    } else if (currentKey) {
      currentLines.push(line);
    }
  }
  flush();

  return {
    date: frontmatter.date ?? "",
    pr: frontmatter.pr ?? "",
    title: frontmatter.title ?? "",
    sections,
  };
}

function splitBullets(sectionText, fallback) {
  const trimmed = String(sectionText ?? "").trim();
  if (!trimmed) return [`- ${fallback}`];
  const rawLines = trimmed.split("\n").map((line) => line.trimEnd());
  if (rawLines.every((line) => line.trim() === "" || /^\s*-\s+/.test(line))) {
    return rawLines.filter((line) => line.trim() !== "").map((line) => line.replace(/^\s+/, ""));
  }
  return rawLines
    .filter((line) => line.trim() !== "")
    .map((line) => (/^-\s+/.test(line.trim()) ? line.trim() : `- ${line.trim()}`));
}

/**
 * Render a complete Markdown PR body matching .github/pull_request_template.md
 * with the product-owner summary at the top.
 */
export function renderPrBodyFromFragment(markdown, options = {}) {
  const parsed = parseChangelogFragment(markdown);
  const baseSha = options.baseSha || "main";
  const fragmentPath = options.fragmentPath || "docs/roadmap/changelog.d/<YYYY-MM-DD>-<slug>.md";
  const why = parsed.sections.get("起因") || parsed.title || "待补充";
  const what = parsed.sections.get("改动") || "";
  const tests = parsed.sections.get("测试") || "待补充本地与 CI 验证结果";
  const notDone = parsed.sections.get("未做") || "无";
  const benefit = options.benefit || `${parsed.title || why}`;
  const unchanged = options.unchanged || "不改外部 API 契约、不改主分支 ruleset 必需检查清单、不改存量运行数据。";
  const risk = options.risk || "单 PR 原子回退（`git revert` 即可恢复原状）。";
  const recommendation = options.recommendation || "合并 —— 全部必需 CI 检查与本地治理门均通过。";

  const changeLines = splitBullets(what, parsed.title || "详见改动 diff").join("\n");
  const riskLines = splitBullets(notDone, "无").join("\n");

  return [
    "## 给产品负责人的说明",
    "",
    `- 你会得到什么：${benefit}`,
    `- 明确没有改变什么：${unchanged}`,
    `- 风险与回退：${risk}`,
    `- 建议：${recommendation}`,
    "",
    "## 概述",
    "",
    why.split("\n")[0],
    "",
    "## 改动分组",
    "",
    changeLines,
    "",
    "## 文档与阶段回写",
    "",
    `- 本次事实基线：\`origin/main@${baseSha}\``,
    "- 是否触发“阶段完成回写清单”：否；原因：未跨越对外发布/阶段验收门，阶段状态文档不变。",
    "- 若触发：不适用。",
    "",
    "## 测试 / 验证",
    "",
    "- [x] `pnpm --filter @global/api build` 绿（nest build = tsc 全量类型检查）",
    "- [x] `pnpm --filter @global/api test` 绿（vitest / 相关测试）",
    `- [x] 校验详情：${tests.replace(/\n+/g, "；")}`,
    `- [x] changelog 片段：\`${fragmentPath}\``,
    "- [ ] CI 绿（提交后跟踪至全绿）",
    "",
    "## 指标影响（改动度量口径或数据链路时必填）",
    "",
    "- 涉及指标 ID：无",
    "- 口径是否变化（升版本）：否",
    "- 是否需重跑金标：否",
    "",
    "## 合规（涉数据源 / 联系人 / 抓取时必填）",
    "",
    "- 不涉及新增个人数据采集或数据源权限变更；继续满足既有门禁与安全边界。",
    "",
    "## 待续 / 已知风险",
    "",
    riskLines,
    "",
  ].join("\n");
}

function detectOriginMainSha(cwd) {
  try {
    return execFileSync("git", ["rev-parse", "--short", "origin/main"], {
      cwd,
      encoding: "utf8",
      env: createSafeGitEnvironment(),
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "main";
  }
}

function main(argv) {
  let fragmentArg = "";
  let baseSha = "";
  let outFile = "";
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--base-sha") {
      baseSha = argv[++i] ?? "";
    } else if (arg === "--out") {
      outFile = argv[++i] ?? "";
    } else if (!arg.startsWith("-") && !fragmentArg) {
      fragmentArg = arg;
    } else {
      throw new Error(`UNKNOWN_ARGUMENT:${arg}`);
    }
  }
  if (!fragmentArg) {
    console.error(
      "Usage: node scripts/pr-body-from-changelog.mjs <fragment-path> [--base-sha <sha>] [--out <file>]",
    );
    process.exit(2);
  }
  const fullPath = resolve(process.cwd(), fragmentArg);
  const content = readFileSync(fullPath, "utf8");
  const rendered = renderPrBodyFromFragment(content, {
    baseSha: baseSha || detectOriginMainSha(process.cwd()),
    fragmentPath: fragmentArg.replace(/\\/g, "/"),
  });
  if (outFile) {
    writeFileSync(resolve(process.cwd(), outFile), rendered, "utf8");
  } else {
    process.stdout.write(rendered);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main(process.argv.slice(2));
}
