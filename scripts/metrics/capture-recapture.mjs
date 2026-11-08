#!/usr/bin/env node
// capture-recapture — two-frame pilot scaffold (deterministic matching + Chapman).
//
//   node scripts/metrics/capture-recapture.mjs --a frameA.csv --b frameB.csv
//   node scripts/metrics/capture-recapture.mjs --a a.csv --b b.csv --json
//   node scripts/metrics/capture-recapture.mjs --a a.csv --b b.csv --keys domain,name_country
//
// Input: two CSVs of entity lists ("frames"). Recognised columns (header row
// required, any subset): name, country, domain, registry_id. Matching is the
// deterministic first stage of the Splink pipeline described in ch01 §3.4.3:
// hard keys (domain / registry id) first, normalised name+country as the soft
// fallback. Probabilistic scoring (Fellegi–Sunter/EM) and the >=3-frame
// log-linear / bootstrap work belong to ch01 PR-13 and are intentionally not
// here.
//
// Estimator: Chapman (small-sample Lincoln-Petersen). Two-frame estimates are
// a sanity check only — ch01 §3.4.4 forbids drawing conclusions from them:
// m11 < 5 => no N̂ at all; m11 < 25 => CV > 20%, report magnitude only.
//
// Pure Node built-ins; no network, no database, no dependencies.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { parseArgs } from "./lib/psql.mjs";

const USAGE = `usage: node scripts/metrics/capture-recapture.mjs --a <frame-a.csv> --b <frame-b.csv> [--keys domain,registry_id,name_country] [--json] [--sample N]`;

const LEGAL_SUFFIXES = new Set([
  "gmbh",
  "mbh",
  "ag",
  "kg",
  "kgaa",
  "ohg",
  "ug",
  "gbr",
  "ek",
  "ev",
  "ltd",
  "limited",
  "llc",
  "inc",
  "incorporated",
  "corp",
  "corporation",
  "plc",
  "sarl",
  "sas",
  "sa",
  "bv",
  "nv",
  "ab",
  "as",
  "aps",
  "oy",
  "oyj",
  "srl",
  "spa",
  "pty",
  "pte",
  "co",
]);

/** Minimal RFC-4180-ish CSV parser: quotes, escaped quotes, CRLF, BOM. */
export function parseCsv(text) {
  const source = text.replace(/^﻿/, "");
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (inQuotes) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && source[index + 1] === "\n") index += 1;
      row.push(field);
      field = "";
      if (row.some((value) => value.trim() !== "")) rows.push(row);
      row = [];
    } else {
      field += char;
    }
  }
  row.push(field);
  if (row.some((value) => value.trim() !== "")) rows.push(row);
  if (rows.length === 0) return { headers: [], records: [] };
  const headers = rows[0].map((header) => header.trim().toLowerCase());
  const records = rows.slice(1).map((cells) =>
    Object.fromEntries(headers.map((header, index) => [header, (cells[index] ?? "").trim()])),
  );
  return { headers, records };
}

/** Domain hard key: lowercase host, no scheme/www/port/path/trailing dot. */
export function normalizeDomain(value) {
  if (!value) return "";
  let domain = String(value).trim().toLowerCase();
  domain = domain.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  domain = domain.split("/")[0];
  domain = domain.replace(/^[^@]*@/, "");
  domain = domain.replace(/:\d+$/, "");
  domain = domain.replace(/\.+$/, "");
  domain = domain.replace(/^www\./, "");
  return domain;
}

/** Company-name soft key: fold German umlauts, strip diacritics/punctuation/legal forms. */
export function normalizeName(value) {
  if (!value) return "";
  let name = String(value).toLowerCase().trim();
  name = name
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss");
  name = name.normalize("NFKD").replace(/\p{M}+/gu, "");
  name = name.replace(/&/g, " and ");
  name = name.replace(/[^a-z0-9]+/g, " ").trim();
  let tokens = name.split(" ").filter(Boolean);
  // Strip trailing legal-form tokens and dangling conjunctions
  // ("... GmbH & Co. KG" reduces fully).
  const isTrimmable = (token) => LEGAL_SUFFIXES.has(token) || token === "and" || token === "und";
  while (tokens.length > 1 && isTrimmable(tokens[tokens.length - 1])) {
    tokens = tokens.slice(0, -1);
  }
  while (tokens.length > 1 && isTrimmable(tokens[0])) {
    tokens = tokens.slice(1);
  }
  return tokens.join(" ");
}

/** Country hard-ish key: uppercase ISO-2; common aliases folded. */
export function normalizeCountry(value) {
  if (!value) return "";
  const text = String(value).trim();
  if (["德国", "deutschland", "germany"].includes(text.toLowerCase())) return "DE";
  return /^[a-z]{2}$/i.test(text) ? text.toUpperCase() : text.toUpperCase();
}

export const KEY_BUILDERS = Object.freeze({
  domain: (record) => {
    const domain = normalizeDomain(record.domain);
    return domain ? `domain:${domain}` : null;
  },
  registry_id: (record) => {
    const id = String(record.registry_id ?? "").trim().toLowerCase();
    return id ? `registry:${id}` : null;
  },
  name_country: (record) => {
    const name = normalizeName(record.name);
    const country = normalizeCountry(record.country);
    return name && country ? `name:${name}|${country}` : null;
  },
});

export const DEFAULT_KEYS = Object.freeze(["domain", "registry_id", "name_country"]);

export function entityKeys(record, keys = DEFAULT_KEYS) {
  const built = [];
  for (const key of keys) {
    const builder = KEY_BUILDERS[key];
    if (!builder) throw new Error(`unknown key: ${key}`);
    const value = builder(record);
    if (value) built.push(value);
  }
  return built;
}

/**
 * Deduplicate a frame by its first available key (priority order given by
 * `keys`), keeping the first record per key. Entities with no usable key are
 * dropped but counted (they cannot participate in matching).
 */
export function dedupeFrame(records, keys = DEFAULT_KEYS) {
  const seen = new Map();
  let keyless = 0;
  let duplicates = 0;
  for (const record of records) {
    const primary = entityKeys(record, keys)[0];
    if (!primary) {
      keyless += 1;
      continue;
    }
    if (seen.has(primary)) {
      duplicates += 1;
      continue;
    }
    seen.set(primary, record);
  }
  return { entities: [...seen.entries()].map(([primary, record]) => ({ primary, record })), keyless, duplicates };
}

/**
 * Deterministic two-frame match: an A entity is "recaptured" when any of its
 * keys appears in frame B. Many-to-one matches are counted once and flagged.
 */
export function matchFrames(recordsA, recordsB, { keys = DEFAULT_KEYS } = {}) {
  const frameA = dedupeFrame(recordsA, keys);
  const frameB = dedupeFrame(recordsB, keys);
  const indexB = new Map();
  for (const entity of frameB.entities) {
    for (const key of entityKeys(entity.record, keys)) {
      const bucket = indexB.get(key) ?? [];
      bucket.push(entity.primary);
      indexB.set(key, bucket);
    }
  }
  const matchedB = new Set();
  const inspected = [];
  let m11 = 0;
  let ambiguous = 0;
  let duplicateMatches = 0;
  for (const entity of frameA.entities) {
    const hits = new Set();
    for (const key of entityKeys(entity.record, keys)) {
      for (const primaryB of indexB.get(key) ?? []) hits.add(primaryB);
    }
    // Greedy one-to-one: a B entity already consumed by an earlier A entity
    // cannot be counted twice, otherwise m11 could exceed n2 and break the
    // estimator.
    const open = [...hits].filter((primaryB) => !matchedB.has(primaryB)).sort();
    if (open.length === 0) {
      if (hits.size > 0) duplicateMatches += 1;
      continue;
    }
    m11 += 1;
    if (open.length > 1) ambiguous += 1;
    const chosen = open[0];
    matchedB.add(chosen);
    if (inspected.length < 200) {
      inspected.push({ keyA: entity.primary, keyB: open.length > 1 ? open.join(" | ") : chosen });
    }
  }
  const n1 = frameA.entities.length;
  const n2 = frameB.entities.length;
  return {
    n1,
    n2,
    m11,
    observedUnion: n1 + n2 - m11,
    ambiguousMatches: ambiguous,
    duplicateMatches,
    matchedPairsSample: inspected,
    frameA: { rows: recordsA.length, entities: n1, duplicates: frameA.duplicates, keyless: frameA.keyless },
    frameB: { rows: recordsB.length, entities: n2, duplicates: frameB.duplicates, keyless: frameB.keyless },
  };
}

export function lincolnPetersen(n1, n2, m11) {
  if (m11 <= 0) return null;
  return (n1 * n2) / m11;
}

/**
 * Chapman estimator with its standard variance.
 * N̂ = (n1+1)(n2+1)/(m11+1) − 1
 * Var = (n1+1)(n2+1)(n1−m11)(n2−m11) / ((m11+1)^2 (m11+2))
 */
export function chapman(n1, n2, m11) {
  if (!(n1 > 0 && n2 > 0)) return null;
  if (m11 <= 0) return null;
  if (m11 > Math.min(n1, n2)) {
    throw new Error(`m11 (${m11}) cannot exceed min(n1,n2) (${Math.min(n1, n2)})`);
  }
  const nHat = ((n1 + 1) * (n2 + 1)) / (m11 + 1) - 1;
  const variance =
    ((n1 + 1) * (n2 + 1) * (n1 - m11) * (n2 - m11)) / ((m11 + 1) * (m11 + 1) * (m11 + 2));
  const se = Math.sqrt(variance);
  const observedUnion = n1 + n2 - m11;
  const low = Math.max(observedUnion, nHat - 1.96 * se);
  return {
    nHat,
    variance,
    se,
    ci95: [low, nHat + 1.96 * se],
    cvApprox: 1 / Math.sqrt(m11),
    cvFormula: nHat > 0 ? se / nHat : null,
  };
}

/** Gate verdicts per ch01 §3.4.4/§3.4.5. */
export function diagnostics({ n1, n2, m11 }) {
  const gates = [];
  if (n1 === 0 || n2 === 0) {
    gates.push({ code: "EMPTY_FRAME", ok: false, detail: "one or both frames have no usable entities" });
  }
  if (m11 < 5) {
    gates.push({
      code: "M11_TOO_SMALL",
      ok: false,
      detail: `m11=${m11} < 5 — do not report N̂ (ch01 §3.4.4)`,
    });
  } else if (m11 < 25) {
    gates.push({
      code: "M11_LOW_RECAPTURE",
      ok: false,
      detail: `m11=${m11} < 25 — CV ≈ ${(100 / Math.sqrt(m11)).toFixed(0)}% (>20%); report magnitude only`,
    });
  } else {
    gates.push({ code: "M11_OK", ok: true, detail: `m11=${m11} supports a point estimate` });
  }
  const minFrame = Math.min(n1, n2);
  if (minFrame > 0 && m11 / minFrame < 0.05) {
    gates.push({
      code: "RECAPTURE_RATE_LOW",
      ok: false,
      detail: `recapture rate ${(100 * m11 / minFrame).toFixed(1)}% < 5% (ch01 §3.4.5)`,
    });
  }
  return gates;
}

/** Full two-frame estimate from parsed records. */
export function estimateTwoFrames(recordsA, recordsB, options = {}) {
  const keys = options.keys ?? DEFAULT_KEYS;
  const match = matchFrames(recordsA, recordsB, { keys });
  const estimate = chapman(match.n1, match.n2, match.m11);
  const gates = diagnostics(match);
  // ch01 §3.4.4: m11 < 5 (or an empty frame) means no N̂ at all; 5–24 may
  // report a magnitude but never a conclusion.
  const blocked = gates.some(
    (gate) => !gate.ok && (gate.code === "EMPTY_FRAME" || gate.code === "M11_TOO_SMALL"),
  );
  const reportable = !blocked && estimate !== null;
  const warnings = gates.filter((gate) => !gate.ok && gate.code !== "EMPTY_FRAME" && gate.code !== "M11_TOO_SMALL");
  return {
    method: "chapman",
    keys,
    counts: {
      n1: match.n1,
      n2: match.n2,
      m11: match.m11,
      observedUnion: match.observedUnion,
      ambiguousMatches: match.ambiguousMatches,
      duplicateMatches: match.duplicateMatches,
    },
    frames: { a: match.frameA, b: match.frameB },
    estimate: reportable ? estimate : null,
    coverage: reportable ? match.observedUnion / estimate.nHat : null,
    diagnostics: gates,
    reportable,
    warnings,
    matchedPairsSample: match.matchedPairsSample.slice(0, options.sample ?? 10),
  };
}

/** Read one CSV frame from disk. */
export function readFrame(path) {
  const { headers, records } = parseCsv(readFileSync(path, "utf8"));
  const recognized = headers.filter((header) => ["name", "country", "domain", "registry_id"].includes(header));
  if (recognized.length === 0) {
    throw new Error(
      `${path}: no recognised columns; need at least one of name, country, domain, registry_id (got: ${headers.join(", ") || "empty"})`,
    );
  }
  return { path, headers, records };
}

function formatNumber(value, digits = 1) {
  return value === null || value === undefined ? "—" : value.toFixed(digits);
}

function renderMarkdown(result, framePaths) {
  const out = [];
  out.push("# capture-recapture 两源试点（Chapman）");
  out.push("");
  out.push(`> frame A：\`${framePaths.a}\`；frame B：\`${framePaths.b}\``);
  out.push(`> 匹配键：${result.keys.join(" → ")}（确定性硬键 + 归一 name+country 兜底）`);
  out.push("");
  out.push("## 1. 捕获计数");
  out.push("");
  out.push("| 量 | 值 |");
  out.push("| --- | --- |");
  out.push(`| frame A 行数 / 去重后实体 n1 | ${result.frames.a.rows} / ${result.counts.n1} |`);
  out.push(`| frame B 行数 / 去重后实体 n2 | ${result.frames.b.rows} / ${result.counts.n2} |`);
  out.push(`| 两源都捕获 m11 | ${result.counts.m11} |`);
  out.push(`| 观测并集（至少被一个 frame 捕获） | ${result.counts.observedUnion} |`);
  out.push(`| A 内重复（按主键去重） | ${result.frames.a.duplicates}；B 内重复 ${result.frames.b.duplicates} |`);
  out.push(`| 无可用键被丢弃 | A ${result.frames.a.keyless} 行；B ${result.frames.b.keyless} 行 |`);
  out.push(`| 一对多歧义匹配 | ${result.counts.ambiguousMatches} |`);
  out.push(`| 重复匹配（B 实体已被先前的 A 占用） | ${result.counts.duplicateMatches} |`);
  out.push("");
  out.push("## 2. 估计量");
  out.push("");
  if (result.estimate) {
    out.push("```text");
    out.push("Chapman: N̂ = (n1+1)(n2+1)/(m11+1) − 1");
    out.push(
      `N̂ = ${formatNumber(result.estimate.nHat)}；SE = ${formatNumber(result.estimate.se)}；95% CI [${formatNumber(result.estimate.ci95[0])}, ${formatNumber(result.estimate.ci95[1])}]`,
    );
    out.push(
      `CV ≈ 1/√m11 = ${formatNumber(result.estimate.cvApprox * 100)}%；CV(公式) = ${formatNumber(result.estimate.cvFormula * 100)}%；覆盖率（观测并集/N̂）= ${formatNumber(result.coverage * 100)}%`,
    );
    out.push("```");
  } else {
    out.push("m11 不足（或空 frame），按 ch01 §3.4.4 不出 N̂。");
  }
  out.push("");
  out.push("## 3. 诊断门");
  out.push("");
  out.push("| 门 | 结果 | 说明 |");
  out.push("| --- | --- | --- |");
  for (const gate of result.diagnostics) {
    out.push(`| ${gate.code} | ${gate.ok ? "PASS" : "WARN/BLOCK"} | ${gate.detail} |`);
  }
  out.push("");
  out.push(
    `结论：${
      result.reportable
        ? result.warnings.length > 0
          ? "可出量级估计（有警告门未过，仅报区间/量级，不得出结论）"
          : "可出点估计（两源仍仅作 sanity check，不得单独出结论）"
        : "不出 N̂（m11 不足或空 frame）"
    }`,
  );
  out.push("");
  out.push("## 4. 匹配样例（前若干对）");
  out.push("");
  if (result.matchedPairsSample.length === 0) {
    out.push("（无匹配对）");
  } else {
    out.push("| A 主键 | B 主键 |");
    out.push("| --- | --- |");
    for (const pair of result.matchedPairsSample) {
      out.push(`| ${pair.keyA} | ${pair.keyB} |`);
    }
  }
  out.push("");
  out.push("## 5. 假设与限制");
  out.push("");
  out.push("1. 两源 Chapman 假设两 frame 捕获独立；业务名单常有共享上游，独立性不可检验（ch01 §3.4.1/§3.4.5），两源结果只作 sanity check。");
  out.push("2. 匹配质量未做人工复核；ch01 要求抽样 100 对人工复核、match precision ≥95% 才可进入正式估计。");
  out.push("3. 三源及以上应使用 log-linear / LCMCR + bootstrap（ch01 PR-13），本脚手架不覆盖。");
  out.push("4. name+country 兜底匹配只做保守归一（德语变音、法律形式、标点）；同名不同实体可能误配，歧义对数已单列。");
  return out.join("\n");
}

function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help || !flags.a || !flags.b) {
    console.error(USAGE);
    process.exit(flags.help ? 0 : 2);
  }
  const keys = flags.keys ? String(flags.keys).split(",").map((key) => key.trim()) : [...DEFAULT_KEYS];
  for (const key of keys) {
    if (!KEY_BUILDERS[key]) throw new Error(`unknown key: ${key} (allowed: ${Object.keys(KEY_BUILDERS).join(", ")})`);
  }
  const frameA = readFrame(flags.a);
  const frameB = readFrame(flags.b);
  const result = estimateTwoFrames(frameA.records, frameB.records, {
    keys,
    sample: flags.sample !== undefined ? Number(flags.sample) : 10,
  });
  if (flags.json) {
    console.log(
      JSON.stringify(
        { ...result, framesInput: { a: frameA.path, b: frameB.path } },
        null,
        2,
      ),
    );
  } else {
    console.log(renderMarkdown(result, { a: frameA.path, b: frameB.path }));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
