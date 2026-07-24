/// <reference lib="dom" />
/// <reference lib="dom.iterable" />

import type {
  DesignBriefV2,
  DesignCatalogV2,
  QualityBreakpoint,
  SiteSpecV1_1,
} from "@global/contracts";
import { source as axeSource } from "axe-core";
import { launch as launchChrome } from "chrome-launcher";
import lighthouse from "lighthouse";
import { XMLParser } from "fast-xml-parser";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { access, lstat, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
  type Route,
} from "playwright";
import {
  QUALITY_BREAKPOINTS,
  type AxeViolationFact,
  type CollectedQualityFacts,
  type LighthouseFacts,
  type QualityPageFacts,
} from "./deterministic-quality";
import { assertReleaseContract, releaseSpecDigest } from "../release-artifact";
import { assertControlledAssemblyValid } from "../assembly/controlled-assembly-validator";
import type { CopySlotDefinition } from "../copy-bundle.service";
import type { PublishableClaimSnapshot } from "../publishable-claim-snapshot";

const PAGE_TIMEOUT_MS = 30_000;
const QUALITY_RUN_TIMEOUT_MS = 12 * 60_000;
const MAX_STATIC_FILE_BYTES = 16 * 1024 * 1024;
const MAX_DOM_ISSUES_PER_KIND = 32;
const MAX_URL_FACTS_PER_PAGE = 512;
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
  resourceUrls: string[];
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
  validation: {
    designBrief: DesignBriefV2;
    catalog: DesignCatalogV2;
    claimSnapshot: PublishableClaimSnapshot;
    copySlots: readonly CopySlotDefinition[];
  };
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

function denyTunnel(socket: Duplex): void {
  socket.on("error", () => undefined);
  socket.end(
    "HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
  );
}

/**
 * Lighthouse has no Playwright-style request interception. Force its Chrome
 * through this deny-by-default proxy so literal IPs cannot bypass DNS rules.
 */
export async function startLoopbackOnlyProxy(
  allowedOrigin: string,
): Promise<{ origin: string; close: () => Promise<void> }> {
  const allowed = new URL(allowedOrigin);
  if (
    allowed.protocol !== "http:" ||
    allowed.hostname !== "127.0.0.1" ||
    !allowed.port
  ) {
    throw new Error("QUALITY_ARTIFACT_INVALID: proxy allowlist");
  }
  const server = createServer(async (request, response: ServerResponse) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { connection: "close" }).end();
      return;
    }
    let target: URL;
    try {
      target = new URL(request.url ?? "");
    } catch {
      response.writeHead(400, { connection: "close" }).end();
      return;
    }
    if (target.origin !== allowed.origin) {
      response.writeHead(403, { connection: "close" }).end();
      return;
    }
    try {
      const upstream = await fetch(target, {
        method: request.method,
        redirect: "manual",
        signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
      });
      const bytes = Buffer.from(await upstream.arrayBuffer());
      if (bytes.length > MAX_STATIC_FILE_BYTES) {
        response.writeHead(413, { connection: "close" }).end();
        return;
      }
      response.writeHead(upstream.status, {
        "content-type":
          upstream.headers.get("content-type") ?? "application/octet-stream",
        "content-length": String(bytes.length),
        "cache-control": "no-store",
        connection: "close",
      });
      response.end(request.method === "HEAD" ? undefined : bytes);
    } catch {
      response.writeHead(502, { connection: "close" }).end();
    }
  });
  server.on("connect", (_request, socket) => denyTunnel(socket));
  server.on("upgrade", (_request, socket) => denyTunnel(socket));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("QUALITY_ARTIFACT_INVALID: loopback proxy");
  }
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

function pagePath(
  spec: SiteSpecV1_1,
  locale: string,
  pathValue: string,
): string {
  const pagePath = pathValue.replace(/^\/+|\/+$/g, "");
  const localePrefix = locale === spec.site.defaultLocale ? "" : locale;
  return `/${[localePrefix, pagePath].filter(Boolean).join("/")}`;
}

async function auditDom(page: Page): Promise<DomAudit> {
  return page.evaluate(
    ({ maxIssues, maxUrls }) => {
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
      const textElements = [
        ...document.querySelectorAll<HTMLElement>(
          "h1,h2,h3,h4,h5,h6,p,a,button,li,label,span",
        ),
      ];
      const clipped = textElements
        .filter(
          (element) =>
            visible(element) &&
            Boolean(element.innerText.trim()) &&
            getComputedStyle(element).overflow !== "visible" &&
            (element.scrollWidth > element.clientWidth + 1 ||
              element.scrollHeight > element.clientHeight + 1),
        )
        .slice(0, maxIssues);
      const overlapCandidates = [
        ...document.querySelectorAll<HTMLElement>(
          "a[href],button,input,select,textarea,[role=button],main h1,main h2,main h3,main p,main img",
        ),
      ].filter(visible);
      let overlaps = 0;
      for (
        let left = 0;
        left < overlapCandidates.length && overlaps < maxIssues;
        left += 1
      ) {
        const first = overlapCandidates[left]!;
        const a = first.getBoundingClientRect();
        for (
          let right = left + 1;
          right < overlapCandidates.length;
          right += 1
        ) {
          const second = overlapCandidates[right]!;
          if (first.contains(second) || second.contains(first)) continue;
          const b = second.getBoundingClientRect();
          const width = Math.max(
            0,
            Math.min(a.right, b.right) - Math.max(a.left, b.left),
          );
          const height = Math.max(
            0,
            Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top),
          );
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
      const resourceUrls = new Set<string>();
      for (const element of document.querySelectorAll<
        | HTMLImageElement
        | HTMLScriptElement
        | HTMLLinkElement
        | HTMLSourceElement
      >("img[src],script[src],link[href],source[src],source[srcset]")) {
        if (element instanceof HTMLImageElement && element.currentSrc) {
          resourceUrls.add(element.currentSrc);
        } else if (
          element instanceof HTMLScriptElement ||
          element instanceof HTMLSourceElement
        ) {
          if (element.src) resourceUrls.add(element.src);
        } else if (element instanceof HTMLLinkElement) {
          if (
            ["stylesheet", "icon", "preload", "modulepreload"].includes(
              element.rel,
            ) &&
            element.href
          ) {
            resourceUrls.add(element.href);
          }
        }
        if (element instanceof HTMLSourceElement && element.srcset) {
          for (const candidate of element.srcset.split(",")) {
            const raw = candidate.trim().split(/\s+/)[0];
            if (raw) resourceUrls.add(new URL(raw, location.href).href);
          }
        }
      }
      const internalLinks = [
        ...document.querySelectorAll<HTMLAnchorElement>("a[href]"),
      ]
        .map((anchor) => anchor.href)
        .filter((href) => href.startsWith(location.origin));
      if (resourceUrls.size > maxUrls || internalLinks.length > maxUrls) {
        throw new Error("QUALITY_ARTIFACT_INVALID: DOM URL limit");
      }
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
        internalLinks,
        resourceUrls: [...resourceUrls],
        horizontalOverflow:
          document.documentElement.scrollWidth >
          document.documentElement.clientWidth + 1,
        clippedText: clipped.length > 0,
        elementOverlap: overlaps > 0,
        unreachableCta: unreachable.length > 0,
      };
    },
    {
      maxIssues: MAX_DOM_ISSUES_PER_KIND,
      maxUrls: MAX_URL_FACTS_PER_PAGE,
    },
  );
}

async function probeLocalUrls(
  urls: string[],
  origin: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const broken: string[] = [];
  const unique = [...new Set(urls)];
  if (unique.length > MAX_URL_FACTS_PER_PAGE) {
    throw new Error("QUALITY_ARTIFACT_INVALID: local URL limit");
  }
  for (const raw of unique) {
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

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function expectedPagePaths(spec: SiteSpecV1_1): string[] {
  return spec.site.locales.flatMap((locale) =>
    spec.pages.map((sitePage) => pagePath(spec, locale, sitePage.path)),
  );
}

function sitemapPaths(xml: string, origin: string): string[] {
  const parsed = new XMLParser({
    ignoreAttributes: false,
    processEntities: false,
  }).parse(xml) as { urlset?: { url?: unknown } };
  const rawUrls = parsed?.urlset?.url;
  const entries = Array.isArray(rawUrls)
    ? rawUrls
    : rawUrls === undefined
      ? []
      : [rawUrls];
  return entries.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("QUALITY_ARTIFACT_INVALID: sitemap entry");
    }
    const loc = (entry as Record<string, unknown>).loc;
    if (typeof loc !== "string" || !loc.trim()) {
      throw new Error("QUALITY_ARTIFACT_INVALID: sitemap loc");
    }
    const url = new URL(loc.trim(), origin);
    if (url.origin !== origin || url.search || url.hash) {
      throw new Error("QUALITY_ARTIFACT_INVALID: sitemap origin");
    }
    return url.pathname.replace(/\/+$/, "") || "/";
  });
}

const JSON_LD_VOCABULARY_KEYS = new Set([
  "@context",
  "@type",
  "@id",
  "url",
  "inLanguage",
]);

function structuredDataUsesFrozenFacts(
  documents: unknown[],
  snapshot: PublishableClaimSnapshot,
): boolean {
  const approved = new Set(snapshot.items.map((item) => item.statement.trim()));
  const visit = (value: unknown, parentKey?: string): boolean => {
    if (Array.isArray(value))
      return value.every((item) => visit(item, parentKey));
    if (value && typeof value === "object") {
      return Object.entries(value).every(([key, child]) => visit(child, key));
    }
    if (value === null) return true;
    if (parentKey && JSON_LD_VOCABULARY_KEYS.has(parentKey)) return true;
    if (typeof value === "string") return approved.has(value.trim());
    return false;
  };
  return documents.every((document) => visit(document));
}

async function closeContext(context: BrowserContext): Promise<void> {
  await context.close().catch(() => undefined);
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
  proxyOrigin: string,
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
      "--disable-quic",
      "--disable-sync",
      "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
      "--metrics-recording-only",
      "--no-first-run",
      `--proxy-server=${proxyOrigin}`,
      "--proxy-bypass-list=<-loopback>",
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
          // Preview artifacts are intentionally noindex until M2 publication.
          // The deterministic PREVIEW_NOINDEX_INVALID rule owns that invariant.
          skipAudits: ["is-crawlable"],
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
      return Math.round(value * 10_000) / 100;
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
  if (input.validation.designBrief.digest !== input.designBriefDigest) {
    throw new Error("QUALITY_ARTIFACT_INVALID: designBriefDigest mismatch");
  }
  assertControlledAssemblyValid({
    spec: input.spec,
    brief: input.validation.designBrief,
    catalog: input.validation.catalog,
    claimSnapshot: input.validation.claimSnapshot,
    copySlots: input.validation.copySlots,
  });
  if (releaseSpecDigest(input.spec) !== input.candidateSpecDigest) {
    throw new Error("QUALITY_ARTIFACT_INVALID: candidateSpecDigest mismatch");
  }
  const targets = expectedPagePaths(input.spec);
  if (targets.length < 1 || targets.length > 24) {
    throw new Error("QUALITY_ARTIFACT_INVALID: locale-page target limit");
  }
  const executablePath = await chromePath(input.chromeExecutablePath);
  const staticServer = await startLoopbackStaticServer(input.buildRoot);
  const lighthouseProxy = await startLoopbackOnlyProxy(staticServer.origin);
  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({
      executablePath,
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
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
        const actual = sitemapPaths(sitemapText, staticServer.origin);
        const expected = targets.map(
          (value) => value.replace(/\/+$/, "") || "/",
        );
        sitemapOk =
          actual.length === expected.length &&
          new Set(actual).size === actual.length &&
          expected.every((value) => actual.includes(value));
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
        let urlEvidenceOverflow = false;
        for (const breakpoint of QUALITY_BREAKPOINTS) {
          const context = await browser.newContext({
            viewport: {
              width: breakpoint,
              height:
                breakpoint === 375 ? 812 : breakpoint === 768 ? 1024 : 900,
            },
            deviceScaleFactor: 1,
            reducedMotion: "reduce",
            serviceWorkers: "block",
          });
          try {
            await context.routeWebSocket("**", (socket) => {
              const url = new URL(socket.url());
              externalRequests.add(`${url.protocol}//${url.host}`);
              if (externalRequests.size > MAX_URL_FACTS_PER_PAGE) {
                urlEvidenceOverflow = true;
              }
              socket.close({ code: 1008, reason: "quality network policy" });
            });
            await context.route("**/*", async (route: Route) => {
              const url = new URL(route.request().url());
              if (
                url.protocol === "data:" ||
                url.protocol === "blob:" ||
                url.origin === staticServer.origin
              ) {
                await route.continue();
              } else {
                externalRequests.add(`${url.protocol}//${url.host}`);
                if (externalRequests.size > MAX_URL_FACTS_PER_PAGE) {
                  urlEvidenceOverflow = true;
                }
                await route.abort("blockedbyclient");
              }
            });
            const page = await context.newPage();
            page.setDefaultTimeout(PAGE_TIMEOUT_MS);
            page.on("response", (response) => {
              if (response.status() < 400) return;
              const request = response.request();
              if (
                ["document", "image", "font", "stylesheet", "script"].includes(
                  request.resourceType(),
                )
              ) {
                missingStaticAssets.add(new URL(response.url()).pathname);
                if (missingStaticAssets.size > MAX_URL_FACTS_PER_PAGE) {
                  urlEvidenceOverflow = true;
                }
              }
            });
            await raceAbort(
              page.goto(`${staticServer.origin}${targetPath}`, {
                waitUntil: "networkidle",
                timeout: PAGE_TIMEOUT_MS,
              }),
              signal,
            );
            await raceAbort(page.addScriptTag({ content: axeSource }), signal);
            axeResults.push(
              await raceAbort(
                page.evaluate(async () => {
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
                signal,
              ),
            );
            domByBreakpoint.set(
              breakpoint,
              await raceAbort(auditDom(page), signal),
            );
            screenshots[breakpoint] = await raceAbort(
              page.screenshot({
                fullPage: true,
                type: "png",
                animations: "disabled",
              }),
              signal,
            );
          } finally {
            await closeContext(context);
          }
          if (urlEvidenceOverflow) {
            throw new Error("QUALITY_ARTIFACT_INVALID: network URL limit");
          }
        }
        const canonicalDom = domByBreakpoint.get(1440)!;
        const brokenInternalLinks = await probeLocalUrls(
          [...domByBreakpoint.values()].flatMap((audit) => audit.internalLinks),
          staticServer.origin,
          signal,
        );
        const resourceUrls = [
          ...new Set(
            [...domByBreakpoint.values()].flatMap(
              (audit) => audit.resourceUrls,
            ),
          ),
        ];
        const localResourceUrls: string[] = [];
        for (const raw of resourceUrls) {
          const resource = new URL(raw);
          if (resource.origin === staticServer.origin) {
            localResourceUrls.push(raw);
          } else if (
            resource.protocol === "http:" ||
            resource.protocol === "https:"
          ) {
            externalRequests.add(`${resource.protocol}//${resource.host}`);
          }
        }
        if (externalRequests.size > MAX_URL_FACTS_PER_PAGE) {
          throw new Error("QUALITY_ARTIFACT_INVALID: external URL limit");
        }
        const missingProbedAssets = await probeLocalUrls(
          localResourceUrls,
          staticServer.origin,
          signal,
        );
        for (const missing of missingProbedAssets) {
          missingStaticAssets.add(new URL(missing).pathname);
        }
        pages.push({
          target,
          screenshots,
          axeViolations: mergeAxeViolations(axeResults),
          h1Count: canonicalDom.h1Count,
          canonical:
            canonicalDom.canonical &&
            new URL(canonicalDom.canonical).origin === staticServer.origin &&
            !new URL(canonicalDom.canonical).search &&
            !new URL(canonicalDom.canonical).hash &&
            (new URL(canonicalDom.canonical).pathname.replace(/\/+$/, "") ||
              "/") === (targetPath.replace(/\/+$/, "") || "/")
              ? canonicalDom.canonical
              : null,
          hreflangs:
            canonicalDom.hreflangs.length === input.spec.site.locales.length &&
            new Set(canonicalDom.hreflangs.map((entry) => entry.lang)).size ===
              input.spec.site.locales.length &&
            input.spec.site.locales.every((expectedLocale) =>
              canonicalDom.hreflangs.some((entry) => {
                const href = new URL(entry.href);
                const expectedPath = pagePath(
                  input.spec,
                  expectedLocale,
                  sitePage.path,
                );
                return (
                  entry.lang === expectedLocale &&
                  href.origin === staticServer.origin &&
                  !href.search &&
                  !href.hash &&
                  (href.pathname.replace(/\/+$/, "") || "/") ===
                    (expectedPath.replace(/\/+$/, "") || "/")
                );
              }),
            )
              ? canonicalDom.hreflangs
              : [],
          robots: canonicalDom.robots,
          robotsTxtOk,
          sitemapOk,
          jsonLdValid: canonicalDom.jsonLdValid,
          jsonLdUnsupportedFacts:
            canonicalDom.jsonLd.length > 0 &&
            !structuredDataUsesFrozenFacts(
              canonicalDom.jsonLd,
              input.validation.claimSnapshot,
            ),
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
      input.spec.pages.find((page) => page.id === "home") ??
      input.spec.pages[0]!;
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
          lighthouseProxy.origin,
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
    await browser?.close();
    await lighthouseProxy.close();
    await staticServer.close();
  }
}
