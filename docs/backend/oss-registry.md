# OSS / 外部能力注册表

> 文档 ID：`GOV-OSS-001`
> 层级：`L1 / Platform adoption registry`
> 生命周期：`CURRENT`
> 评审状态：`APPROVED_AT_GATE_7`
> Registry Owner：`OWN-SEC-COMMERCIAL`
> 最后核验：2026-07-20
> 批准来源：产品负责人于 2026-07-20 批准 `DEC-FE-P7-001..012`；实现、生产和逐项准入门未因此关闭

本表是外部项目、商业服务和可复用方法的 Card ID、主决定、当前状态、边界和责任帽子的唯一总账。详细证据和退出计划见 [OSS 与外部能力采用入口](../platform/oss-adoption/README.md)。登记不等于生产许可；`INTEGRATE` 只表示已有代码或开发运行事实需要继续硬化。

## 1. 决策词汇

| 决策 | 含义 |
|---|---|
| `LEARN` | 吸收方法、信息架构、评测或交互思想，不引入运行时、数据库、代码或素材 |
| `BUILD` | 自建我方 Contract、Adapter、Policy、状态机或必要差异化实现 |
| `ADAPT` | 在我方边界内做隔离 Spike/Fork/包装，必须可替换且有维护 Owner |
| `INTEGRATE` | 经 Adapter 使用外部运行时；不允许其成为身份、权限或业务对象 SoR |
| `BUY` | 采购服务/授权；必须经过商业、隐私、安全、SLA 与退出门 |
| `AVOID` | 已知边界下禁止该用途；只有证据或授权变化才可重开 |
| `DEFER` | 当前价值/先决条件不足，不安装；触发条件出现后重新评审 |

完整准入规则见[采用政策](../platform/oss-adoption/adoption-policy.md)。

## 2. 全量注册表

| Card | 候选 | 能力域 | 主决定 / 当前状态 | License / 商业边界摘要 | 我方边界 | Accountable Owner | 详情 |
|---|---|---|---|---|---|---|---|
| `ADP-FE-001` | PostgreSQL + pgvector | 数据 / 检索 | `INTEGRATE / DEV_AS_BUILT_HARDEN` | PostgreSQL License；镜像/备份/数据另管 | Prisma/repository + `RetrievalGateway`；我方 schema 是 SoR | `OWN-DATA-BE` | [Card](../platform/oss-adoption/foundation-site-and-design.md#adp-fe-001-postgresql-pgvector) |
| `ADP-FE-002` | Astro | 独立站渲染 | `INTEGRATE / AS_BUILT_CODE_HARDEN` | MIT；内容/字体/素材另管 | `RendererPort`；SiteSpec/Release 归我方 | `OWN-SITE-BE` | [Card](../platform/oss-adoption/foundation-site-and-design.md#adp-fe-002-astro) |
| `ADP-FE-003` | Puck | Site 编辑 | `ADAPT / SPIKE_BLOCKED` | 核心 MIT；插件/资产另审 | `EditorAdapter` 只读写版本化 SiteSpec draft/diff | `OWN-SAAS-FE` | [Card](../platform/oss-adoption/foundation-site-and-design.md#adp-fe-003-puck) |
| `ADP-FE-004` | Readdy | 设计研究 | `AVOID / RUNTIME_CODE_ASSET_REUSE`；`LEARN / CLEAN_ROOM_MULTI_SOURCE` | 商业 ToS，不是 OSS | 无 Adapter/运行时；只留抽象 `DesignObservation` | `OWN-DESIGN` | [Card](../platform/oss-adoption/foundation-site-and-design.md#adp-fe-004-readdy) |
| `ADP-FE-005` | Fontsource | 字体供应 | `INTEGRATE / AS_BUILT_CODE_HARDEN` | 工具/文件仓 MIT；每个字体 family 另核 | semantic font token 指向本地资产 | `OWN-DESIGN` | [Card](../platform/oss-adoption/foundation-site-and-design.md#adp-fe-005-fontsource) |
| `ADP-FE-006` | shadcn/ui | SaaS UI 基底 | `DEFER / PRIMARY_SPIKE_CANDIDATE_IF_REACT` | MIT；底层依赖/图标另审 | 只实现 `COMP-FE-*` 与 semantic tokens | `OWN-SAAS-FE` | [Card](../platform/oss-adoption/foundation-site-and-design.md#adp-fe-006-shadcnui) |
| `ADP-FE-007` | daisyUI | SaaS UI 备选 | `DEFER / ALTERNATE_UI_BAKEOFF` | 核心 MIT；附加商业产品另审 | 同一组件 bake-off；不得拼装全套库 | `OWN-SAAS-FE` | [Card](../platform/oss-adoption/foundation-site-and-design.md#adp-fe-007-daisyui) |
| `ADP-FE-008` | Flowbite | SaaS UI 备选 | `DEFER / ALTERNATE_UI_BAKEOFF` | Core MIT；Pro/Blocks/Figma/EULA 分开 | 只映射我方 token/组件合同 | `OWN-SAAS-FE` | [Card](../platform/oss-adoption/foundation-site-and-design.md#adp-fe-008-flowbite) |
| `ADP-FE-009` | AiToEarn | 社交发布 | `LEARN / NO_RUNTIME`；运行时 `DEFER` | MIT 根许可；各渠道条款独立 | 学习 Adapter/补偿思想，不接账号/渠道 | `OWN-GROWTH-PRODUCT` | [Card](../platform/oss-adoption/growth-automation-and-engagement.md#adp-fe-009-aitoearn) |
| `ADP-FE-010` | Activepieces | 自动化编排 | `DEFER / COMMERCIAL_EMBED_AND_SOR_GATE` | Core MIT；EE/embedding/Cloud 商业边界 | 不取代 Temporal/Outbox/Policy；未来只接受控动作 | `OWN-PLATFORM` | [Card](../platform/oss-adoption/growth-automation-and-engagement.md#adp-fe-010-activepieces) |
| `ADP-FE-011` | Chatwoot | 会话工作台 | `LEARN / NO_RUNTIME`；运行时 `DEFER` | Community/enterprise 目录与渠道条款分开 | 学习 inbox/assignment；Conversation SoR 留 SaaS | `OWN-CONVERSATION-PRODUCT` | [Card](../platform/oss-adoption/growth-automation-and-engagement.md#adp-fe-011-chatwoot) |
| `ADP-FE-012` | MoneyPrinterTurbo | 视频生成 | `LEARN / PIPELINE_DECOMPOSITION`；运行时 `DEFER` | 根代码 MIT；模型/音频/图库/字体另核 | 学习阶段化媒体 job；不进当前产品 | `OWN-CONTENT-PRODUCT` | [Card](../platform/oss-adoption/media-generation.md#adp-fe-012-moneyprinterturbo) |
| `ADP-FE-013` | ComfyUI | 媒体工作流 | `DEFER / GPL_NODE_MODEL_SUPPLY_CHAIN_GATE` | GPL-3.0；节点/模型/工作流各自授权 | 隔离 Worker/Provider；禁任意节点图直入平台 | `OWN-MEDIA-PLATFORM` | [Card](../platform/oss-adoption/media-generation.md#adp-fe-013-comfyui) |
| `ADP-FE-014` | Remotion | 程序化视频 | `DEFER / COMPANY_LICENSE_AND_PRODUCT_TRIGGER` | 专用许可；实体规模/用途决定义务 | 未来 `VideoRendererPort`；项目/素材归我方 | `OWN-MEDIA-PLATFORM` | [Card](../platform/oss-adoption/media-generation.md#adp-fe-014-remotion) |
| `ADP-FE-015` | Cognee | 知识图/RAG | `DEFER / CONTROLLED_BAKEOFF` | Apache-2.0；模型/外部服务另审 | `RetrievalGateway` 后端候选，不做对象 SoR | `OWN-KB-BE` | [Card](../platform/oss-adoption/knowledge-and-retrieval.md#adp-fe-015-cognee) |
| `ADP-FE-016` | Graphiti | 时序知识图 | `DEFER / CONTROLLED_BAKEOFF` | Apache-2.0；图数据库/模型另审 | 只在相同 corpus/问题/删除约束下比基线 | `OWN-KB-BE` | [Card](../platform/oss-adoption/knowledge-and-retrieval.md#adp-fe-016-graphiti) |
| `ADP-FE-017` | LightRAG | RAG | `DEFER / CONTROLLED_BAKEOFF` | MIT；模型/embedding/存储另审 | `RetrievalGateway` 可替换候选 | `OWN-KB-BE` | [Card](../platform/oss-adoption/knowledge-and-retrieval.md#adp-fe-017-lightrag) |
| `ADP-FE-018` | Docling | 文档解析 | `INTEGRATE / DEV_AS_BUILT_HARDEN` | MIT；OCR 模型/输入内容另审 | `DocumentParserProvider`；解析结果进我方 KB 合同 | `OWN-KB-BE` | [Card](../platform/oss-adoption/documents-and-acquisition.md#adp-fe-018-docling) |
| `ADP-FE-019` | Crawl4AI | 网页采集 | `INTEGRATE / DEV_AS_BUILT_HARDEN` | Apache-2.0；目标站条款/内容权利另管 | `WebCrawlerProvider` + egress gate | `OWN-ACQUISITION-BE` | [Card](../platform/oss-adoption/documents-and-acquisition.md#adp-fe-019-crawl4ai) |
| `ADP-FE-020` | Firecrawl | 采集备选 | `DEFER / FALLBACK_ONLY` | AGPL-3.0；Cloud/数据边界另核 | 与 `WebCrawlerProvider` 契约等价才可替换 | `OWN-ACQUISITION-BE` | [Card](../platform/oss-adoption/documents-and-acquisition.md#adp-fe-020-firecrawl) |
| `ADP-FE-021` | SearXNG | 元搜索 | `INTEGRATE / DEV_AS_BUILT_HARDEN` | AGPL-3.0；各搜索引擎条款另核 | `SearchProvider`，只返回候选，不做事实 SoR | `OWN-DISCOVERY-BE` | [Card](../platform/oss-adoption/documents-and-acquisition.md#adp-fe-021-searxng) |
| `ADP-FE-022` | Temporal | Durable Workflow | `INTEGRATE / DEV_AS_BUILT_HARDEN` | MIT | `WorkflowPort`；业务真值/Outbox 留我方 DB | `OWN-PLATFORM` | [Card](../platform/oss-adoption/workflow-policy-model-and-observability.md#adp-fe-022-temporal) |
| `ADP-FE-023` | OPA | 策略引擎 | `DEFER / POLICY_SCALE_TRIGGER` | Apache-2.0 | 未来 `PolicyEngine`；授权真值仍在平台策略合同 | `OWN-SECURITY` | [Card](../platform/oss-adoption/workflow-policy-model-and-observability.md#adp-fe-023-opa) |
| `ADP-FE-024` | new-api | 模型网关 | `INTEGRATE / DEV_AS_BUILT_HARDEN` | AGPL-3.0；上游模型条款独立 | `ModelGateway` + task routes；不做模型结果/预算 SoR | `OWN-AI-PLATFORM` | [Card](../platform/oss-adoption/workflow-policy-model-and-observability.md#adp-fe-024-new-api) |
| `ADP-FE-025` | LiteLLM | 模型网关备选 | `DEFER / CONTINGENCY_BAKEOFF` | 根许可含 MIT/Enterprise 划分 | 同 `ModelGateway`；只有迁移演练才允许并行 | `OWN-AI-PLATFORM` | [Card](../platform/oss-adoption/workflow-policy-model-and-observability.md#adp-fe-025-litellm) |
| `ADP-FE-026` | Langfuse | LLM 观测 | `DEFER / OBSERVABILITY_BAKEOFF` | 根许可含 MIT/EE 目录划分 | `ModelTelemetrySink`，先脱敏，不做成本/任务真值 | `OWN-AI-PLATFORM` | [Card](../platform/oss-adoption/workflow-policy-model-and-observability.md#adp-fe-026-langfuse) |
| `ADP-FE-027` | Diátaxis | 文档方法 | `LEARN / CURRENT_METHOD` | 方法/网站权利与代码分开 | 四类文档标签和阅读路径；无运行时 | `OWN-DOC-GOV` | [Card](../platform/oss-adoption/documentation-and-quality-methods.md#adp-fe-027-diátaxis) |
| `ADP-FE-028` | Backstage TechDocs | 文档门户方法 | `LEARN / NO_RUNTIME` | Apache-2.0 项目；插件/托管另审 | 学习 catalog/owner/docs-like-code，不部署门户 | `OWN-DOC-GOV` | [Card](../platform/oss-adoption/documentation-and-quality-methods.md#adp-fe-028-backstage-techdocs) |
| `ADP-FE-029` | Storybook | 组件文档/测试 | `DEFER / FORMAL_FE_REPO_TRIGGER`；方法 `LEARN` | MIT；addons/服务另审 | 正式组件库后作为 `COMP-FE-*` 展示/测试层 | `OWN-SAAS-FE` | [Card](../platform/oss-adoption/documentation-and-quality-methods.md#adp-fe-029-storybook) |
| `ADP-FE-030` | Playwright | 前端 E2E | `LEARN / CURRENT_QUALITY_METHOD`；工具 `DEFER / FORMAL_FE_REPO_TRIGGER` | Apache-2.0；浏览器包/CI 镜像另管 | 场景 ID/证据方法先用；正式前端后接 runner | `OWN-QA-EVIDENCE` | [Card](../platform/oss-adoption/documentation-and-quality-methods.md#adp-fe-030-playwright) |
| `ADP-FE-031` | GoodJob | 功能设计/使用文档方法 | `LEARN / CURRENT_METHOD` | 外部仓库；只吸收方法，不复制代码/内容 | 功能闭环、页面 IA、取舍、FAQ；真值治理用我方体系 | `OWN-DOC-GOV` | [Card](../platform/oss-adoption/documentation-and-quality-methods.md#adp-fe-031-goodjob) |

## 3. 组合结论

- **八项现用、继续硬化**：`001/002/005/018/019/021/022/024`。它们均不得从开发 as-built 推导生产已批准。
- **一个受阻 Spike**：`003` Puck；正式 SaaS 前端、编辑 API、Claim/权限合同和设计源未定位前不得安装。
- **一个用途级避免项**：`004` Readdy；禁止运行时、代码、素材、训练/RAG/蒸馏复用，只保留多来源净室学习。
- **其余候选**：按 Card 维持 `LEARN` 或 `DEFER`；没有新增采购、账号、依赖、部署或生产流量授权。
- **我方必须 Build 的部分**：Contract、Adapter、SoR、allowed actions、审计、数据分类、测试夹具、退出导出和替换机制，不交给候选项目。

## 4. 生产准入硬门

每项从 `LEARN/DEFER/ADAPT/DEV_AS_BUILT` 走向生产前，必须同时具备：

1. Capability/Non-goal 与本地差距；
2. 固定版本、许可证/商业/数据权利结论；
3. Adapter Contract 与 SoR 声明；
4. Security/Privacy/SSRF/Supply-chain/多租户审查；
5. 可执行 Test Plan、Release Gate 和失败恢复；
6. 具名责任帽、运行预算与值班/升级方案；
7. 导出、删除、替换、回放和演练过的 Exit Plan；
8. 对应 Gate 的用户批准。

任一项缺失即 fail-closed。Card 或 Adapter 的存在不代表实现、测试或生产部署已完成。

## 5. 禁止事项

- 不拼接多个 OSS 前端导航，不让供应商 UI 决定 SaaS 信息架构。
- 不把 Company、Claim、Campaign、Opportunity、Conversation、Site、Release 或身份写成 OSS 私有数据库真值。
- 不绕过 `ProviderAdapter`、模型 task route、ToolBroker、Outbox/Temporal、Workspace RLS 或 allowed actions。
- 未审许可前不复制代码、模板、页面、模型权重、字体、图片、音频、视频、数据集或插件。
- 不把“根仓库开源”解释为企业目录、托管能力、连接器、渠道 API 和生成内容都可商用。
- Fork 没有长期 Owner、上游同步策略、SBOM 和退出路径时不得进入生产。
