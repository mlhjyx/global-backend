import { gzipSync } from "node:zlib";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  requestPublicHttp,
  type PublicHttpResponse,
} from "../adapters/guarded-http";
import { httpGetTool } from "./source-tools";

vi.mock("../adapters/guarded-http", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../adapters/guarded-http")>();
  return { ...actual, requestPublicHttp: vi.fn() };
});

const mockedRequestPublicHttp = vi.mocked(requestPublicHttp);
const artifactContext = {
  workspaceId: "workspace",
  purpose: ["discovery"] as const,
};

function successfulHttpResponse(body: Buffer): PublicHttpResponse {
  return {
    status: 200,
    ok: true,
    headers: {},
    body,
    text: "unused-by-http-get",
    finalUrl: "https://public.example/result",
  };
}

beforeEach(() => {
  mockedRequestPublicHttp.mockReset();
});

describe("http.get artifact text boundary", () => {
  it("retains a valid UTF-8 response at the exact approved byte cap", async () => {
    const body = Buffer.from("中".repeat(1_000_000), "utf8");
    expect(body.byteLength).toBe(3_000_000);
    mockedRequestPublicHttp.mockResolvedValueOnce(successfulHttpResponse(body));

    const result = await httpGetTool.execute(
      { url: "https://public.example/document.txt" },
      artifactContext,
    );

    expect(result.data.text).toHaveLength(1_000_000);
    expect(Buffer.byteLength(result.data.text, "utf8")).toBe(3_000_000);
  });

  it("rejects a raw maximum-size response that is not strict UTF-8", async () => {
    mockedRequestPublicHttp.mockResolvedValueOnce(
      successfulHttpResponse(Buffer.alloc(3_000_000, 0xff)),
    );

    await expect(
      httpGetTool.execute(
        { url: "https://public.example/document.txt" },
        artifactContext,
      ),
    ).rejects.toThrow("HTTP_GET_ARTIFACT_UTF8_INVALID");
  });

  it("rejects a gzip response whose decompressed maximum-size body is not strict UTF-8", async () => {
    mockedRequestPublicHttp.mockResolvedValueOnce(
      successfulHttpResponse(gzipSync(Buffer.alloc(3_000_000, 0xff))),
    );

    await expect(
      httpGetTool.execute(
        { url: "https://public.example/document.txt" },
        artifactContext,
      ),
    ).rejects.toThrow("HTTP_GET_ARTIFACT_UTF8_INVALID");
  });
});
