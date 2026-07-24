/// <reference lib="dom" />
/// <reference lib="dom.iterable" />

import type { SiteSpecV1_1, QualityBreakpoint } from "@global/contracts";
import { source as axeSource } from "axe-core";
import { launch as launchChrome } from "chrome-launcher";
import lighthouse from "lighthouse";
import { XMLParser } from "fast-xml-parser";
import { createServer, type Server } from "node:http";
import { access, lstat, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { chromium, type Page, type Route } from "playwright";
import {
  QUALITY_BREAKPOINTS,
  type AxeViolationFact,
  type CollectedQualityFacts,
  type LighthouseFacts,
  type QualityPageFacts,
} from "./deterministic-quality";
import { assertReleaseContract, releaseSpecDigest } from "../release-artifact";

const PAGE_TIMEOUT_MS = 30_000;
const QUALITY_RUN_TIMEOUT_MS = 12 * 60_000;
const MAX_STATIC_FILE_BYTES = 16 * 1024 * 1024;
const MAX_DOM_ISSUES_PER_KIND = 32;
const CHROME_CANDIDATES = ["/usr/bin/google-chrome", "/usr/bin/chromium"];

interface DomAudit {
  h1Count: number;
  canonical: string | null;
  hreflangs: Array<{ lang: string; href: string }>;
  robots: string | null;
  jsonLd: unknown[];
  jsonLdValid: boolean;
  unresolvedPlaceholder: boolean;
  internalLinks: string[];
  horizontalOverflow: boolean;
  clippedText: boolean;
  elementOverlap: boolean;
  unreachableCta: boolean;
}

interface AxeResult {
  violations: Array<{
    id: string;
    impact: AxeViolationFact["impact"];
    nodes: unknown[];
  }>;
}

export interface BrowserQualityRunnerInput {
  spec: SiteSpecV1_1;
  buildRoot: string;
  candidateSpecDigest: string;
  designBriefDigest: string;
  round: 0 | 1 | 2 | 3;
  chromeExecutablePath?: string;
  signal?: AbortSignal;
  /** Required to authorize every structured fact against frozen Claim/Offering truth. */
  structuredDataFactValidator: (documents: unknown[]) => boolean;
  /** Required four-layer catalog/Blueprint/Claim/Asset validation owned by controlled assembly. */
  candidateValidator: (spec: SiteSpecV1_1) => void;
}

function abortError(): Error {
  const error = new Error("QUALITY_RUN_CANCELLED");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function mimeType(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  return (
    {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".mjs": "text/javascript; charset=utf-8",
      ".json": "application/json",
      ".xml": "application/xml",
      ".txt": "text/plain; charset=utf-8",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".svg": "image/svg+xml",
      ".woff": "font/woff",
      ".woff2": "font/woff2",
    }[extension] ?? "application/octet-stream"
  );
}

async function resolveStaticFile(
  root: string,
  rawPathname: string,
): Promise<string | null> {
  let pathname: string;
  try {
    pathname = decodeURIComponent(rawPathname);
  } catch {
    return null;
  }
  if (pathname.includes("\0") || pathname.includes("\\")) return null;
  const relative = pathname.replace(/^\/+/, "");
  const candidates = relative.endsWith("/")
    ? [path.join(relative, "index.html")]
    : [relative, path.join(relative, "index.html"), `${relative}.html`];
  const resolvedRoot = await realpath(root);
  for (const candidate of candidates) {
    const resolved = path.resolve(resolvedRoot, candidate || "index.html");
    if (
      resolved !== resolvedRoot &&
      !resolved.startsWith(`${resolvedRoot}${path.sep}`)
    ) {
      continue;
    }
    try {
      const canonical = await realpath(resolved);
      if (
        canonical !== resolvedRoot &&
        !canonical.startsWith(`${resolvedRoot}${path.sep}`)
      ) {
        continue;
      }
      const info = await stat(canonical);
      if (info.isFile() && info.size <= MAX_STATIC_FILE_BYTES) return canonical;
    } catch {
      // Try the next static route shape.
    }
  }
  return null;
}

export async function startLoopbackStaticServer(
  root: string,
): Promise<{ origin: string; close: () => Promise<void> }> {
  const entry = await lstat(root);
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new Error("QUALITY_ARTIFACT_INVALID: build root");
  }
  const server: Server = createServer(async (request, response) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405).end();
      return;
    }
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    const filePath = await resolveStaticFile(root, requestUrl.pathname);
    if (!filePath) {
      response.writeHead(404, { "cache-control": "no-store" }).end();
      return;
    }
    try {
      const bytes = await readFile(filePath);
      response.writeHead(200, {
        "content-type": mimeType(filePath),
        "content-length": String(bytes.length),
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
      response.end(request.method === "HEAD" ? undefined : bytes);
    } catch {
      response.writeHead(500).end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("QUALITY_ARTIFACT_INVALID: loopback server");
  }
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

function pagePath(spec: SiteSpecV1_1, locale: string, pathValue: string): string {
  const pagePath = pathValue.replace(/^\/+|\/+$/g, "");
  const localePrefix = locale === spec.site.defaultLocale ? "" : locale;
  return `/${[localePrefix, pagePath].filter(Boolean).join("/")}`;
}

async function auditDom(page: Page): Promise<DomAudit> {
  return page.evaluate(
    ({ maxIssues }) => {
      const visible = (element: Element): boolean => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          Number(style.opacity) > 0 &&
          rect.width > 0 &&
          rect.height > 0
        );
      };
      const all = [...document.querySelectorAll<HTMLElement>("body *")];
      const clipped = all
        .filter(
          (element) =>
            visible(element) &&
            getComputedStyle(element).overflow !== "visible" &&
            (element.scrollWidth > element.clientWidth + 1 ||
              element.scrollHeight > element.clientHeight + 1),
        )
        .slice(0, maxIssues);
      const interactive = [
        ...document.querySelectorAll<HTMLElement>(
          "a[href],button,input,select,textarea,[role=button]",
        ),
      ].filter(visible);
      let overlaps = 0;
      for (let left = 0; left < interactive.length && overlaps < maxIssues; left += 1) {
        const first = interactive[left]!;
        const a = first.getBoundingClientRect();
        for (let right = left + 1; right < interactive.length; right += 1) {
          const second = interactive[right]!;
          if (first.contains(second) || second.contains(first)) continue;
          const b = second.getBoundingClientRect();
          const width = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
          const height = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
          const overlap = width * height;
          const minimum = Math.min(a.width * a.height, b.width * b.height);
          if (minimum > 0 && overlap / minimum > 0.25) overlaps += 1;
        }
      }
      const ctas = [
        ...document.querySelectorAll<HTMLElement>(".btn,[data-cta=true]"),
      ];
      const unreachable = ctas.filter((element) => {
        if (!visible(element)) return true;
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return (
          style.pointerEvents === "none" ||
          rect.right <= 0 ||
          rect.left >= document.documentElement.clientWidth ||
          rect.bottom <= 0 ||
          rect.top >= document.documentElement.scrollHeight
        );
      });
      const jsonLd: unknown[] = [];
      let jsonLdValid = true;
      for (const script of document.querySelectorAll<HTMLScriptElement>(
        'script[type="application/ld+json"]',
      )) {
        try {
          jsonLd.push(JSON.parse(script.textContent ?? ""));
        } catch {
          jsonLdValid = false;
        }
      }
      if (jsonLd.length === 0) jsonLdValid = false;
      return {
        h1Count: document.querySelectorAll("h1").length,
        canonical: (() => {
          const link = document.querySelector<HTMLLinkElement>(
            'link[rel="canonical"]',
          );
          return link?.getAttribute("href")?.trim() ? link.href : null;
        })(),
        hreflangs: [
          ...document.querySelectorAll<HTMLLinkElement>(
            'link[rel="alternate"][hreflang]',
          ),
        ].map((link) => ({
          lang: link.hreflang,
          href: link.href,
        })),
        robots:
          document.querySelector<HTMLMetaElement>('meta[name="robots"]')
            ?.content ?? null,
        jsonLd,
        jsonLdValid,
        unresolvedPlaceholder:
          document.documentElement.textContent?.includes("⟦") ?? false,
        internalLinks: [
          ...document.querySelectorAll<HTMLAnchorElement>("a[href]"),
        ]
          .map((anchor) => anchor.href)
          .filter((href) => href.startsWith(location.origin)),
        horizontalOverflow:
          document.documentElement.scrollWidth >
          document.documentElement.clientWidth + 1,
        clippedText: clipped.length > 0,
        elementOverlap: overlaps > 0,
        unreachableCta: unreachable.length > 0,
      };
    },
    { maxIssues: MAX_DOM_ISSUES_PER_KIND },
  );
}

async function probeLocalUrls(
  urls: string[],
  origin: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const broken: string[] = [];
  for (const raw of [...new Set(urls)].slice(0, 128)) {
    throwIfAborted(signal);
    const url = new URL(raw);
    url.hash = "";
    if (url.origin !== origin) {
      broken.push(raw);
      continue;
    }
    const response = await fetch(url, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.any([
        signal ?? new AbortController().signal,
        AbortSignal.timeout(5_000),
      ]),
    });
    if (response.status >= 400) broken.push(raw);
    await response.body?.cancel();
  }
  return broken;
}

function mergeAxeViolations(results: AxeResult[]): AxeViolationFact[] {
  const impacts = new Map<AxeViolationFact["impact"], number>([
    [null, 0],
    ["minor", 1],
    ["moderate", 2],
    ["serious", 3],
    ["critical", 4],
  ]);
  const merged = new Map<string, AxeViolationFact>();
  for (const result of results) {
    for (const violation of result.violations) {
      const previous = merged.get(violation.id);
      const impact =
        (impacts.get(violation.impact) ?? 0) >
        (impacts.get(previous?.impact ?? null) ?? 0)
          ? violation.impact
          : (previous?.impact ?? violation.impact);
      merged.set(violation.id, {
        id: violation.id.slice(0, 128),
        impact,
        nodeCount: (previous?.nodeCount ?? 0) + violation.nodes.length,
      });
    }
  }
  return [...merged.values()].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
}

async function chromePath(explicit?: string): Promise<string> {
  const candidates = explicit ? [explicit] : CHROME_CANDIDATES;
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next pinned executable path.
    }
  }
  throw new Error("QUALITY_ARTIFACT_INVALID: chrome unavailable");
}

async function runLighthouse(
  origin: string,
  targetPath: string,
  target: LighthouseFacts["target"],
  breakpoint: 375 | 1440,
  executablePath: string,
  signal?: AbortSignal,
): Promise<LighthouseFacts> {
  throwIfAborted(signal);
  const chrome = await launchChrome({
    chromePath: executablePath,
    chromeFlags: [
      "--headless=new",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-domain-reliability",
      "--disable-sync",
      "--metrics-recording-only",
      "--no-first-run",
      "--proxy-server=direct://",
      "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1",
    ],
    logLevel: "silent",
  });
  try {
    const mobile = breakpoint === 375;
    const result = await Promise.race([
      lighthouse(
        `${origin}${targetPath}`,
        {
          port: chrome.port,
          output: "json",
          logLevel: "error",
          onlyCategories: ["performance", "accessibility", "seo"],
          formFactor: mobile ? "mobile" : "desktop",
          screenEmulation: mobile
            ? {
                mobile: true,
                width: 375,
                height: 812,
                deviceScaleFactor: 1,
                disabled: false,
              }
            : {
                mobile: false,
                width: 1440,
                height: 900,
                deviceScaleFactor: 1,
                disabled: false,
              },
        },
        undefined,
      ),
      new Promise<never>((_, reject) => {
        if (signal?.aborted) reject(abortError());
        signal?.addEventListener("abort", () => reject(abortError()), {
          once: true,
        });
      }),
    ]);
    if (!result?.lhr) {
      throw new Error("QUALITY_ARTIFACT_INVALID: lighthouse empty");
    }
    const score = (key: "performance" | "accessibility" | "seo"): number => {
      const value = result.lhr.categories[key]?.score;
      if (typeof value !== "number") {
        throw new Error(`QUALITY_ARTIFACT_INVALID: lighthouse ${key}`);
      }
      return Math.round(value * 100);
    };
    return {
      target,
      breakpoint,
      performance: score("performance"),
      accessibility: score("accessibility"),
      seo: score("seo"),
    };
  } finally {
    await chrome.kill();
  }
}

export async function collectBrowserQualityFacts(
  input: BrowserQualityRunnerInput,
): Promise<CollectedQualityFacts> {
  const deadline = AbortSignal.timeout(QUALITY_RUN_TIMEOUT_MS);
  const signal = input.signal
    ? AbortSignal.any([input.signal, deadline])
    : deadline;
  throwIfAborted(signal);
  assertReleaseContract(input.spec, input.spec.specVersion);
  input.candidateValidator(input.spec);
  if (releaseSpecDigest(input.spec) !== input.candidateSpecDigest) {
    throw new Error("QUALITY_ARTIFACT_INVALID: candidateSpecDigest mismatch");
  }
  const executablePath = await chromePath(input.chromeExecutablePath);
  const staticServer = await startLoopbackStaticServer(input.buildRoot);
  const browser = await chromium.launch({
    executablePath,
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  try {
    const robotsResponse = await fetch(`${staticServer.origin}/robots.txt`, {
      signal,
    });
    const robotsText = robotsResponse.ok
      ? (await robotsResponse.text()).slice(0, 64 * 1024)
      : "";
    const robotsTxtOk =
      robotsResponse.ok &&
      /^user-agent\s*:/im.test(robotsText) &&
      /^disallow\s*:\s*\/\s*$/im.test(robotsText);
    const sitemapResponse = await fetch(`${staticServer.origin}/sitemap.xml`, {
      signal,
    });
    const sitemapText = sitemapResponse.ok
      ? (await sitemapResponse.text()).slice(0, 1024 * 1024)
      : "";
    let sitemapOk = false;
    if (sitemapResponse.ok) {
      try {
        const parsed = new XMLParser({
          ignoreAttributes: false,
          processEntities: false,
        }).parse(sitemapText) as Record<string, unknown>;
        sitemapOk =
          typeof parsed === "object" &&
          parsed !== null &&
          ("urlset" in parsed || "sitemapindex" in parsed);
      } catch {
        sitemapOk = false;
      }
    }
    const pages: QualityPageFacts[] = [];
    for (const locale of input.spec.site.locales) {
      for (const sitePage of input.spec.pages) {
        throwIfAborted(signal);
        const target = { locale, pageId: sitePage.id };
        const targetPath = pagePath(input.spec, locale, sitePage.path);
        const screenshots = {} as Record<QualityBreakpoint, Buffer>;
        const axeResults: AxeResult[] = [];
        const domByBreakpoint = new Map<QualityBreakpoint, DomAudit>();
        const externalRequests = new Set<string>();
        const missingStaticAssets = new Set<string>();
        for (const breakpoint of QUALITY_BREAKPOINTS) {
          const context = await browser.newContext({
            viewport: {
              width: breakpoint,
              height: breakpoint === 375 ? 812 : breakpoint === 768 ? 1024 : 900,
            },
            deviceScaleFactor: 1,
            reducedMotion: "reduce",
          });
          const page = await context.newPage();
          page.setDefaultTimeout(PAGE_TIMEOUT_MS);
          await page.route("**/*", async (route: Route) => {
            const url = new URL(route.request().url());
            if (
              url.protocol === "data:" ||
              url.protocol === "blob:" ||
              url.origin === staticServer.origin
            ) {
              await route.continue();
            } else {
              externalRequests.add(`${url.protocol}//${url.host}`);
              await route.abort("blockedbyclient");
            }
          });
          page.on("response", (response) => {
            if (response.status() < 400) return;
            const request = response.request();
            if (
              ["image", "font", "stylesheet", "script"].includes(
                request.resourceType(),
              )
            ) {
              missingStaticAssets.add(new URL(response.url()).pathname);
            }
          });
          await page.goto(`${staticServer.origin}${targetPath}`, {
            waitUntil: "networkidle",
            timeout: PAGE_TIMEOUT_MS,
          });
          await page.addScriptTag({ content: axeSource });
          axeResults.push(
            await page.evaluate(async () => {
              const axe = (
                window as unknown as {
                  axe: {
                    run: (
                      root: Document,
                      options: unknown,
                    ) => Promise<AxeResult>;
                  };
                }
              ).axe;
              return axe.run(document, {
                runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] },
              });
            }),
          );
          domByBreakpoint.set(breakpoint, await auditDom(page));
          screenshots[breakpoint] = await page.screenshot({
            fullPage: true,
            type: "png",
            animations: "disabled",
          });
          await context.close();
        }
        const canonicalDom = domByBreakpoint.get(1440)!;
        const brokenInternalLinks = await probeLocalUrls(
          canonicalDom.internalLinks,
          staticServer.origin,
          signal,
        );
        pages.push({
          target,
          screenshots,
          axeViolations: mergeAxeViolations(axeResults),
          h1Count: canonicalDom.h1Count,
          canonical:
            canonicalDom.canonical &&
            new URL(canonicalDom.canonical).pathname.replace(/\/+$/, "") ===
              new URL(`${staticServer.origin}${targetPath}`).pathname.replace(
                /\/+$/,
                "",
              )
              ? canonicalDom.canonical
              : null,
          hreflangs: canonicalDom.hreflangs,
          robots: canonicalDom.robots,
          robotsTxtOk,
          sitemapOk,
          jsonLdValid: canonicalDom.jsonLdValid,
          jsonLdUnsupportedFacts:
            canonicalDom.jsonLd.length > 0 &&
            !input.structuredDataFactValidator(canonicalDom.jsonLd),
          unresolvedPlaceholder: [...domByBreakpoint.values()].some(
            (audit) => audit.unresolvedPlaceholder,
          ),
          externalRequests: [...externalRequests].sort(),
          brokenInternalLinks,
          missingStaticAssets: [...missingStaticAssets].sort(),
          horizontalOverflow: QUALITY_BREAKPOINTS.filter(
            (breakpoint) => domByBreakpoint.get(breakpoint)!.horizontalOverflow,
          ),
          clippedText: QUALITY_BREAKPOINTS.filter(
            (breakpoint) => domByBreakpoint.get(breakpoint)!.clippedText,
          ),
          elementOverlap: QUALITY_BREAKPOINTS.filter(
            (breakpoint) => domByBreakpoint.get(breakpoint)!.elementOverlap,
          ),
          unreachableCta: QUALITY_BREAKPOINTS.filter(
            (breakpoint) => domByBreakpoint.get(breakpoint)!.unreachableCta,
          ),
        });
      }
    }
    const home =
      input.spec.pages.find((page) => page.id === "home") ?? input.spec.pages[0]!;
    const homeTarget = {
      locale: input.spec.site.defaultLocale,
      pageId: home.id,
    };
    const homePath = pagePath(
      input.spec,
      input.spec.site.defaultLocale,
      home.path,
    );
    const lighthouseFacts: LighthouseFacts[] = [];
    for (const breakpoint of [375, 1440] as const) {
      lighthouseFacts.push(
        await runLighthouse(
          staticServer.origin,
          homePath,
          homeTarget,
          breakpoint,
          executablePath,
          signal,
        ),
      );
    }
    return {
      spec: input.spec,
      candidateSpecDigest: input.candidateSpecDigest,
      designBriefDigest: input.designBriefDigest,
      round: input.round,
      pages,
      lighthouse: lighthouseFacts,
    };
  } catch (error) {
    if (signal.aborted) throw abortError();
    throw error;
  } finally {
    await browser.close();
    await staticServer.close();
  }
}
