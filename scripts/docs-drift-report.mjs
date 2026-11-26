#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { githubSlugs, parseLinkTarget, withoutFencedCode } from "./governance-docs-markdown.mjs";

const entries = {
  workspace: [
    "AGENTS.md", "CLAUDE.md", ".agents/skills/global-pr-delivery/SKILL.md",
    "local-config/RUNBOOK.md",
  ],
  backend: [
    "AGENTS.md", "CLAUDE.md", "CONTRIBUTING.md", "README.md", "docs/README.md",
    "docs/CODEX-NAVIGATION-GUIDE.md", "docs/shared/development-process.md",
    "docs/backend/worktree-management.md", "docs/status/current.md",
  ],
  "gain-saas": [
    "AGENTS.md", "README.md", "docs/README.md", "docs/documentation-rules.md",
    "docs/status/current.md", "docs/engineering/ui-design-guidelines.md",
    "deploy/engine-integration.md",
  ],
};

const topics = {
  backend: [
    ["运行与平台调度",
      ["apps/api/src/platform-authority/", "apps/api/src/runtime/", "apps/api/src/temporal/", "infra/"],
      ["docs/status/current.md", "docs/architecture/current.md", "docs/runbooks/"]],
    ["寻源与买家证据",
      ["apps/api/src/acquisition/", "apps/api/src/discovery/", "apps/api/src/enrichment/", "apps/api/src/icp/"],
      ["docs/status/current.md", "docs/modules/discovery-qualification/", "docs/modules/buyer-knowledge/"]],
    ["企业资料",
      ["apps/api/src/seller-knowledge/"],
      ["docs/status/current.md", "docs/modules/seller-knowledge/"]],
    ["执行预算与模型",
      ["apps/api/src/execution-budget/", "apps/api/src/model-runtime/"],
      ["docs/status/current.md", "docs/architecture/current.md", "docs/modules/ai-foundation/"]],
    ["独立站",
      ["apps/api/src/site-builder/", "apps/site-renderer/"],
      ["docs/status/current.md", "docs/modules/site-builder/", "docs/site-builder/"]],
  ],
  "gain-saas": [
    ["登录、租户与引擎合同",
      ["apps/server/src/auth/", "apps/server/src/bff/", "apps/server/src/tenant/", "packages/engine-client/src/openapi.json"],
      ["docs/status/current.md", "docs/technical/phase-1-01-04.md", "deploy/engine-integration.md"]],
    ["钱包与旧执行预算",
      ["apps/server/src/wallet/", "apps/server/src/service/event-consumer.service.ts", "apps/server/src/bff/bff.module.ts"],
      ["docs/status/current.md", "docs/technical/credits-wallet.md", "docs/technical/workspace-budget-quota.md"]],
    ["事件与触达",
      ["apps/server/src/service/event-consumer.service.ts", "apps/server/src/outreach/"],
      ["docs/status/current.md", "docs/technical/campaign-control-plane-m2-0.md"]],
    ["前端入口与导航",
      ["apps/web/src/router/", "apps/web/src/layouts/", "apps/web/src/composables/use-menu-groups.ts", "apps/web/src/feature-flags.ts"],
      ["docs/status/current.md", "apps/web/PRODUCT.md", "docs/engineering/"]],
    ["发布与运行",
      ["deploy/systemd/", "deploy/compose.postgres.yml", "apps/server/src/config/"],
      ["docs/status/current.md", "docs/technical/phase-1-01-04.md", "docs/engineering/frontend-release-rollback.md"]],
  ],
};

function contained(root, path) {
  const child = relative(root, path);
  return child !== ".." && !child.startsWith(".." + sep) && !isAbsolute(child);
}

function localTarget(root, path) {
  if (!contained(root, path)) return { issue: "LINK_OUTSIDE_ROOT" };
  try {
    const actual = realpathSync(path);
    if (!contained(root, actual)) return { issue: "LINK_OUTSIDE_ROOT" };
    return { actual, isFile: statSync(actual).isFile() };
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return { issue: "BROKEN_LINK" };
    throw error;
  }
}

function linkLocation(roots, site, entry, target) {
  const [rawPath, rawAnchor = ""] = target.split("#", 2);
  const repoLink = /^https:\/\/github\.com\/mlhjyx\/(global-backend|gain-saas)\/(?:blob|tree)\/main\/([^?]+)$/.exec(rawPath);
  if (repoLink) {
    const repo = repoLink[1] === "global-backend" ? "backend" : "gain-saas";
    return {
      root: roots[repo],
      path: resolve(roots[repo], decodeURIComponent(repoLink[2])),
      anchor: decodeURIComponent(rawAnchor).toLowerCase(),
    };
  }
  if (/^(?:[\w+.-]+:|\/\/)/.test(rawPath)) return null;

  const file = decodeURIComponent(rawPath.split("?", 1)[0]);
  const anchor = decodeURIComponent(rawAnchor).toLowerCase();
  const root = roots[site];
  if (isAbsolute(file) && site !== "workspace") return { issue: "LINK_ROOT_RELATIVE" };
  const path = file ? resolve(root, dirname(entry), file) : join(root, entry);
  if (site === "workspace" && contained(root, path)) {
    const [folder, ...rest] = relative(root, path).split(sep);
    if (folder === "backend" || folder === "gain-saas") {
      return { root: roots[folder], path: join(roots[folder], ...rest), anchor };
    }
  }
  return { root, path, anchor };
}

const definition = /^\s{0,3}\[([^\]^\n]+)\]:\s*(<[^>]+>|\S+)/;
const reference = /!?\[([^\]\n]+)\]\[([^\]\n]*)\]/g;
const normalizeLabel = (label) => label.trim().toLowerCase().replace(/\s+/g, " ");

function checkLinks(roots, site, entry, content, warn) {
  const visible = withoutFencedCode(content).replace(/\x60[^\x60\n]*\x60/g, "").split("\n");
  const definitions = new Set(visible.flatMap((line) => {
    const match = definition.exec(line);
    return match ? [normalizeLabel(match[1])] : [];
  }));

  for (const [index, line] of visible.entries()) {
    const targets = [...line.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)].map((link) => link[1]);
    const ref = definition.exec(line);
    if (ref) targets.push(ref[2]);
    for (const [, label, explicit] of line.matchAll(reference)) {
      if (!definitions.has(normalizeLabel(explicit || label))) {
        warn("MISSING_LINK_REFERENCE", index + 1, "引用式链接缺少定义");
      }
    }
    for (const raw of targets) {
      const target = parseLinkTarget(raw);
      let location;
      try {
        location = linkLocation(roots, site, entry, target);
      } catch (error) {
        if (!(error instanceof URIError)) throw error;
        warn("LINK_ENCODING", index + 1, "链接编码无法解析");
        continue;
      }
      if (!location) continue;
      if (location.issue) {
        warn(location.issue, index + 1, "仓库文档应使用可移植的相对链接");
        continue;
      }
      const found = localTarget(location.root, location.path);
      if (found.issue) {
        warn(found.issue, index + 1, "本地链接目标缺失或超出读取范围");
      } else if (location.anchor && found.isFile && extname(found.actual) === ".md" &&
        !githubSlugs(readFileSync(found.actual, "utf8")).has(location.anchor)) {
        warn("BROKEN_ANCHOR", index + 1, "本地 Markdown 标题锚点不存在");
      }
    }
  }
}

const commonProjectScripts = new Set(["build", "dev", "test", "lint", "typecheck", "check", "format"]);

function checkCommands(roots, manifests, sites, content, warn) {
  for (const [index, line] of content.split("\n").entries()) {
    if (/^\s*#/.test(line)) continue;
    for (const match of line.matchAll(/(?:^|[\s\x60])node\s+(?:--test\s+)?(scripts\/[\w./-]+\.m?js)\b/g)) {
      const prefix = line.slice(0, match.index);
      const directory = /(?:^|[(&|\x60]\s*)cd\s+([\w./-]+)\s*&&\s*$/.exec(prefix)?.[1] ?? ".";
      const script = join(directory, match[1]);
      if (!sites.some((site) => localTarget(roots[site], resolve(roots[site], script)).isFile)) {
        warn("MISSING_SCRIPT", index + 1, script);
      }
    }
    for (const match of line.matchAll(/(?:^\s*|[\x60&|;]\s*)pnpm\s+(?:--silent\s+)?(run\s+)?([\w][\w:-]*)/g)) {
      const [, explicitRun, command] = match;
      if (!explicitRun && !command.includes(":") && !commonProjectScripts.has(command)) continue;
      if (!sites.some((site) => Object.hasOwn(manifests[site], command))) {
        warn("MISSING_PNPM_SCRIPT", index + 1, command);
      }
    }
  }
}

function git(root, args) {
  return execFileSync("git", ["--no-optional-locks", "-C", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function commitRef(root, ref) {
  try {
    return git(root, ["rev-parse", "--verify", "--end-of-options", ref + "^{commit}"]).trim();
  } catch {
    throw new Error("无法读取本地 Git 引用 " + JSON.stringify(ref));
  }
}

function reportChanges(roots, { repo, base, head }) {
  const root = roots[repo];
  const refs = commitRef(root, base) + "..." + commitRef(root, head);
  const changed = git(root, ["diff", "--name-only", "-z", "--no-ext-diff", "--no-renames", refs, "--"]).split("\0");
  const touches = (patterns) => changed.some((file) =>
    patterns.some((pattern) => pattern.endsWith("/") ? file.startsWith(pattern) : file === pattern));
  let hints = 0;
  for (const [topic, source, docs] of topics[repo]) {
    if (touches(source) && !touches(docs)) {
      console.log("WARN DOC_REVIEW " + repo + " " + topic + "，复核 " + docs.join("、"));
      hints += 1;
    }
  }
  return hints;
}

function main() {
  const { values } = parseArgs({
    options: {
      workspace: { type: "string" },
      backend: { type: "string" },
      saas: { type: "string" },
      repo: { type: "string" },
      base: { type: "string" },
      head: { type: "string" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log("node scripts/docs-drift-report.mjs --workspace <dir> [--backend <dir>] [--saas <dir>] [--repo backend|gain-saas --base <ref> --head <ref>]");
    return;
  }
  if (!values.workspace) throw new Error("缺少 --workspace");
  const diff = values.repo !== undefined || values.base !== undefined || values.head !== undefined;
  if (diff && (!Object.hasOwn(topics, values.repo ?? "") || !values.base || !values.head)) {
    throw new Error("比较改动需要同时指定 --repo backend|gain-saas、--base 和 --head");
  }
  const roots = { workspace: realpathSync(values.workspace) };
  roots.backend = realpathSync(values.backend ?? join(roots.workspace, "backend"));
  roots["gain-saas"] = realpathSync(values.saas ?? join(roots.workspace, "gain-saas"));
  const manifests = {};
  for (const site of ["backend", "gain-saas"]) {
    const file = localTarget(roots[site], join(roots[site], "package.json"));
    if (!file.isFile) throw new Error(site + " 的 package.json 无法读取");
    try {
      manifests[site] = JSON.parse(readFileSync(file.actual, "utf8")).scripts ?? {};
    } catch {
      throw new Error(site + " 的 package.json 无法解析");
    }
  }

  let checked = 0;
  let warnings = 0;
  for (const [site, paths] of Object.entries(entries)) {
    const commandSites = site === "workspace" ? ["backend", "gain-saas"] : [site];
    for (const entry of paths) {
      const label = site === "workspace" ? entry : site + "/" + entry;
      const warn = (code, line, detail) => {
        console.log("WARN " + code + " " + label + (line ? ":" + line : "") + " " + detail);
        warnings += 1;
      };
      const file = localTarget(roots[site], join(roots[site], entry));
      if (!file.isFile) {
        warn("ENTRY_UNAVAILABLE", 0, "入口文件缺失或超出读取范围");
        continue;
      }
      const content = readFileSync(file.actual, "utf8");
      checked += 1;
      checkLinks(roots, site, entry, content, warn);
      checkCommands(roots, manifests, commandSites, content, warn);
    }
  }
  if (diff) warnings += reportChanges(roots, values);
  console.log("文档漂移检查，已读取 " + checked + " 个入口，" + warnings + " 条提示");
}

try {
  main();
} catch (error) {
  console.error("ERROR 文档漂移检查未完成，" + error.message);
  process.exitCode = 2;
}
