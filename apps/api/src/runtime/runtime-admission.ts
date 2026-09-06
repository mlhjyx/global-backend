import type { RuntimeReleaseIdentity } from "./runtime-release-identity";
import type { RuntimeSettings } from "./runtime-environment";
import { createRolesToScopesPolicy } from "../auth/scopes";
import { validateJwksTokenVerifierConfiguration } from "../auth/jwks-token-verifier";
import { resolveProcessorJurisdiction } from "../compliance/data-rights.context";
import { assertPiiKeyConfiguration } from "../compliance/pii-crypto";
import { isAbsolute } from "node:path";
import {
  siteBuildProviderWireTargetsAppDatabase,
  withSiteBuildProviderWireStatementTimeout,
} from "../site-builder/site-build-provider-wire.database";
import {
  canonicalGatewayCredential,
  gatewayCredentialsAreDistinct,
  parseModelGatewayRequestTimeout,
} from "../model-gateway/gateway-credential-boundary";

type AdmissionStatus = "ok" | "optional" | "failed";
export type RuntimeAdmissionRole = "API" | "WORKER" | "OUTBOX_RELAY";

interface AdmissionCheck {
  status: AdmissionStatus;
  code?: string;
}

export interface RuntimeAdmissionResult {
  mode: RuntimeSettings["mode"];
  admitted: boolean;
  checks: {
    build: AdmissionCheck;
    environment: AdmissionCheck;
    database: AdmissionCheck;
    auth: AdmissionCheck;
    gateway: AdmissionCheck;
    pii: AdmissionCheck;
  };
}

function inspectEnvironment(
  settings: RuntimeSettings,
  env: NodeJS.ProcessEnv,
): AdmissionCheck {
  if (!managed(settings.mode)) {
    return { status: "optional" };
  }
  if (env.NODE_ENV !== "production") {
    return { status: "failed", code: "MANAGED_NODE_ENV_REQUIRED" };
  }
  try {
    resolveProcessorJurisdiction(env.DATA_PROCESSOR_JURISDICTION);
  } catch {
    return {
      status: "failed",
      code: "DATA_PROCESSOR_JURISDICTION_INVALID",
    };
  }
  return { status: "ok" };
}

function present(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function managed(mode: RuntimeSettings["mode"]): boolean {
  return mode !== "test";
}

function inspectDatabase(
  settings: RuntimeSettings,
  env: NodeJS.ProcessEnv,
): AdmissionCheck {
  if (!managed(settings.mode)) return { status: "optional" };
  if (!present(env.APP_DATABASE_URL)) {
    return { status: "failed", code: "APP_DATABASE_URL_REQUIRED" };
  }
  try {
    const url = new URL(env.APP_DATABASE_URL);
    if (
      (url.protocol !== "postgresql:" && url.protocol !== "postgres:") ||
      decodeURIComponent(url.username) !== "app_user"
    ) {
      return { status: "failed", code: "APP_DATABASE_ROLE_INVALID" };
    }
  } catch {
    return { status: "failed", code: "APP_DATABASE_URL_INVALID" };
  }
  return { status: "ok" };
}

function inspectAuth(
  settings: RuntimeSettings,
  env: NodeJS.ProcessEnv,
): AdmissionCheck {
  if (!managed(settings.mode)) return { status: "optional" };
  if (
    !present(env.AUTH_JWKS_URI) ||
    !present(env.AUTH_ISSUER) ||
    !present(env.AUTH_AUDIENCE)
  ) {
    return { status: "failed", code: "AUTH_CONFIG_INCOMPLETE" };
  }
  try {
    const jwks = new URL(env.AUTH_JWKS_URI);
    const issuer = new URL(env.AUTH_ISSUER);
    const localDevelopment =
      settings.mode === "development" &&
      jwks.protocol === "http:" &&
      issuer.protocol === "http:" &&
      loopback(jwks.hostname) &&
      loopback(issuer.hostname);
    if (
      !localDevelopment &&
      (jwks.protocol !== "https:" || issuer.protocol !== "https:")
    ) {
      return { status: "failed", code: "AUTH_ORIGIN_NOT_HTTPS" };
    }
    if (
      jwks.username ||
      jwks.password ||
      jwks.search ||
      jwks.hash ||
      issuer.username ||
      issuer.password ||
      issuer.search ||
      issuer.hash
    ) {
      return { status: "failed", code: "AUTH_CONFIG_INVALID" };
    }
  } catch {
    return { status: "failed", code: "AUTH_CONFIG_INVALID" };
  }
  if (!present(env.AUTH_ROLE_SCOPE_MAP_JSON)) {
    return { status: "failed", code: "AUTH_ROLE_SCOPE_POLICY_INCOMPLETE" };
  }
  try {
    validateJwksTokenVerifierConfiguration(env);
  } catch {
    return { status: "failed", code: "AUTH_CONFIG_INVALID" };
  }
  try {
    createRolesToScopesPolicy(env, settings.mode);
  } catch {
    return { status: "failed", code: "AUTH_ROLE_SCOPE_POLICY_INVALID" };
  }
  return { status: "ok" };
}

function loopback(hostname: string): boolean {
  return (
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname === "::1" ||
    hostname === "localhost"
  );
}

function inspectGateway(
  settings: RuntimeSettings,
  env: NodeJS.ProcessEnv,
  role: RuntimeAdmissionRole,
): AdmissionCheck {
  if (!managed(settings.mode)) return { status: "optional" };
  const dispatchCredential = canonicalGatewayCredential(env.MODEL_GATEWAY_KEY);
  if (!present(env.MODEL_GATEWAY_URL) || !dispatchCredential) {
    return { status: "failed", code: "GATEWAY_CONFIG_INCOMPLETE" };
  }
  if (parseModelGatewayRequestTimeout(env.MODEL_TIMEOUT_MS) === undefined) {
    return { status: "failed", code: "GATEWAY_TIMEOUT_INVALID" };
  }
  const readerCredential = canonicalGatewayCredential(
    env.MODEL_GATEWAY_SETTLEMENT_READBACK_CREDENTIAL,
  );
  if (
    !readerCredential ||
    !/^srb1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{43}$/u.test(
      readerCredential,
    ) ||
    !present(env.SITE_BUILD_SETTLEMENT_DERIVATION_KEYRING_FILE) ||
    !isAbsolute(env.SITE_BUILD_SETTLEMENT_DERIVATION_KEYRING_FILE) ||
    !present(env.SITE_BUILD_COST_RECONCILIATION_CATALOG_JSON)
  ) {
    return {
      status: "failed",
      code: "GATEWAY_SETTLEMENT_READBACK_CONFIG_INCOMPLETE",
    };
  }
  if (
    !gatewayCredentialsAreDistinct(dispatchCredential, readerCredential)
  ) {
    return {
      status: "failed",
      code: "GATEWAY_SETTLEMENT_CREDENTIAL_SCOPE_INVALID",
    };
  }
  if (role === "WORKER") {
    if (!present(env.SITE_BUILD_PROVIDER_WIRE_DATABASE_URL)) {
      return {
        status: "failed",
        code: "SITE_BUILD_PROVIDER_WIRE_DATABASE_CONFIG_REQUIRED",
      };
    }
    try {
      withSiteBuildProviderWireStatementTimeout(
        env.SITE_BUILD_PROVIDER_WIRE_DATABASE_URL,
      );
    } catch {
      return {
        status: "failed",
        code: "SITE_BUILD_PROVIDER_WIRE_DATABASE_CONFIG_INVALID",
      };
    }
    if (
      !env.APP_DATABASE_URL ||
      !siteBuildProviderWireTargetsAppDatabase(
        env.SITE_BUILD_PROVIDER_WIRE_DATABASE_URL,
        env.APP_DATABASE_URL,
      )
    ) {
      return {
        status: "failed",
        code: "SITE_BUILD_PROVIDER_WIRE_DATABASE_TARGET_MISMATCH",
      };
    }
  } else if (present(env.SITE_BUILD_PROVIDER_WIRE_DATABASE_URL)) {
    return {
      status: "failed",
      code: "SITE_BUILD_PROVIDER_WIRE_DATABASE_SCOPE_INVALID",
    };
  }
  try {
    const url = new URL(env.MODEL_GATEWAY_URL);
    if (url.username || url.password || url.search || url.hash) {
      return { status: "failed", code: "GATEWAY_URL_INVALID" };
    }
    if (settings.mode === "pilot" && !loopback(url.hostname)) {
      return { status: "failed", code: "PILOT_GATEWAY_NOT_LOOPBACK" };
    }
    if (
      url.protocol !== "https:" &&
      !(url.protocol === "http:" && loopback(url.hostname))
    ) {
      return { status: "failed", code: "GATEWAY_ORIGIN_NOT_SECURE" };
    }
  } catch {
    return { status: "failed", code: "GATEWAY_URL_INVALID" };
  }
  return { status: "ok" };
}

function inspectPii(
  settings: RuntimeSettings,
  env: NodeJS.ProcessEnv,
): AdmissionCheck {
  if (!managed(settings.mode)) return { status: "optional" };
  try {
    assertPiiKeyConfiguration(env.PII_ENCRYPTION_KEY);
    return { status: "ok" };
  } catch {
    return { status: "failed", code: "PII_ENCRYPTION_KEY_INVALID" };
  }
}

export function inspectRuntimeAdmission(
  settings: RuntimeSettings,
  env: NodeJS.ProcessEnv,
  buildIdentity: RuntimeReleaseIdentity,
  role: RuntimeAdmissionRole = "API",
): RuntimeAdmissionResult {
  const build: AdmissionCheck = buildIdentity.attested
    ? { status: "ok" }
    : managed(settings.mode)
      ? { status: "failed", code: buildIdentity.code }
      : { status: "optional" };
  const checks = Object.freeze({
    build,
    environment: inspectEnvironment(settings, env),
    database: inspectDatabase(settings, env),
    auth: inspectAuth(settings, env),
    gateway: inspectGateway(settings, env, role),
    pii: inspectPii(settings, env),
  });
  return Object.freeze({
    mode: settings.mode,
    admitted: Object.values(checks).every((check) => check.status !== "failed"),
    checks,
  });
}

export class RuntimeAdmissionService {
  constructor(private readonly result: RuntimeAdmissionResult) {}

  current(): RuntimeAdmissionResult {
    return this.result;
  }
}
