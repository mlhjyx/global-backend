import { describe, expect, it } from "vitest";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { buildSiteSpecWithTemporaryFile } from "../../../api/src/site-builder/renderer-build";

// CI 构建门：每个 fixture 物化为 SITESPEC_PATH 后真实跑 astro build，
// 实例化 Section/Base/全 55 组件（不只是查 JSON）。
const fixturesDir = join(process.cwd(), "fixtures");
const fixtures = readdirSync(fixturesDir, { recursive: true })
  .filter((f): f is string => typeof f === "string" && f.endsWith("-spec.json"))
  .sort();
const TEST_SITE_ORIGIN = "https://preview.example.test";

async function runBuild(specPath: string, outDir: string): Promise<void> {
  const absoluteOutDir = join(process.cwd(), outDir);
  const spec = JSON.parse(
    readFileSync(join(process.cwd(), specPath), "utf8"),
  ) as unknown;
  mkdirSync(absoluteOutDir, { recursive: true });
  try {
    await buildSiteSpecWithTemporaryFile(spec, {
      outDir: absoluteOutDir,
      basePath: "/",
      siteOrigin: TEST_SITE_ORIGIN,
    });
  } finally {
    rmSync(absoluteOutDir, { recursive: true, force: true });
  }
}

describe("每 fixture 真实 Astro 构建（CI 构建门）", () => {
  for (const f of fixtures) {
    it(`${f}: astro build 成功（实例化全 55 组件）`, async () => {
      await expect(
        runBuild(
          join("fixtures", f),
          "dist-test-" + f.replace(/[/.]/g, "-").replace(/json$/, ""),
        ),
      ).resolves.toBeUndefined();
    }, 90000);
  }
});

describe("未知 type/preset 真实 build fail-closed 负例", () => {
  const baseSpec = {
    specVersion: "1.0.0",
    site: {
      defaultLocale: "en",
      locales: ["en"],
      theme: { preset: "modern-industrial" },
      nav: [],
      seoGlobal: { siteName: "T" },
    },
    pages: [
      {
        id: "home",
        path: "/",
        puck: { content: [], root: {} },
        seo: { titleKey: "t", descriptionKey: "d" },
      },
    ],
    assets: {},
    copyBundles: { en: { t: "T", d: "D" } },
  };

  it("未知 block.type -> astro build throw UNKNOWN_COMPONENT_TYPE", async () => {
    const spec = {
      ...baseSpec,
      pages: [
        {
          ...baseSpec.pages[0],
          puck: { content: [{ type: "UnknownType", props: {} }], root: {} },
        },
      ],
    };
    const tmp = join(fixturesDir, "__tmp-unknown-type.json");
    writeFileSync(tmp, JSON.stringify(spec));
    let err: unknown;
    try {
      await runBuild(
        "fixtures/__tmp-unknown-type.json",
        "dist-test-unknown-type",
      );
    } catch (e) {
      err = e;
    } finally {
      try {
        unlinkSync(tmp);
      } catch {
        /* noop */
      }
    }
    expect(err).toBeDefined();
    const out = String(
      (err as { stderr?: Buffer; stdout?: Buffer; message?: string })?.stderr ||
        (err as { stdout?: Buffer })?.stdout ||
        (err as { message?: string })?.message ||
        "",
    );
    expect(out).toContain("UNKNOWN_COMPONENT_TYPE");
  }, 90000);

  it("未知 theme.preset -> astro build throw UNKNOWN_STYLE_PRESET", async () => {
    const spec = {
      ...baseSpec,
      site: { ...baseSpec.site, theme: { preset: "unknown-preset" } },
    };
    const tmp = join(fixturesDir, "__tmp-unknown-preset.json");
    writeFileSync(tmp, JSON.stringify(spec));
    let err: unknown;
    try {
      await runBuild(
        "fixtures/__tmp-unknown-preset.json",
        "dist-test-unknown-preset",
      );
    } catch (e) {
      err = e;
    } finally {
      try {
        unlinkSync(tmp);
      } catch {
        /* noop */
      }
    }
    expect(err).toBeDefined();
    const out = String(
      (err as { stderr?: Buffer; stdout?: Buffer; message?: string })?.stderr ||
        (err as { stdout?: Buffer })?.stdout ||
        (err as { message?: string })?.message ||
        "",
    );
    expect(out).toContain("UNKNOWN_STYLE_PRESET");
  }, 90000);

  it("缺必填 props -> astro build fail-closed (COPY_SLOT_MISSING)", async () => {
    const spec = {
      ...baseSpec,
      pages: [
        {
          ...baseSpec.pages[0],
          puck: { content: [{ type: "HeroBanner", props: {} }], root: {} },
        },
      ],
    };
    const tmp = join(fixturesDir, "__tmp-missing-prop.json");
    writeFileSync(tmp, JSON.stringify(spec));
    let err: unknown;
    try {
      await runBuild(
        "fixtures/__tmp-missing-prop.json",
        "dist-test-missing-prop",
      );
    } catch (e) {
      err = e;
    } finally {
      try {
        unlinkSync(tmp);
      } catch {
        /* noop */
      }
    }
    expect(err).toBeDefined();
    const out = String(
      (err as { stderr?: Buffer; stdout?: Buffer; message?: string })?.stderr ||
        (err as { stdout?: Buffer })?.stdout ||
        (err as { message?: string })?.message ||
        "",
    );
    expect(out).toContain("INVALID_BLOCK_PROPS");
  }, 90000);

  it("错误 props 类型 -> astro build fail-closed (INVALID_BLOCK_PROPS)", async () => {
    const spec = {
      ...baseSpec,
      pages: [
        {
          ...baseSpec.pages[0],
          puck: {
            content: [{ type: "HeroBanner", props: { headlineKey: 123 } }],
            root: {},
          },
        },
      ],
    };
    const tmp = join(fixturesDir, "__tmp-wrong-type.json");
    writeFileSync(tmp, JSON.stringify(spec));
    let err: unknown;
    try {
      await runBuild("fixtures/__tmp-wrong-type.json", "dist-test-wrong-type");
    } catch (e) {
      err = e;
    } finally {
      try {
        unlinkSync(tmp);
      } catch {
        /* noop */
      }
    }
    expect(err).toBeDefined();
    const out = String(
      (err as { stderr?: Buffer; stdout?: Buffer; message?: string })?.stderr ||
        (err as { stdout?: Buffer })?.stdout ||
        (err as { message?: string })?.message ||
        "",
    );
    expect(out).toContain("INVALID_BLOCK_PROPS");
  }, 90000);

  it("未知字段 -> astro build fail-closed (.strict INVALID_BLOCK_PROPS)", async () => {
    const spec = {
      ...baseSpec,
      pages: [
        {
          ...baseSpec.pages[0],
          puck: {
            content: [
              {
                type: "HeroBanner",
                props: { headlineKey: "h", unknownField: "x" },
              },
            ],
            root: {},
          },
        },
      ],
    };
    const tmp = join(fixturesDir, "__tmp-unknown-field.json");
    writeFileSync(tmp, JSON.stringify(spec));
    let err: unknown;
    try {
      await runBuild(
        "fixtures/__tmp-unknown-field.json",
        "dist-test-unknown-field",
      );
    } catch (e) {
      err = e;
    } finally {
      try {
        unlinkSync(tmp);
      } catch {
        /* noop */
      }
    }
    expect(err).toBeDefined();
    const out = String(
      (err as { stderr?: Buffer; stdout?: Buffer; message?: string })?.stderr ||
        (err as { stdout?: Buffer })?.stdout ||
        (err as { message?: string })?.message ||
        "",
    );
    expect(out).toContain("INVALID_BLOCK_PROPS");
  }, 90000);

  it("未知 variant -> astro build fail-closed (z.enum INVALID_BLOCK_PROPS)", async () => {
    const spec = {
      ...baseSpec,
      pages: [
        {
          ...baseSpec.pages[0],
          puck: {
            content: [
              {
                type: "MapLocation",
                props: { titleKey: "t", addressKey: "a", variant: "unknown" },
              },
            ],
            root: {},
          },
        },
      ],
    };
    const tmp = join(fixturesDir, "__tmp-unknown-variant.json");
    writeFileSync(tmp, JSON.stringify(spec));
    let err: unknown;
    try {
      await runBuild(
        "fixtures/__tmp-unknown-variant.json",
        "dist-test-unknown-variant",
      );
    } catch (e) {
      err = e;
    } finally {
      try {
        unlinkSync(tmp);
      } catch {
        /* noop */
      }
    }
    expect(err).toBeDefined();
    const out = String(
      (err as { stderr?: Buffer; stdout?: Buffer; message?: string })?.stderr ||
        (err as { stdout?: Buffer })?.stdout ||
        (err as { message?: string })?.message ||
        "",
    );
    expect(out).toContain("INVALID_BLOCK_PROPS");
  }, 90000);
});
