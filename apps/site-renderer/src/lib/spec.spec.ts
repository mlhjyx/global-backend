import { describe, expect, it } from "vitest";
import type { SiteSpec } from "@global/contracts";
import {
  buildStaticLocalePaths,
  localePageHref,
  localePagePathHref,
  makeT,
  safeOptionalSlot,
  siteLocaleDirection,
} from "./spec";

const spec = {
  specVersion: "1.0.0",
  site: {
    defaultLocale: "en",
    locales: ["en", "de-DE", "ar"],
    theme: { preset: "precision-light" },
    nav: [],
    seoGlobal: { siteName: "Acme" },
  },
  pages: [
    {
      id: "home",
      path: "/",
      puck: { content: [], root: {} },
      seo: { titleKey: "title", descriptionKey: "description" },
    },
    {
      id: "products",
      path: "/products",
      puck: { content: [], root: {} },
      seo: { titleKey: "title", descriptionKey: "description" },
    },
  ],
  assets: {},
  copyBundles: {
    en: { title: "English", description: "English description" },
    "de-DE": { title: "Deutsch", description: "Beschreibung" },
    ar: { title: "العربية", description: "وصف" },
  },
} satisfies SiteSpec;

describe("M1-d renderer locale contract", () => {
  it("renders default routes unprefixed and every other locale explicitly prefixed", () => {
    expect(buildStaticLocalePaths(spec)).toEqual([
      { slug: undefined, pageId: "home", locale: "en" },
      { slug: "products", pageId: "products", locale: "en" },
      { slug: "de-DE", pageId: "home", locale: "de-DE" },
      {
        slug: "de-DE/products",
        pageId: "products",
        locale: "de-DE",
      },
      { slug: "ar", pageId: "home", locale: "ar" },
      { slug: "ar/products", pageId: "products", locale: "ar" },
    ]);
  });

  it("uses exact locale bundles and never falls back to English", () => {
    expect(makeT(spec, "de-DE")("title")).toBe("Deutsch");
    expect(() => makeT(spec, "fr-FR")).toThrowError(/COPY_LOCALE_MISSING/);
    expect(() => makeT(spec, "de-DE")("missing")).toThrowError(
      /COPY_SLOT_MISSING/,
    );
  });

  it("derives direction and locale-aware links from the frozen registry", () => {
    expect(siteLocaleDirection("ar")).toBe("rtl");
    expect(siteLocaleDirection("de-DE")).toBe("ltr");
    expect(localePageHref("products", "de-DE", "en")).toBe(
      "/de-DE/products",
    );
    expect(localePageHref("home", "en", "en")).toBe("/");
    expect(localePagePathHref("/catalogue", "de-DE", "en")).toBe(
      "/de-DE/catalogue",
    );
    expect(localePagePathHref("/", "en", "en")).toBe("/");
  });
});

describe("safeOptionalSlot (Base 可选 slot 精确探测，不吞异常)", () => {
  const t = makeT(spec, "en");
  it("缺 key (COPY_SLOT_MISSING) 返回空串", () => {
    expect(safeOptionalSlot(t, "missing.key")).toBe("");
  });
  it("有 key 返回值", () => {
    expect(safeOptionalSlot(t, "title")).toBe("English");
  });
  it("非 COPY_SLOT_MISSING 异常 rethrow（不静默吞）", () => {
    const badT = () => {
      throw new Error("SOME_OTHER_ERROR: x");
    };
    expect(() => safeOptionalSlot(badT, "k")).toThrow("SOME_OTHER_ERROR");
  });
});
