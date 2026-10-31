/**
 * ISO 8601 weeks in UTC (BI-22 weekly report): a week starts Monday 00:00 UTC and belongs to the
 * ISO year of its Thursday. Pure functions; the caller supplies the instant.
 */

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
const WEEK_LABEL = /^(\d{4})-W(\d{2})$/u;
const MIN_YEAR = 2000;

export interface IsoWeekRange {
  /** `YYYY-Www`. */
  readonly week: string;
  /** Monday 00:00 UTC, inclusive. */
  readonly start: Date;
  /** The next Monday 00:00 UTC, exclusive. */
  readonly end: Date;
}

/** Monday 00:00 UTC of ISO week 1: the week that contains 4 January. */
function firstMondayMs(year: number): number {
  const fourth = Date.UTC(year, 0, 4);
  const weekday = (new Date(fourth).getUTCDay() + 6) % 7; // Monday = 0
  return fourth - weekday * DAY_MS;
}

function label(year: number, week: number): string {
  return `${year}-W${String(week).padStart(2, '0')}`;
}

function weekParts(instant: Date): { year: number; week: number } {
  const midnight = Date.UTC(instant.getUTCFullYear(), instant.getUTCMonth(), instant.getUTCDate());
  const weekday = (new Date(midnight).getUTCDay() + 6) % 7;
  const thursday = midnight + (3 - weekday) * DAY_MS;
  const year = new Date(thursday).getUTCFullYear();
  return { year, week: Math.floor((thursday - firstMondayMs(year)) / WEEK_MS) + 1 };
}

/** The `YYYY-Www` label of the ISO week that contains `instant`. */
export function isoWeekOf(instant: Date): string {
  const { year, week } = weekParts(instant);
  return label(year, week);
}

/** The UTC range of a `YYYY-Www` label, or null unless it names exactly one existing ISO week. */
export function parseIsoWeek(value: string): IsoWeekRange | null {
  const match = WEEK_LABEL.exec(value);
  if (!match || value.length !== 8) return null;
  const year = Number(match[1]);
  const week = Number(match[2]);
  if (year < MIN_YEAR || week < 1) return null;
  // 28 December always falls in the last ISO week of its year.
  const weeksInYear = weekParts(new Date(Date.UTC(year, 11, 28))).week;
  if (week > weeksInYear) return null;
  const start = firstMondayMs(year) + (week - 1) * WEEK_MS;
  return { week: label(year, week), start: new Date(start), end: new Date(start + WEEK_MS) };
}
