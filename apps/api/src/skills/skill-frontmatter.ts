/**
 * SKILL.md frontmatter 的严格子集解析器（v0）。
 *
 * 只接受块状映射（顶层 + 一级 `metadata`）与单行标量；复杂 YAML（锚点、别名、标签、
 * 块标量 `|`/`>`、流式集合 `{}`/`[]`、多行折叠）一律拒绝并给出稳定错误码。平台技能包
 * 由我们自己维护，宁可报错也不静默解析成另一种意思。解析只发生在 dev/CI（生成
 * `generated/builtin-skill-catalog.ts`），运行时不做 YAML 解析。
 *
 * 依赖策略：本仓库锁文件由其他会话独占，v0 不引入 `yaml` 依赖；待锁文件释放后可把
 * 本文件内部替换为 `yaml` 包而不改变对外行为（决策 D-c）。
 */

export type SkillFrontmatterErrorCode =
  | "SKILL_FRONTMATTER_MISSING"
  | "SKILL_FRONTMATTER_UNCLOSED"
  | "SKILL_FRONTMATTER_SYNTAX"
  | "SKILL_FRONTMATTER_DUPLICATE_KEY"
  | "SKILL_FRONTMATTER_UNSUPPORTED";

export class SkillFrontmatterError extends Error {
  constructor(
    readonly code: SkillFrontmatterErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SkillFrontmatterError";
  }
}

export interface ParsedSkillDocument {
  readonly frontmatter: Record<string, unknown>;
  readonly body: string;
}

const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const UNSUPPORTED_VALUE_STARTS = new Set(["|", ">", "{", "[", "&", "*", "!", "%", "@"]);

function splitScalar(raw: string): unknown {
  if (raw.startsWith("{") || raw.startsWith("[")) {
    throw new SkillFrontmatterError("SKILL_FRONTMATTER_UNSUPPORTED", "flow collections are not supported");
  }
  if (raw.startsWith('"')) {
    try {
      const value: unknown = JSON.parse(raw);
      if (typeof value !== "string") {
        throw new Error("not a string");
      }
      return value;
    } catch {
      throw new SkillFrontmatterError("SKILL_FRONTMATTER_SYNTAX", "invalid double-quoted scalar");
    }
  }
  if (raw.startsWith("'")) {
    if (!raw.endsWith("'") || raw.length < 2) {
      throw new SkillFrontmatterError("SKILL_FRONTMATTER_SYNTAX", "unterminated single-quoted scalar");
    }
    return raw.slice(1, -1).replace(/''/gu, "'");
  }
  if (raw.includes(": ") || raw.endsWith(":")) {
    throw new SkillFrontmatterError("SKILL_FRONTMATTER_SYNTAX", "plain scalar must not contain a nested mapping");
  }
  if (raw.includes(" #")) {
    throw new SkillFrontmatterError("SKILL_FRONTMATTER_UNSUPPORTED", "inline comments are not supported");
  }
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "null" || raw === "~") return null;
  if (/^-?\d+$/u.test(raw)) return Number.parseInt(raw, 10);
  return raw;
}

function parseValue(rawValue: string, line: string): unknown {
  const value = rawValue.trim();
  if (!value) {
    throw new SkillFrontmatterError("SKILL_FRONTMATTER_SYNTAX", `missing value: ${line}`);
  }
  if (value.includes("\t")) {
    throw new SkillFrontmatterError("SKILL_FRONTMATTER_UNSUPPORTED", "tabs are not supported");
  }
  const first = value[0];
  if (UNSUPPORTED_VALUE_STARTS.has(first) || value.startsWith("- ")) {
    throw new SkillFrontmatterError(
      "SKILL_FRONTMATTER_UNSUPPORTED",
      `unsupported YAML construct: ${line}`,
    );
  }
  return splitScalar(value);
}

export function parseSkillFrontmatter(content: string): ParsedSkillDocument {
  const normalized = (content.startsWith("﻿") ? content.slice(1) : content).replace(/\r\n/gu, "\n");
  const lines = normalized.split("\n");
  if (lines[0] !== "---") {
    throw new SkillFrontmatterError("SKILL_FRONTMATTER_MISSING", "document must start with a --- frontmatter block");
  }
  let closing = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index] === "---") {
      closing = index;
      break;
    }
  }
  if (closing < 0) {
    throw new SkillFrontmatterError("SKILL_FRONTMATTER_UNCLOSED", "frontmatter block is not closed");
  }

  const frontmatter: Record<string, unknown> = {};
  let metadata: Record<string, unknown> | undefined;
  for (let index = 1; index < closing; index += 1) {
    const line = lines[index];
    if (line.trim() === "" || line.startsWith("#")) continue;
    if (line.includes("\t")) {
      throw new SkillFrontmatterError("SKILL_FRONTMATTER_UNSUPPORTED", `tabs are not supported: ${line}`);
    }
    const indent = line.length - line.trimStart().length;
    if (indent === 0) {
      const separator = line.indexOf(":");
      if (separator <= 0) {
        throw new SkillFrontmatterError("SKILL_FRONTMATTER_SYNTAX", `expected "key: value": ${line}`);
      }
      const key = line.slice(0, separator).trim();
      if (!KEY_PATTERN.test(key)) {
        throw new SkillFrontmatterError("SKILL_FRONTMATTER_SYNTAX", `invalid key: ${key}`);
      }
      if (Object.hasOwn(frontmatter, key)) {
        throw new SkillFrontmatterError("SKILL_FRONTMATTER_DUPLICATE_KEY", `duplicate key: ${key}`);
      }
      const rawValue = line.slice(separator + 1);
      if (rawValue.trim() === "") {
        if (key !== "metadata") {
          throw new SkillFrontmatterError("SKILL_FRONTMATTER_SYNTAX", `missing value: ${line}`);
        }
        metadata = {};
        frontmatter.metadata = metadata;
        continue;
      }
      if (key === "metadata") {
        const first = rawValue.trim()[0];
        throw new SkillFrontmatterError(
          first === "{" || first === "[" ? "SKILL_FRONTMATTER_UNSUPPORTED" : "SKILL_FRONTMATTER_SYNTAX",
          "metadata must be a block mapping",
        );
      }
      metadata = undefined;
      frontmatter[key] = parseValue(rawValue, line);
      continue;
    }
    if (indent === 2 && metadata) {
      const separator = line.slice(2).indexOf(":");
      if (separator <= 0) {
        throw new SkillFrontmatterError("SKILL_FRONTMATTER_SYNTAX", `expected "key: value": ${line}`);
      }
      const key = line.slice(2, 2 + separator).trim();
      if (!KEY_PATTERN.test(key)) {
        throw new SkillFrontmatterError("SKILL_FRONTMATTER_SYNTAX", `invalid key: ${key}`);
      }
      if (Object.hasOwn(metadata, key)) {
        throw new SkillFrontmatterError("SKILL_FRONTMATTER_DUPLICATE_KEY", `duplicate key: ${key}`);
      }
      metadata[key] = parseValue(line.slice(2 + separator + 1), line);
      continue;
    }
    throw new SkillFrontmatterError(
      "SKILL_FRONTMATTER_UNSUPPORTED",
      `unsupported indentation or nesting: ${line}`,
    );
  }

  const body = lines
    .slice(closing + 1)
    .join("\n")
    .replace(/^\n+/u, "")
    .replace(/\s+$/u, "");
  return { frontmatter, body };
}
