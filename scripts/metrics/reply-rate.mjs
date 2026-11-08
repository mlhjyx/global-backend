#!/usr/bin/env node
// reply-rate — compute the mandated paired RR1 + RR3 statement (ch01 §1.4).
//
//   node scripts/metrics/reply-rate.mjs --input counts.json [--json]
//   node scripts/metrics/reply-rate.mjs --check statement.txt
//
// counts.json:
// {
//   "window": {"start": "2026-10-09", "end": "2026-11-08"},
//   "strata": [
//     {"key": "DE|zerobounce|google", "sent": 1000, "skipped": 10, "internal": 5,
//      "duplicateRetries": 3, "delivered": 950, "unknown": 20, "replies": 5, "eHat": 0.98}
//   ]
// }
//
// RR1 = unique_human_replies / eligible_send_attempts
//   eligible = sent − skipped − internal − duplicate retries (ch01 §1.4)
// RR3 = unique_human_replies / (delivered + Σ eHat × unknown)
//   eHat = 1 − hard_bounce_rate for the same country × verifier × MX stratum.
//
// The two are reported together or not at all: P4 前没有真实发送数据，脚本先作为
// 周报/看板的唯一实现，禁止手写单口径数字。Pure Node built-ins.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { parseArgs, pctInterval, utcStamp } from "./lib/psql.mjs";

const COUNT_FIELDS = ["sent", "skipped", "internal", "duplicateRetries", "delivered", "unknown", "replies"];

function requireInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer, got: ${value}`);
  }
}

/** Compute RR1/RR3 (and Wilson CIs) from a validated counts document. */
export function computeReplyRates(document) {
  const strata = document?.strata;
  if (!Array.isArray(strata) || strata.length === 0) {
    throw new Error("strata must be a non-empty array");
  }
  let eligible = 0;
  let delivered = 0;
  let adjustedUnknown = 0;
  let replies = 0;
  strata.forEach((stratum, index) => {
    for (const field of COUNT_FIELDS) {
      requireInteger(stratum[field], `strata[${index}].${field}`);
    }
    if (stratum.unknown > 0) {
      const eHat = stratum.eHat;
      if (typeof eHat !== "number" || eHat < 0 || eHat > 1) {
        throw new Error(
          `strata[${index}] (${stratum.key}) has unknown deliveries but no eHat in [0,1]; RR3 cannot be computed without ê`,
        );
      }
      adjustedUnknown += eHat * stratum.unknown;
    }
    const stratumEligible =
      stratum.sent - stratum.skipped - stratum.internal - stratum.duplicateRetries;
    if (stratumEligible < 0) {
      throw new Error(`strata[${index}] (${stratum.key}): exclusions exceed sent`);
    }
    if (stratum.replies > stratumEligible) {
      throw new Error(`strata[${index}] (${stratum.key}): replies exceed eligible sends`);
    }
    eligible += stratumEligible;
    delivered += stratum.delivered;
    replies += stratum.replies;
  });
  if (eligible === 0) {
    throw new Error("eligible send attempts is 0; nothing to report");
  }
  const rr3Denominator = delivered + adjustedUnknown;
  if (rr3Denominator <= 0) {
    throw new Error("RR3 denominator (delivered + ê×unknown) is 0; nothing to report");
  }
  return {
    generatedAt: utcStamp(),
    window: document.window ?? null,
    eligibleSends: eligible,
    delivered,
    adjustedUnknown,
    uniqueHumanReplies: replies,
    rr1: replies / eligible,
    rr3: replies / rr3Denominator,
    rr1Ci: pctInterval(replies, eligible),
    rr3Ci: pctInterval(replies, Math.round(rr3Denominator)),
    strataCount: strata.length,
  };
}

/** The one-line statement every report must carry (ch01 §1.4 成对报告). */
export function formatReplyStatement(result) {
  const unknownPart = result.adjustedUnknown > 0 ? ` + ê×未知 ${result.adjustedUnknown.toFixed(1)}` : "";
  return `回复率：RR1 ${percent(result.rr1)}（${result.uniqueHumanReplies}/${result.eligibleSends} 发送，Wilson 95% CI ${result.rr1Ci}）；RR3 ${percent(result.rr3)}（${result.uniqueHumanReplies}/${result.delivered} 投递${unknownPart}，Wilson 95% CI ${result.rr3Ci}）`;
}

function percent(value) {
  return `${(value * 100).toFixed(2)}%`;
}

/**
 * Validate a human-written reply-rate statement: both RR1 and RR3 must appear,
 * each with a numerator/denominator fraction. Single-caliber statements fail.
 */
export function validateReplyStatement(text) {
  const errors = [];
  const source = String(text ?? "");
  for (const label of ["RR1", "RR3"]) {
    const pattern = new RegExp(`${label}\\s*[:：]?\\s*[\\d.]+\\s*%?\\s*[（(]?\\s*[\\d,]+\\s*/\\s*[\\d,]+`);
    if (!pattern.test(source)) {
      errors.push(`${label}_MISSING_OR_BARE`);
    }
  }
  return { ok: errors.length === 0, errors };
}

export { percent };

function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help || (!flags.input && !flags.check)) {
    console.error("usage: node scripts/metrics/reply-rate.mjs --input <counts.json> [--json] | --check <statement.txt>");
    process.exit(flags.help ? 0 : 2);
  }
  if (flags.check) {
    const result = validateReplyStatement(readFileSync(flags.check, "utf8"));
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
    return;
  }
  const document = JSON.parse(readFileSync(flags.input, "utf8"));
  const result = computeReplyRates(document);
  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatReplyStatement(result));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
