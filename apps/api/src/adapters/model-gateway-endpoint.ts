import { isIP } from "node:net";

/**
 * Model gateway endpoint resolution & validation.
 *
 * Eliminates hardcoded container/host IP literals (e.g. `http://172.18.0.x:3000/v1`)
 * in favor of explicit `MODEL_GATEWAY_URL` or DNS/Compose service-name resolution
 * (`MODEL_GATEWAY_SERVICE_HOST` / `MODEL_GATEWAY_FALLBACK_URL`), while preserving
 * strict origin safety (no embedded credentials/query/fragment, no plain HTTP to
 * arbitrary public domains).
 */
export const DEFAULT_MODEL_GATEWAY_SERVICE_PORT = 3000;
export const DEFAULT_MODEL_GATEWAY_SERVICE_PATH = "/v1";
export const DEFAULT_ALLOWED_INTERNAL_GATEWAY_HOSTS = Object.freeze([
  "new-api",
  "global-new-api",
] as const);

export type ModelGatewayEndpointSource =
  | "MODEL_GATEWAY_URL"
  | "MODEL_GATEWAY_SERVICE_HOST"
  | "MODEL_GATEWAY_FALLBACK_URL"
  | "NONE";

export interface ResolvedModelGatewayEndpoint {
  readonly baseUrl: string | undefined;
  readonly source: ModelGatewayEndpointSource;
}

export interface ModelGatewayEndpointValidationResult {
  readonly ok: boolean;
  readonly url?: URL;
  readonly code?:
    | "MODEL_GATEWAY_URL_MISSING"
    | "MODEL_GATEWAY_URL_INVALID"
    | "MODEL_GATEWAY_IP_LITERAL_FORBIDDEN"
    | "MODEL_GATEWAY_ORIGIN_NOT_SECURE";
  readonly warnings: readonly string[];
}

export function isLoopbackGatewayHost(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1"
  );
}

/** True for any non-loopback IPv4/IPv6 literal (e.g. Docker bridge IP `172.18.0.5`). */
export function isNonLoopbackIpLiteral(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/gu, "").trim();
  if (!normalized || isLoopbackGatewayHost(normalized)) return false;
  return isIP(normalized) !== 0;
}

export function allowedInternalGatewayHosts(
  env: NodeJS.ProcessEnv = process.env,
): ReadonlySet<string> {
  const hosts = new Set<string>(DEFAULT_ALLOWED_INTERNAL_GATEWAY_HOSTS);
  const extra = env.MODEL_GATEWAY_ALLOWED_INTERNAL_HOSTS?.trim();
  if (extra) {
    for (const raw of extra.split(",")) {
      const host = raw.trim().toLowerCase();
      if (host && /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(host) && isIP(host) === 0) {
        hosts.add(host);
      }
    }
  }
  return hosts;
}

export function isAllowedInternalGatewayHost(
  hostname: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const normalized = hostname.replace(/\.$/u, "").toLowerCase();
  return allowedInternalGatewayHosts(env).has(normalized);
}

/**
 * Resolves the model gateway base URL with safe priority:
 *  1. `MODEL_GATEWAY_URL` (explicit deployment override)
 *  2. `MODEL_GATEWAY_SERVICE_HOST` (+ optional scheme/port/path, Compose/K8s DNS service name)
 *  3. `MODEL_GATEWAY_FALLBACK_URL` (explicit secondary endpoint when primary is unset)
 */
export function resolveModelGatewayEndpoint(
  env: NodeJS.ProcessEnv = process.env,
): ResolvedModelGatewayEndpoint {
  const explicit = env.MODEL_GATEWAY_URL?.trim();
  if (explicit) {
    return { baseUrl: explicit, source: "MODEL_GATEWAY_URL" };
  }

  const serviceHost = env.MODEL_GATEWAY_SERVICE_HOST?.trim();
  if (serviceHost) {
    const schemeRaw = (env.MODEL_GATEWAY_SERVICE_SCHEME ?? "http").trim().toLowerCase();
    const scheme = schemeRaw === "https" ? "https" : "http";
    const portRaw = env.MODEL_GATEWAY_SERVICE_PORT?.trim();
    const parsedPort = portRaw ? Number(portRaw) : DEFAULT_MODEL_GATEWAY_SERVICE_PORT;
    const port =
      Number.isInteger(parsedPort) && parsedPort >= 1 && parsedPort <= 65535
        ? parsedPort
        : DEFAULT_MODEL_GATEWAY_SERVICE_PORT;
    const rawPath = env.MODEL_GATEWAY_SERVICE_PATH?.trim() || DEFAULT_MODEL_GATEWAY_SERVICE_PATH;
    const path = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
    return {
      baseUrl: `${scheme}://${serviceHost}:${port}${path}`,
      source: "MODEL_GATEWAY_SERVICE_HOST",
    };
  }

  const fallback = env.MODEL_GATEWAY_FALLBACK_URL?.trim();
  if (fallback) {
    return { baseUrl: fallback, source: "MODEL_GATEWAY_FALLBACK_URL" };
  }

  return { baseUrl: undefined, source: "NONE" };
}

export function resolveModelGatewayBaseUrl(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return resolveModelGatewayEndpoint(env).baseUrl;
}

export interface ValidateModelGatewayEndpointOptions {
  /** Allow plain `http://` only for explicitly allowlisted Compose internal service names (e.g. `new-api`, `global-new-api`). */
  readonly allowInternalServiceHttp?: boolean;
  /** Allow non-IP plain `http://` hostnames (used by low-level provider builder tests; production admission/readiness keeps strict HTTPS/internal checks). */
  readonly allowPlainHttpHostnames?: boolean;
  /** Override IP-literal guard (defaults to `env.MODEL_GATEWAY_ALLOW_IP_LITERAL === 'true'`). */
  readonly allowIpLiteral?: boolean;
  readonly env?: NodeJS.ProcessEnv;
}

export function validateModelGatewayEndpoint(
  rawUrl: string | undefined,
  options: ValidateModelGatewayEndpointOptions = {},
): ModelGatewayEndpointValidationResult {
  const env = options.env ?? process.env;
  const trimmed = rawUrl?.trim();
  if (!trimmed) {
    return { ok: false, code: "MODEL_GATEWAY_URL_MISSING", warnings: [] };
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, code: "MODEL_GATEWAY_URL_INVALID", warnings: [] };
  }

  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    return { ok: false, code: "MODEL_GATEWAY_URL_INVALID", warnings: [] };
  }

  const warnings: string[] = [];
  const allowIpLiteral =
    options.allowIpLiteral ??
    env.MODEL_GATEWAY_ALLOW_IP_LITERAL?.trim().toLowerCase() === "true";

  if (isNonLoopbackIpLiteral(url.hostname)) {
    warnings.push("MODEL_GATEWAY_IP_LITERAL_DETECTED");
    if (!allowIpLiteral) {
      return {
        ok: false,
        code: "MODEL_GATEWAY_IP_LITERAL_FORBIDDEN",
        warnings,
      };
    }
  }

  const secureHttpAllowed =
    url.protocol === "https:" ||
    (url.protocol === "http:" &&
      (isLoopbackGatewayHost(url.hostname) ||
        options.allowPlainHttpHostnames === true ||
        (options.allowInternalServiceHttp === true &&
          isAllowedInternalGatewayHost(url.hostname, env))));

  if (!secureHttpAllowed) {
    return {
      ok: false,
      code: "MODEL_GATEWAY_ORIGIN_NOT_SECURE",
      warnings,
    };
  }

  return { ok: true, url, warnings };
}
