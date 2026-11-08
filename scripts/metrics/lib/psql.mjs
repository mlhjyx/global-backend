// Read-only psql access for the metrics scripts.
//
// Every query goes through `docker exec ... psql` with
// PGOPTIONS='-c default_transaction_read_only=on', so a bug (or a copy-pasted
// write statement) cannot modify the production database — the server refuses
// the statement inside the read-only transaction. Only Node built-ins.
import { execFileSync } from "node:child_process";

export const DEFAULTS = Object.freeze({
  container: process.env.GLOBAL_PG_CONTAINER ?? "global-postgres",
  user: process.env.GLOBAL_PG_USER ?? "global",
  database: process.env.GLOBAL_PG_DATABASE ?? "global_dev",
});

const MAX_BUFFER = 64 * 1024 * 1024;

/**
 * Run one SQL statement (or a multi-statement batch) in a read-only session
 * and return raw TSV rows (no header, unaligned).
 */
export function queryTsv(sql, options = {}) {
  const { container, user, database } = { ...DEFAULTS, ...options };
  const output = execFileSync(
    "docker",
    [
      "exec",
      "-e",
      "PGOPTIONS=-c default_transaction_read_only=on",
      container,
      "psql",
      "-U",
      user,
      "-d",
      database,
      "-X",
      "-q",
      "-A",
      "-t",
      "-F",
      "\t",
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      sql,
    ],
    { encoding: "utf8", maxBuffer: MAX_BUFFER },
  );
  return output
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => line.split("\t"));
}

/** Run a query expected to return a single row and map columns by position. */
export function queryRow(sql, columns, options = {}) {
  const rows = queryTsv(sql, options);
  if (rows.length !== 1) {
    throw new Error(`expected exactly 1 row, got ${rows.length} for: ${sql}`);
  }
  return Object.fromEntries(columns.map((name, index) => [name, rows[0][index]]));
}

/** Run a query returning (dimension, value...) rows into objects. */
export function queryRows(sql, columns, options = {}) {
  return queryTsv(sql, options).map((cells) =>
    Object.fromEntries(columns.map((name, index) => [name, cells[index]])),
  );
}

/** Postgres count columns arrive as decimal strings; keep them as numbers. */
export function toInt(value) {
  if (value === null || value === undefined || value === "") return 0;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`not a number: ${JSON.stringify(value)}`);
  }
  return parsed;
}

/** Ratio helper that returns null instead of NaN/Infinity for empty denominators. */
export function ratio(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : null;
}

/**
 * Wilson score interval for a binomial proportion (z = 1.96).
 * Returns null when n = 0; the interval is clamped to [0, 1].
 */
export function wilson(numerator, denominator, z = 1.96) {
  if (denominator <= 0) return null;
  const p = numerator / denominator;
  const z2 = z * z;
  const centre = (p + z2 / (2 * denominator)) / (1 + z2 / denominator);
  const half =
    (z * Math.sqrt((p * (1 - p)) / denominator + z2 / (4 * denominator * denominator))) /
    (1 + z2 / denominator);
  return {
    low: Math.max(0, centre - half),
    high: Math.min(1, centre + half),
  };
}

/** Format a fraction as a percentage with one decimal (dash for empty). */
export function pct(numerator, denominator, digits = 1) {
  const value = ratio(numerator, denominator);
  return value === null ? "—" : `${(value * 100).toFixed(digits)}%`;
}

/** Format a Wilson interval as "[low%, high%]". */
export function pctInterval(numerator, denominator, digits = 1) {
  const interval = wilson(numerator, denominator);
  if (interval === null) return "—";
  return `[${(interval.low * 100).toFixed(digits)}%, ${(interval.high * 100).toFixed(digits)}%]`;
}

/** ISO timestamp (UTC, seconds) for report headers. */
export function utcStamp(now = new Date()) {
  return now.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Parse common CLI flags: --flag, --flag value, --flag=value. */
export function parseArgs(argv) {
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      throw new Error(`unexpected argument: ${token}`);
    }
    const [name, inline] = token.slice(2).split("=", 2);
    if (inline !== undefined) {
      flags[name] = inline;
    } else if (argv[index + 1] !== undefined && !argv[index + 1].startsWith("--")) {
      flags[name] = argv[index + 1];
      index += 1;
    } else {
      flags[name] = true;
    }
  }
  return flags;
}

/** Validate a UUID before splicing it into SQL. */
export function assertUuid(value, label) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error(`${label} must be a UUID, got: ${value}`);
  }
  return value.toLowerCase();
}
