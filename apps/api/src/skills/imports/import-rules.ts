import type { SkillManifest, SkillManifestIssue } from "../skill-manifest";

/**
 * 导入技能的合规门（设计 §6.4 / GOV-TPS-003）：许可、NOTICE 溯源与安全扫描。
 * 衍生版正文由本仓编写，规则用于防回归——不许夹带可执行内容、外部推广链接，
 * 或丢失来源与改动说明。
 */

export const IMPORTED_LICENSE_ALLOWLIST = ["MIT", "Apache-2.0"] as const;

const SOURCE_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/u;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;
const URL_PATTERN = /https?:\/\/\S+/u;
const EXECUTABLE_LANGS = new Set([
  "sh",
  "bash",
  "zsh",
  "shell",
  "console",
  "python",
  "py",
  "node",
  "js",
  "javascript",
  "ts",
  "typescript",
  "powershell",
  "ps1",
  "ruby",
  "perl",
  "go",
]);

export interface ImportedSkillRuleInput {
  readonly sourceId: string;
  readonly directory: string;
  readonly manifest: SkillManifest;
  readonly body: string;
}

interface NoticeLine {
  readonly key: string;
  readonly value: string;
}

/** 提取 `## NOTICE` 小节（到下一个 `## ` 标题或文末）的 `- Key: value` 行。 */
function noticeLines(body: string): { present: boolean; lines: readonly NoticeLine[] } {
  const lines = body.split("\n");
  const start = lines.findIndex((line) => /^##\s+NOTICE\s*$/iu.test(line.trim()));
  if (start < 0) return { present: false, lines: [] };
  const collected: NoticeLine[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^##\s+/u.test(line.trim())) break;
    const match = /^-\s*([A-Za-z][A-Za-z ]*):\s*(.*)$/u.exec(line.trim());
    if (match) collected.push({ key: match[1].trim().toLowerCase(), value: match[2].trim() });
  }
  return { present: true, lines: collected };
}

function executableFenceLanguage(body: string): string | undefined {
  for (const line of body.split("\n")) {
    const match = /^```([A-Za-z0-9_-]*)\s*$/u.exec(line.trim());
    if (!match) continue;
    const language = match[1].toLowerCase();
    if (language !== "" && EXECUTABLE_LANGS.has(language)) return language;
  }
  return undefined;
}

/** URL 只允许出现在 NOTICE 小节（溯源链接）；正文其他位置一律视为推广/外链。 */
function urlsOutsideNotice(body: string): readonly string[] {
  const lines = body.split("\n");
  const start = lines.findIndex((line) => /^##\s+NOTICE\s*$/iu.test(line.trim()));
  let end = lines.length;
  if (start >= 0) {
    for (let index = start + 1; index < lines.length; index += 1) {
      if (/^##\s+/u.test(lines[index].trim())) {
        end = index;
        break;
      }
    }
  }
  const found: string[] = [];
  lines.forEach((line, index) => {
    if (start >= 0 && index >= start && index < end) return;
    const match = URL_PATTERN.exec(line);
    if (match) found.push(match[0]);
  });
  return found;
}

export function validateImportedSkill(input: ImportedSkillRuleInput): readonly SkillManifestIssue[] {
  const issues: SkillManifestIssue[] = [];
  const error = (code: string, message: string): void => {
    issues.push({ code, severity: "error", message });
  };

  if (!SOURCE_ID_PATTERN.test(input.sourceId)) {
    error("IMPORTED_SOURCE_INVALID", `source id "${input.sourceId}" must be lowercase kebab-case`);
  }
  if (!(IMPORTED_LICENSE_ALLOWLIST as readonly string[]).includes(input.manifest.license)) {
    error(
      "IMPORTED_LICENSE_NOT_ALLOWED",
      `license "${input.manifest.license}" is not in the import allowlist (${IMPORTED_LICENSE_ALLOWLIST.join(", ")})`,
    );
  }
  if (input.manifest.platform.tenantDefault !== "disabled") {
    error(
      "IMPORTED_TENANT_DEFAULT_INVALID",
      "imported skills must ship tenant-default: disabled (enable per tenant explicitly)",
    );
  }

  const notice = noticeLines(input.body);
  if (!notice.present) {
    error("IMPORTED_NOTICE_MISSING", "imported skill body must contain a `## NOTICE` section");
  } else {
    const value = (key: string): string | undefined =>
      notice.lines.find((line) => line.key === key)?.value;
    const upstream = value("upstream");
    if (!upstream || !URL_PATTERN.test(upstream)) {
      error("IMPORTED_NOTICE_INCOMPLETE", "NOTICE needs `- Upstream: <repository URL>`");
    }
    const commit = value("commit");
    if (!commit || !COMMIT_PATTERN.test(commit)) {
      error("IMPORTED_NOTICE_INCOMPLETE", "NOTICE needs `- Commit: <40-hex commit>`");
    }
    const license = value("license");
    if (!license || !license.startsWith(input.manifest.license)) {
      error(
        "IMPORTED_NOTICE_INCOMPLETE",
        "NOTICE `- License:` must start with the manifest license",
      );
    }
    const modified = value("modified");
    if (!modified) {
      error("IMPORTED_NOTICE_INCOMPLETE", "NOTICE needs `- Modified:` describing the derivative changes");
    }
  }

  const fence = executableFenceLanguage(input.body);
  if (fence !== undefined) {
    error("IMPORTED_SCRIPT_CONTENT", `executable code fence (\`\`\`${fence}) is not allowed in imported skills`);
  }
  if (/<script\b/iu.test(input.body)) {
    error("IMPORTED_SCRIPT_CONTENT", "<script> content is not allowed in imported skills");
  }
  for (const url of urlsOutsideNotice(input.body)) {
    error("IMPORTED_EXTERNAL_URL", `external URL outside NOTICE is not allowed: ${url}`);
  }

  return issues;
}
