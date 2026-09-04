import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  buildRendererEnv,
  buildSiteSpecWithTemporaryFile,
  assertRendererOutputMatches,
  assertRenderedOutboundDomains,
  linkRendererDependencies,
  prepareRendererBuildWorkspace,
  prepareRendererCacheRoot,
  resolveRendererEntrypoint,
  writeRendererOutputManifest,
  type RendererBuildInput,
} from "./renderer-build";
const SITE_ORIGIN = "https://preview.example.test";

async function expectMissing(filePath: string): Promise<void> {
  await expect(access(filePath)).rejects.toMatchObject({ code: "ENOENT" });
}

describe("buildRendererEnv — Renderer 子进程最小环境", () => {
  it("skips nonexistent candidate roots before resolving the hoisted Astro package", () => {
    expect(resolveRendererEntrypoint(process.cwd()).rendererRoot).toBe(
      path.resolve(process.cwd(), "..", "site-renderer"),
    );
  });

  it("只包含确定性构建变量，不继承数据库、对象存储或模型密钥", () => {
    const env = buildRendererEnv({
      specPath: "/tmp/spec.json",
      outDir: "/tmp/out",
      cacheRoot: "/tmp/build-owned/.renderer-cache",
      basePath: "/preview/acme/",
      siteOrigin: SITE_ORIGIN,
    });

    expect(env).toEqual({
      NODE_ENV: "production",
      LANG: "C.UTF-8",
      TZ: "UTC",
      SITESPEC_PATH: "/tmp/spec.json",
      OUT_DIR: "/tmp/out",
      RENDERER_CACHE_ROOT: "/tmp/build-owned/.renderer-cache",
      BASE_PATH: "/preview/acme/",
      SITE_ORIGIN,
      ASTRO_TELEMETRY_DISABLED: "1",
    });
    expect(env).not.toHaveProperty("DATABASE_URL");
    expect(env).not.toHaveProperty("S3_SECRET_KEY");
    expect(env).not.toHaveProperty("NEW_API_KEY");
    expect(env).not.toHaveProperty("PATH");
    expect(env).not.toHaveProperty("HOME");
    expect(env).not.toHaveProperty("NODE_OPTIONS");
  });

  it("只按显式输入传递一次性 public asset overlay", () => {
    expect(
      buildRendererEnv({
        specPath: "/tmp/spec.json",
        outDir: "/tmp/out",
        cacheRoot: "/tmp/build-owned/.renderer-cache",
        basePath: "/",
        siteOrigin: SITE_ORIGIN,
        publicAssetDir: "/tmp/overlay",
      }),
    ).toMatchObject({
      PUBLIC_ASSET_DIR: "/tmp/overlay",
    });
  });
});

describe("rendered outbound-domain gate", () => {
  it("allows internal/self-hosted assets and explicitly approved HTTPS domains only", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "m1d-outbound-"));
    try {
      await writeFile(
        path.join(dir, "index.html"),
        '<!-- vendored license: https://remixicon.com --><!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd"><svg xmlns="http://www.w3.org/2000/svg"></svg><a href="/contact">local</a><style>@font-face{src:url(data:font/woff2;base64,abc//+v6p4f1u9glr58yni)}</style><img src="data:image/png;base64,x"><a href="https://docs.example.com/x">docs</a>',
      );
      await expect(
        assertRenderedOutboundDomains(dir, ["docs.example.com"]),
      ).resolves.toBeUndefined();

      await writeFile(
        path.join(dir, "app.js"),
        'fetch("https://tracker.invalid/collect")',
      );
      await expect(
        assertRenderedOutboundDomains(dir, ["docs.example.com"]),
      ).rejects.toThrowError(/RENDERER_OUTBOUND_DOMAIN_FORBIDDEN/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("allows schema vocabulary only inside JSON-LD, not navigable links", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "m1f-schema-domain-"));
    try {
      await writeFile(
        path.join(dir, "index.html"),
        '<script type="application/ld+json">{"@context":"https://schema.org"}</script>',
      );
      await expect(
        assertRenderedOutboundDomains(dir, [], SITE_ORIGIN),
      ).resolves.toBeUndefined();
      await writeFile(
        path.join(dir, "index.html"),
        '<a href="https://schema.org/escape">escape</a>',
      );
      await expect(
        assertRenderedOutboundDomains(dir, [], SITE_ORIGIN),
      ).rejects.toThrow("RENDERER_OUTBOUND_DOMAIN_FORBIDDEN");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("redacts credentials and query values from rejected URLs", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "m1g-url-redaction-"));
    try {
      await writeFile(
        path.join(dir, "index.html"),
        '<a href="https://user:secret@evil.example/path?token=private#fragment">x</a>',
      );
      const caught = await assertRenderedOutboundDomains(
        dir,
        [],
        SITE_ORIGIN,
      ).catch((error: unknown) => error);
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toContain(
        "RENDERER_OUTBOUND_DOMAIN_FORBIDDEN: evil.example",
      );
      expect((caught as Error).message).not.toMatch(
        /user|secret|token|private|fragment/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("renderer output candidate binding", () => {
  it("binds the complete bounded output tree to the candidate and detects mutation", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "m1f-render-tree-"));
    const candidateSpecDigest = "a".repeat(64);
    try {
      await writeFile(path.join(dir, "index.html"), "<h1>candidate A</h1>");
      const manifest = await writeRendererOutputManifest({
        root: dir,
        candidateSpecDigest,
        basePath: "/preview/acme/",
        siteOrigin: SITE_ORIGIN,
      });
      await expect(
        assertRendererOutputMatches({
          root: dir,
          candidateSpecDigest,
          basePath: "/preview/acme/",
          siteOrigin: SITE_ORIGIN,
          treeDigest: manifest.treeDigest,
        }),
      ).resolves.toEqual(manifest);

      await writeFile(
        path.join(dir, ".site-builder-render-output.json.tmp"),
        "incomplete",
      );
      await expect(
        assertRendererOutputMatches({
          root: dir,
          candidateSpecDigest,
          basePath: "/preview/acme/",
          siteOrigin: SITE_ORIGIN,
          treeDigest: manifest.treeDigest,
        }),
      ).rejects.toThrow("RENDERER_OUTPUT_TREE_MISMATCH");
      await rm(path.join(dir, ".site-builder-render-output.json.tmp"));

      await writeFile(path.join(dir, "index.html"), "<h1>stale output</h1>");
      await expect(
        assertRendererOutputMatches({
          root: dir,
          candidateSpecDigest,
          basePath: "/preview/acme/",
          siteOrigin: SITE_ORIGIN,
          treeDigest: manifest.treeDigest,
        }),
      ).rejects.toThrow("RENDERER_OUTPUT_TREE_MISMATCH");

      await writeFile(
        path.join(dir, ".site-builder-render-output.json"),
        Buffer.alloc(4097),
      );
      await expect(
        assertRendererOutputMatches({
          root: dir,
          candidateSpecDigest,
          basePath: "/preview/acme/",
          siteOrigin: SITE_ORIGIN,
          treeDigest: manifest.treeDigest,
        }),
      ).rejects.toThrow("RENDERER_OUTPUT_MANIFEST_INVALID");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("buildSiteSpecWithTemporaryFile — 临时 SiteSpec 生命周期", () => {
  it("构建期间使用 0600 随机临时文件，成功后删除整个临时目录", async () => {
    let observedPath = "";
    const outDir = await mkdtemp(path.join(tmpdir(), "m1f-render-out-"));
    const execute = vi.fn(async (input: RendererBuildInput) => {
      observedPath = input.specPath;
      expect(input.cacheRoot).toBe(
        path.join(path.dirname(input.specPath), ".renderer-cache"),
      );
      expect((await stat(input.cacheRoot)).mode & 0o777).toBe(0o700);
      expect(path.basename(input.specPath)).toBe("site-spec.json");
      expect(await readFile(input.specPath, "utf8")).toBe('{"safe":true}');
      expect((await stat(path.dirname(input.specPath))).mode & 0o777).toBe(
        0o700,
      );
      expect((await stat(input.specPath)).mode & 0o777).toBe(0o600);
      await writeFile(path.join(input.outDir, "index.html"), "<h1>ok</h1>");
    });

    try {
      await buildSiteSpecWithTemporaryFile(
        { safe: true },
        {
          outDir,
          basePath: "/preview/acme/",
          siteOrigin: SITE_ORIGIN,
        },
        execute,
      );

      expect(execute).toHaveBeenCalledTimes(1);
      await expectMissing(observedPath);
      await expectMissing(path.dirname(observedPath));
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("isolates concurrent renderer cache directories and cleans both workspaces", async () => {
    const outputs = await Promise.all(
      ["a", "b"].map(async (name) => {
        const outDir = await mkdtemp(path.join(tmpdir(), `renderer-${name}-`));
        let cacheRoot = "";
        try {
          await buildSiteSpecWithTemporaryFile(
            { site: { name }, pages: [] },
            { outDir, basePath: "/", siteOrigin: SITE_ORIGIN },
            async (input) => {
              cacheRoot = input.cacheRoot;
              await writeFile(path.join(input.outDir, "index.html"), name);
            },
          );
          return { outDir, cacheRoot };
        } catch (error) {
          await rm(outDir, { recursive: true, force: true });
          throw error;
        }
      }),
    );
    try {
      expect(outputs[0]?.cacheRoot).not.toBe(outputs[1]?.cacheRoot);
      for (const output of outputs) await expectMissing(output.cacheRoot);
    } finally {
      await Promise.all(
        outputs.map((output) =>
          rm(output.outDir, { recursive: true, force: true }),
        ),
      );
    }
  });

  it("runs two real Astro builds concurrently without shared cache or workspace residue", async () => {
    const spec = JSON.parse(
      await readFile(
        path.resolve(process.cwd(), "../site-renderer/fixtures/demo-spec.json"),
        "utf8",
      ),
    ) as unknown;
    const before = new Set(
      (await readdir(tmpdir())).filter((name) =>
        name.startsWith("global-site-renderer-"),
      ),
    );
    const outDirs = await Promise.all(
      ["one", "two"].map(() =>
        mkdtemp(path.join(tmpdir(), "renderer-real-concurrent-")),
      ),
    );
    try {
      const manifests = await Promise.all(
        outDirs.map((outDir) =>
          buildSiteSpecWithTemporaryFile(spec, {
            outDir,
            basePath: "/",
            siteOrigin: SITE_ORIGIN,
          }),
        ),
      );
      expect(manifests.every((manifest) => manifest.fileCount > 0)).toBe(true);
      const after = (await readdir(tmpdir())).filter((name) =>
        name.startsWith("global-site-renderer-"),
      );
      expect(after.filter((name) => !before.has(name))).toEqual([]);
    } finally {
      await Promise.all(
        outDirs.map((outDir) => rm(outDir, { recursive: true, force: true })),
      );
    }
  }, 60_000);

  it("rejects a cache symlink escaping the build-owned workspace", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "renderer-cache-root-"),
    );
    const outside = await mkdtemp(
      path.join(tmpdir(), "renderer-cache-outside-"),
    );
    try {
      await mkdir(path.join(outside, "cache"));
      await symlink(
        path.join(outside, "cache"),
        path.join(workspace, ".renderer-cache"),
      );
      await expect(prepareRendererCacheRoot(workspace)).rejects.toThrow(
        "RENDERER_CACHE_PATH_INVALID",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("rejects a non-directory renderer workspace", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "renderer-cache-file-"));
    const workspaceFile = path.join(root, "workspace");
    try {
      await writeFile(workspaceFile, "not a directory");
      await expect(prepareRendererCacheRoot(workspaceFile)).rejects.toThrow(
        "RENDERER_CACHE_PATH_INVALID",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a renderer dependency root that is itself a symlink", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "renderer-workspace-"));
    const rendererRoot = await mkdtemp(path.join(tmpdir(), "renderer-source-"));
    const externalModules = await mkdtemp(
      path.join(tmpdir(), "renderer-modules-"),
    );
    try {
      const cacheRoot = await prepareRendererCacheRoot(workspace);
      await symlink(
        externalModules,
        path.join(rendererRoot, "node_modules"),
        "dir",
      );
      await expect(
        linkRendererDependencies(cacheRoot, rendererRoot),
      ).rejects.toThrow("RENDERER_DEPENDENCY_ROOT_INVALID");
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(rendererRoot, { recursive: true, force: true });
      await rm(externalModules, { recursive: true, force: true });
    }
  });

  it("rejects a source symlink before Astro receives the private workspace", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "renderer-workspace-"));
    const rendererRoot = await mkdtemp(path.join(tmpdir(), "renderer-source-"));
    const outside = await mkdtemp(path.join(tmpdir(), "renderer-outside-"));
    try {
      const cacheRoot = await prepareRendererCacheRoot(workspace);
      await mkdir(path.join(rendererRoot, "src"));
      await mkdir(path.join(rendererRoot, "node_modules"));
      await writeFile(path.join(outside, "secret"), "not renderer source");
      await symlink(
        path.join(outside, "secret"),
        path.join(rendererRoot, "src", "escape"),
      );
      await expect(
        prepareRendererBuildWorkspace(cacheRoot, rendererRoot),
      ).rejects.toThrow("RENDERER_SOURCE_SYMLINK_FORBIDDEN");
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(rendererRoot, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("将可信 overlay 路径传给 renderer executor", async () => {
    const outDir = await mkdtemp(path.join(tmpdir(), "m1f-render-out-"));
    const execute = vi.fn(async (input: RendererBuildInput) => {
      expect(input.publicAssetDir).toBe("/tmp/overlay");
      await writeFile(path.join(input.outDir, "index.html"), "<h1>ok</h1>");
    });
    try {
      await buildSiteSpecWithTemporaryFile(
        { safe: true },
        {
          outDir,
          basePath: "/",
          siteOrigin: SITE_ORIGIN,
          publicAssetDir: "/tmp/overlay",
        },
        execute,
      );
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("Renderer 抛错时仍在 finally 删除 SiteSpec 与随机临时目录，并保留原错误", async () => {
    let observedPath = "";
    const outDir = await mkdtemp(path.join(tmpdir(), "m1f-render-out-"));
    const execute = vi.fn(async (input: RendererBuildInput) => {
      observedPath = input.specPath;
      expect(await readFile(input.specPath, "utf8")).toBe(
        '{"tenant":"content"}',
      );
      throw new Error("astro failed");
    });

    try {
      await expect(
        buildSiteSpecWithTemporaryFile(
          { tenant: "content" },
          {
            outDir,
            basePath: "/preview/acme/",
            siteOrigin: SITE_ORIGIN,
          },
          execute,
        ),
      ).rejects.toThrow("astro failed");

      await expectMissing(observedPath);
      await expectMissing(path.dirname(observedPath));
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("子进程超时也清理完整构建工作区", async () => {
    let observedWorkspace = "";
    const outDir = await mkdtemp(path.join(tmpdir(), "m1f-render-timeout-"));
    const timeout = Object.assign(new Error("renderer timed out"), {
      code: "ETIMEDOUT",
    });
    try {
      await expect(
        buildSiteSpecWithTemporaryFile(
          { tenant: "content" },
          { outDir, basePath: "/", siteOrigin: SITE_ORIGIN },
          async (input) => {
            observedWorkspace = path.dirname(input.specPath);
            throw timeout;
          },
        ),
      ).rejects.toBe(timeout);
      await expectMissing(observedWorkspace);
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("retry 总是获得新的构建工作区和 cache root", async () => {
    const cacheRoots: string[] = [];
    const outDir = await mkdtemp(path.join(tmpdir(), "m1f-render-retry-"));
    const execute = vi.fn(async (input: RendererBuildInput) => {
      cacheRoots.push(input.cacheRoot);
      if (cacheRoots.length === 1) throw new Error("first attempt failed");
      await writeFile(path.join(input.outDir, "index.html"), "retry ok");
    });
    try {
      await expect(
        buildSiteSpecWithTemporaryFile(
          { attempt: 1 },
          { outDir, basePath: "/", siteOrigin: SITE_ORIGIN },
          execute,
        ),
      ).rejects.toThrow("first attempt failed");
      await buildSiteSpecWithTemporaryFile(
        { attempt: 2 },
        { outDir, basePath: "/", siteOrigin: SITE_ORIGIN },
        execute,
      );
      expect(cacheRoots).toHaveLength(2);
      expect(cacheRoots[0]).not.toBe(cacheRoots[1]);
      await Promise.all(cacheRoots.map(expectMissing));
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });
});
