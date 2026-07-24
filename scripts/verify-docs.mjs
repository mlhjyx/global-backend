#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const policyPath = join(root, "docs/governance/docs-verification-policy.json");
const policy = JSON.parse(readFileSync(policyPath, "utf8"));
const issues = [];
const stats = {
  markdownFiles: 0,
  controlledFiles: 0,
  documentIds: 0,
  links: 0,
  anchors: 0,
  tables: 0,
  releaseBundles: 0,
  authoritativeFiles: 0,
  historicalFiles: 0,
};

function repoPath(path) {
  return relative(root, path).split("\\").join("/");
}

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

function report(severity, code, path, detail) {
  issues.push({ severity, code, path: repoPath(path), detail });
}

function isControlled(path) {
  const pathFromRoot = repoPath(path);
  return (
    policy.controlledMarkdown.exact.includes(pathFromRoot) ||
    policy.controlledMarkdown.prefixes.some((prefix) =>
      pathFromRoot.startsWith(prefix),
    )
  );
}

function isAuthoritativeCurrent(path) {
  return policy.authoritativeCurrent?.exact.includes(repoPath(path)) ?? false;
}

function isHistoricalProvenance(path) {
  const pathFromRoot = repoPath(path);
  const historical = policy.historicalProvenance ?? {};
  return (
    historical.exact?.includes(pathFromRoot) ||
    historical.prefixes?.some((prefix) => pathFromRoot.startsWith(prefix)) ||
    historical.evidencePrefixes?.some((prefix) => pathFromRoot.startsWith(prefix))
  );
}

function withoutFencedCode(content) {
  let inFence = false;
  return content
    .split("\n")
    .map((line) => {
      if (/^\s*```/.test(line)) {
        inFence = !inFence;
        return "";
      }
      return inFence ? "" : line;
    })
    .join("\n");
}

function githubSlugs(content) {
  const occurrences = new Map();
  const slugs = new Set();
  for (const line of withoutFencedCode(content).split("\n")) {
    const match = line.match(/^#{1,6}\s+(.+?)\s*#*\s*$/);
    if (!match) continue;
    const base = match[1]
      .replace(/<[^>]+>/g, "")
      .replace(/`([^`]*)`/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .toLowerCase()
      .trim()
      .replace(/[^\p{L}\p{N}\s_-]/gu, "")
      .replace(/\s+/g, "-");
    const count = occurrences.get(base) ?? 0;
    occurrences.set(base, count + 1);
    slugs.add(count === 0 ? base : `${base}-${count}`);
  }
  return slugs;
}

function tableCellCount(line) {
  const masked = line.replace(/`[^`]*`/g, "`code`").trim();
  const body = masked.replace(/^\|/, "").replace(/\|$/, "");
  return body.split(/(?<!\\)\|/).length;
}

function markdownTableCells(line) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim());
}

function registryDefinitions(content, registry, pattern) {
  const definitions = new Set();
  const definitionColumns = new Set(registry.definitionColumns ?? []);
  const lines = withoutFencedCode(content).split("\n");

  for (let index = 0; index < lines.length - 1; index += 1) {
    const header = lines[index].trim();
    const separator = lines[index + 1].trim();
    if (!header.startsWith("|") || !separator.startsWith("|")) continue;
    const headers = markdownTableCells(header);
    const separatorCells = markdownTableCells(separator);
    if (
      headers.length !== separatorCells.length ||
      !separatorCells.every((cell) => /^:?-{3,}:?$/.test(cell))
    ) {
      continue;
    }

    const declarationIndexes = headers
      .map((cell, columnIndex) =>
        definitionColumns.has(cell) ? columnIndex : -1,
      )
      .filter((columnIndex) => columnIndex >= 0);
    if (declarationIndexes.length === 0) continue;

    let row = index + 2;
    while (row < lines.length && lines[row].trim().startsWith("|")) {
      const cells = markdownTableCells(lines[row]);
      for (const columnIndex of declarationIndexes) {
        for (const match of cells[columnIndex]?.matchAll(pattern) ?? []) {
          definitions.add(match[0]);
        }
      }
      row += 1;
    }
    index = row - 1;
  }

  return definitions;
}

function checkTables(path, content, controlled) {
  const lines = withoutFencedCode(content).split("\n");
  for (let index = 0; index < lines.length - 1; index += 1) {
    const header = lines[index].trim();
    const separator = lines[index + 1].trim();
    if (!header.startsWith("|") || !separator.startsWith("|")) continue;
    const separatorCells = separator
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split(/(?<!\\)\|/);
    if (!separatorCells.every((cell) => /^\s*:?-{3,}:?\s*$/.test(cell)))
      continue;
    stats.tables += 1;
    const expected = tableCellCount(header);
    let row = index + 1;
    while (row < lines.length && lines[row].trim().startsWith("|")) {
      const actual = tableCellCount(lines[row]);
      if (actual !== expected) {
        report(
          controlled ? "error" : "warning",
          "TABLE_COLUMNS",
          path,
          `line ${row + 1}: expected ${expected}, found ${actual}`,
        );
      }
      row += 1;
    }
    index = row - 1;
  }
}

function parseLinkTarget(raw) {
  const trimmed = raw.trim();
  if (trimmed.startsWith("<")) {
    const end = trimmed.indexOf(">");
    return end === -1 ? trimmed : trimmed.slice(1, end);
  }
  return trimmed.split(/\s+["']/)[0];
}

const docsRoot = join(root, "docs");
const markdownPaths = walk(docsRoot).filter((path) => extname(path) === ".md");
const markdownByPath = new Map(
  markdownPaths.map((path) => [path, readFileSync(path, "utf8")]),
);
stats.markdownFiles = markdownPaths.length;

for (const pathFromRoot of policy.authoritativeCurrent?.exact ?? []) {
  const path = join(root, pathFromRoot);
  if (!existsSync(path)) {
    report(
      "error",
      "AUTHORITY_DOCUMENT_MISSING",
      path,
      "registered authoritative current document is missing",
    );
  }
}

const documentIds = new Map();
for (const [path, content] of markdownByPath) {
  const controlled = isControlled(path);
  const authoritativeCurrent = isAuthoritativeCurrent(path);
  const historicalProvenance = isHistoricalProvenance(path);
  if (controlled) stats.controlledFiles += 1;
  if (authoritativeCurrent) stats.authoritativeFiles += 1;
  if (historicalProvenance) stats.historicalFiles += 1;

  const h1Count = withoutFencedCode(content)
    .split("\n")
    .filter((line) => /^#\s+/.test(line)).length;
  if (controlled && h1Count !== 1)
    report("error", "H1_COUNT", path, `expected 1 H1, found ${h1Count}`);
  if (!content.endsWith("\n"))
    report("error", "FINAL_NEWLINE", path, "file must end with a newline");
  const fenceCount = content
    .split("\n")
    .filter((line) => /^\s*```/.test(line)).length;
  if (fenceCount % 2 !== 0)
    report("error", "CODE_FENCE", path, `found ${fenceCount} fence markers`);

  const idMatch = content.match(/^> 文档 ID：\s*`?([A-Z][A-Z0-9-]+)`?\s*$/m);
  if (idMatch) {
    stats.documentIds += 1;
    const paths = documentIds.get(idMatch[1]) ?? [];
    paths.push(path);
    documentIds.set(idMatch[1], paths);
  } else if (
    controlled &&
    !policy.controlledMarkdown.documentIdExceptions.includes(repoPath(path))
  ) {
    report(
      "error",
      "DOCUMENT_ID_MISSING",
      path,
      "controlled Markdown requires a Document ID",
    );
  }

  if (controlled) {
    const metadata = content.split("\n").slice(0, 16).join("\n");
    if (
      !/^> (状态|生命周期)：/m.test(metadata) &&
      !policy.controlledMarkdown.documentIdExceptions.includes(repoPath(path))
    ) {
      report(
        "error",
        "STATUS_MISSING",
        path,
        "controlled Markdown requires 状态 or 生命周期 metadata",
      );
    }
    for (const match of metadata.matchAll(
      /^> (?:状态|生命周期|评审状态)：(.+)$/gm,
    )) {
      const rawStatus = match[1].trim();
      if (!/^`[^`\n]+`(?:\s*\/\s*`[^`\n]+`)*$/.test(rawStatus)) {
        report(
          "error",
          "STATUS_UNKNOWN",
          path,
          `malformed metadata status value ${rawStatus}`,
        );
        continue;
      }
      const tokens = [...rawStatus.matchAll(/`([^`]+)`/g)].flatMap((item) => {
        const value = item[1].trim();
        if (!/^[A-Z][A-Z0-9_]*(?:\s*\/\s*[A-Z][A-Z0-9_]*)*$/.test(value)) {
          report(
            "error",
            "STATUS_UNKNOWN",
            path,
            `malformed metadata status token ${value}`,
          );
          return [];
        }
        return value.split(/\s*\/\s*/);
      });
      for (const token of tokens) {
        if (!policy.allowedStatusTokens.includes(token)) {
          report(
            "error",
            "STATUS_UNKNOWN",
            path,
            `unknown metadata status token ${token}`,
          );
        }
      }
    }
  }

  if (authoritativeCurrent) {
    const metadata = content.split("\n").slice(0, 20).join("\n");
    for (const field of policy.authoritativeCurrent.requiredMetadata) {
      const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (!new RegExp(`^> ${escaped}：\\s*\\S`, "m").test(metadata)) {
        report(
          "error",
          "AUTHORITY_METADATA_MISSING",
          path,
          `authoritative current document requires ${field} metadata`,
        );
      }
    }
  }

  checkTables(path, content, controlled);

  const visible = withoutFencedCode(content).replace(/`[^`\n]*`/g, "");
  const linkPattern = /!?\[[^\]]*\]\(([^)]+)\)/g;
  for (const match of visible.matchAll(linkPattern)) {
    const target = parseLinkTarget(match[1]);
    if (!target || /^(?:https?:|mailto:|tel:|data:)/i.test(target)) continue;
    stats.links += 1;
    const hashIndex = target.indexOf("#");
    const rawFile = hashIndex === -1 ? target : target.slice(0, hashIndex);
    const rawAnchor = hashIndex === -1 ? "" : target.slice(hashIndex + 1);
    let decodedFile;
    let decodedAnchor;
    try {
      decodedFile = decodeURIComponent(rawFile);
      decodedAnchor = decodeURIComponent(rawAnchor).toLowerCase();
    } catch {
      report("error", "LINK_ENCODING", path, `cannot decode ${target}`);
      continue;
    }
    if (decodedFile.startsWith("/")) {
      report(
        "error",
        "LINK_ROOT_RELATIVE",
        path,
        `repository links must be relative: ${target}`,
      );
      continue;
    }
    const resolvedPath = decodedFile
      ? resolve(dirname(path), decodedFile)
      : path;
    if (resolvedPath !== root && !resolvedPath.startsWith(`${root}${sep}`)) {
      report(
        "error",
        "LINK_OUTSIDE_ROOT",
        path,
        `target escapes repository: ${target}`,
      );
      continue;
    }
    if (!existsSync(resolvedPath)) {
      report("error", "LINK_TARGET", path, `missing target ${target}`);
      continue;
    }
    if (
      rawAnchor &&
      statSync(resolvedPath).isFile() &&
      extname(resolvedPath) === ".md"
    ) {
      stats.anchors += 1;
      const targetContent =
        markdownByPath.get(resolvedPath) ?? readFileSync(resolvedPath, "utf8");
      if (!githubSlugs(targetContent).has(decodedAnchor)) {
        report("error", "LINK_ANCHOR", path, `missing anchor ${target}`);
      }
    }
  }

  const sensitivePatterns = [
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    /\bsk-[A-Za-z0-9_-]{32,}\b/,
    /\bAKIA[0-9A-Z]{16}\b/,
  ];
  if (sensitivePatterns.some((pattern) => pattern.test(content))) {
    report(
      "error",
      "SECRET_PATTERN",
      path,
      "possible credential or private key in documentation",
    );
  }
}

for (const [id, paths] of documentIds) {
  if (paths.length > 1) {
    report(
      "error",
      "DOCUMENT_ID_DUPLICATE",
      paths[0],
      `${id}: ${paths.map(repoPath).join(", ")}`,
    );
  }
}

for (const registry of policy.idRegistries) {
  const sourcePath = join(root, registry.source);
  const pattern = new RegExp(`\\b${registry.pattern}\\b`, "g");
  const definitions = registryDefinitions(
    readFileSync(sourcePath, "utf8"),
    registry,
    pattern,
  );
  if (definitions.size === 0) {
    report(
      "error",
      "REGISTRY_DEFINITIONS",
      sourcePath,
      `${registry.name} registry has no IDs in declaration columns: ${(registry.definitionColumns ?? []).join(", ")}`,
    );
  }
  for (const [path, content] of markdownByPath) {
    if (!isControlled(path)) continue;
    for (const id of new Set(content.match(pattern) ?? [])) {
      if (!definitions.has(id)) {
        report(
          "error",
          "REGISTRY_REFERENCE",
          path,
          `${registry.name} ID ${id} absent from ${registry.source}`,
        );
      }
    }
  }
}

for (const banner of policy.historicalBannerChecks) {
  const path = join(root, banner.path);
  if (!existsSync(path)) {
    report(
      "error",
      "HISTORY_MISSING",
      path,
      "registered historical document is missing",
    );
    continue;
  }
  const preamble = readFileSync(path, "utf8")
    .split("\n")
    .slice(0, 20)
    .join("\n")
    .toLowerCase();
  if (
    !banner.requiredAny.some((term) => preamble.includes(term.toLowerCase()))
  ) {
    report(
      "error",
      "HISTORY_BANNER",
      path,
      `preamble lacks one of: ${banner.requiredAny.join(", ")}`,
    );
  }
}

const releaseDirectory = join(root, policy.releaseBundles.directory);
if (existsSync(releaseDirectory)) {
  const bundles = readdirSync(releaseDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && extname(entry.name) === ".md")
    .map((entry) => join(releaseDirectory, entry.name));
  stats.releaseBundles = bundles.length;
  for (const path of bundles) {
    const content = readFileSync(path, "utf8");
    for (const field of policy.releaseBundles.requiredMetadata) {
      const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const match = content.match(new RegExp(`^> ${escaped}：\\s*(.+)$`, "m"));
      if (!match || /(?:TBD|TODO|待定|<[^>]+>)/i.test(match[1])) {
        report(
          "error",
          "RELEASE_METADATA",
          path,
          `missing or placeholder metadata: ${field}`,
        );
      }
    }
    const headings = new Set(
      withoutFencedCode(content)
        .split("\n")
        .map((line) => line.match(/^##\s+(.+?)\s*$/)?.[1])
        .filter(Boolean),
    );
    for (const heading of policy.releaseBundles.requiredHeadings) {
      if (!headings.has(heading))
        report("error", "RELEASE_SECTION", path, `missing ## ${heading}`);
    }
  }
}

const errors = issues.filter((issue) => issue.severity === "error");
const warnings = issues.filter((issue) => issue.severity === "warning");

for (const issue of issues) {
  console.error(
    `${issue.severity.toUpperCase()} ${issue.code} ${issue.path}: ${issue.detail}`,
  );
}
console.log(
  `docs:verify ${errors.length === 0 ? "PASS" : "FAIL"} — ${stats.markdownFiles} Markdown, ${stats.controlledFiles} controlled, ${stats.documentIds} IDs, ${stats.links} local links, ${stats.anchors} anchors, ${stats.tables} tables, ${stats.releaseBundles} release bundles; ${errors.length} errors, ${warnings.length} warnings`,
);

if (errors.length > 0) process.exitCode = 1;
