/**
 * Temporal may execute a paid Site Builder Activity at most twice. Paid
 * operations remain individually idempotent, but a known failed task attempt
 * can be released before the second Activity attempt, so the build-level
 * technical envelope must reserve for both attempts.
 */
export const SITE_BUILD_PAID_ACTIVITY_MAXIMUM_ATTEMPTS = 2 as const;
