import { describe, expect, it } from "vitest";
import {
  isAllowedInternalGatewayHost,
  isNonLoopbackIpLiteral,
  resolveModelGatewayBaseUrl,
  resolveModelGatewayEndpoint,
  validateModelGatewayEndpoint,
} from "./model-gateway-endpoint";

describe("model-gateway-endpoint", () => {
  it("resolves MODEL_GATEWAY_URL, service-name host, and explicit fallback in order", () => {
    expect(
      resolveModelGatewayEndpoint({
        MODEL_GATEWAY_URL: "http://127.0.0.1:3001/v1",
        MODEL_GATEWAY_SERVICE_HOST: "global-new-api",
      }),
    ).toEqual({
      baseUrl: "http://127.0.0.1:3001/v1",
      source: "MODEL_GATEWAY_URL",
    });

    expect(
      resolveModelGatewayEndpoint({
        MODEL_GATEWAY_SERVICE_HOST: "global-new-api",
        MODEL_GATEWAY_SERVICE_PORT: "3000",
      }),
    ).toEqual({
      baseUrl: "http://global-new-api:3000/v1",
      source: "MODEL_GATEWAY_SERVICE_HOST",
    });

    expect(
      resolveModelGatewayEndpoint({
        MODEL_GATEWAY_FALLBACK_URL: "https://gateway.internal.example/v1",
      }),
    ).toEqual({
      baseUrl: "https://gateway.internal.example/v1",
      source: "MODEL_GATEWAY_FALLBACK_URL",
    });

    expect(resolveModelGatewayBaseUrl({})).toBeUndefined();
  });

  it("rejects hardcoded non-loopback IP literals by default to prevent fragile container IP drift", () => {
    expect(isNonLoopbackIpLiteral("172.18.0.5")).toBe(true);
    expect(isNonLoopbackIpLiteral("10.0.0.12")).toBe(true);
    expect(isNonLoopbackIpLiteral("127.0.0.1")).toBe(false);
    expect(isNonLoopbackIpLiteral("::1")).toBe(false);
    expect(isNonLoopbackIpLiteral("global-new-api")).toBe(false);

    const rejected = validateModelGatewayEndpoint("http://172.18.0.5:3000/v1", {
      allowInternalServiceHttp: true,
      env: {},
    });
    expect(rejected).toMatchObject({
      ok: false,
      code: "MODEL_GATEWAY_IP_LITERAL_FORBIDDEN",
      warnings: ["MODEL_GATEWAY_IP_LITERAL_DETECTED"],
    });

    const httpsIpRejected = validateModelGatewayEndpoint("https://172.18.0.5/v1", {
      env: {},
    });
    expect(httpsIpRejected.ok).toBe(false);
    expect(httpsIpRejected.code).toBe("MODEL_GATEWAY_IP_LITERAL_FORBIDDEN");
  });

  it("permits Compose service-name HTTP for allowlisted hosts while still rejecting arbitrary plain HTTP hosts", () => {
    expect(isAllowedInternalGatewayHost("new-api", {})).toBe(true);
    expect(isAllowedInternalGatewayHost("global-new-api", {})).toBe(true);
    expect(isAllowedInternalGatewayHost("gateway.example.test", {})).toBe(false);

    const internalOk = validateModelGatewayEndpoint("http://global-new-api:3000/v1", {
      allowInternalServiceHttp: true,
      env: {},
    });
    expect(internalOk.ok).toBe(true);
    expect(internalOk.url?.href).toBe("http://global-new-api:3000/v1");

    const customHostOk = validateModelGatewayEndpoint("http://llm-router.internal:3000/v1", {
      allowInternalServiceHttp: true,
      env: { MODEL_GATEWAY_ALLOWED_INTERNAL_HOSTS: "llm-router.internal" },
    });
    expect(customHostOk.ok).toBe(true);

    const publicHttpRejected = validateModelGatewayEndpoint("http://gateway.example.test/v1", {
      allowInternalServiceHttp: true,
      env: {},
    });
    expect(publicHttpRejected).toMatchObject({
      ok: false,
      code: "MODEL_GATEWAY_ORIGIN_NOT_SECURE",
    });
  });

  it("rejects credentials, query strings, and fragments in gateway URLs", () => {
    for (const bad of [
      "https://user:pass@gateway.example.test/v1",
      "https://gateway.example.test/v1?redirect=evil",
      "https://gateway.example.test/v1#frag",
      "ftp://127.0.0.1:3001/v1",
    ]) {
      expect(
        validateModelGatewayEndpoint(bad, { allowInternalServiceHttp: true, env: {} }),
      ).toMatchObject({ ok: false, code: "MODEL_GATEWAY_URL_INVALID" });
    }
  });
});
