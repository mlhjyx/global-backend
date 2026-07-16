# OSS Registry（开源/外部能力登记表）

依据 PRD §10（D-014、OSG-001/002/003）：每个开源项目/外部服务必须登记，业务代码**只依赖平台 Contract**、不直接依赖其内部数据模型/数据库/厂商 SDK；每个进生产前需 **Capability Card · License/Contract · Security Review · Adapter Contract · Test Plan · Release Gate · Exit Plan**。**绝不**让任何 OSS 成为主库、主身份或唯一数据源。

> 状态取自 §10.18 采用状态总表。当前只登记 **AI 获客 + 企业理解** 相关项；Create/Publish/Engage/视频 相关（AiToEarn、MoneyPrinterTurbo、ComfyUI、Remotion、Chatwoot、Activepieces）等做到对应能力再登记。

## 当前采用（AI 获客）

| 项目 | 用途 | PRD 决策 | 状态 · Gate | 我方 Contract/Adapter | 退出方案 |
|---|---|---|---|---|---|
| **PostgreSQL + pgvector** | 事实源 + 检索基线 | Build/Integrate | ✅ APPROVED BASELINE | 直接主库（已用）；向量走扩展 | 规模后引 OpenSearch |
| **Temporal** | Durable Workflow | Integrate | ADR-002 批准，进 M1 | `WorkflowClient` 封装 | BullMQ/Redis 兜底短任务 |
| **new-api / one-api**（中转站，已采用） | 模型 API 聚合网关：统一接入 DeepSeek/GPT/Gemini/火山，UI 管渠道/key/路由/额度/日志 | Integrate | ✅ docker 已起（`:3001`） | app 只接**单一 OpenAI 兼容端点**；薄 `ModelGateway` 契约在上（ADR-007，禁厂商 SDK） | 换 LiteLLM 或其它中转站仅改 `model-providers.config.ts` |
| **LiteLLM**（备选中转站） | 模型连接内核（PRD 原选） | Integrate | 备选 | 同上单一端点接法 | 与 new-api 互为备选 |
| **Docling** | 文档解析（PDF/DOCX/PPTX/网页） | Integrate | Security Review 后进 M1 | `DocumentParserProvider` | 自建解析器 fallback |
| **Crawl4AI**（已采用） | 自托管公开情报采集 | Integrate | ⚠️ Ubuntu dev 已起（loopback `:11235`）；fake-IP 兼容暂启 broad allow-internal，当前**不能声称 SSRF 已闭环**。仅可信开发 URL，生产前以 R1-safety 补 API+crawler+robots 全链 egress gate | `WebCrawlerProvider`（`/md` 端点，token 鉴权） | 换 Firecrawl |
| **SearXNG**（已采用） | 自托管元搜索：客户发现的**发现层入口**（搜候选企业域名） | Integrate | ✅ docker 已起(:8081)，JSON API，实测真挖到真实公司 | `PublicWebDiscoveryProvider` 内部调用（`/search?format=json`）；**仅内网**、limiter off | 换商业搜索 API（Brave/Bing） |
| **Firecrawl** | 托管采集备选 | Buy/API Candidate | Commercial/License Gate | 同 `WebCrawlerProvider` | 与 Crawl4AI 互为备选 |
| **Langfuse** | Trace/Prompt/Eval | Integrate | 脱敏与保留策略 Gate | Observability 封装（写前脱敏） | 换 trace 后端 |
| **OPA** | 确定性策略决策 | Integrate | Policy Test Gate | `PolicyEngine` Contract（allow/deny/mask/…） | 内置规则引擎兜底 |
| **Cognee / Graphiti** | 关系/时序记忆 | Integrate Candidate | 与 pgvector **Bake-off**（ADR-004） | `RetrievalGateway` 后端之一 | 未胜出则保持 pgvector 基线 |

## 登记要求（每项进生产前补全）

- **Capability Card**：能力边界、输入输出、性能/成本、限制。
- **License**：许可证类型 + 商用/缓存/导出/多租户权利结论。
- **Security Review**：网络隔离、SSRF、密钥、数据出境；爬虫/媒体 Worker 与主库隔离。
- **Adapter Contract**：统一 `ProviderAdapter`（见 PRD 11.13），契约测试证明可替换。
- **Owner + Exit Plan**：负责人 + 退出/迁移路径。

## 接入原则（PRD 10.19 禁止事项）

不拼接多个 OSS 前端导航；不把业务实体写进 OSS 自己的库；不让 OSS 成为唯一身份/权限/数据源；未审许可证前不复制代码/模型权重/素材；不暴露 OSS 未认证 API；不让外部队列替代核心 Workflow 状态与补偿；Fork 必须有长期维护 Owner。
