const DAY_MS = 24 * 60 * 60 * 1000;
export const SITE_RELEASE_ATTEMPT_RETENTION_MS = DAY_MS;
export const SITE_RELEASE_READY_RETENTION_MS = 30 * DAY_MS;
export const SITE_RELEASE_ROLLBACK_COUNT = 2;

export function siteReleaseGcEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.SITE_RELEASE_GC_ENABLED === 'true';
}

export interface SiteReleaseGcEligibility {
  status: string;
  createdAt: Date;
  readyAt: Date | null;
  active: boolean;
  newerReadyCount: number;
  now: Date;
}

export function isSiteReleaseGcEligible(
  input: SiteReleaseGcEligibility,
): boolean {
  if (input.active || !Number.isFinite(input.now.getTime())) return false;
  if (input.status === 'candidate' || input.status === 'failed') {
    return (
      Number.isFinite(input.createdAt.getTime()) &&
      input.createdAt.getTime() <=
        input.now.getTime() - SITE_RELEASE_ATTEMPT_RETENTION_MS
    );
  }
  if (input.status !== 'ready' || !input.readyAt) return false;
  return (
    Number.isFinite(input.readyAt.getTime()) &&
    input.readyAt.getTime() <=
      input.now.getTime() - SITE_RELEASE_READY_RETENTION_MS &&
    input.newerReadyCount >= SITE_RELEASE_ROLLBACK_COUNT
  );
}
