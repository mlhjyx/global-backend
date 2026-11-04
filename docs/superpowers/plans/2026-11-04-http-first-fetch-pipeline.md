# HTTP-first 抓取管线（PR-A）落地设计：分级抓取、参数修复与并发 env 化

> 生命周期：`APPROVED`
> 依据：产品负责人 2026-11-04「同意你说的，加入到 plan 计划中，规划好」；主计划 §3.5b 与决策 Q34（2026-11-04 批准）；两轮开源调研选型（8 路并行、一手来源，403k tokens）。
> 范围：主计划 §3.5b 的 PR-A（HTTP-first 分级 + 参数修复 + 并发 env 化）。PR-B（ETag/LLM 缓存）、PR-C（trafilatura sidecar + 自适应限速）、Crawl4AI 0.9.5 升级不在本文范围。

## 一、问题（已核实的证据链）

1. `apps/api/src/adapters/web-crawler.ts:112-114`：每个页面渲染请求硬编码 `delay_before_return_html: 3.0`（每页固定等 3 秒）+ `cache_mode: "BYPASS"`（从不用缓存）。
2. `crawlUrl` 对每个页面无条件走 Crawl4AI `/md` 浏览器渲染（超时 75s）；静态官网也付一次 headless Chromium。
3. 抓取限速与并发写死在工具定义（`crawl4ai.fetch`：rps 2 / concurrency 3 / 同域 2s），无任何环境变量。
4. 基准证据（独立语料，同为 181 页）：无浏览器抽取 F1 0.955 vs 浏览器渲染链路 0.790；渲染路径慢 24–35 倍。

## 二、目标与验收线（映射主计划 §3.5b）

- 静态页抓取 p50 ≤ 0.5s（当前约 3–20s）。
- 浏览器渲染页占比 < 30%（日志计数）。
- 27 家规模深挖 ≤ 20 分钟（当前 50 分钟级）。
- 同集合口径召回不降（对比 2026-11-04 影子验收基线：R1 2≥1 零漏判、R2 6≥4 一致 21/27）。

## 三、承重假设与反证兜底

| # | 假设 | 证据 | 兜底 |
| --- | --- | --- | --- |
| H1 | 公司官网/名录页大多服务端渲染，HTTP 直取 + readability 抽取质量不低于渲染链路 | 独立基准 F1 0.955 vs 0.790；SIGIR 2023 跨复杂度最稳 | **fail-safe 默认渲染**：空壳/薄页/非 HTML/解析异常一律回落 `/md` 渲染 |
| H2 | readability+linkedom 进程内开销可忽略且不阻塞事件循环 | p50 31ms（12ms 解析 + 19ms 抽取），单页 <<50ms | #794 的事件循环滞后保护在位；golden run 观测 p99 |
| H3 | delay 3s→0.5s 与缓存启用不影响抽取质量 | delay 只影响等待时机；缓存键含抓取配置 | env 一键回落（delay 3000 / cache BYPASS） |
| H4 | 新依赖供应链可控 | readability Apache-2.0（周下载 3.8M）、turndown MIT（16M）、linkedom ISC（2M） | Copy 重签 + 漏洞基线重绑门禁 |

## 四、触点（逐文件）

1. **新增 `apps/api/src/adapters/http-first-fetch.ts`**：`fetchPageHttpFirst(url, deps)` — 复用 `requestPublicHttp`（SSRF 逐跳公网 IP 钉扎，透传 `authorizeExternalAction`/`beforePhysicalWire` 钩子）→ 内容类型/魔数检查（非 HTML/二进制放弃）→ 解码（charset 从头/`<meta>` 嗅探，UTF-8 为主）→ `linkedom` 解析 + `@mozilla/readability` 抽正文 → 薄页判定（可读字符数阈值，env 可调）→ `turndown` 转 Markdown（保持 `/md` 输出契约）。返回 `{ markdown, title, contentHash, degraded?: true }` 或 `null`（表示应回落渲染）。
2. **`apps/api/src/tools/builtin-tools.ts`（crawl4ai.fetch.execute）**：robots 检查保持最前；`HTTP_FIRST_FETCH`（env，默认 on）时先走 `fetchPageHttpFirst`，成功且非薄页 → 直接返回（durable 契约不变）；薄页/失败/关闭开关 → 现有 `crawlUrl` 渲染路径。429/503：尊重 `Retry-After`（有则等，无则 1s）重试一次，仍失败按现有失败语义。
3. **`apps/api/src/adapters/web-crawler.ts`**：`delay_before_return_html` 与 `cache_mode` 从 env 读取（`CRAWLER_RENDER_DELAY_MS` 默认 500；`CRAWLER_CACHE_MODE` 默认 `ENABLED`），非法值回落默认。
4. **限速 env 化**：`builtin-tools.ts` 导出纯函数 `readCrawl4aiFetchLimits(env)` → `{ rps, concurrency, perDomainCrawlDelayMs }`（默认 4 / 6 / 2000；env：`CRAWL4AI_FETCH_RPS`、`CRAWL4AI_FETCH_CONCURRENCY`、`CRAWL4AI_FETCH_DOMAIN_DELAY_MS`），工具 spec 在模块加载时使用之。
5. **依赖**：`@mozilla/readability`、`linkedom`、`turndown`（dev：`@types/turndown`）→ lockfile 变更 → `node scripts/copy-fixed-source-impact-resign.mjs` 重签 + 按 `docs/backend/dependency-refresh.md` 重绑漏洞基线。

## 五、合规与治理（不变式，不得破坏）

- **robots**：仍在 `crawl4ai.fetch` 入口强制（HTTP 路径继承，不新增绕过点）。
- **出网审计**：HTTP 路径走 `requestPublicHttp` 并透传 broker 的 `authorizeExternalAction`/`beforePhysicalWire`，物理出口观测与既有 `http.get` 完全一致；`source_policy` advisory 语义不变。
- **个人数据**：readability 输出现有 durable artifact 契约（PERSONAL_DATA, 24h TTL）不变。
- **不做指纹伪装**：本 PR 只用诚实 UA（`HTTP_FIRST_UA`）；curl-impersonate/Lightpanda 属观察名单，另行决策。

## 六、决策记录

| 编号 | 决策 | 理由 |
| --- | --- | --- |
| F1 | HTTP-first 注入点在 `crawl4ai.fetch` 工具（发现抓取的唯一边界），不改 provider / workflow | 一处生效全链路；活动/工作流零改动，可并行 P1–P6 |
| F2 | fail-safe 方向：任何可疑信号（薄页、非 HTML、解析异常、超时）**回落渲染** | 召回优先于速度；渲染仍是正确性底线 |
| F3 | 429 自适应延迟本 PR 只做「一次重试 + Retry-After 尊重」；衰减式自适应留 PR-B/C 用数据决定 | PR-A 保持小步；防两层限流打架 |
| F4 | 缓存修复（BYPASS→ENABLED）随本 PR | 零成本收益；配置变更时人工 BYPASS 验证一次（文档写明） |
| F5 | env 读取实现为纯函数并导出，默认值即生产目标值 | 可单测、可观测、可回落 |

## 七、TDD 步骤（RED→GREEN，每步先写失败测试）

1. `http-first-fetch.spec.ts`：SRP 页 fixture → 返回 markdown（含正文关键句）且**不调用**渲染 fetcher；薄页 → 返回 null；`application/pdf` 魔数 → 返回 null；HTML 实体/unicode 正确。
2. `builtin-tools` spec：HTTP-first 成功时不 invoke `crawlUrl`；薄页时 invoke（render 兜底）；`HTTP_FIRST_FETCH=off` 直接 render；robots 拒绝 → 空文本不计失败（回归现有行为）；429+Retry-After → 重试一次后成功/失败路径。
3. `web-crawler` spec：env 覆盖（`CRAWLER_RENDER_DELAY_MS=0`、`CRAWLER_CACHE_MODE=BYPASS`）反映在请求体；非法值回落默认。
4. `readCrawl4aiFetchLimits` 纯函数测试：默认值与 env 覆盖、非法值回落。
5. 相关回归：`web-crawler`、`builtin-tools`、`tool-broker` 既有 spec 全绿；`nest build` 通过。
6. 真实验收（PR 合入后 golden mini-run）：见 §二。

## 八、风险与回退

- 抽取质量下降 → `HTTP_FIRST_FETCH=off` 即时回到纯渲染（无需回滚代码）。
- 站点对诚实 UA 返回 403/空壳 → 自动回落渲染；若某域长期如此，后续把 curl-impersonate 列入观察升级。
- 依赖引入引发门禁 → Copy 重签与基线重绑随 PR 完成；`pnpm docs:verify`/`gctl check` 全绿才推。
- 全面回退：env 三开关恢复（HTTP_FIRST_FETCH=off、CRAWLER_RENDER_DELAY_MS=3000、CRAWLER_CACHE_MODE=BYPASS）。

## 九、闭环（本 PR 完成后）

- 日志/计数：httpFirst 命中 vs 渲染回落的每次 run 计数（为归因看板「抓取层」页提供数据）。
- 归因看板（Q33 PR-1）加抓取层页签：HTTP/渲染占比、p50/p95 抓取耗时、429 次数。
- PR-B：ETag/304 + 内容哈希 LLM 缓存；PR-C：trafilatura sidecar + 自适应限速；Crawl4AI 0.9.5 安全升级独立 PR（重打 egress 补丁镜像）。
