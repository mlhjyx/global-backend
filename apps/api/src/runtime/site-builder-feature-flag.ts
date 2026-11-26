/**
 * Runtime decoupling switch for the frozen Site Builder domain.
 *
 * Defaults to `true` so existing OpenAPI export, renderer visual CI, and
 * full-stack local environments stay 100% backward-compatible.
 * Setting `SITE_BUILDER_ENABLED=false` (or `0` / `off` / `no`) lets the
 * acquisition API and worker boot without loading `SiteBuilderModule`,
 * `site-builder.activities.ts` (4400+ lines), the heavy image pipeline,
 * browser/renderer readiness probes, or settlement readback keyring probes.
 */

export const SITE_BUILDER_ENABLED_ENV = "SITE_BUILDER_ENABLED";

const TRUE_VALUES = new Set(["true", "1", "on", "yes"]);
const FALSE_VALUES = new Set(["false", "0", "off", "no"]);

export function isSiteBuilderEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = env[SITE_BUILDER_ENABLED_ENV];
  if (raw === undefined || raw.trim() === "") {
    return true;
  }
  const normalized = raw.trim().toLowerCase();
  if (TRUE_VALUES.has(normalized)) return true;
  if (FALSE_VALUES.has(normalized)) return false;
  throw new Error(
    `SITE_BUILDER_ENABLED_INVALID: unsupported value "${raw.trim()}" (expected true|false|1|0|on|off|yes|no)`,
  );
}
