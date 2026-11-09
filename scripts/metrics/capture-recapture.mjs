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

import { createRng, poisson, quantile } from "./lib/prng.mjs";
import { parseArgs } from "./lib/psql.mjs";

const USAGE = `usage:
  node scripts/metrics/capture-recapture.mjs --a <frame-a.csv> --b <frame-b.csv> [--keys domain,registry_id,name_country] [--json] [--sample N]
  node scripts/metrics/capture-recapture.mjs --frame F1=<a.csv> --frame F2=<b.csv> --frame F3=<c.csv> [--bootstrap N] [--seed <s>] [--probabilistic] [--json]

Two frames use the Chapman estimator (sanity check only). Three or more frames
use a log-linear model fit (independence / pairwise interactions, G²+AIC model
selection, parametric bootstrap CI) per ch01 §3.4.4.`;

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

// ── Probabilistic second stage (Splink-style simplified) ───────────────────

/** Jaro similarity over two strings (used for name/city comparison). */
export function jaro(left, right) {
  const a = String(left);
  const b = String(right);
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  const matchDistance = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aMatched = new Array(a.length).fill(false);
  const bMatched = new Array(b.length).fill(false);
  let matches = 0;
  for (let i = 0; i < a.length; i += 1) {
    const start = Math.max(0, i - matchDistance);
    const end = Math.min(i + matchDistance + 1, b.length);
    for (let j = start; j < end; j += 1) {
      if (!bMatched[j] && a[i] === b[j]) {
        aMatched[i] = true;
        bMatched[j] = true;
        matches += 1;
        break;
      }
    }
  }
  if (matches === 0) return 0;
  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < a.length; i += 1) {
    if (!aMatched[i]) continue;
    while (!bMatched[k]) k += 1;
    if (a[i] !== b[k]) transpositions += 1;
    k += 1;
  }
  return (matches / a.length + matches / b.length + (matches - transpositions / 2) / matches) / 3;
}

/** Jaro–Winkler similarity (prefix boost, p = 0.1, max prefix 4). */
export function jaroWinkler(left, right) {
  const base = jaro(left, right);
  if (base < 0.7) return base;
  let prefix = 0;
  const limit = Math.min(4, String(left).length, String(right).length);
  while (prefix < limit && String(left)[prefix] === String(right)[prefix]) prefix += 1;
  return base + prefix * 0.1 * (1 - base);
}

/**
 * Fixed-weight pair scoring (Fellegi–Sunter shape, weights calibrated by the
 * tests rather than EM). Returns {score, reasons, band} where band is
 * auto (>= 8), review (4..8) or reject (< 4). Positive weights favour a match.
 */
export function scorePair(left, right, { auto = 8, review = 4 } = {}) {
  let score = 0;
  const reasons = [];
  const push = (weight, reason) => {
    score += weight;
    reasons.push(`${weight >= 0 ? "+" : ""}${weight} ${reason}`);
  };
  const leftDomain = normalizeDomain(left.domain);
  const rightDomain = normalizeDomain(right.domain);
  if (leftDomain && rightDomain) {
    if (leftDomain === rightDomain) push(6, "domain exact");
    else push(-6, "domain conflict");
  }
  const leftRegistry = String(left.registry_id ?? "").trim().toLowerCase();
  const rightRegistry = String(right.registry_id ?? "").trim().toLowerCase();
  if (leftRegistry && rightRegistry) {
    if (leftRegistry === rightRegistry) push(6, "registry exact");
    else push(-6, "registry conflict");
  }
  const leftCountry = normalizeCountry(left.country);
  const rightCountry = normalizeCountry(right.country);
  if (leftCountry && rightCountry) {
    if (leftCountry === rightCountry) push(1, "country exact");
    else push(-4, "country conflict");
  }
  const leftName = normalizeName(left.name);
  const rightName = normalizeName(right.name);
  if (leftName && rightName) {
    const similarity = jaroWinkler(leftName, rightName);
    if (similarity >= 0.92) push(5, `name JW ${similarity.toFixed(2)}`);
    else if (similarity >= 0.85) push(2, `name JW ${similarity.toFixed(2)}`);
    else if (similarity >= 0.75) push(0, `name JW ${similarity.toFixed(2)} (borderline)`);
    else push(-3, `name JW ${similarity.toFixed(2)}`);
  }
  const leftCity = normalizeName(left.city);
  const rightCity = normalizeName(right.city);
  if (leftCity && rightCity) {
    if (leftCity === rightCity) push(1, "city exact");
    else if (jaroWinkler(leftCity, rightCity) < 0.85) push(-1, "city differs");
  }
  const leftPostcode = String(left.postcode ?? "").replace(/\s+/g, "").toLowerCase();
  const rightPostcode = String(right.postcode ?? "").replace(/\s+/g, "").toLowerCase();
  if (leftPostcode && rightPostcode) {
    if (leftPostcode === rightPostcode) push(1, "postcode exact");
    else if (leftPostcode.slice(0, 2) !== rightPostcode.slice(0, 2)) push(-1, "postcode differs");
  }
  const band = score >= auto ? "auto" : score >= review ? "review" : "reject";
  return { score, reasons, band };
}

/**
 * Blocking candidates for the probabilistic stage: same first normalised name
 * token + country, or same postcode prefix + country. Blocking keeps the pair
 * space linear for our stratum sizes (ch01 §3.4.3).
 */
export function blockingKeys(record) {
  const blocks = [];
  const country = normalizeCountry(record.country);
  const name = normalizeName(record.name);
  if (name && country) blocks.push(`name:${name.split(" ")[0]}|${country}`);
  const postcode = String(record.postcode ?? "").replace(/\s+/g, "").toLowerCase();
  if (postcode.length >= 2 && country) blocks.push(`postcode:${postcode.slice(0, 2)}|${country}`);
  return blocks;
}

/**
 * Score every blocked pair across two frames and split them into auto links
 * (usable for estimation) and review pairs (human adjudication queue).
 */
export function probabilisticMatch(frameA, frameB, { maxPairs = 200000, thresholds = {}, keys = DEFAULT_KEYS } = {}) {
  const index = new Map();
  frameB.records.forEach((record, indexB) => {
    for (const block of blockingKeys(record)) {
      const bucket = index.get(block) ?? [];
      bucket.push(indexB);
      index.set(block, bucket);
    }
  });
  const keySetsB = frameB.records.map((record) => new Set(entityKeys(record, keys)));
  const auto = [];
  const review = [];
  let candidates = 0;
  frameA.records.forEach((recordA, indexA) => {
    const keysA = entityKeys(recordA, keys);
    const seen = new Set();
    for (const block of blockingKeys(recordA)) {
      for (const indexB of index.get(block) ?? []) {
        if (seen.has(indexB)) continue;
        seen.add(indexB);
        // Already merged by the deterministic stage — nothing new to link.
        if (keysA.some((key) => keySetsB[indexB].has(key))) continue;
        candidates += 1;
        if (candidates > maxPairs) {
          throw new Error(`probabilisticMatch exceeded ${maxPairs} candidate pairs; tighten blocking`);
        }
        const result = scorePair(recordA, frameB.records[indexB], thresholds);
        const pair = {
          frameA: frameA.label ?? "A",
          indexA,
          frameB: frameB.label ?? "B",
          indexB,
          score: result.score,
          reasons: result.reasons,
        };
        if (result.band === "auto") auto.push(pair);
        else if (result.band === "review") review.push(pair);
      }
    }
  });
  return { auto, review, candidates };
}

/** Chao (1987) lower bound from capture-pattern frequencies. */
export function chaoLowerBound(patterns) {
  let observed = 0;
  let f1 = 0;
  let f2 = 0;
  for (const [pattern, count] of patterns) {
    observed += count;
    const popcount = pattern.toString(2).replace(/0/g, "").length;
    if (popcount === 1) f1 += count;
    if (popcount === 2) f2 += count;
  }
  if (f2 === 0) return null;
  return { observed, f1, f2, nHat: observed + (f1 * f1) / (2 * f2) };
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

// ── Multi-frame capture-recapture (k ≥ 3): log-linear models ────────────────

/**
 * Build the capture matrix across k frames. Entities are keyed by the same
 * deterministic keys as the two-frame matcher; union-find merges records that
 * share any key. Returns the number of clusters per capture pattern (a k-bit
 * integer, bit i set = captured by frame i).
 */
export function buildCaptureMatrix(frames, { keys = DEFAULT_KEYS, extraLinks = [] } = {}) {
  const parent = new Map();
  const find = (key) => {
    let root = key;
    while (parent.get(root) !== root) root = parent.get(root);
    while (parent.get(key) !== root) {
      const next = parent.get(key);
      parent.set(key, root);
      key = next;
    }
    return root;
  };
  const union = (left, right) => {
    const a = find(left);
    const b = find(right);
    if (a !== b) parent.set(a, b);
  };
  const keyless = frames.map(() => 0);
  const duplicates = frames.map(() => 0);
  const processed = [];
  const primaryByRecord = frames.map(() => new Map());
  frames.forEach((frame, frameIndex) => {
    const seenPrimary = new Set();
    frame.records.forEach((record, recordIndex) => {
      const recordKeys = entityKeys(record, keys);
      if (recordKeys.length === 0) {
        keyless[frameIndex] += 1;
        return;
      }
      primaryByRecord[frameIndex].set(recordIndex, recordKeys[0]);
      if (seenPrimary.has(recordKeys[0])) {
        duplicates[frameIndex] += 1;
        return;
      }
      seenPrimary.add(recordKeys[0]);
      for (const key of recordKeys) {
        if (!parent.has(key)) parent.set(key, key);
      }
      for (let index = 1; index < recordKeys.length; index += 1) {
        union(recordKeys[0], recordKeys[index]);
      }
      processed.push({ frameIndex, primary: recordKeys[0] });
    });
  });
  // Probabilistic auto-matches arrive as record-index pairs; translate them to
  // primary keys and union the clusters.
  for (const link of extraLinks) {
    const left = primaryByRecord[link.frameA]?.get(link.indexA);
    const right = primaryByRecord[link.frameB]?.get(link.indexB);
    if (left && right) union(left, right);
  }
  const clusterPattern = new Map();
  for (const { frameIndex, primary } of processed) {
    const root = find(primary);
    clusterPattern.set(root, (clusterPattern.get(root) ?? 0) | (1 << frameIndex));
  }
  const patterns = new Map();
  for (const pattern of clusterPattern.values()) {
    patterns.set(pattern, (patterns.get(pattern) ?? 0) + 1);
  }
  const k = frames.length;
  const nPerFrame = Array.from({ length: k }, (_, frameIndex) =>
    [...patterns.entries()].reduce(
      (sum, [pattern, count]) => sum + ((pattern >> frameIndex) & 1 ? count : 0),
      0,
    ),
  );
  const observed = [...patterns.values()].reduce((sum, count) => sum + count, 0);
  return {
    k,
    labels: frames.map((frame) => frame.label),
    patterns,
    nPerFrame,
    observed,
    keyless,
    duplicates,
  };
}

/** Pairwise recapture counts from the pattern table. */
export function pairRecaptures(patterns, k) {
  const pairs = [];
  for (let left = 0; left < k; left += 1) {
    for (let right = left + 1; right < k; right += 1) {
      let count = 0;
      for (const [pattern, value] of patterns) {
        if ((pattern >> left) & 1 && (pattern >> right) & 1) count += value;
      }
      pairs.push({ left, right, count });
    }
  }
  return pairs;
}

/**
 * Fit a hierarchical log-linear model to the observed (incomplete) table by
 * iterative proportional fitting. `terms` are factor subsets (arrays of frame
 * indices), e.g. independence = [[0],[1],[2]], one pairwise interaction =
 * [[0],[1],[2],[0,1]]. Marginals are taken over observed cells only, so the
 * structural all-zero cell is estimated from the fitted model (Fienberg /
 * Rcapture convention).
 */
export function fitLogLinear(patterns, k, terms) {
  const cells = 1 << k;
  const observed = new Float64Array(cells);
  for (const [pattern, count] of patterns) observed[pattern] = count;
  const masks = terms.map((term) => term.reduce((mask, factor) => mask | (1 << factor), 0));
  const fitted = new Float64Array(cells).fill(1);
  const observedTotal = [...patterns.values()].reduce((sum, count) => sum + count, 0);
  for (let iteration = 0; iteration < 1000; iteration += 1) {
    let maxChange = 0;
    terms.forEach((_, termIndex) => {
      const mask = masks[termIndex];
      const target = new Map();
      for (let pattern = 1; pattern < cells; pattern += 1) {
        if (observed[pattern] === 0) continue;
        const key = pattern & mask;
        target.set(key, (target.get(key) ?? 0) + observed[pattern]);
      }
      // Margins are taken over the observable cells only: the structural all-zero
      // cell contributes no likelihood term, so it must not enter the score
      // equations. Its fitted value still accumulates the same multiplicative
      // factors (below), which is what makes it the model-implied N̂₀.
      const current = new Map();
      for (let pattern = 1; pattern < cells; pattern += 1) {
        const key = pattern & mask;
        current.set(key, (current.get(key) ?? 0) + fitted[pattern]);
      }
      for (let pattern = 0; pattern < cells; pattern += 1) {
        const key = pattern & mask;
        const currentTotal = current.get(key) ?? 0;
        const targetTotal = target.get(key) ?? 0;
        if (currentTotal > 0 && targetTotal > 0) {
          const ratio = targetTotal / currentTotal;
          fitted[pattern] *= ratio;
          if (pattern > 0) maxChange = Math.max(maxChange, Math.abs(Math.log(ratio)));
        }
      }
    });
    if (maxChange < 1e-10) break;
  }
  let g2 = 0;
  for (let pattern = 1; pattern < cells; pattern += 1) {
    const count = observed[pattern];
    if (count > 0 && fitted[pattern] > 0) g2 += 2 * count * Math.log(count / fitted[pattern]);
  }
  // Floating-point noise can make a perfect fit read as −1e-16.
  g2 = Math.max(0, g2);
  const parameters = 1 + terms.length;
  const df = cells - 1 - parameters;
  return {
    terms,
    fitted,
    fittedZero: fitted[0],
    g2,
    df,
    parameters,
    aic: g2 + 2 * parameters,
    bic: g2 + parameters * Math.log(Math.max(observedTotal, 2)),
  };
}

/** Candidate models for k = 3 per ch01 §3.4.4 (8 models incl. saturated). */
export function candidateModels(k) {
  if (k !== 3) throw new Error(`log-linear candidate models are implemented for k=3, got k=${k}`);
  const singles = [[0], [1], [2]];
  const pairs = [
    [0, 1],
    [0, 2],
    [1, 2],
  ];
  const models = [{ name: "independence", terms: singles }];
  for (const pair of pairs) {
    models.push({ name: `[${pair.join("")}]`, terms: [...singles, pair] });
  }
  for (let first = 0; first < pairs.length; first += 1) {
    for (let second = first + 1; second < pairs.length; second += 1) {
      models.push({
        name: `[${pairs[first].join("")}][${pairs[second].join("")}]`,
        terms: [...singles, pairs[first], pairs[second]],
      });
    }
  }
  models.push({ name: "saturated", terms: [...singles, ...pairs] });
  return models;
}

/**
 * Multi-frame estimate: capture matrix → log-linear model selection → N̂ with
 * parametric bootstrap CI. Only models with df > 0 are estimable; the
 * saturated model is reported but excluded (structural zero makes it
 * unidentified).
 */
export function estimateMultiFrame(frames, options = {}) {
  const keys = options.keys ?? DEFAULT_KEYS;
  const bootstrapReps = options.bootstrap ?? 1000;
  const seed = options.seed ?? "20261108";
  let probabilistic = options.probabilisticResult ?? null;
  let extraLinks = options.extraLinks ?? null;
  if (extraLinks === null) {
    extraLinks = [];
    if (options.probabilistic) {
      const auto = [];
      const review = [];
      let candidates = 0;
      for (let left = 0; left < frames.length; left += 1) {
        for (let right = left + 1; right < frames.length; right += 1) {
          const result = probabilisticMatch(frames[left], frames[right], {
            thresholds: options.probabilisticThresholds ?? {},
            keys,
          });
          candidates += result.candidates;
          for (const pair of result.auto) {
            auto.push({ frameA: left, indexA: pair.indexA, frameB: right, indexB: pair.indexB });
          }
          for (const pair of result.review) {
            review.push({ ...pair, frameA: left, frameB: right });
          }
        }
      }
      extraLinks = auto;
      probabilistic = {
        candidates,
        auto: auto.length,
        review: review.length,
        reviewSample: review.slice(0, 10),
      };
    }
  }
  const matrix = buildCaptureMatrix(frames, { keys, extraLinks });
  if (matrix.k < 3) throw new Error("estimateMultiFrame requires at least 3 frames");
  const pairs = pairRecaptures(matrix.patterns, matrix.k);
  const models = candidateModels(matrix.k).map((model) => {
    const fit = fitLogLinear(matrix.patterns, matrix.k, model.terms);
    return {
      name: model.name,
      g2: fit.g2,
      df: fit.df,
      parameters: fit.parameters,
      aic: fit.aic,
      bic: fit.bic,
      nHat: matrix.observed + fit.fittedZero,
      estimable: fit.df > 0,
      fittedZero: fit.fittedZero,
      fitted: fit.fitted,
      terms: model.terms,
    };
  });
  const estimable = models.filter((model) => model.estimable).sort((l, r) => l.aic - r.aic || l.bic - r.bic);
  const chosen = estimable[0] ?? null;
  const gates = [];
  const minPair = Math.min(...pairs.map((pair) => pair.count));
  if (matrix.observed < 10) {
    gates.push({ code: "OBSERVED_TOO_SMALL", ok: false, detail: `observed entities ${matrix.observed} < 10` });
  }
  if (minPair < 5) {
    gates.push({
      code: "PAIR_TOO_SMALL",
      ok: false,
      detail: `min pairwise recapture ${minPair} < 5 — do not report N̂ (ch01 §3.4.4)`,
    });
  } else if (minPair < 25) {
    gates.push({
      code: "PAIR_LOW_RECAPTURE",
      ok: false,
      detail: `min pairwise recapture ${minPair} < 25 — CV is large; report magnitude only`,
    });
  } else {
    gates.push({ code: "PAIRS_OK", ok: true, detail: `min pairwise recapture ${minPair} ≥ 25` });
  }
  const estimableCandidates = models.filter((model) => model.estimable);
  const spread =
    estimableCandidates.length > 0
      ? (Math.max(...estimableCandidates.map((model) => model.nHat)) -
          Math.min(...estimableCandidates.map((model) => model.nHat))) /
        (chosen ? chosen.nHat : 1)
      : null;
  if (spread !== null && spread > 0.3) {
    gates.push({
      code: "MODEL_SPREAD_HIGH",
      ok: false,
      detail: `N̂ varies ${(spread * 100).toFixed(1)}% across models (>30%) — report the range only`,
    });
  }
  const blocked = gates.some((gate) => !gate.ok && ["OBSERVED_TOO_SMALL", "PAIR_TOO_SMALL"].includes(gate.code));
  const reportable = !blocked && chosen !== null;

  let bootstrap = null;
  if (reportable && bootstrapReps > 0) {
    const rng = createRng(seed, "multi-frame-bootstrap");
    const cells = 1 << matrix.k;
    const estimates = [];
    for (let rep = 0; rep < bootstrapReps; rep += 1) {
      const drawn = new Map();
      let total = 0;
      for (let pattern = 1; pattern < cells; pattern += 1) {
        const value = poisson(chosen.fitted[pattern], rng);
        if (value > 0) {
          drawn.set(pattern, value);
          total += value;
        }
      }
      if (total === 0) continue;
      const fit = fitLogLinear(drawn, matrix.k, chosen.terms);
      estimates.push(total + fit.fittedZero);
    }
    estimates.sort((left, right) => left - right);
    const mean = estimates.reduce((sum, value) => sum + value, 0) / estimates.length;
    const variance = estimates.reduce((sum, value) => sum + (value - mean) ** 2, 0) / estimates.length;
    bootstrap = {
      reps: estimates.length,
      mean,
      sd: Math.sqrt(variance),
      ci95: [quantile(estimates, 0.025), quantile(estimates, 0.975)],
    };
  }
  // Leave-one-frame-out sensitivity (ch01 §3.4.7): refit without each frame
  // and report how N̂ moves. Subsets reuse the same probabilistic links.
  let sensitivity = null;
  if (options.sensitivity !== false && matrix.k >= 3) {
    sensitivity = [];
    for (let drop = 0; drop < matrix.k; drop += 1) {
      const subFrames = frames
        .filter((_, index) => index !== drop)
        .map((frame) => ({ label: frame.label, records: frame.records }));
      const remap = (index) => (index < drop ? index : index - 1);
      const subLinks = extraLinks
        .filter((link) => link.frameA !== drop && link.frameB !== drop)
        .map((link) => ({
          frameA: remap(link.frameA),
          indexA: link.indexA,
          frameB: remap(link.frameB),
          indexB: link.indexB,
        }));
      let subset;
      if (subFrames.length === 2) {
        // Dropping one of three frames leaves a Chapman pair.
        const subMatrix = buildCaptureMatrix(subFrames, { keys, extraLinks: subLinks });
        const m11 = [...subMatrix.patterns.entries()]
          .filter(([pattern]) => (pattern & 0b11) === 0b11)
          .reduce((sum, [, count]) => sum + count, 0);
        const estimate = chapman(subMatrix.nPerFrame[0], subMatrix.nPerFrame[1], m11);
        subset = {
          nHat: m11 >= 5 && estimate ? estimate.nHat : null,
          reportable: m11 >= 5 && estimate !== null,
          chosen: { name: "chapman" },
        };
      } else {
        subset = estimateMultiFrame(subFrames, {
          keys,
          bootstrap: 0,
          seed,
          probabilistic: false,
          sensitivity: false,
          extraLinks: subLinks,
        });
      }
      sensitivity.push({
        dropped: matrix.labels[drop],
        nHat: subset.nHat,
        reportable: subset.reportable,
        chosen: subset.chosen?.name ?? null,
      });
    }
  }
  const sensitivityValues = (sensitivity ?? []).filter((row) => row.nHat !== null).map((row) => row.nHat);
  const sensitivitySpread =
    sensitivityValues.length > 1 && chosen
      ? (Math.max(...sensitivityValues) - Math.min(...sensitivityValues)) / chosen.nHat
      : null;
  const chao = chaoLowerBound(matrix.patterns);
  return {
    method: "loglinear",
    labels: matrix.labels,
    chao,
    sensitivity,
    sensitivitySpread,
    probabilistic,
    counts: {
      perFrame: matrix.nPerFrame,
      observed: matrix.observed,
      keyless: matrix.keyless,
      duplicates: matrix.duplicates,
      pairs: pairs.map((pair) => ({
        frames: `${matrix.labels[pair.left]}-${matrix.labels[pair.right]}`,
        count: pair.count,
      })),
    },
    patterns: [...matrix.patterns.entries()]
      .sort((left, right) => left[0] - right[0])
      .map(([pattern, count]) => ({ pattern: pattern.toString(2).padStart(matrix.k, "0"), count })),
    models: models.map(({ fitted, terms, ...rest }) => rest),
    chosen: chosen ? { name: chosen.name, nHat: chosen.nHat, fittedZero: chosen.fittedZero, df: chosen.df, aic: chosen.aic, g2: chosen.g2 } : null,
    nHat: reportable ? chosen.nHat : null,
    coverage: reportable ? matrix.observed / chosen.nHat : null,
    bootstrap,
    cv: reportable && bootstrap && bootstrap.mean > 0 ? bootstrap.sd / bootstrap.mean : null,
    modelSpread: spread,
    diagnostics: gates,
    reportable,
  };
}

function renderMultiMarkdown(result, framePaths) {
  const out = [];
  out.push("# capture-recapture 多源试点（log-linear）");
  out.push("");
  out.push(`> frames：${result.labels.map((label, index) => `${label}=${framePaths[index]}`).join("；")}`);
  out.push("> 模型：分层 log-linear（独立 / 两两交互），G²+AIC 选型；缺失格由拟合值给出 N̂₀；bootstrap 为参数化重采样。");
  out.push("");
  out.push("## 1. 捕获计数");
  out.push("");
  out.push("| 量 | 值 |");
  out.push("| --- | --- |");
  result.counts.perFrame.forEach((count, index) => {
    out.push(`| ${result.labels[index]} 捕获实体 | ${count} |`);
  });
  out.push(`| 至少被一个 frame 捕获（N_obs） | ${result.counts.observed} |`);
  for (const pair of result.counts.pairs) {
    out.push(`| 两两交集 ${pair.frames} | ${pair.count} |`);
  }
  out.push("");
  out.push("捕获模式（bit 顺序 = frame 顺序）：");
  out.push("");
  out.push("| pattern | 实体数 |");
  out.push("| --- | --- |");
  for (const row of result.patterns) out.push(`| ${row.pattern} | ${row.count} |`);
  out.push("");
  out.push("## 2. 模型比较");
  out.push("");
  out.push("| 模型 | G² | df | AIC | N̂ | 可估计 |");
  out.push("| --- | --- | --- | --- | --- | --- |");
  for (const model of result.models) {
    out.push(
      `| ${model.name} | ${model.g2.toFixed(2)} | ${model.df} | ${model.aic.toFixed(2)} | ${model.nHat.toFixed(1)} | ${model.estimable ? "是" : "否（df=0）"} |`,
    );
  }
  out.push("");
  out.push("## 3. 估计");
  out.push("");
  if (result.reportable && result.chosen) {
    out.push("```text");
    out.push(`选定模型：${result.chosen.name}（AIC 最小，df=${result.chosen.df}）`);
    out.push(`N̂ = N_obs + N̂₀ = ${result.counts.observed} + ${result.chosen.fittedZero.toFixed(1)} = ${result.nHat.toFixed(1)}`);
    if (result.bootstrap) {
      out.push(
        `参数化 bootstrap 95% CI [${result.bootstrap.ci95[0].toFixed(1)}, ${result.bootstrap.ci95[1].toFixed(1)}]（${result.bootstrap.reps} 次）；CV = ${(result.cv * 100).toFixed(1)}%`,
      );
    }
    out.push(`覆盖率（N_obs / N̂）= ${(result.coverage * 100).toFixed(1)}%；模型间 N̂ 相对跨度 = ${(result.modelSpread * 100).toFixed(1)}%`);
    if (result.chao) {
      out.push(
        `Chao (1987) 下界：N̂_chao = ${result.chao.observed} + ${result.chao.f1}²/(2×${result.chao.f2}) = ${result.chao.nHat.toFixed(1)}（异质性下的保守下界，仅作参照）`,
      );
    }
    out.push("```");
  } else {
    out.push("不可报告：见诊断门（m11/两两交集不足或观测过少）。");
  }
  out.push("");
  let sectionNumber = 4;
  if (result.probabilistic) {
    out.push(`## ${sectionNumber++}. 概率匹配（第二段，异键候选）`);
    out.push("");
    out.push(
      `候选对 ${result.probabilistic.candidates}；自动合并 ${result.probabilistic.auto}；进人工复核队列 ${result.probabilistic.review}。`,
    );
    out.push("Blocking = 姓名首 token+国家 / 邮编前缀+国家；已由确定性硬键合并的对不再重复评分。评分 = 固定权重 Fellegi–Sunter 形状（domain/registry 硬键 ±6、name Jaro–Winkler 0–5、国家/城市/邮编 ±）。阈值：auto ≥8、review 4–8、reject <4。");
    if (result.probabilistic.reviewSample.length > 0) {
      out.push("");
      out.push("| A 记录 | B 记录 | 分数 | 理由 |");
      out.push("| --- | --- | --- | --- |");
      for (const pair of result.probabilistic.reviewSample) {
        out.push(`| #${pair.indexA}（frame ${pair.frameA + 1}） | #${pair.indexB}（frame ${pair.frameB + 1}） | ${pair.score} | ${pair.reasons.join("；")} |`);
      }
    }
    out.push("");
  }
  if (result.sensitivity) {
    out.push(`## ${sectionNumber++}. 敏感性（留一法）`);
    out.push("");
    out.push("| 剔除 frame | 子集 N̂ | 可报告 | 选定模型 |");
    out.push("| --- | --- | --- | --- |");
    for (const row of result.sensitivity) {
      out.push(`| ${row.dropped} | ${row.nHat === null ? "—" : row.nHat.toFixed(1)} | ${row.reportable ? "是" : "否"} | ${row.chosen ?? "—"} |`);
    }
    out.push("");
    out.push(
      result.sensitivitySpread === null
        ? "留一法跨度不可计算（可报告子集不足）。"
        : `留一法 N̂ 相对跨度 = ${(result.sensitivitySpread * 100).toFixed(1)}%（>40% 说明结果高度依赖单一源，降置信；ch01 §3.4.7）。`,
    );
    out.push("");
  }
  out.push(`## ${sectionNumber++}. 诊断门`);
  out.push("");
  out.push("| 门 | 结果 | 说明 |");
  out.push("| --- | --- | --- |");
  for (const gate of result.diagnostics) {
    out.push(`| ${gate.code} | ${gate.ok ? "PASS" : "WARN/BLOCK"} | ${gate.detail} |`);
  }
  out.push("");
  out.push(`## ${sectionNumber++}. 假设与限制`);
  out.push("");
  out.push("1. log-linear 假设各 frame 捕获概率的交互结构可被两两交互解释；强依赖（共享上游）会让 N̂ 偏低。");
  out.push("2. 概率匹配是固定权重的 Fellegi–Sunter 形状（非 EM 训练）；review 队列必须人工复核并测 match precision（ch01 §3.4.3 要求 ≥95%）。");
  out.push("3. 参数化 bootstrap 以选定模型为真值重采样，未覆盖模型选择不确定性；模型间跨度与留一法跨度单列。");
  out.push("4. Chao 下界假设异质性可由捕获次数分布刻画，只作保守参照，不做点估计。");
  out.push("5. k>3 的模型（含三阶交互）与 LCMCR 未实现。");
  return out.join("\n");
}

function extractFrameArgs(argv) {
  const frames = [];
  const rest = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--frame") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error("--frame requires <label>=<path> or <path>");
      }
      frames.push(value);
      index += 1;
    } else if (token.startsWith("--frame=")) {
      frames.push(token.slice("--frame=".length));
    } else {
      rest.push(token);
    }
  }
  return { frames, rest };
}

function parseKeyList(flags) {
  const keys = flags.keys ? String(flags.keys).split(",").map((key) => key.trim()) : [...DEFAULT_KEYS];
  for (const key of keys) {
    if (!KEY_BUILDERS[key]) throw new Error(`unknown key: ${key} (allowed: ${Object.keys(KEY_BUILDERS).join(", ")})`);
  }
  return keys;
}

function main() {
  const { frames: frameSpecs, rest } = extractFrameArgs(process.argv.slice(2));
  const flags = parseArgs(rest);
  if (flags.help) {
    console.log(USAGE);
    return;
  }
  const keys = parseKeyList(flags);
  if (frameSpecs.length > 0) {
    if (flags.a || flags.b) throw new Error("use either --a/--b or repeated --frame, not both");
    if (frameSpecs.length < 2) throw new Error("--frame must be given at least twice");
    const loaded = frameSpecs.map((spec, index) => {
      const equals = spec.indexOf("=");
      const label = equals === -1 ? `F${index + 1}` : spec.slice(0, equals);
      const path = equals === -1 ? spec : spec.slice(equals + 1);
      return { label, frame: readFrame(path) };
    });
    if (loaded.length === 2) {
      const result = estimateTwoFrames(loaded[0].frame.records, loaded[1].frame.records, {
        keys,
        sample: flags.sample !== undefined ? Number(flags.sample) : 10,
      });
      if (flags.json) {
        console.log(
          JSON.stringify(
            { ...result, framesInput: { a: loaded[0].frame.path, b: loaded[1].frame.path } },
            null,
            2,
          ),
        );
      } else {
        console.log(renderMarkdown(result, { a: loaded[0].frame.path, b: loaded[1].frame.path }));
      }
      return;
    }
    const result = estimateMultiFrame(
      loaded.map((entry) => ({ label: entry.label, records: entry.frame.records })),
      {
        keys,
        bootstrap: flags.bootstrap !== undefined ? Number(flags.bootstrap) : 1000,
        seed: flags.seed ?? "20261108",
        probabilistic: Boolean(flags.probabilistic),
      },
    );
    if (flags.json) {
      console.log(
        JSON.stringify(
          { ...result, framesInput: loaded.map((entry) => ({ label: entry.label, path: entry.frame.path })) },
          null,
          2,
        ),
      );
    } else {
      console.log(renderMultiMarkdown(result, loaded.map((entry) => entry.frame.path)));
    }
    return;
  }
  if (!flags.a || !flags.b) {
    console.error(USAGE);
    process.exit(2);
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
