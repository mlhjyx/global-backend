/**
 * deepseek.search / deepseek.fetch —— DeepSeek Search & Fetch API 的 ToolBroker 工具
 * （获客通路 A：模型驱动联网搜索的执行后端；模型侧工具环见 discovery/model-web-search）。
 *
 * 治理口径：
 *  - sourcePolicy=none：DeepSeek 是**搜索基础设施**（与自托管 SearXNG 同层），不是被检索的
 *    标的站点，也不是受 source_policy 登记治理的数据源；出网目标固定为 api.deepseek.com。
 *  - personalData：`deepseek.search` 只输出 url+title，并把个人主页 URL 整体丢弃（与
 *    `searxng.search` 同口径，D1）；摘要/正文/作者等 provider 字段不离开适配器。
 *    `deepseek.fetch` 返回任意公开页面正文，正文可能承载具名个人 → 声明 personalData:true，
 *    与 `social.fetch` 同类。
 *  - 成本：DeepSeek 按成功请求计费 5 元/1000 次（≈0.075 美分/次），而预算账本以整数
 *    美分结算（BigInt(costCents)），无法表示亚分金额；这里按**上限取整**：reserve 1 美分、
 *    成功计费一次 settle 1 美分，未计费的响应（空结果/正文为空/失败）settle 0。
 *  - 缺 key：返回 degraded 空结果而不抛错（未配置 = 该通路不可用，不是故障）。
 *  - 限速：官方按账户约 5 QPS/端点；客户端限速取 5 rps，避免 429 与共享 key 互相踩踏。
 */
import { createHash } from "node:crypto";
import { CATALOG_RESULT_PROJECTION_SCHEMAS } from "../durable-results/catalog-result-projections";
import {
  deepSeekToolFetch,
  deepSeekToolSearch,
  resolveDeepSeekApiKey,
  type DeepSeekSearchHit,
} from "../adapters/deepseek-tools";
import { isAllowedByRobots } from "../adapters/robots";
import { assertToolExternalActionAuthorized, Tool } from "./tool-contract";
import { ToolRegistry } from "./tool-registry";
import {
  durablePageText,
  durableTitle,
  isDurableText,
  isPersonProfileUrl,
} from "./durable-text";

const hash = (value: string): string =>
  createHash("sha256").update(value).digest("hex").slice(0, 24);
const stableKey = (value: unknown): string => hash(JSON.stringify(value));

/** deepseek-search/v1 的持久上限：最多 20 条、url ≤2048、title ≤2000（与 searxng 同构）。 */
export const DEEPSEEK_SEARCH_MAX_RESULTS = 20;
/** deepseek-fetch/v1 的正文上限（字符）：UTF-8 最坏 3 字节/字符仍低于 119 KiB 信封。 */
export const DEEPSEEK_FETCH_MAX_CONTENT_CHARS = 32_000;
const DEEPSEEK_QUERY_MAX_CHARS = 128;
const DEEPSEEK_COUNT_MAX = 50;
/** 官方默认 count=10；持久契约最多保留 20，故请求侧同样不超过 20。 */
const DEEPSEEK_COUNT_WIRE_MAX = DEEPSEEK_SEARCH_MAX_RESULTS;
const DEEPSEEK_URL_MAX_CHARS = 2048;
const DEEPSEEK_TITLE_MAX_CHARS = 2000;
/** 一次计费请求的最低可表示成本（账本只接受整数美分，见文件头）。 */
const DEEPSEEK_REQUEST_COST_CENTS = 1;

export type DeepSeekSearchResult = { url: string; title?: string };
export type DeepSeekSearchOutput = { results: DeepSeekSearchResult[] };

export interface DeepSeekSearchInput {
  query: string;
  /** 1–50（官方口径）；超过 20 的请求会被截到持久契约上限 20。缺省 10（官方默认）。 */
  count?: number;
  /**
   * 只允许 false/缺省：本工具声明 personalData:false，搜索结果正文/摘要一律不持久化，
   * 请求 need_content 只会花钱买到被丢弃的正文。需要页面正文时用 deepseek.fetch。
   */
  needContent?: false;
}

interface NormalizedSearchInput {
  query: string;
  count: number;
}

function normalizeSearchInput(input: DeepSeekSearchInput): NormalizedSearchInput {
  const invalid = (detail: string): never => {
    throw new Error(`DEEPSEEK_SEARCH_INPUT_INVALID: ${detail}`);
  };
  if (!input || typeof input !== "object") return invalid("input must be an object");
  if (typeof input.query !== "string") return invalid("query must be a string");
  const query = input.query.trim();
  if (query.length < 1 || query.length > DEEPSEEK_QUERY_MAX_CHARS) {
    return invalid(`query must be 1-${DEEPSEEK_QUERY_MAX_CHARS} characters`);
  }
  const rawCount = input.count ?? 10;
  if (
    !Number.isSafeInteger(rawCount) || rawCount < 1 ||
    rawCount > DEEPSEEK_COUNT_MAX
  ) {
    return invalid(`count must be an integer between 1 and ${DEEPSEEK_COUNT_MAX}`);
  }
  // 模型输出不可信：按 unknown 复核，类型层只声明了合法取值。
  const needContent = (input as { needContent?: unknown }).needContent;
  if (needContent !== undefined && needContent !== false) {
    throw new Error("DEEPSEEK_SEARCH_CONTENT_NOT_PERMITTED");
  }
  return { query, count: Math.min(rawCount, DEEPSEEK_COUNT_WIRE_MAX) };
}

/**
 * Only what the durable contract keeps leaves deepseek.search: url and title. Snippets,
 * summaries and content are raw provider output that may name people, and a personal
 * profile page names one in its URL and title; neither leaves a personalData:false tool.
 */
function durableSearchResults(hits: readonly DeepSeekSearchHit[]): DeepSeekSearchResult[] {
  return hits
    .flatMap((hit): DeepSeekSearchResult[] => {
      const url: unknown = hit.url;
      if (
        typeof url !== "string" || url.length === 0 || url.length > DEEPSEEK_URL_MAX_CHARS ||
        !isDurableText(url) || isPersonProfileUrl(url)
      ) {
        return [];
      }
      const title = typeof hit.title === "string" ? durableTitle(hit.title, DEEPSEEK_TITLE_MAX_CHARS) : null;
      return [title === null ? { url } : { url, title }];
    })
    .slice(0, DEEPSEEK_SEARCH_MAX_RESULTS);
}

export interface DeepSeekSearchToolDependencies {
  deepSeekSearch: typeof deepSeekToolSearch;
}

export function createDeepSeekSearchTool(
  dependencies: DeepSeekSearchToolDependencies = { deepSeekSearch: deepSeekToolSearch },
): Tool<DeepSeekSearchInput, DeepSeekSearchOutput> {
  return {
    id: "deepseek.search",
    version: "1.0.0",
    category: "search",
    sourceClass: "public_intelligence",
    cost: { unit: "request", estimatedCents: DEEPSEEK_REQUEST_COST_CENTS, external: true },
    rateLimit: { rps: 5, concurrency: 5 },
    compliance: {
      sourcePolicy: "none",
      respectsRobots: false,
      personalData: false,
      allowedPurpose: ["discovery"],
      reversible: true,
      authRequired: true,
      risk: "low",
    },
    capabilities: { produces: ["domain"], accepts: ["keywords"] },
    idempotencyKey: (i) => `deepseek.search:${stableKey(i)}`,
    durableResultStrategy: {
      kind: "typed_projection",
      schema: CATALOG_RESULT_PROJECTION_SCHEMAS["deepseek.search"],
    },
    durableReplayResult: (result) => ({
      data: {
        results: result.data.results.flatMap((item) => {
          const url = publicOrigin(item.url);
          return url ? [{ url }] : [];
        }),
      },
      costCents: result.costCents,
      ...(result.degraded === undefined ? {} : { degraded: result.degraded }),
    }),
    healthCheck: async () =>
      resolveDeepSeekApiKey()
        ? { healthy: true, detail: "deepseek" }
        : { healthy: false, detail: "DEEPSEEK_API_KEY not configured" },
    // One wire per attempt: the adapter calls ctx.beforePhysicalWire immediately before each send.
    physicalWireObservation: "before_each_wire",
    execute: async (input, ctx) => {
      const normalized = normalizeSearchInput(input);
      const apiKey = resolveDeepSeekApiKey();
      if (!apiKey) {
        return { data: { results: [] }, costCents: 0, degraded: true };
      }
      await assertToolExternalActionAuthorized(ctx);
      const response = await dependencies.deepSeekSearch(
        { query: normalized.query, count: normalized.count },
        {
          apiKey,
          beforeRequest: async () => {
            await assertToolExternalActionAuthorized(ctx);
            await ctx.beforePhysicalWire?.();
          },
        },
      );
      return {
        data: { results: durableSearchResults(response.hits) },
        costCents: response.billed ? DEEPSEEK_REQUEST_COST_CENTS : 0,
      };
    },
  };
}

/** 搜索结果 replay 只保留 origin（与 searxng 同口径：路径/标题可能承载 query PII 或人名）。 */
function publicOrigin(rawUrl: string | undefined): string | null {
  if (!rawUrl) return null;
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
      return null;
    return `${parsed.origin}/`;
  } catch {
    return null;
  }
}

export const deepseekSearchTool = createDeepSeekSearchTool();

export interface DeepSeekFetchInput {
  url: string;
}

export interface DeepSeekFetchOutput {
  url: string;
  title?: string;
  content: string;
}

function normalizeFetchUrl(input: DeepSeekFetchInput): string {
  const invalid = (): never => {
    throw new Error("DEEPSEEK_FETCH_URL_INVALID");
  };
  if (!input || typeof input !== "object" || typeof input.url !== "string") return invalid();
  const raw = input.url.trim();
  if (raw.length === 0 || raw.length > DEEPSEEK_URL_MAX_CHARS) return invalid();
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return invalid();
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return invalid();
  if (parsed.username !== "" || parsed.password !== "") return invalid();
  if (!isDurableText(raw)) return invalid();
  return raw;
}

export interface DeepSeekFetchToolDependencies {
  deepSeekFetch: typeof deepSeekToolFetch;
  isAllowedByRobots: typeof isAllowedByRobots;
}

export function createDeepSeekFetchTool(
  dependencies: DeepSeekFetchToolDependencies = {
    deepSeekFetch: deepSeekToolFetch,
    isAllowedByRobots,
  },
): Tool<DeepSeekFetchInput, DeepSeekFetchOutput> {
  return {
    id: "deepseek.fetch",
    version: "1.0.0",
    category: "fetch",
    sourceClass: "public_intelligence",
    cost: { unit: "request", estimatedCents: DEEPSEEK_REQUEST_COST_CENTS, external: true },
    rateLimit: { rps: 5, concurrency: 5 },
    // personalData:true —— 任意公开页面正文可能承载具名个人（与 social.fetch 同类）。
    // robots 在 execute 内强制（由我方先查目标站 robots.txt，再委托 DeepSeek 抓取）。
    compliance: {
      sourcePolicy: "none",
      respectsRobots: true,
      personalData: true,
      allowedPurpose: ["discovery", "enrichment"],
      reversible: true,
      authRequired: true,
      risk: "medium",
    },
    capabilities: {
      produces: ["company", "domain", "contact"],
      accepts: ["domain"],
    },
    idempotencyKey: (i) => `deepseek.fetch:${hash(i.url)}`,
    durableResultStrategy: {
      kind: "typed_projection",
      schema: CATALOG_RESULT_PROJECTION_SCHEMAS["deepseek.fetch"],
    },
    durableReplayResult: (result) => ({
      data: {
        url: result.data.url,
        ...(result.data.title === undefined ? {} : { title: result.data.title }),
        content: durablePageText(result.data.content, DEEPSEEK_FETCH_MAX_CONTENT_CHARS),
      },
      costCents: result.costCents,
      ...(result.degraded === undefined ? {} : { degraded: result.degraded }),
    }),
    healthCheck: async () =>
      resolveDeepSeekApiKey()
        ? { healthy: true, detail: "deepseek" }
        : { healthy: false, detail: "DEEPSEEK_API_KEY not configured" },
    // robots.txt hops and the fetch POST each call ctx.beforePhysicalWire before sending (D13).
    physicalWireObservation: "before_each_wire",
    execute: async (input, ctx) => {
      const url = normalizeFetchUrl(input);
      const apiKey = resolveDeepSeekApiKey();
      if (!apiKey) {
        return { data: { url, content: "" }, costCents: 0, degraded: true };
      }
      // 抑制闸门先行：拒绝是终态错误，不能降级成空结果（robots 内部还会再查一次）。
      await assertToolExternalActionAuthorized(ctx);
      // robots 禁抓 → 合规放弃（不换 UA、不付费），返回空正文，不计失败。
      const allowed = await dependencies.isAllowedByRobots(url, {
        authorizeExternalAction: ctx.authorizeExternalAction,
        beforePhysicalWire: ctx.beforePhysicalWire,
      });
      if (!allowed) {
        return { data: { url, content: "" }, costCents: 0 };
      }
      const response = await dependencies.deepSeekFetch(
        { url },
        {
          apiKey,
          beforeRequest: async () => {
            await assertToolExternalActionAuthorized(ctx);
            await ctx.beforePhysicalWire?.();
          },
        },
      );
      const title = response.title === undefined ? null : durableTitle(response.title, DEEPSEEK_TITLE_MAX_CHARS);
      return {
        data: {
          url,
          ...(title === null ? {} : { title }),
          content: durablePageText(response.content, DEEPSEEK_FETCH_MAX_CONTENT_CHARS),
        },
        costCents: response.billed ? DEEPSEEK_REQUEST_COST_CENTS : 0,
      };
    },
  };
}

export const deepseekFetchTool = createDeepSeekFetchTool();

/** 注册 DeepSeek 搜索/抓取工具（由 registerBuiltinTools 调用）。 */
export function registerDeepSeekTools(registry: ToolRegistry): ToolRegistry {
  registry.register(deepseekSearchTool as Tool);
  registry.register(deepseekFetchTool as Tool);
  return registry;
}
