#!/usr/bin/env node
// frame registry — validate the machine-readable frame matrix (ch01 §3.3 / PR-10).
//
//   node scripts/metrics/frame-registry.mjs                 # summary + validation
//   node scripts/metrics/frame-registry.mjs --json          # machine-readable
//   node scripts/metrics/frame-registry.mjs --registry <path>
//
// The registry is the source of truth for "which frame covers which
// jurisdiction, under which licence, fetched how often". A frame may only be
// ACTIVE when its licence and source URL are recorded (ch01 PR-10 requirement:
// 缺 license/toS 不许 ACTIVE). Pure Node built-ins.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { parseArgs } from "./lib/psql.mjs";

const DEFAULT_REGISTRY = new URL("../../docs/metrics/frames/frame-registry.v1.json", import.meta.url);

const ACCESS_MODES = new Set(["bulk", "api", "crawl", "import", "paid"]);
const CADENCES = new Set(["daily", "weekly", "monthly", "quarterly", "annual", "irregular", "realtime"]);
const REDISTRIBUTION = new Set(["allowed", "restricted", "prohibited", "unknown"]);
const STATUSES = new Set(["ACTIVE", "PAUSED", "RETIRED", "DRAFT"]);
const FRAME_KEY = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const JURISDICTION = /^[A-Z]{2}(?:-[A-Z0-9]{1,3})?$/;

function issue(code, path, message) {
  return { code, path, message };
}

/** Validate a parsed frame-registry/v1 document. Returns { issues, summary }. */
export function validateFrameRegistry(registry) {
  const issues = [];
  if (registry?.schemaVersion !== "frame-registry/v1") {
    issues.push(issue("SCHEMA_VERSION", "$.schemaVersion", "must be frame-registry/v1"));
  }
  const frames = Array.isArray(registry?.frames) ? registry.frames : [];
  if (frames.length === 0) {
    issues.push(issue("FRAMES_EMPTY", "$.frames", "registry must contain at least one frame"));
  }
  const seenKeys = new Set();
  const seenJurisdictionKeys = new Set();
  frames.forEach((frame, index) => {
    const path = `$.frames[${index}]`;
    if (!FRAME_KEY.test(frame?.frameKey ?? "")) {
      issues.push(issue("FRAME_KEY_INVALID", `${path}.frameKey`, `invalid frame_key: ${frame?.frameKey}`));
    }
    if (seenKeys.has(frame?.frameKey)) {
      issues.push(issue("FRAME_KEY_DUPLICATE", `${path}.frameKey`, `duplicate frame_key: ${frame?.frameKey}`));
    }
    seenKeys.add(frame?.frameKey);
    if (!JURISDICTION.test(frame?.jurisdiction ?? "")) {
      issues.push(
        issue("JURISDICTION_INVALID", `${path}.jurisdiction`, `expected ISO-2 or CC-XXX: ${frame?.jurisdiction}`),
      );
    }
    const jurisdictionKey = `${frame?.jurisdiction}::${frame?.frameKey}`;
    if (seenJurisdictionKeys.has(jurisdictionKey)) {
      issues.push(issue("FRAME_DUPLICATE", path, `duplicate jurisdiction+frame_key: ${jurisdictionKey}`));
    }
    seenJurisdictionKeys.add(jurisdictionKey);
    if (!frame?.name || String(frame.name).trim() === "") {
      issues.push(issue("NAME_MISSING", `${path}.name`, "name is required"));
    }
    if (!/^https:\/\//.test(frame?.sourceUrl ?? "")) {
      issues.push(issue("SOURCE_URL_INVALID", `${path}.sourceUrl`, "sourceUrl must be https://"));
    }
    if (!ACCESS_MODES.has(frame?.accessMode)) {
      issues.push(issue("ACCESS_MODE_INVALID", `${path}.accessMode`, `unknown accessMode: ${frame?.accessMode}`));
    }
    if (!CADENCES.has(frame?.updateCadence)) {
      issues.push(
        issue("CADENCE_INVALID", `${path}.updateCadence`, `unknown updateCadence: ${frame?.updateCadence}`),
      );
    }
    if (!REDISTRIBUTION.has(frame?.redistribution)) {
      issues.push(
        issue("REDISTRIBUTION_INVALID", `${path}.redistribution`, `unknown redistribution: ${frame?.redistribution}`),
      );
    }
    if (!STATUSES.has(frame?.status)) {
      issues.push(issue("STATUS_INVALID", `${path}.status`, `unknown status: ${frame?.status}`));
    }
    if (![1, 2, 3].includes(frame?.priority)) {
      issues.push(issue("PRIORITY_INVALID", `${path}.priority`, "priority must be 1, 2 or 3"));
    }
    if (!Array.isArray(frame?.pitfalls) || frame.pitfalls.length === 0) {
      issues.push(issue("PITFALLS_MISSING", `${path}.pitfalls`, "at least one pitfall entry is required"));
    }
    if (frame?.status === "ACTIVE" && !(frame?.licenseId && frame?.licenseUrl)) {
      issues.push(
        issue("ACTIVE_WITHOUT_LICENSE", path, "a frame may only be ACTIVE with licenseId and licenseUrl recorded"),
      );
    }
    if (frame?.licenseUrl && !/^https:\/\//.test(frame.licenseUrl)) {
      issues.push(issue("LICENSE_URL_INVALID", `${path}.licenseUrl`, "licenseUrl must be https://"));
    }
  });

  const summary = {
    total: frames.length,
    byStatus: Object.fromEntries(
      [...STATUSES].map((status) => [status, frames.filter((frame) => frame.status === status).length]),
    ),
    byPriority: Object.fromEntries(
      [1, 2, 3].map((priority) => [priority, frames.filter((frame) => frame.priority === priority).length]),
    ),
    jurisdictions: [...new Set(frames.map((frame) => frame.jurisdiction))].sort(),
  };
  return { issues, summary };
}

export function loadFrameRegistry(path = DEFAULT_REGISTRY) {
  const registry = JSON.parse(readFileSync(path, "utf8"));
  return { registry, ...validateFrameRegistry(registry) };
}

function renderMarkdown({ registry, summary, issues }) {
  const out = [];
  out.push("# frame registry 校验");
  out.push("");
  out.push(`> 来源：${registry.source ?? "(未标注)"}；asOf：${registry.asOf ?? "(未标注)"}`);
  out.push("");
  out.push("| 指标 | 值 |");
  out.push("| --- | --- |");
  out.push(`| frame 总数 | ${summary.total} |`);
  out.push(`| 法域数 | ${summary.jurisdictions.length}（${summary.jurisdictions.join(", ")}） |`);
  out.push(
    `| 按状态 | ${Object.entries(summary.byStatus)
      .filter(([, count]) => count > 0)
      .map(([status, count]) => `${status} ${count}`)
      .join(" / ")} |`,
  );
  out.push(
    `| 按优先级 | ${Object.entries(summary.byPriority)
      .map(([priority, count]) => `P${priority} ${count}`)
      .join(" / ")} |`,
  );
  out.push("");
  if (issues.length > 0) {
    out.push("## 校验失败");
    out.push("");
    out.push("| 代码 | 路径 | 说明 |");
    out.push("| --- | --- | --- |");
    for (const item of issues) out.push(`| ${item.code} | ${item.path} | ${item.message} |`);
  } else {
    out.push("校验通过：0 个问题。");
  }
  return out.join("\n");
}

function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help) {
    console.log(
      "usage: node scripts/metrics/frame-registry.mjs [--json] [--registry <path>]",
    );
    return;
  }
  const result = loadFrameRegistry(flags.registry ?? DEFAULT_REGISTRY);
  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(renderMarkdown(result));
  }
  if (result.issues.length > 0) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
