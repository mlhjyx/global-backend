import { isAbsolute } from "node:path";

/**
 * Dual-mode Temporal configuration & readiness validation for customer workflows.
 *
 * Supports migrating customer workflows off the single-node SQLite `temporal-dev`
 * server onto the PostgreSQL-backed Temporal server (`postgres_platform`) without
 * altering `temporal-platform` containers or colliding with `platform-automation`.
 */
export type CustomerTemporalBackendMode = "dev_sqlite" | "postgres_platform";

export const DEFAULT_CUSTOMER_TEMPORAL_NAMESPACE = "default";
export const RESERVED_PLATFORM_TEMPORAL_NAMESPACE = "platform-automation";

export interface CustomerTemporalConfig {
  readonly mode: CustomerTemporalBackendMode;
  readonly address: string | undefined;
  readonly namespace: string;
  readonly tlsServerName: string | undefined;
  readonly tlsCaFile: string | undefined;
  readonly platformNamespace: string;
}

export interface CustomerTemporalReadinessReport {
  readonly ok: boolean;
  readonly mode: CustomerTemporalBackendMode;
  readonly namespace: string;
  readonly issues: readonly string[];
}

export function resolveCustomerTemporalBackendMode(
  env: NodeJS.ProcessEnv = process.env,
): CustomerTemporalBackendMode {
  const raw = env.TEMPORAL_CUSTOMER_BACKEND_MODE?.trim().toLowerCase();
  if (raw === "postgres_platform") return "postgres_platform";
  return "dev_sqlite";
}

export function resolveCustomerTemporalConfig(
  env: NodeJS.ProcessEnv = process.env,
): CustomerTemporalConfig {
  const mode = resolveCustomerTemporalBackendMode(env);
  const platformNamespace =
    env.PLATFORM_TEMPORAL_NAMESPACE?.trim() ||
    RESERVED_PLATFORM_TEMPORAL_NAMESPACE;
  const address =
    env.TEMPORAL_CUSTOMER_ADDRESS?.trim() ||
    env.TEMPORAL_ADDRESS?.trim() ||
    undefined;
  const namespace =
    env.TEMPORAL_CUSTOMER_NAMESPACE?.trim() ||
    env.TEMPORAL_NAMESPACE?.trim() ||
    DEFAULT_CUSTOMER_TEMPORAL_NAMESPACE;
  const tlsServerName =
    env.TEMPORAL_CUSTOMER_TLS_SERVER_NAME?.trim() ||
    env.TEMPORAL_TLS_SERVER_NAME?.trim() ||
    undefined;
  const tlsCaFile =
    env.TEMPORAL_CUSTOMER_TLS_CA_FILE?.trim() ||
    env.TEMPORAL_TLS_CA_FILE?.trim() ||
    undefined;

  return Object.freeze({
    mode,
    address,
    namespace,
    tlsServerName,
    tlsCaFile,
    platformNamespace,
  });
}

/**
 * Produces an env view for `temporalTlsConfiguration()` so customer-specific
 * overrides (`TEMPORAL_CUSTOMER_*`) take precedence cleanly in dual-mode rollouts.
 */
export function resolveCustomerTemporalTlsEnv(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const config = resolveCustomerTemporalConfig(env);
  return {
    ...env,
    ...(config.address ? { TEMPORAL_ADDRESS: config.address } : {}),
    ...(config.tlsServerName
      ? { TEMPORAL_TLS_SERVER_NAME: config.tlsServerName }
      : {}),
    ...(config.tlsCaFile ? { TEMPORAL_TLS_CA_FILE: config.tlsCaFile } : {}),
  };
}

/**
 * Validates customer Temporal configuration fail-closed before connecting or during
 * startup diagnostics. Never mutates containers or touches platform-automation.
 */
export function validateCustomerTemporalReadiness(
  env: NodeJS.ProcessEnv = process.env,
): CustomerTemporalReadinessReport {
  const rawMode = env.TEMPORAL_CUSTOMER_BACKEND_MODE?.trim().toLowerCase();
  const config = resolveCustomerTemporalConfig(env);
  const issues: string[] = [];

  if (rawMode && rawMode !== "dev_sqlite" && rawMode !== "postgres_platform") {
    issues.push("TEMPORAL_CUSTOMER_BACKEND_MODE_INVALID");
  }

  if (
    !config.namespace ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(config.namespace)
  ) {
    issues.push("TEMPORAL_CUSTOMER_NAMESPACE_INVALID");
  }

  if (
    config.namespace === config.platformNamespace ||
    config.namespace === RESERVED_PLATFORM_TEMPORAL_NAMESPACE
  ) {
    issues.push("TEMPORAL_CUSTOMER_NAMESPACE_COLLISION");
  }

  if (config.mode === "postgres_platform") {
    if (!config.address) {
      issues.push("TEMPORAL_CUSTOMER_ADDRESS_REQUIRED");
    }
    if (
      !config.tlsServerName ||
      !/^[A-Za-z0-9.-]+$/u.test(config.tlsServerName)
    ) {
      issues.push("TEMPORAL_CUSTOMER_TLS_SERVER_NAME_REQUIRED");
    }
    if (!config.tlsCaFile || !isAbsolute(config.tlsCaFile)) {
      issues.push("TEMPORAL_CUSTOMER_TLS_CA_FILE_REQUIRED");
    }
  } else if (config.tlsCaFile && !isAbsolute(config.tlsCaFile)) {
    issues.push("TEMPORAL_CUSTOMER_TLS_CA_FILE_INVALID");
  }

  return Object.freeze({
    ok: issues.length === 0,
    mode: config.mode,
    namespace: config.namespace,
    issues: Object.freeze(issues),
  });
}
