import { describe, expect, it } from "vitest";

import {
  decodeJsonBytes,
  readFetchResponseBodyBounded,
} from "./bounded-fetch-response";

describe("bounded Fetch response parsing", () => {
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
});
