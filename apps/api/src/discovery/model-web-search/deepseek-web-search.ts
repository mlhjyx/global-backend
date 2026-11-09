import type { ToolBroker } from '../../tools/tool-broker';

/**
 * 模型联网搜索的 DeepSeek 执行器（获客通路 A）。
 *
 * 模型侧工具环（`model-web-search.ts`，独立在途 PR）把 `web_search` 工具调用交给
 * `ModelWebSearchDeps.search`；本模块是它的生产绑定：经 ToolBroker 调用
 * `deepseek.search`（预算/限流/Trace 在 Broker 内强制），工具持久契约只保留
 * url+title（personalData:false，摘要/正文不离开工具）。与
 * `company/website-candidates.ts#brokerBackedSearxSearch` 同构；需要页面正文时由
 * `deepseek.fetch` 单独承担（personalData:true）。
 *
 * 不传 taskContractId：与 searxng 执行器一致，任务级 allowedTools 门由调用方在接线
 * provider 时决定（模型任务 `discovery.web_search_candidates` 的 allowedTools 要在
 * 接线 PR 里显式加入本工具后，才能以该任务契约身份调用）。
 */

export interface DeepSeekWebSearchHit {
  url: string;
  title?: string;
}

export interface DeepSeekWebSearchContext {
  workspaceId: string;
  correlationId?: string;
}

export type DeepSeekWebSearchFn = (
  query: string,
  context: DeepSeekWebSearchContext,
) => Promise<readonly DeepSeekWebSearchHit[]>;

export function brokerBackedDeepSeekWebSearch(
  broker: Pick<ToolBroker, 'invoke'>,
): DeepSeekWebSearchFn {
  return async (query, context) => {
    const result = await broker.invoke<
      { query: string },
      { results: DeepSeekWebSearchHit[] }
    >(
      'deepseek.search',
      { query },
      {
        workspaceId: context.workspaceId,
        ...(context.correlationId ? { correlationId: context.correlationId } : {}),
      },
    );
    const rows = Array.isArray(result.data?.results) ? result.data.results : [];
    return rows
      .filter((row) => typeof row?.url === 'string' && row.url.length > 0)
      .map((row) =>
        typeof row.title === 'string' && row.title.length > 0
          ? { url: row.url, title: row.title }
          : { url: row.url },
      );
  };
}
