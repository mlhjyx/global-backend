import type { Request, Response, NextFunction } from "express";
import type { NestExpressApplication } from "@nestjs/platform-express";
import {
  PLATFORM_REVOCATION_HTTP_PATH,
  PLATFORM_FENCE_ACK_JWKS_PATH,
  PLATFORM_REVOCATION_HTTP_DEADLINE_MS,
  parsePlatformRevocationHeaders,
  revocationFailure,
  revocationErrorBody,
} from "./platform-revocation-http.contract";

export interface RevocationRequestScope {
  readonly startedAt: number;
  readonly deadlineAt: number;
  readonly signal: AbortSignal;
  readonly body: Buffer;
  assertActive(): void;
}
const scopes = new WeakMap<
  object,
  { scope: RevocationRequestScope; setBody(value: Buffer): void }
>();
export function revocationRequestScope(
  request: object,
): RevocationRequestScope {
  const scope = scopes.get(request)?.scope;
  if (!scope) return revocationFailure();
  scope.assertActive();
  return scope;
}
/** Use Nest's existing parser. Immediately remove its body/rawBody fields before
 * any route/global guard; preserve signed bytes only in the private scope. */
export function installPlatformRevocationHttpBoundary(
  app: NestExpressApplication,
): void {
  app.use(preflight);
  app.useBodyParser("raw", {
    type: (request: object) => scopes.has(request),
    limit: 16384,
    inflate: false,
  });
  app.use((request: Request, response: Response, next: NextFunction) => {
    const entry = scopes.get(request);
    if (!entry) {
      next();
      return;
    }
    const parsed: unknown = request.body;
    scrub(request);
    if (!Buffer.isBuffer(parsed)) {
      response.status(400).json(revocationErrorBody("invalid"));
      return;
    }
    entry.setBody(parsed);
    try {
      entry.scope.assertActive();
    } catch {
      parsed.fill(0);
      return;
    }
    next();
  });
  app.use(
    (
      error: unknown,
      request: Request,
      response: Response,
      next: NextFunction,
    ) => {
      if (!scopes.has(request)) {
        next(error);
        return;
      }
      scrub(request);
      response.status(400).json(revocationErrorBody("invalid"));
    },
  );
}
function scrub(request: Request) {
  delete request.body;
  delete (request as Request & { rawBody?: Buffer }).rawBody;
}
function preflight(
  request: Request,
  response: Response,
  next: NextFunction,
): void {
  const path = request.originalUrl
    .split("?", 1)[0]
    ?.toLowerCase()
    .replace(/\/+$/, "");
  if (
    path !== PLATFORM_REVOCATION_HTTP_PATH &&
    path !== PLATFORM_FENCE_ACK_JWKS_PATH
  ) {
    next();
    return;
  }
  response.setHeader("Cache-Control", "no-store");
  if (path === PLATFORM_FENCE_ACK_JWKS_PATH) {
    if (
      request.method !== "GET" ||
      request.originalUrl !== PLATFORM_FENCE_ACK_JWKS_PATH
    ) {
      response.status(400).json(revocationErrorBody("invalid"));
      return;
    }
    next();
    return;
  }
  try {
    parsePlatformRevocationHeaders({
      method: request.method,
      originalUrl: request.originalUrl,
      rawHeaders: request.rawHeaders,
    });
  } catch {
    response.setHeader("Connection", "close");
    response.status(400).json(revocationErrorBody("invalid"));
    return;
  }
  const startedAt = performance.now(),
    deadlineAt = startedAt + PLATFORM_REVOCATION_HTTP_DEADLINE_MS;
  const abort = new AbortController();
  let body: Buffer = Buffer.alloc(0);
  const stop = () => {
    abort.abort();
    body.fill(0);
    scopes.delete(request);
  };
  const timeout = setTimeout(() => {
    stop();
    response.destroy();
  }, PLATFORM_REVOCATION_HTTP_DEADLINE_MS);
  timeout.unref();
  const cleanup = () => {
    clearTimeout(timeout);
    stop();
    request.removeListener("aborted", stop);
  };
  response.once("close", cleanup);
  response.once("finish", cleanup);
  request.once("aborted", stop);
  const assertActive = () => {
    const now = performance.now();
    if (abort.signal.aborted || now < startedAt || now >= deadlineAt)
      return revocationFailure();
  };
  const scope = {
    startedAt,
    deadlineAt,
    signal: abort.signal,
    get body() {
      return body;
    },
    assertActive,
  };
  scopes.set(request, {
    scope,
    setBody(value) {
      body = value;
    },
  });
  next();
}
