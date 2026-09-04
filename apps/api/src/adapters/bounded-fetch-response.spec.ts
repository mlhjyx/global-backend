import { describe, expect, it } from "vitest";

import {
  decodeJsonBytes,
  readFetchResponseBodyBounded,
} from "./bounded-fetch-response";

describe("bounded Fetch response parsing", () => {
  it.each([0, 1.5, Number.NaN])(
    "rejects an invalid configured byte ceiling: %s",
    async (maximumBytes) => {
      await expect(readFetchResponseBodyBounded(
        new Response("{}"),
        maximumBytes,
        "RAW_RESPONSE_TOO_LARGE",
      )).rejects.toThrow("RAW_RESPONSE_TOO_LARGE");
    },
  );

  it.each(["01", "129"])(
    "rejects a malformed or excessive declared content length: %s",
    async (declared) => {
      await expect(readFetchResponseBodyBounded(
        new Response("{}", { headers: { "content-length": declared } }),
        128,
        "RAW_RESPONSE_TOO_LARGE",
      )).rejects.toThrow("RAW_RESPONSE_TOO_LARGE");
    },
  );

  it("retains a streaming body at the exact byte ceiling", async () => {
    const body = await readFetchResponseBodyBounded(
      new Response("x".repeat(128)),
      128,
      "RAW_RESPONSE_TOO_LARGE",
    );
    expect(body).toEqual(Buffer.from("x".repeat(128)));
  });

  it("stops an undeclared streaming body before JSON parsing when bytes exceed the cap", async () => {
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(80));
        controller.enqueue(new Uint8Array(49));
        controller.close();
      },
    }));

    await expect(readFetchResponseBodyBounded(
      response,
      128,
      "RAW_RESPONSE_TOO_LARGE",
    )).rejects.toThrow("RAW_RESPONSE_TOO_LARGE");
  });

  it("rejects invalid UTF-8 before handing bytes to JSON.parse", () => {
    expect(() => decodeJsonBytes(Uint8Array.of(0xff), "RAW_JSON_INVALID"))
      .toThrow("RAW_JSON_INVALID");
  });

  it("decodes a bounded valid JSON object", () => {
    expect(decodeJsonBytes(Buffer.from('{"ok":true}'), "RAW_JSON_INVALID"))
      .toEqual({ ok: true });
  });
});
