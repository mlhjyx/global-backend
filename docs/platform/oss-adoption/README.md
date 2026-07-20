# OSS 与外部能力采用入口

> 文档 ID：`OSS-FE-000`
> 层级：`L2 / Adoption index`
> 生命周期：`ACTIVE_INPUT`
> 评审状态：`READY_FOR_GATE_7_REVIEW`
> 组合 Owner：`OWN-SEC-COMMERCIAL`；Capability Owner 见各 Card
> 核验日期：2026-07-20

本目录回答“哪些外部项目只值得学习、哪些已在开发环境使用、哪些可以进入受控 Spike、哪些必须延后或避免，以及如何替换退出”。它不把官方许可证初审冒充法律意见，也不因项目已出现在代码、Compose、Word 或原型中就宣称生产准入。

## 1. 权威关系

- [全平台 OSS Registry](../../backend/oss-registry.md)是 Card ID、采用决定、当前状态和责任帽子的唯一总账。
- [采用政策](adoption-policy.md)定义 `Learn / Build / Adapt / Integrate / Buy / Avoid / Defer`、准入门和证据要求。
- [官方来源与本地运行快照](official-source-snapshots.md)记录外部版本/许可与本机版本，二者不得互相替代。
- 本目录的分组 Card 解释具体边界；产品范围、架构和 as-built 仍分别服从 `product-scope`、ADR、`architecture/current` 与代码。
- [Phase 7 评审包](../../roadmap/saas-frontend-phase-7/gate-7-review.md)只请求批准采用组合，不授权安装、采购、账号、依赖、部署或生产流量。

## 2. Card 分组

| 分组 | Card | 覆盖 |
|---|---|---|
| 基础、建站与设计 | [foundation-site-and-design](foundation-site-and-design.md) | `ADP-FE-001..008`：pgvector、Astro、Puck、Readdy、Fontsource、shadcn/ui、daisyUI、Flowbite |
| 增长、自动化与互动 | [growth-automation-and-engagement](growth-automation-and-engagement.md) | `ADP-FE-009..011`：AiToEarn、Activepieces、Chatwoot |
| 媒体生成 | [media-generation](media-generation.md) | `ADP-FE-012..014`：MoneyPrinterTurbo、ComfyUI、Remotion |
| 知识与检索 | [knowledge-and-retrieval](knowledge-and-retrieval.md) | `ADP-FE-015..017`：Cognee、Graphiti、LightRAG |
| 文档与采集 | [documents-and-acquisition](documents-and-acquisition.md) | `ADP-FE-018..021`：Docling、Crawl4AI、Firecrawl、SearXNG |
| 工作流、策略、模型与观测 | [workflow-policy-model-and-observability](workflow-policy-model-and-observability.md) | `ADP-FE-022..026`：Temporal、OPA、new-api、LiteLLM、Langfuse |
| 文档与质量方法 | [documentation-and-quality-methods](documentation-and-quality-methods.md) | `ADP-FE-027..031`：Diátaxis、Backstage TechDocs、Storybook、Playwright、GoodJob |

## 3. 组合摘要

| 决策族 | Card | 含义 |
|---|---|---|
| `INTEGRATE / HARDEN` | 001、002、005、018、019、021、022、024 | 已有代码/开发运行事实；保持现有边界并补 pin、许可、安全、恢复和生产证据 |
| `ADAPT / SPIKE_BLOCKED` | 003 | Puck 只允许在正式 SaaS 前端与权限/Claim 合同明确后做隔离 Spike |
| `LEARN / NO_RUNTIME` | 027、028、031；009/011/012 的方法子集 | 吸收方法，不复制运行时、数据库、导航或营销声明 |
| `DEFER` | 006–017 中除 009 学习子集，以及 020、023、025、026、029、030 | 等待产品纵切、正式前端、Bake-off、商业或安全触发条件 |
| `AVOID` | 004 的运行时、代码、图片、训练/RAG/蒸馏用途 | Readdy 仅可做多来源净室视觉研究；书面授权前 fail-closed |

`BUILD` 保留给我方 Contract、Adapter、政策门、读模型和替代实现；`BUY` 只在商业服务经过采购/隐私/退出评审时使用。本轮没有批准新的 `BUILD` 施工或 `BUY` 采购。

## 4. 不得从本目录推出

- `INTEGRATE` 不等于生产部署或安全/法务最终签字；当前八项仍有不同程度硬化缺口。
- `DEFER` 不等于永久拒绝；只有触发条件出现后才允许重新评审。
- MIT/Apache/PostgreSQL License 不覆盖模型权重、字体、素材、连接器、渠道 API、企业目录或第三方数据。
- 供应商 UI 不进入我们的一级导航；OSS 数据库不成为 Company、Claim、Campaign、Opportunity 或 Site 的主真值。
- Adapter 设计不代表 Adapter 已编码；Test Plan 不代表测试已执行。
