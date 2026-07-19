import { describe, expect, it } from "vitest";
import {
  COPY_GENERATION_LOCALES,
  RENDERER_LOCALES,
  resolveSiteLocale,
} from "@global/contracts";

describe("M1-d locale registry", () => {
  it("launches English and German copy generation with an Arabic RTL renderer smoke locale", () => {
    expect(COPY_GENERATION_LOCALES).toEqual(["en", "de-DE"]);
    expect(RENDERER_LOCALES).toEqual(["en", "de-DE", "ar"]);
    expect(resolveSiteLocale("ar")).toMatchObject({
      direction: "rtl",
      copyGeneration: false,
      fontFamily: "Noto Sans Arabic",
    });
  });

  it("requires canonical BCP-47 tags and never aliases unsupported locales", () => {
    expect(resolveSiteLocale("de-DE")?.direction).toBe("ltr");
    expect(resolveSiteLocale("de-de")).toBeNull();
    expect(resolveSiteLocale("fr-FR")).toBeNull();
  });
});
