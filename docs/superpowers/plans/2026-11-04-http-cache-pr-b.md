# PR-B 落地设计：ETag/304 条件请求 + 内容哈希键控 LLM 抽取缓存（v2 · 2026-11-08 补齐启动门）

> 生命周期：`APPROVED`
> 生命周期依据：产品负责人 2026-11-08 批准 D-a~D-f 按本设计执行（§0.6 任务启动门通过）；主计划 §0.2 步 5 / §3.5b PR-B。漂移核验基于 origin/main `6bd421a0`，实现分支基于 `eacae200`（核验结论不变）。
> 关联：步 6（Crawl4AI 0.9.5 安全升级 + trafilatura 处置）见 §14；PR-A 设计 `docs/superpowers/plans/2026-11-04-http-first-fetch-pipeline.md`。

## 1. 背景与目标

PR-A（HTTP-first 抓取，已上线）让静态页不再走浏览器渲染，但**每个 run 仍会重复抓同一页、重复花同一笔 LLM 抽取钱**。全仓当前**零条件请求**，LLM 抽取结果**不跨 run 复用**（durable result 只按 run 内 operation key 重放，跨 run 是新的 key）。

目标（主计划 §0.2 步 5 验收）：
1. `url_content_cache`：HTTP-first 路径带 `If-None-Match`/`If-Modified-Since` 条件请求；304 直接复用缓存 markdown，不读 body、不重做抽取。
2. `llm_extraction_cache`：键 = 输入全文哈希 + task + model + prompt/契约版本（本次实现为严格超集，见 §4.2）；24h TTL；DSR 擦除；env 一键关断；过期行清理为上线硬条件。
3. **验收**：同一 ICP 连跑两次，第二次**零重复 LLM 调用**（usage 台账对比）、抓取请求下降；跨 run 冷启动提速 ≥30%；golden mini-run 同集合召回不降。

## 2. 现状与漂移核验（2026-11-08）

对 11-04 草案逐触点核对当前代码（origin/main `6bd421a0`），**四处漂移**必须修正：

| # | 草案表述 | 现状事实 | 修正 |
| --- | --- | --- | --- |
| 1 | C3：LLM 缓存挂在「task-registry runner」，一处生效 | **不存在 runner**。`ai-tasks/` 只有 `task-contract.ts`/`task-registry.ts`；所有结构化任务统一经 `model-runtime/structured-task-runtime-bridge.ts` 的 `executeStructuredTaskWithRuntime()`（fit-judge / providers / icp.service / outreach / taxonomy 等 ~9 处调用）→ 内部 `ModelExecutionRuntime.execute` → `gateway.generateStructured` | 落点改为 `executeStructuredTaskWithRuntime` 入口（唯一收口），见 §4.2 |
| 2 | C5：两表均无新增 PII 列 | `llm_extraction_cache.result` 可能含个人信息（`contact.find_decision_makers` 抽取姓名/邮箱；`discovery.classify_trade_role` 证据片段），页面 markdown 也可能含 Impressum 个人信息 | 按既有 `crawl4ai.fetch` 工件口径：`PERSONAL_DATA`、24h TTL、DSR 按 workspace 擦除；不新增 pii-crypto 列（同工件先例），见 §7 |
| 3 | 未提平台渠道抓取 | 渠道抓取以 `workspaceId='platform'` 走 transient artifact 作用域（#821），**不是 UUID**，进不了 `workspace_id UUID` + RLS 的表 | v1 只覆盖租户 workspace（UUID）；平台渠道缓存另立平台域缓存表，不在本 PR，见 §4.6 |
| 4 | 清理「每日 03:30 vacuum / pg_cron 不用」 | 备份窗口在宿主侧（db-backup timer），引擎无对应 hook；raw-retention sweep 只枚举「有到期 raw 记录」的 workspace，覆盖不了纯缓存 workspace | 迁移内置 owner 权限的 `purge_expired_*_v1()`（照 `list_due_raw_retention_workspaces_v1` 的 SECURITY DEFINER 先例）+ worker 启动与每 6h 调用，见 §4.3 |

已核验成立的部分：
- `fetchPageHttpFirst`（`apps/api/src/adapters/http-first-fetch.ts`）经 `requestPublicHttp` 出网；`sanitizeRequestHeaders` 不会丢弃 `If-None-Match`/`If-Modified-Since`；`PublicHttpResponse` 含 `status`/`headers`/`body`。
- **304 现状是陷阱**：`requestPublicHttp` 把 3xx 当重定向；304 无 `location` 时返回 `{ok:false, status:304, headers}`。`defaultFetchHtml` 现在把非 2xx 一律当 `null`→回落渲染——**必须显式识别 304**，否则条件请求反而更贵。
- 工具层 `crawl4ai.fetch`（`tools/builtin-tools.ts`）是唯一 HTTP-first 调用点，`ToolContext` 有 `workspaceId`；`registerBuiltinTools` / `buildToolBroker({prisma})` 是注入 DB 缓存的组合根。
- 结构化任务调用方显式传 `model: contract.model`（如 `discovery/fit-judge.ts`），键可含真实配置模型。
- `PrismaService` 以 `app_user` + `withWorkspace()` RLS 事务访问；新表照 `discovery_company_job`（FORCE RLS + tenant policy + GRANT）与 `source_channel_record`（无 FORCE 的平台表）两种样板。
- DSR：`temporal/deletion.activities.ts` `eraseSubject` 已在事务内做 workspace 级清理（含 patent cache），两表可并入；raw 保留 sweep 的 `patch()` 先例可参考。

## 3. 承重假设（可证伪）

1. **同页二次运行内容不变** → 条件请求拿到 304，markdown 与 contentHash 不变，LLM 缓存键自然命中。若目标站频繁改版/按时间戳渲染，收益按命中率折算（env 可关）。
2. **结构化任务对同一输入返回可复用结果 24h**：采样默认温度、纯生成无副作用；humanGate 任务（claims/ICP）缓存命中的仍是同一输入的同一产出，审批语义不变。若某任务需强制新鲜（未来上线），在任务契约加 `cacheable:false` 即可。
3. **键足够防串**：全文 digest 覆盖 prompt/system/model/maxTokens/task；再加契约版本、schema digest、promptVersion、注册模型名。任一元组变化→新键。
4. **缓存是纯优化**：任何缓存读写失败（DB 抖动/RLS 拒绝/脏数据）都退化为 miss 直通，绝不影响抓取/抽取主链；负向测试覆盖。
5. **24h TTL 是承诺上限**：过期行按 §4.3 清理机制有界；单 workspace 活跃时写入路径即时清，空闲 workspace 由 purge 函数兜底。

## 4. 设计

### 4.1 `url_content_cache`（页面缓存 + 条件请求）

**表**（新迁移，additive）：

```
url_content_cache (
  workspace_id UUID NOT NULL,
  url_hash CHAR(64) NOT NULL,        -- sha256(规范化 URL)
  url TEXT NOT NULL,                 -- 原 URL（观测/审计）
  etag TEXT NULL,
  last_modified TEXT NULL,
  content_hash CHAR(64) NOT NULL,    -- sha256(markdown utf8)，沿用 HttpFirstPage.contentHash
  markdown TEXT NOT NULL,
  fetched_at TIMESTAMPTZ(3) NOT NULL,
  expires_at TIMESTAMPTZ(3) NOT NULL,
  PRIMARY KEY (workspace_id, url_hash)
)
INDEX (workspace_id, expires_at)
FORCE RLS + POLICY workspace_id = current_workspace_id()
GRANT SELECT, INSERT, UPDATE, DELETE TO app_user
```

**读写路径**（`adapters/http-first-fetch.ts` + `adapters/url-content-cache.ts`）：
- `HttpFirstOptions` 新增 `cache?: UrlContentCachePort`（`get(url)` / `put(entry)`）；`HttpFirstHtmlFetcher` 返回体扩展 `status`、`etag`、`lastModified`（可选字段，向后兼容）。
- 三态：**miss**（无有效行）→ 普通 GET；**条件命中**（有未过期行 + etag/lastModified）→ GET 带 `If-None-Match`/`If-Modified-Since`；**304** → 直接返回缓存 markdown（provenance `cache:'conditional-304'`），**不解析 body、不写缓存**；**200** → 正常 readability/turndown → upsert 缓存（`ON CONFLICT (workspace_id,url_hash) DO UPDATE`，`fetched_at/expires_at` 滑动续期，provenance `cache:'miss'`）。
- 缓存行过期（`expires_at <= now`）→ 不带条件头全量抓、覆盖写（不回放过期内容，保持 24h 承诺简单）。
- 机器人/source_policy/授权检查保持原位：`crawl4ai.fetch` 先做 robots 与用途门，再进 HTTP-first；条件请求仍逐跳过 `authorizeExternalAction`/`beforePhysicalWire`（它是真实出网）。
- 缓存写库用 `withWorkspace(prisma, workspaceId, tx)`（工具经组合根拿到端口，`workspaceId` 非 UUID 时端口直接 no-op）。

### 4.2 `llm_extraction_cache`（结构化任务结果缓存）

**表**（同一迁移）：

```
llm_extraction_cache (
  workspace_id UUID NOT NULL,
  cache_key CHAR(64) NOT NULL,       -- sha256(键材料，见下)
  task_id VARCHAR(160) NOT NULL,
  result JSONB NOT NULL,             -- 结构化输出（过 schema 校验后才入库）
  created_at TIMESTAMPTZ(3) NOT NULL,
  expires_at TIMESTAMPTZ(3) NOT NULL,
  PRIMARY KEY (workspace_id, cache_key)
)
INDEX (workspace_id, expires_at)
FORCE RLS + POLICY workspace_id = current_workspace_id()
GRANT SELECT, INSERT, UPDATE, DELETE TO app_user
```

**键材料**（`canonicalDigest`，严格超集于计划 §3.5b 的 normalizedTextHash+task+model+promptVersion）：
`workspaceId | task | contractVersion | promptVersion | requestedAlias(注册模型串) | canonicalDigest(requestMaterial=task+prompt+system+model+maxTokens) | canonicalDigest(schema) | reasoningEffort`。

**落点**（`model-runtime/structured-task-runtime-bridge.ts`）：`executeStructuredTaskWithRuntime` 内，在构造 runtime **之前**：
1. `cacheable = getTask(input.task)?.cacheable === true && llmCacheEnabled()`（env `ACQ_LLM_CACHE` 默认 on；`off` 全直通）。
2. 查缓存（未过期）→ 命中：对结果重跑 `checkAgainstSchema` + `input.validateOutput`；通过则返回 `ModelResult`（`provider:'llm-cache'`，`usage` 缺省、`callCount:0`，`runtimeExecution` 标记 `cacheHit:true`/`physicalCalls:0`）；**不创建 runtime、不过网关，因此不落 ai_trace/usage_ledger、不结算**。校验不过 → 视同 miss 并覆盖。
3. miss：走现有 runtime/网关；**成功后**把 `gatewayResult.data` upsert 入库（TTL 24h，env `ACQ_LLM_CACHE_TTL_HOURS` 可调，非法值回 24）。
4. 缓存读写任何异常：`console.warn` + 直通（fail-open 只为优化；负向测试覆盖）。

**任务白名单**：`task-registry.ts` 给以下任务加 `cacheable: true`：`discovery.extract_company`、`discovery.classify_trade_role`、`discovery.extract_list`、`discovery.qualify_fit`、`contact.find_decision_makers`、`company_understanding.extract_claims`、`company_understanding.extract_offerings`、`company_understanding.extract_profile`。`icp.design`/`discovery.query_plan`（计划类、低频、humanGate）不缓存；site-builder 任务不改（不设 `cacheable`）。

**配置注入**：新 `model-runtime/llm-result-cache.ts` 提供端口接口与 `configureLlmResultCacheStore()`；在三个进程入口（`main.ts`、`temporal/worker.ts`、`temporal/dev-fast-lane-worker.ts`）用各自 `PrismaService` 注入 Prisma 实现。未配置 = 关闭（单测默认关闭，避免隐式依赖）。

### 4.3 过期清理（上线硬条件）

- 写入路径：每次 `put` 顺带 `deleteMany({ workspaceId, expiresAt: { lte: now } })`（走 `(workspace_id, expires_at)` 索引，有界）。
- 全局兜底：迁移内置两个 `SECURITY DEFINER` 函数 `purge_expired_url_content_cache_v1(p_limit INT)` / `purge_expired_llm_extraction_cache_v1(p_limit INT)`，仅删 `expires_at <= statement_timestamp()` 的行、返回删除数；照 `list_due_raw_retention_workspaces_v1` 先例加 `session_user = 'app_user'` 守卫、`REVOKE ALL FROM PUBLIC`、`GRANT EXECUTE TO app_user`。worker（`temporal/worker.ts`）**启动时 + 每 6h** 调用，每轮最多 10×5000 行；失败只记日志，不影响 worker 就绪。

### 4.4 DSR（数据权利）

`temporal/deletion.activities.ts` 的 `eraseSubject` 事务内追加：`urlContentCache.deleteMany({ where: { workspaceId } })` + `llmExtractionCache.deleteMany({ where: { workspaceId } })`（与 patent cache 同模式），回执计数并入既有统计。按 workspace 全删（隐私保守方向），不做 per-subject 过滤。

### 4.5 观测

- 页面缓存：`crawl4ai.fetch` provenance 增 `cache: 'miss' | 'conditional-304'`（无缓存时缺省）；结构化日志 `[http-cache] url=… state=…`（URL 截断）。
- LLM 缓存：bridge 命中/未命中各打一行 `[llm-cache] task=… hit=…`；命中返回 `runtimeExecution.cacheHit=true`（类型加可选字段，现有消费方无感）。
- 归因看板「抓取层」页签（Q33 PR-1）不在本 PR；本 PR 提供可聚合日志字段。
- **不写 ai_trace/usage_ledger**（不碰整改线）；命中即不计费是设计语义。

### 4.6 平台渠道抓取边界（v1 不含）

渠道抓取 `workspaceId='platform'` + transient 作用域，无法进 RLS 租户表。v1：端口对非 UUID workspace no-op（渠道链路零行为变化）。后续如需平台域缓存，另立 `platform_url_content_cache`（平台表、无 RLS、ops 可审计）单独设计——本 PR 不做，避免越权合并两域。

## 5. 接口 / 事件契约

```ts
// adapters/url-content-cache.ts
export interface UrlContentCacheEntry {
  url: string; etag: string | null; lastModified: string | null;
  contentHash: string; markdown: string; fetchedAt: Date; expiresAt: Date;
}
export interface UrlContentCachePort {
  get(workspaceId: string, url: string): Promise<UrlContentCacheEntry | null>; // 仅未过期
  put(workspaceId: string, url: string, entry: UrlContentCacheWrite): Promise<void>; // upsert + 清本 workspace 过期行
}
// DSR 擦除不在此端口：deletion.eraseSubject 在同一事务内按 workspace DELETE 两表。

// model-runtime/llm-result-cache.ts
export interface LlmResultCachePort {
  get(workspaceId: string, key: string): Promise<{ result: unknown } | null>;   // 仅未过期
  put(workspaceId: string, key: string, taskId: string, result: unknown, ttlHours: number): Promise<void>;
}
```

- 对外事件：**无新增**（纯内部缓存，不发 outbox/run_event）。
- Tool Contract：`crawl4ai.fetch` 的输入/输出 schema **不变**（缓存只在实现内透明生效）；provenance 增可选字段。
- 环境变量：`ACQ_LLM_CACHE`（on/off，默认 on）、`ACQ_LLM_CACHE_TTL_HOURS`（默认 24）、`URL_CONTENT_CACHE`（on/off，默认 on）。三开关一键回退。

## 6. 幂等与重试

- 页面缓存：`ON CONFLICT (workspace_id,url_hash) DO UPDATE`；重复写同页只刷新时间戳，无副作用。
- LLM 缓存：`ON CONFLICT (workspace_id,cache_key) DO UPDATE`；键含全部输入，重放写同值幂等。
- Temporal 重试：缓存是活动内的旁路读写，不改变活动输入/输出契约；重试要么命中要么重算，均可重入。
- 并发：两个同键运行同时 miss → 各算一次、后写覆盖（可接受；不引分布式锁）。

## 7. 权限与合规（RLS / DSR / PII）

- 两表均 FORCE RLS + `workspace_id = current_workspace_id()`，读写一律 `withWorkspace`；跨租户不可见由 DB 保证。真库用例照 `*.rls.spec.mjs` 模式（跨 workspace 读 0 行、app_user 无越权 DDL/无 policy 绕过）。
- PII 口径：页面 markdown 与抽取结果可能含个人信息（Impressum/联系人抽取），按既有工件 `PERSONAL_DATA` 同口径——24h TTL + DSR 级联 + 不导出、不进平台绿库。**不新增 pii-crypto 列**（内容为自由文本，同 `crawl4ai-fetch/v1` 工件先例）。
- DSR：见 §4.4；擦除计数进删除回执。
- 清理函数：`SECURITY DEFINER` + `session_user='app_user'` 守卫 + `REVOKE ALL FROM PUBLIC` + 只删过期行，无读接口。

## 8. 预算与成本

- LLM 缓存命中 = 零网关调用、零结算、零 ai_trace；直接削减「重复页重复判」的模型花费（当前每个 run 对同页 fit/抽取各一次）。
- 页面缓存只省带宽与解析，不改变工具计价（HTTP-first 本身 `costCents: 0`，渲染兜底 1）。
- 存储有界：缓存写入把 markdown 截断到 200k 字符（`DEFAULT_HTTP_FIRST_CACHE_MAX_CHARS`；工具单次最多消费 100k，故截断不影响任何调用方结果），24h TTL + 每 6h purge；量级 = 活跃 workspace 数 × 24h 抓取页数，不预付。

## 9. 迁移与回滚

- 迁移：单个 additive 迁移（两表 + 两 purge 函数 + RLS/GRANT）。无回填、无数据改写。
- 代码回滚：三个 env 置 `off` 即恢复原行为（缓存表闲置不影响旧代码——旧镜像不认识该表）；镜像回退无迁移依赖。
- 迁移回滚（如需）：`DROP TABLE url_content_cache, llm_extraction_cache; DROP FUNCTION purge_expired_*_v1;`——仅缓存数据，可直接丢弃。
- 部署顺序：迁移先于新镜像（新代码缺表时 fail-open 直通，不阻塞；旧代码不读新表）。与发车纪律一致（发车由产品负责人决定）。

## 10. 测试与 TDD 步骤（RED→GREEN）

1. `http-first-fetch.spec.ts`：注入缓存 stub——miss 不带条件头；有条件行时请求带 `If-None-Match`/`If-Modified-Since`；304 → 返回缓存 markdown 且 `fetchHtml` 未被二次解析（不触发 readability）、不写缓存；200 → 写回（含 etag/lastModified）；过期行 → 全量抓。**先写失败测试**。
2. `structured-task-runtime-bridge.spec.ts`：同键二次调用零 `gateway.generateStructured`；换 prompt/schema/契约版本/model 任一不命中；带 `cacheable:false` 任务不缓存；env off 直通；缓存脏数据（schema 不合法）→ miss 重算并覆盖；缓存端口抛错 → 直通且上游成功。
3. `llm-result-cache.spec.ts` / `url-content-cache.spec.ts`：键材料稳定性（字段顺序无关）、TTL 计算、upsert SQL 语义（可用 fake db 记录）。
4. 真库：`packages/db/test/url-llm-cache.rls.spec.mjs`——两表跨 workspace 隔离、app_user CRUD 权限、purge 函数只删过期行且拒非 app_user、deletion 擦除计数。
5. `deletion.activities.spec.ts`：eraseSubject 调用两表 deleteMany。
6. 全量：`APP_DATABASE_URL= pnpm --filter @global/api test` + `gctl check`（推送前）。
7. **验收（发车后由产品负责人流程执行）**：同一 ICP golden mini-run 连跑两次——`usage_ledger`/`ai_trace` 按 run 时间窗对比 LLM 调用数（第二次同页任务 ≈0 新增）、`crawl4ai.fetch` 日志 304 命中率 >0、同集合召回不降（影子口径）；跨 run 冷启动耗时对比 ≥30%。

## 11. 闭环设计（§0.6-2）

- **SoR**：`url_content_cache` / `llm_extraction_cache` 是**派生缓存**，SoR 仍是页面本身与 `ai_trace`/结构化产出（Claim/Offering/Lead 等）；缓存可随时丢弃重建。
- **对外事件**：无新增（内部优化不改变事件脊梁）。
- **Tool Contract**：`crawl4ai.fetch` 契约不变；缓存端口是实现细节，不暴露给模型。
- **闭环位置**：抓取层（§17.6 能力地图）——影响发现/理解/联系人/渠道之外的所有 `crawl4ai.fetch` 消费方，下游零改动。
- **端到端演示脚本**：dev 栈（`gctl up all` + 迁移）→ 同一 ICP 连续两次 mini-run → 展示第二次的 `[llm-cache] hit=true` 日志、`usage_ledger` 零新增、304 计数；再置 `ACQ_LLM_CACHE=off` 复跑证明直通。
- **负向测试**：跨租户读 0 行；DSR 擦除后同 workspace 无行；过期行不命中；脏缓存不返回；非 UUID workspace no-op。

## 12. 风险与开放问题

| 风险 | 处理 |
| --- | --- |
| 键误命中（脏读） | 键含五元组 + schema digest；命中后 schema 二次校验；TTL 24h 上限 |
| 站点频繁改版导致缓存价值低 | 304 为真相源（每次校验）；env 可关；看板观察命中率 |
| 缓存含个人信息 | PERSONAL_DATA 同工件口径、RLS、24h、DSR；待 Q25/联系方式整改线统一加密要求后复评 |
| purge 函数绕过 RLS | 只删过期行、无返回值数据、审计函数体；e2e 用例固定行为 |
| 与整改线冲突 | 不碰 `discovery.activities.ts`/`discovery.workflows.ts`/账本/ai-trace.sink；只加任务契约字段 + bridge 旁路 + 新文件 |
| 开放问题 | ① 平台渠道缓存是否另立项（§4.6）；② `company_understanding.extract_profile` 是否也纳入白名单（理解线低频，倾向纳入、数据说话）；③ 是否把命中率写进归因看板（依赖 Q33 PR-1 排期） |

## 13. 联网研究依据（§0.6-3）

- 主计划 §3.5b 的 8 路一手来源调研已定案「ETag/304 + 内容哈希 LLM 缓存」选型（含：HTTP-first 基准 F1 0.955、渲染慢 24–35 倍、全仓零条件请求的实测）。
- 本步补充核验：RFC 9110 §13 条件请求语义（304 不带 body、ETag 强弱比较）；业界 LLM cache 通行做法 = 输入全文 hash + 模型/提示版本作键 + 短 TTL（与本设计一致）。
- Crawl4AI 0.9.5 安全版本事实见 §14（源码/公告核对）。

## 14. 步 6 设计摘要：Crawl4AI 0.9.5 安全升级（独立 PR）与 trafilatura 处置

### 14.1 0.9.5 升级（必做，独立镜像 PR）

事实（2026-11-08 联网核验）：
- 0.9.5 于 2026-10-14 发布，安全版本，修复 6 个协调披露通告：**CVE-2026-119119**（DoS：`delay_before_return_html`/`mean_delay`/`max_range` 无上限，CVSS v4 8.7 / v3.1 7.5）、**JS 注入**（`css_selector`/`wait_for` 绕过 `js_code` 拦截进 `page.evaluate()`）、**盲 SSRF**（`CacheValidator` 自带 httpx 绕过 egress proxy）、**调用方指定 HuggingFace 模型**（pickle RCE）、**ReDoS**（调用方正则）、**TLS 校验关闭**（默认 Chromium 参数含 `--ignore-certificate-errors`）。另：`crawler.pool.max_pages_before_recycle` 默认 200、Docker server `limits.wall_clock_s` 默认 300（超时上限，0=无界）。
- 我们自托管 Docker API（`:11235`），这些正是暴露面 → 必须升级。

改造点：
1. `infra/crawl4ai/Dockerfile`：`FROM unclecode/crawl4ai@sha256:c9e1b12…`（0.9.1）→ `unclecode/crawl4ai:0.9.5@sha256:<发布时解析并钉住>`；重新验证 `patch_egress_broker.py`/`fakeip_resolver.py` 对 0.9.5 `egress_broker.py` 仍成立（构建内 `grep`/补丁脚本失败会硬失败），失效则按新版源码改补丁并留注释。
2. 重打镜像并保留回滚：旧镜像打 `global-crawl4ai:rollback-<0.9.1>-20261108`；新镜像 `global-crawl4ai:local`（部署按既有本地 tag 流程）。
3. 显式启用池回收与截止：服务配置里落 `max_pages_before_recycle=200`、`wall_clock_s=300`（0.9.5 默认值即目标值，显式写入防上游默认漂移；若走 adapter 请求体则在 `web-crawler.ts` 请求构造处加，并单测断言）。
4. 适配器契约测试：`web-crawler.spec.ts` + `builtin-tools` 相关 spec 全绿；新增/更新对 `/md`、`/crawl` 响应契约的解析用例；构建后容器冒烟（`/health` 200、受治理抓一个 example.com 页面成功、拒绝内网地址）。
5. 回滚：Dockerfile digest 回退 + 镜像 tag 回退，无代码/迁移依赖。
6. 验收：镜像可回滚；渠道/发现链路回归绿（发车后 preview/run 冒烟由产品负责人流程执行）。

### 14.2 trafilatura sidecar（PR-C）处置：**降级为观察项，不建 sidecar（本次）**

理由：
- PR-A 真机验收两真实公司站均 HTTP 命中无回落（抽取毫秒级），现有 `provenance.parserVersion`（`http-first/1` vs `crawl4ai/1`）已能统计渲染回退率；sidecar 引入新 Python 服务与依赖心跳（#794 教训），在回退率数据出来前是过早优化。
- 触发条件：golden mini-run 中渲染回退率 >30%（PR-A 验收线）或低置信页召回不达标 → 再出 PR-C 设计。
- 记录：主计划 §0.2 步 6 的「视 PR-A 数据可降级」已满足；本次在 PR-B/Crawl4AI PR 文档中各留一句。

## 15. 给产品负责人的说明

- **得到什么**：重复页面不再重复抓、不再重复花 LLM 钱；24h 内同页二次运行 LLM 调用接近零，冷启动提速目标 ≥30%；两表均有 TTL/DSR/env 关断。
- **没改什么**：抓取与抽取的对外契约、事件、账本、编排都不变；渠道抓取（平台域）v1 不启用缓存；site-builder 任务不缓存。
- **风险与回退**：脏读风险由「输入全量 digest + schema 二次校验 + 24h TTL」兜底；任何异常退化为原行为；`ACQ_LLM_CACHE=off` / `URL_CONTENT_CACHE=off` 一键回退；迁移纯 additive、可直接删除回滚。
- **建议**：批准 D-a～D-f 按本文执行；PR-B 与 Crawl4AI 0.9.5 分两个 PR；PR-C trafilatura 暂缓（观察渲染回退率）；上线验收在发车后按 §10-7 执行。
