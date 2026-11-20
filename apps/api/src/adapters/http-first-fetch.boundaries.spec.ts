import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("./guarded-http", () => ({ requestPublicHttp: vi.fn() }));
import { requestPublicHttp } from "./guarded-http";
import { fetchPageHttpFirst } from "./http-first-fetch";
const html = `<html><head><title>Acme Pumps GmbH</title></head><body><article><h1>Acme Pumps GmbH</h1><p>Country: Germany</p><p>employee@acme.example</p><p>${"Industrial distribution support and approved profile description. ".repeat(6)}</p></article></body></html>`;
afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
});
function response(
  status = 200,
  contentType = "text/html",
  body = Buffer.from(html),
) {
  vi.mocked(requestPublicHttp).mockResolvedValue({
    status,
    headers: {
      "content-type": contentType,
      etag: '"original"',
      "last-modified": "Thu, 19 Nov 2026 10:00:00 GMT",
    },
    body,
  } as never);
}
describe("HTTP-first guarded transport contract", () => {
  it("requests exactly one guarded HTTP response with no redirect/cache and preserves both existing wire hooks", async () => {
    response();
    const hooks = {
      authorizeExternalAction: vi.fn(async () => true),
      beforePhysicalWire: vi.fn(async () => undefined),
    };
    const page = await fetchPageHttpFirst(
      "https://manufacturer.example/location",
      { exactUrl: true, profileTextRevision: "manufacturer-profile/v1", hooks },
    );
    expect(page?.markdown).toContain("# Acme Pumps GmbH");
    expect(requestPublicHttp).toHaveBeenCalledOnce();
    expect(requestPublicHttp).toHaveBeenCalledWith(
      "https://manufacturer.example/location",
      expect.objectContaining({
        method: "GET",
        timeoutMs: 15000,
        maxBytes: 3000000,
        maxRedirects: 0,
      }),
      hooks,
    );
  });
  it.each([304, 302, 500])(
    "does not convert non-200 exact responses %s",
    async (status) => {
      response(status);
      expect(
        await fetchPageHttpFirst("https://manufacturer.example/location", {
          exactUrl: true,
          profileTextRevision: "manufacturer-profile/v1",
        }),
      ).toBeNull();
    },
  );
  it("keeps normal redirects and conditional request validators for the legacy cache path", async () => {
    response(304);
    const cached = {
      markdown: "Original cached text",
      contentHash: "a".repeat(64),
      etag: '"original"',
      lastModified: "Thu, 19 Nov 2026 10:00:00 GMT",
    };
    const port = { get: vi.fn(async () => cached), put: vi.fn() };
    expect(
      await fetchPageHttpFirst("https://acme.example/", {
        cache: { workspaceId: "test", port },
      }),
    ).toMatchObject({
      markdown: cached.markdown,
      fromCache: "conditional-304",
    });
    expect(requestPublicHttp).toHaveBeenCalledWith(
      "https://acme.example/",
      expect.objectContaining({
        maxRedirects: 5,
        headers: expect.objectContaining({
          "If-None-Match": cached.etag,
          "If-Modified-Since": cached.lastModified,
        }),
      }),
      undefined,
    );
    expect(port.put).not.toHaveBeenCalled();
  });
  it.each(["windows-1252", "invalid-charset"])(
    "decodes a declared %s encoding within the same response",
    async (charset) => {
      response(
        200,
        `text/html; charset=${charset}`,
        Buffer.from(html.replace("Acme Pumps", "Acme Pümpen"), "latin1"),
      );
      expect(await fetchPageHttpFirst("https://acme.example/")).not.toBeNull();
    },
  );
  it.each(["not-a-number", "-1", "0"])(
    "handles the existing minimum-character configuration %s",
    async (value) => {
      vi.stubEnv("HTTP_FIRST_MIN_CHARS", value);
      response();
      expect(await fetchPageHttpFirst("https://acme.example/")).not.toBeNull();
    },
  );
  it("returns no profile if the guarded transport itself fails", async () => {
    vi.mocked(requestPublicHttp).mockRejectedValue(
      new Error("WIRE_UNAVAILABLE"),
    );
    expect(
      await fetchPageHttpFirst("https://manufacturer.example/location", {
        exactUrl: true,
        profileTextRevision: "manufacturer-profile/v1",
      }),
    ).toBeNull();
  });
});
