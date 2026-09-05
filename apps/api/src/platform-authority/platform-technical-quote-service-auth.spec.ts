import type { ExecutionContext } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import {
  PLATFORM_TECHNICAL_QUOTE_AUTHENTICATION_READINESS_CONTRIBUTOR,
  PLATFORM_TECHNICAL_QUOTE_READ_SCOPE,
  PlatformTechnicalQuoteAuthenticationReadinessContributor,
  PlatformTechnicalQuoteServiceAuthenticationGuard,
  PlatformTechnicalQuoteServiceAuthenticationVerifier,
  UnavailablePlatformTechnicalQuoteServiceAuthenticationVerifier,
} from "./platform-technical-quote-service-auth";
import { RuntimeReadinessContributorRegistry } from "../runtime/runtime-readiness-registry";

const PATH = "/api/v1/platform-authority/technical-quote";

function context(
  overrides: Readonly<Record<string, unknown>> = {},
): ExecutionContext {
  const request = {
    method: "POST",
    originalUrl: PATH,
    headers: {
      host: "backend.internal",
      "content-type": "application/json",
      "content-length": "2",
    },
    rawHeaders: [
      "Host",
      "backend.internal",
      "Content-Type",
      "application/json",
      "Content-Length",
      "2",
    ],
    rawBody: Buffer.from("{}", "utf8"),
    ...overrides,
  };
  return {
    getType: () => "http",
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function verifier(
  verify: PlatformTechnicalQuoteServiceAuthenticationVerifier["verify"],
): PlatformTechnicalQuoteServiceAuthenticationVerifier {
  return {
    readiness: () => Object.freeze({
      status: "ready",
      code: "PLATFORM_TECHNICAL_QUOTE_AUTHENTICATION_READY",
    }),
    verify,
  } as PlatformTechnicalQuoteServiceAuthenticationVerifier;
}

describe("PlatformTechnicalQuoteServiceAuthenticationGuard", () => {
  it("keeps production composition unavailable without a dedicated verifier", async () => {
    const guard = new PlatformTechnicalQuoteServiceAuthenticationGuard(
      new UnavailablePlatformTechnicalQuoteServiceAuthenticationVerifier(),
    );

    await expect(guard.canActivate(context())).rejects.toMatchObject({
      status: 503,
      response: {
        error: {
          code: "PLATFORM_TECHNICAL_QUOTE_AUTHENTICATION_UNAVAILABLE",
        },
      },
    });
  });

  it("accepts only the exact dedicated service identity and scope", async () => {
    const verify = vi.fn(async () => Object.freeze({
      authenticationMode: "SERVICE_ONLY" as const,
      principalId: "growthos-platform-authority",
      scopes: Object.freeze([PLATFORM_TECHNICAL_QUOTE_READ_SCOPE]),
    }));
    const guard = new PlatformTechnicalQuoteServiceAuthenticationGuard(
      verifier(verify),
    );

    await expect(guard.canActivate(context())).resolves.toBe(true);
    expect(verify).toHaveBeenCalledOnce();
    const input = verify.mock.calls[0]![0] as unknown as Record<string, unknown>;
    expect(input).toEqual({
      method: "POST",
      normalizedPath: PATH,
      headers: {
        host: "backend.internal",
        "content-type": "application/json",
        "content-length": "2",
      },
    });
    expect(input).not.toHaveProperty("body");
    expect(input).not.toHaveProperty("rawBody");
    expect(Object.isFrozen(input)).toBe(true);
    expect(Object.isFrozen(input.headers)).toBe(true);
  });

  it.each([
    ["identity bearer mode", {
      authenticationMode: "IDENTITY_BEARER",
      principalId: "user",
      scopes: [PLATFORM_TECHNICAL_QUOTE_READ_SCOPE],
    }],
    ["workspace scope", {
      authenticationMode: "SERVICE_ONLY",
      principalId: "growthos-platform-authority",
      scopes: ["acquisition:read"],
    }],
    ["extra scope", {
      authenticationMode: "SERVICE_ONLY",
      principalId: "growthos-platform-authority",
      scopes: [PLATFORM_TECHNICAL_QUOTE_READ_SCOPE, "platform-authority.issue"],
    }],
    ["unbounded principal", {
      authenticationMode: "SERVICE_ONLY",
      principalId: "x".repeat(129),
      scopes: [PLATFORM_TECHNICAL_QUOTE_READ_SCOPE],
    }],
  ])("rejects %s without an identity fallback", async (_label, identity) => {
    const guard = new PlatformTechnicalQuoteServiceAuthenticationGuard(
      verifier(async () => identity as never),
    );

    await expect(guard.canActivate(context())).rejects.toMatchObject({
      status: 401,
      response: {
        error: { code: "PLATFORM_TECHNICAL_QUOTE_AUTHENTICATION_DENIED" },
      },
    });
  });

  it("maps verifier failures to one unavailable error without leaking detail", async () => {
    const guard = new PlatformTechnicalQuoteServiceAuthenticationGuard(
      verifier(async () => {
        throw new Error("secret service credential detail");
      }),
    );

    const caught = await guard
      .canActivate(context())
      .then(() => undefined)
      .catch((error: unknown) => error);
    expect(caught).toMatchObject({
      status: 503,
      response: {
        error: {
          code: "PLATFORM_TECHNICAL_QUOTE_AUTHENTICATION_UNAVAILABLE",
        },
      },
    });
    expect(JSON.stringify(caught)).not.toContain("secret service credential detail");
  });

  it("bounds and disambiguates headers before the verifier sees them", async () => {
    const verify = vi.fn();
    const guard = new PlatformTechnicalQuoteServiceAuthenticationGuard(
      verifier(verify),
    );
    const duplicate = context({
      rawHeaders: ["X-Service", "one", "X-Service", "two"],
      headers: { "x-service": "one, two" },
    });
    const oversized = context({
      rawHeaders: ["X-Service", "x".repeat(16_385)],
      headers: { "x-service": "x".repeat(16_385) },
    });
    const query = context({ originalUrl: `${PATH}?token=forbidden` });
    const sixtyFiveHeaders = Array.from({ length: 65 }, (_, index) => [
      `X-Bounded-${index}`,
      "value",
    ]).flat();
    const tooMany = context({ rawHeaders: sixtyFiveHeaders });

    for (const request of [duplicate, oversized, query, tooMany]) {
      await expect(guard.canActivate(request)).rejects.toMatchObject({
        status: 401,
        response: {
          error: { code: "PLATFORM_TECHNICAL_QUOTE_AUTHENTICATION_DENIED" },
        },
      });
    }
    expect(verify).not.toHaveBeenCalled();
  });

  it("maps hostile raw-header accessors to denial without leaking their error", async () => {
    const verify = vi.fn();
    const guard = new PlatformTechnicalQuoteServiceAuthenticationGuard(
      verifier(verify),
    );
    const rawHeaders = ["X-Service", "value"];
    Object.defineProperty(rawHeaders, "0", {
      enumerable: true,
      get: () => {
        throw new Error("secret header detail");
      },
    });

    const caught = await guard
      .canActivate(context({ rawHeaders }))
      .then(() => undefined)
      .catch((error: unknown) => error);
    expect(caught).toMatchObject({
      status: 401,
      response: {
        error: { code: "PLATFORM_TECHNICAL_QUOTE_AUTHENTICATION_DENIED" },
      },
    });
    expect(JSON.stringify(caught)).not.toContain("secret header detail");
    expect(verify).not.toHaveBeenCalled();
  });

  it.each([
    ["null", () => null],
    ["extra field", () => ({
      status: "ready",
      code: "PLATFORM_TECHNICAL_QUOTE_AUTHENTICATION_READY",
      extra: "forbidden",
    })],
    ["proxy", () => new Proxy(
      {
        status: "ready",
        code: "PLATFORM_TECHNICAL_QUOTE_AUTHENTICATION_READY",
      },
      {
        get: () => {
          throw new Error("secret readiness proxy detail");
        },
      },
    )],
    ["throwing getter", () => {
      const value: Record<string, unknown> = {
        code: "PLATFORM_TECHNICAL_QUOTE_AUTHENTICATION_READY",
      };
      Object.defineProperty(value, "status", {
        enumerable: true,
        get: () => {
          throw new Error("secret readiness getter detail");
        },
      });
      return value;
    }],
  ])("maps a malformed %s readiness result to stable unavailable", async (_label, make) => {
    const verify = vi.fn();
    const guard = new PlatformTechnicalQuoteServiceAuthenticationGuard({
      readiness: make as never,
      verify,
    } as PlatformTechnicalQuoteServiceAuthenticationVerifier);

    const caught = await guard
      .canActivate(context())
      .then(() => undefined)
      .catch((error: unknown) => error);
    expect(caught).toMatchObject({
      status: 503,
      response: {
        error: {
          code: "PLATFORM_TECHNICAL_QUOTE_AUTHENTICATION_UNAVAILABLE",
        },
      },
    });
    expect(JSON.stringify(caught)).not.toContain("secret readiness");
    expect(verify).not.toHaveBeenCalled();
  });

  it("registers an independently consumable quote-auth readiness fact", async () => {
    const unavailableRegistry = new RuntimeReadinessContributorRegistry();
    const unavailable = new PlatformTechnicalQuoteAuthenticationReadinessContributor(
      new UnavailablePlatformTechnicalQuoteServiceAuthenticationVerifier(),
      unavailableRegistry,
    );
    unavailable.onModuleInit();
    await expect(
      unavailableRegistry.check(
        PLATFORM_TECHNICAL_QUOTE_AUTHENTICATION_READINESS_CONTRIBUTOR,
      ),
    ).resolves.toEqual({
      status: "failed",
      code: "PLATFORM_TECHNICAL_QUOTE_AUTHENTICATION_UNAVAILABLE",
    });
    unavailable.onModuleDestroy();

    const readyRegistry = new RuntimeReadinessContributorRegistry();
    const ready = new PlatformTechnicalQuoteAuthenticationReadinessContributor(
      verifier(async () => ({
        authenticationMode: "SERVICE_ONLY",
        principalId: "growthos-platform-authority",
        scopes: [PLATFORM_TECHNICAL_QUOTE_READ_SCOPE],
      })),
      readyRegistry,
    );
    ready.onModuleInit();
    await expect(
      readyRegistry.check(
        PLATFORM_TECHNICAL_QUOTE_AUTHENTICATION_READINESS_CONTRIBUTOR,
      ),
    ).resolves.toEqual({ status: "ok" });
    ready.onModuleDestroy();
    await expect(
      readyRegistry.check(
        PLATFORM_TECHNICAL_QUOTE_AUTHENTICATION_READINESS_CONTRIBUTOR,
      ),
    ).resolves.toEqual({
      status: "failed",
      code: "READINESS_CONTRIBUTOR_MISSING",
    });
  });
});
