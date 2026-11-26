import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface RecordedUpstreamCall {
  readonly method: string;
  readonly prefix: string;
  readonly path: string;
  readonly query: Record<string, string>;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly bodyText: string;
  readonly bodyJson: unknown;
}

export type UpstreamRouteHandler = (
  req: RecordedUpstreamCall,
  res: ServerResponse,
) => void | Promise<void>;

export const MOCK_UPSTREAM_PREFIXES = [
  "/serper",
  "/exa",
  "/searxng",
  "/crawl4ai",
  "/docling",
  "/changedetection",
  "/rsshub",
  "/vies",
  "/companies-house",
  "/gleif",
  "/ted",
  "/prospeo",
  "/emailable",
  "/zerobounce",
  "/millionverifier",
  "/hunter",
  "/openapi-it",
  "/bounceban",
  "/fullenrich",
  "/dropcontact",
  "/twilio",
  "/dataforseo",
  "/crustdata",
  "/importyeti",
  "/exa-websets",
  "/web",
] as const;

export type MockUpstreamPrefix = (typeof MOCK_UPSTREAM_PREFIXES)[number];

export interface MockUpstreamsServer {
  readonly baseUrl: string;
  readonly calls: readonly RecordedUpstreamCall[];
  urlFor(prefix: MockUpstreamPrefix): string;
  setRoute(prefix: string, handler: UpstreamRouteHandler): void;
  getCalls(prefix?: string): readonly RecordedUpstreamCall[];
  reset(): void;
  applyEnv(overrides?: Readonly<Record<string, string | undefined>>): void;
  restoreEnv(): void;
  close(): Promise<void>;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
}

function matchPrefix(pathname: string, handlers: ReadonlyMap<string, UpstreamRouteHandler>): string {
  let matched = "";
  for (const key of handlers.keys()) {
    if ((pathname === key || pathname.startsWith(`${key}/`)) && key.length > matched.length) {
      matched = key;
    }
  }
  if (matched) return matched;
  for (const prefix of MOCK_UPSTREAM_PREFIXES) {
    if ((pathname === prefix || pathname.startsWith(`${prefix}/`)) && prefix.length > matched.length) {
      matched = prefix;
    }
  }
  return matched || "/";
}

export async function startMockUpstreamsServer(): Promise<MockUpstreamsServer> {
  const customRoutes = new Map<string, UpstreamRouteHandler>();
  const recordedCalls: RecordedUpstreamCall[] = [];
  const savedEnv = new Map<string, string | undefined>();

  const defaultRouteHandler: UpstreamRouteHandler = (call, res) => {
    switch (call.prefix) {
      case "/serper":
        return sendJson(res, 200, { organic: [] });
      case "/exa":
        return sendJson(res, 200, { results: [] });
      case "/searxng":
        return sendJson(res, 200, { results: [], suggestions: [], infoboxes: [], number_of_results: 0 });
      case "/crawl4ai":
        return sendJson(res, 200, { success: true, html: "<html><body></body></html>", markdown: "" });
      case "/docling":
        if (call.path.endsWith("/health")) return sendJson(res, 200, { status: "ok" });
        return sendJson(res, 200, {
          status: "success",
          document: { md_content: "# Mock PDF Document", json_content: { pages: [{}] } },
        });
      case "/changedetection":
        return sendJson(res, 200, {});
      case "/rsshub":
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/rss+xml");
        res.end("<rss version=\"2.0\"><channel><title>Empty</title></channel></rss>");
        return;
      case "/vies":
        return sendJson(res, 200, { valid: false });
      case "/companies-house":
        return sendJson(res, 200, { items: [] });
      case "/gleif":
        return sendJson(res, 200, { data: [] });
      case "/ted":
        return sendJson(res, 200, { notices: [] });
      case "/prospeo":
        return sendJson(res, 200, { error: false, person: null });
      case "/emailable":
        return sendJson(res, 200, { state: "unknown", score: 0 });
      case "/zerobounce":
        return sendJson(res, 200, { status: "unknown" });
      case "/millionverifier":
        return sendJson(res, 200, { result: "unknown" });
      case "/hunter":
        return sendJson(res, 200, { data: {} });
      default:
        return sendJson(res, 200, { ok: true, prefix: call.prefix, path: call.path });
    }
  };

  const server = createServer(async (req, res) => {
    try {
      const parsed = new URL(req.url ?? "/", "http://127.0.0.1");
      const bodyText = await readBody(req);
      let bodyJson: unknown = undefined;
      if (bodyText.trim().startsWith("{") || bodyText.trim().startsWith("[")) {
        try {
          bodyJson = JSON.parse(bodyText);
        } catch {
          bodyJson = undefined;
        }
      }
      const prefix = matchPrefix(parsed.pathname, customRoutes);
      const subPath = prefix !== "/" && parsed.pathname.startsWith(prefix)
        ? parsed.pathname.slice(prefix.length) || "/"
        : parsed.pathname;

      const query: Record<string, string> = {};
      for (const [k, v] of parsed.searchParams.entries()) {
        query[k] = v;
      }

      const recorded: RecordedUpstreamCall = {
        method: req.method ?? "GET",
        prefix,
        path: subPath,
        query,
        headers: req.headers,
        bodyText,
        bodyJson,
      };
      recordedCalls.push(recorded);

      const handler = customRoutes.get(prefix) ?? defaultRouteHandler;
      await handler(recorded, res);
    } catch (err) {
      if (!res.writableEnded) {
        sendJson(res, 500, { error: err instanceof Error ? err.message : "mock error" });
      }
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  const setEnvKey = (key: string, value: string | undefined) => {
    if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };

  return {
    baseUrl,
    calls: recordedCalls,
    urlFor(prefix: MockUpstreamPrefix): string {
      return `${baseUrl}${prefix}`;
    },
    setRoute(prefix: string, handler: UpstreamRouteHandler): void {
      customRoutes.set(prefix, handler);
    },
    getCalls(prefix?: string): readonly RecordedUpstreamCall[] {
      if (!prefix) return [...recordedCalls];
      return recordedCalls.filter((c) => c.prefix === prefix);
    },
    reset(): void {
      customRoutes.clear();
      recordedCalls.length = 0;
    },
    applyEnv(overrides: Readonly<Record<string, string | undefined>> = {}): void {
      const defaults: Record<string, string> = {
        SERPER_API_URL: `${baseUrl}/serper/search`,
        SERPER_API_KEY: "test-key-0000",
        EXA_API_URL: `${baseUrl}/exa/search`,
        EXA_API_KEY: "test-key-0000",
        SEARXNG_URL: `${baseUrl}/searxng`,
        CRAWLER_URL: `${baseUrl}/crawl4ai`,
        CRAWLER_TOKEN: "test-key-0000",
        DOCLING_BACKEND: "local",
        DOCLING_URL: `${baseUrl}/docling`,
        DOCLING_API_KEY: "test-key-0000",
        CHANGE_DETECTION_URL: `${baseUrl}/changedetection`,
        RSSHUB_URL: `${baseUrl}/rsshub`,
        VIES_API_BASE_URL: `${baseUrl}/vies`,
        CH_API_URL: `${baseUrl}/companies-house`,
        COMPANIES_HOUSE_API_KEY: "test-key-0000",
        GLEIF_API_URL: `${baseUrl}/gleif`,
        TED_API_URL: `${baseUrl}/ted/v3/notices/search`,
        PROSPEO_BASE_URL: `${baseUrl}/prospeo`,
        PROSPEO_API_KEY: "test-key-0000",
        EMAILABLE_BASE_URL: `${baseUrl}/emailable`,
        EMAILABLE_API_KEY: "test-key-0000",
        ZEROBOUNCE_BASE_URL: `${baseUrl}/zerobounce`,
        ZEROBOUNCE_API_KEY: "test-key-0000",
        MILLIONVERIFIER_BASE_URL: `${baseUrl}/millionverifier`,
        MILLIONVERIFIER_API_KEY: "test-key-0000",
        HUNTER_BASE_URL: `${baseUrl}/hunter`,
        HUNTER_API_KEY: "test-key-0000",
      };
      for (const [k, v] of Object.entries(defaults)) {
        setEnvKey(k, v);
      }
      for (const [k, v] of Object.entries(overrides)) {
        setEnvKey(k, v);
      }
    },
    restoreEnv(): void {
      for (const [k, v] of savedEnv.entries()) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      savedEnv.clear();
    },
    async close(): Promise<void> {
      for (const [k, v] of savedEnv.entries()) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      savedEnv.clear();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

export interface PinnedHostRouteCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

export type PinnedHostRouteHandler = (
  url: URL,
  init: RequestInit | undefined,
  call: PinnedHostRouteCall,
) => Response | Promise<Response>;

export function createPinnedHostFetchMock(
  routes: ReadonlyArray<{
    readonly match: (url: URL, init?: RequestInit) => boolean;
    readonly handle: PinnedHostRouteHandler;
  }>,
): {
  readonly fetchMock: typeof fetch;
  readonly calls: readonly PinnedHostRouteCall[];
} {
  const calls: PinnedHostRouteCall[] = [];
  const fetchMock: typeof fetch = async (input, init) => {
    const rawUrl =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const url = new URL(rawUrl);
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const headers: Record<string, string> = {};
    if (init?.headers) {
      new Headers(init.headers).forEach((v, k) => {
        headers[k.toLowerCase()] = v;
      });
    }
    const body = typeof init?.body === "string" ? init.body : "";
    const call: PinnedHostRouteCall = { url: url.toString(), method, headers, body };
    calls.push(call);
    for (const route of routes) {
      if (route.match(url, init)) {
        return route.handle(url, init, call);
      }
    }
    return new Response(JSON.stringify({ error: "UNMOCKED_PINNED_HOST", url: url.toString() }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { fetchMock, calls };
}
