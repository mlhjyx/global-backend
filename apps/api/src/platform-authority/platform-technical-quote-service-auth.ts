import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { types } from "node:util";

export const PLATFORM_TECHNICAL_QUOTE_READ_SCOPE =
  "platform-technical-quote.read" as const;
export const PLATFORM_TECHNICAL_QUOTE_PATH =
  "/api/v1/platform-authority/technical-quote" as const;

export const PLATFORM_TECHNICAL_QUOTE_MAX_HEADER_BYTES = 16 * 1024;
export const PLATFORM_TECHNICAL_QUOTE_MAX_HEADER_COUNT = 64;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const PRINCIPAL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface PlatformTechnicalQuoteServiceAuthenticationRequest {
  readonly method: "POST";
  readonly normalizedPath: typeof PLATFORM_TECHNICAL_QUOTE_PATH;
  readonly headers: Readonly<Record<string, string>>;
}

export interface PlatformTechnicalQuoteServiceIdentity {
  readonly authenticationMode: "SERVICE_ONLY";
  readonly principalId: string;
  readonly scopes: readonly [typeof PLATFORM_TECHNICAL_QUOTE_READ_SCOPE];
}

export type PlatformTechnicalQuoteServiceAuthenticationReadiness =
  | Readonly<{
      readonly status: "ready";
      readonly code: "PLATFORM_TECHNICAL_QUOTE_AUTHENTICATION_READY";
    }>
  | Readonly<{
      readonly status: "not_ready";
      readonly code: "PLATFORM_TECHNICAL_QUOTE_AUTHENTICATION_UNAVAILABLE";
    }>;

export const PLATFORM_TECHNICAL_QUOTE_AUTHENTICATION_NOT_READY = Object.freeze({
  status: "not_ready" as const,
  code: "PLATFORM_TECHNICAL_QUOTE_AUTHENTICATION_UNAVAILABLE" as const,
});

export abstract class PlatformTechnicalQuoteServiceAuthenticationVerifier {
  abstract readiness(): PlatformTechnicalQuoteServiceAuthenticationReadiness;

  abstract verify(
    request: PlatformTechnicalQuoteServiceAuthenticationRequest,
  ): Promise<PlatformTechnicalQuoteServiceIdentity>;
}

export class PlatformTechnicalQuoteServiceAuthenticationDeniedError extends Error {
  constructor() {
    super("PLATFORM_TECHNICAL_QUOTE_AUTHENTICATION_DENIED");
    this.name = "PlatformTechnicalQuoteServiceAuthenticationDeniedError";
  }
}

export class PlatformTechnicalQuoteServiceAuthenticationUnavailableError extends Error {
  constructor() {
    super("PLATFORM_TECHNICAL_QUOTE_AUTHENTICATION_UNAVAILABLE");
    this.name = "PlatformTechnicalQuoteServiceAuthenticationUnavailableError";
  }
}

export class UnavailablePlatformTechnicalQuoteServiceAuthenticationVerifier extends PlatformTechnicalQuoteServiceAuthenticationVerifier {
  readiness(): PlatformTechnicalQuoteServiceAuthenticationReadiness {
    return PLATFORM_TECHNICAL_QUOTE_AUTHENTICATION_NOT_READY;
  }

  async verify(): Promise<never> {
    throw new PlatformTechnicalQuoteServiceAuthenticationUnavailableError();
  }
}

type HttpRequest = Readonly<{
  readonly method?: unknown;
  readonly originalUrl?: unknown;
  readonly rawHeaders?: unknown;
}>;

function authenticationUnavailable(): never {
  throw new ServiceUnavailableException({
    error: {
      code: "PLATFORM_TECHNICAL_QUOTE_AUTHENTICATION_UNAVAILABLE",
      message: "platform technical quote authentication is unavailable",
    },
  });
}

function authenticationDenied(): never {
  throw new UnauthorizedException({
    error: {
      code: "PLATFORM_TECHNICAL_QUOTE_AUTHENTICATION_DENIED",
      message: "platform technical quote service authentication failed",
    },
  });
}

function headersFromRaw(value: unknown): Readonly<Record<string, string>> {
  try {
    if (
      !Array.isArray(value) ||
      types.isProxy(value) ||
      Object.getPrototypeOf(value) !== Array.prototype ||
      value.length % 2 !== 0 ||
    value.length / 2 > PLATFORM_TECHNICAL_QUOTE_MAX_HEADER_COUNT
    ) {
      return authenticationDenied();
    }
    const headers: Record<string, string> = Object.create(null) as Record<
      string,
      string
    >;
    let bytes = 0;
    for (let index = 0; index < value.length; index += 2) {
      const rawName = value[index];
      const rawValue = value[index + 1];
      if (
        typeof rawName !== "string" ||
        typeof rawValue !== "string" ||
        !HEADER_NAME.test(rawName) ||
        /[\0\r\n]/.test(rawValue)
      ) {
        return authenticationDenied();
      }
      const name = rawName.toLowerCase();
      if (Object.hasOwn(headers, name)) return authenticationDenied();
      bytes +=
        Buffer.byteLength(rawName, "utf8") +
        Buffer.byteLength(rawValue, "utf8") +
        4;
      if (bytes > PLATFORM_TECHNICAL_QUOTE_MAX_HEADER_BYTES) {
        return authenticationDenied();
      }
      headers[name] = rawValue;
    }
    return Object.freeze({ ...headers });
  } catch {
    return authenticationDenied();
  }
}

function authenticationRequest(
  request: HttpRequest,
): PlatformTechnicalQuoteServiceAuthenticationRequest {
  try {
    if (
      request.method !== "POST" ||
      request.originalUrl !== PLATFORM_TECHNICAL_QUOTE_PATH
    ) {
      return authenticationDenied();
    }
    return Object.freeze({
      method: "POST" as const,
      normalizedPath: PLATFORM_TECHNICAL_QUOTE_PATH,
      headers: headersFromRaw(request.rawHeaders),
    });
  } catch {
    return authenticationDenied();
  }
}

function validIdentity(
  value: unknown,
): value is PlatformTechnicalQuoteServiceIdentity {
  try {
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      types.isProxy(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    ) {
      return false;
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (
      Reflect.ownKeys(descriptors).some((key) => typeof key !== "string") ||
      Object.keys(descriptors).sort().join("\0") !==
        ["authenticationMode", "principalId", "scopes"].sort().join("\0")
    ) {
      return false;
    }
    for (const key of ["authenticationMode", "principalId", "scopes"] as const) {
      const descriptor = descriptors[key];
      if (
        !descriptor?.enumerable ||
        !Object.hasOwn(descriptor, "value") ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined
      ) {
        return false;
      }
    }
    const identity = value as Readonly<Record<string, unknown>>;
    const scopes = identity.scopes;
    return (
      identity.authenticationMode === "SERVICE_ONLY" &&
      typeof identity.principalId === "string" &&
      PRINCIPAL_ID.test(identity.principalId) &&
      Array.isArray(scopes) &&
      !types.isProxy(scopes) &&
      Object.getPrototypeOf(scopes) === Array.prototype &&
      scopes.length === 1 &&
      scopes[0] === PLATFORM_TECHNICAL_QUOTE_READ_SCOPE
    );
  } catch {
    return false;
  }
}

@Injectable()
export class PlatformTechnicalQuoteServiceAuthenticationGuard
  implements CanActivate
{
  constructor(
    private readonly verifier: PlatformTechnicalQuoteServiceAuthenticationVerifier,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    let readiness: PlatformTechnicalQuoteServiceAuthenticationReadiness;
    try {
      readiness = this.verifier.readiness();
    } catch {
      return authenticationUnavailable();
    }
    if (
      readiness.status !== "ready" ||
      readiness.code !== "PLATFORM_TECHNICAL_QUOTE_AUTHENTICATION_READY"
    ) {
      return authenticationUnavailable();
    }

    const request = context.switchToHttp().getRequest<HttpRequest>();
    const boundedRequest = authenticationRequest(request);
    let verified: PlatformTechnicalQuoteServiceIdentity;
    try {
      verified = await this.verifier.verify(boundedRequest);
    } catch (error) {
      if (error instanceof PlatformTechnicalQuoteServiceAuthenticationDeniedError) {
        return authenticationDenied();
      }
      return authenticationUnavailable();
    }
    if (!validIdentity(verified)) return authenticationDenied();
    return true;
  }
}
