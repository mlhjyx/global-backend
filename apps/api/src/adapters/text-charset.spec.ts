import {
  brotliCompressSync,
  deflateRawSync,
  deflateSync,
  gzipSync,
} from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  decodeHttpTextWithCharset,
  decompressHttpBody,
} from "./bounded-fetch-response";
import { EgressBlockedError } from "./url-guard";

describe("decodeHttpTextWithCharset", () => {
  it("decodes Windows-1252 / ISO-8859-1 declared in Content-Type", () => {
    // "Müller GmbH — Pumpen" in windows-1252 (ü = 0xfc, — = 0x97)
    const raw = Buffer.from([
      0x4d, 0xfc, 0x6c, 0x6c, 0x65, 0x72, 0x20, 0x47, 0x6d, 0x62, 0x48, 0x20,
      0x97, 0x20, 0x50, 0x75, 0x6d, 0x70, 0x65, 0x6e,
    ]);
    const text = decodeHttpTextWithCharset(
      raw,
      "text/html; charset=windows-1252",
      { strictWithoutDeclaredCharset: true },
    );
    expect(text).toBe("Müller GmbH — Pumpen");
  });

  it("decodes Shift_JIS declared via HTML meta tag", () => {
    const htmlHead = Buffer.from('<meta charset="shift_jis">', "ascii");
    // "太陽" in Shift_JIS: 0x91 0xbe 0x97 0x7a
    const body = Buffer.concat([htmlHead, Buffer.from([0x91, 0xbe, 0x97, 0x7a])]);
    const text = decodeHttpTextWithCharset(body, "text/html", {
      strictWithoutDeclaredCharset: true,
    });
    expect(text).toContain("太陽");
  });

  it("falls back to windows-1252 for unlabeled HTML when strict mode is off", () => {
    const raw = Buffer.from([0x4d, 0xfc, 0x6c, 0x6c, 0x65, 0x72]);
    expect(decodeHttpTextWithCharset(raw, "text/html")).toBe("Müller");
  });

  it("fails closed on unlabeled invalid UTF-8 when strict mode is on", () => {
    const raw = Buffer.from([0xff, 0xfe, 0xff]);
    expect(() =>
      decodeHttpTextWithCharset(raw, undefined, {
        strictWithoutDeclaredCharset: true,
      }),
    ).toThrow();
  });
});

describe("decompressHttpBody", () => {
  it("decompresses gzip, deflate, raw deflate, and brotli within maxBytes", () => {
    const payload = Buffer.from("Liansheng PV HJT 720W solar module specification", "utf8");
    expect(decompressHttpBody(gzipSync(payload), "gzip", 4096).equals(payload)).toBe(true);
    expect(decompressHttpBody(deflateSync(payload), "deflate", 4096).equals(payload)).toBe(true);
    expect(decompressHttpBody(deflateRawSync(payload), "deflate", 4096).equals(payload)).toBe(true);
    expect(decompressHttpBody(brotliCompressSync(payload), "br", 4096).equals(payload)).toBe(true);
  });

  it("blocks decompression bombs exceeding maxBytes", () => {
    const bomb = gzipSync(Buffer.alloc(128 * 1024, 0x41));
    expect(() => decompressHttpBody(bomb, "gzip", 4096)).toThrow(EgressBlockedError);
    try {
      decompressHttpBody(bomb, "gzip", 4096);
    } catch (error) {
      expect((error as EgressBlockedError).code).toBe("response_too_large");
    }
  });

  it("blocks excessively stacked or unsupported encodings", () => {
    const payload = gzipSync(Buffer.from("hi"));
    expect(() => decompressHttpBody(payload, "gzip, br, deflate", 4096)).toThrow(
      EgressBlockedError,
    );
    expect(() => decompressHttpBody(payload, "zstd", 4096)).toThrow(
      EgressBlockedError,
    );
  });
});
