import { describe, expect, it } from "vitest";
import {
  parsePlatformRevocationRequest,
  PLATFORM_REVOCATION_HTTP_PATH,
} from "./platform-revocation-http.contract";

const request = () => ({
  method: "POST",
  originalUrl: PLATFORM_REVOCATION_HTTP_PATH,
  rawHeaders: ["Content-Type", "application/jose", "Content-Length", "5"],
  rawBody: Buffer.from("a.b.c"),
});
describe("revocation transport pre-authentication bounds", () => {
  it("preserves compact bytes without trimming or interpreting claims", () => {
    expect(parsePlatformRevocationRequest(request())).toBe("a.b.c");
  });
  it.each([
    { method: "GET" },
    { originalUrl: PLATFORM_REVOCATION_HTTP_PATH + "/" },
    { originalUrl: PLATFORM_REVOCATION_HTTP_PATH + "?token=hidden" },
    { rawBody: Buffer.alloc(16385, 65) },
    { rawBody: Buffer.from(" a.b.c") },
    { rawBody: Buffer.from("a.b.c\n") },
    { rawBody: Buffer.from([255]) },
    { rawBody: "a.b.c" },
    { rawHeaders: ["Content-Type", "application/json"] },
    {
      rawHeaders: [
        "Content-Type",
        "application/jose",
        "content-type",
        "application/jose",
      ],
    },
    {
      rawHeaders: [
        "Content-Type",
        "application/jose",
        "Content-Encoding",
        "gzip",
      ],
    },
    {
      rawHeaders: [
        "Content-Type",
        "application/jose",
        "Transfer-Encoding",
        "chunked",
      ],
    },
    {
      rawHeaders: [
        "Content-Type",
        "application/jose",
        "Authorization",
        "Bearer user",
      ],
    },
    { rawHeaders: ["Content-Type", "application/jose", "Cookie", "session=x"] },
    { rawHeaders: ["Content-Type", "application/jose", "Content-Length", "4"] },
    {
      rawHeaders: ["Content-Type", "application/jose", "Content-Length", "05"],
    },
    {
      rawHeaders: [
        "Content-Type",
        "application/jose",
        "X-Test",
        "x".repeat(32768),
      ],
    },
    { rawHeaders: ["Content-Type"] },
  ])("rejects ambiguous or oversized input without echoing it", (change) => {
    expect(() =>
      parsePlatformRevocationRequest({ ...request(), ...change }),
    ).toThrow("PLATFORM_REVOCATION_REQUEST_INVALID");
  });
});
