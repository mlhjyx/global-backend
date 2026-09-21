// Re-sign the Copy fixed-source eligibility receipt after an edit to one of
// its bound files (package.json, pnpm-lock.yaml, schema.prisma, ...).
//
// The receipt is a content hash over those files. Most edits to them - a
// dependency bump, a script entry - move only the hash and leave Copy
// eligibility exactly as it was. This helper re-signs those hash-only moves
// in one step (receipt plus the two digests mirrored in the governance
// record) and refuses anything else: if status, drifted paths, stale scope or
// any other eligibility field would change, it stops unless the caller passes
// --accept-eligibility-change after reviewing why.
//
//   node scripts/copy-fixed-source-impact-resign.mjs [--accept-eligibility-change]
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  COPY_RUNTIME_ELIGIBILITY_PATH,
  prepareCopyRuntimeEligibilityReceiptFromRepository,
  writeCopyRuntimeEligibilityReceiptFromRepository,
} from "./copy-fixed-source-impact.mjs";

export const COPY_GOVERNANCE_RECORD_PATH =
  "docs/implementation-records/copy-fixed-source-impact-governance.md";

const ACCEPT_FLAG = "--accept-eligibility-change";

/** Every receipt field except the source fingerprint is an eligibility decision. */
export function classifyResign(previous, next) {
  const changed = [...new Set([...Object.keys(previous), ...Object.keys(next)])]
    .filter((key) => key !== "current_source_fingerprint")
    .filter((key) => JSON.stringify(previous[key]) !== JSON.stringify(next[key]))
    .sort();
  if (changed.length > 0) return { kind: "ELIGIBILITY_CHANGED", changed };
  if (previous.current_source_fingerprint === next.current_source_fingerprint) {
    return { kind: "UNCHANGED", changed };
  }
  return { kind: "HASH_ONLY", changed };
}

/** Rewrite the two digest rows the document-drift test compares against the receipt. */
export function updateGovernanceRecord(markdown, fingerprint, receiptSha256) {
  let updated = markdown;
  for (const [label, value] of [
    ["Current source fingerprint", fingerprint],
    ["Eligibility receipt SHA-256", receiptSha256],
  ]) {
    if (!/^[0-9a-f]{64}$/u.test(value)) {
      throw new Error(`COPY_RESIGN_DIGEST_INVALID: ${label}`);
    }
    const row = new RegExp(`^\\| ${label} \\| \`[0-9a-f]{64}\` \\|$`, "gmu");
    const matches = updated.match(row) ?? [];
    if (matches.length !== 1) {
      throw new Error(`COPY_RESIGN_RECORD_ROW_COUNT: ${label}=${matches.length}`);
    }
    updated = updated.replace(row, `| ${label} | \`${value}\` |`);
  }
  return updated;
}

/**
 * Decide what a re-sign run may do, validating the governance record before
 * anything is written so a malformed record fails with the repository
 * untouched.
 */
export function planResign({ previous, next, record, accept }) {
  const verdict = classifyResign(previous, next);
  if (verdict.kind === "UNCHANGED") return { ...verdict, write: false, refused: false };
  if (verdict.kind === "ELIGIBILITY_CHANGED" && !accept) {
    return { ...verdict, write: false, refused: true };
  }
  updateGovernanceRecord(record, next.current_source_fingerprint, "0".repeat(64));
  return { ...verdict, write: true, refused: false };
}

async function main(argv) {
  if (argv.some((argument) => argument !== ACCEPT_FLAG)) {
    throw new Error(`usage: node scripts/copy-fixed-source-impact-resign.mjs [${ACCEPT_FLAG}]`);
  }
  const root = process.cwd();
  const receiptPath = resolve(root, COPY_RUNTIME_ELIGIBILITY_PATH);
  const recordPath = resolve(root, COPY_GOVERNANCE_RECORD_PATH);
  const previous = JSON.parse(await readFile(receiptPath, "utf8"));
  const next = await prepareCopyRuntimeEligibilityReceiptFromRepository(root);
  const record = await readFile(recordPath, "utf8");
  const plan = planResign({ previous, next, record, accept: argv.includes(ACCEPT_FLAG) });
  if (plan.refused) {
    process.stderr.write(
      `COPY_RESIGN_ELIGIBILITY_CHANGED: ${plan.changed.join(", ")}\n` +
        `status ${previous.status} -> ${next.status}. Review why before re-running with ${ACCEPT_FLAG}.\n`,
    );
    process.exitCode = 1;
    return;
  }
  if (!plan.write) {
    process.stdout.write(`${JSON.stringify({ result: plan.kind, status: next.status })}\n`);
    return;
  }
  // Mirror what was actually written, not the earlier prepared receipt.
  const written = await writeCopyRuntimeEligibilityReceiptFromRepository(root);
  const receiptSha256 = createHash("sha256")
    .update(await readFile(receiptPath))
    .digest("hex");
  await writeFile(
    recordPath,
    updateGovernanceRecord(record, written.current_source_fingerprint, receiptSha256),
    "utf8",
  );
  process.stdout.write(
    `${JSON.stringify({
      result: plan.kind,
      changed: plan.changed,
      status: written.status,
      current_source_fingerprint: written.current_source_fingerprint,
      receipt_sha256: receiptSha256,
    })}\n`,
  );
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
