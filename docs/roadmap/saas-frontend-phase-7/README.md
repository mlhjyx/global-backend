# Phase 7 OSS / 外部能力采用决策包

> 文档 ID：`GATE-FE-P7-000`
> 层级：`L3 / Phase evidence`
> 状态：`READY_FOR_GATE_7_REVIEW`
> 授权：产品负责人于 2026-07-20 通过 Gate 6，批准 `DEC-FE-P6-001..012`，接受非 Site 域 `MAP_COMPLETE / NOT_DEV_READY`、客户开发 `FROZEN_MAP_ONLY`，保留 `BLK-FE-001..007` 与 `GAP-FE-P6-001..012` 并授权 Phase 7
> 当前授权终点：Gate 7；未获批准不得进入 Phase 8 或任何采用实现

## 1. Phase 7 解决的问题

Word、GoodJob、Phase 1 研究、本地代码/lockfile/Compose 和现行架构中存在大量外部项目名称。Phase 7 把“提到过、学习过、代码已依赖、开发环境已运行、可做 Spike、可采购、可进生产”拆开，防止路线讨论被误写成采用事实，也防止已经运行的开发依赖长期没有版本、许可、安全、Owner 和退出治理。

## 2. 交付物

- [采用入口与组合摘要](../../platform/oss-adoption/README.md)
- [采用政策与七类决定](../../platform/oss-adoption/adoption-policy.md)
- [全平台注册表](../../backend/oss-registry.md)
- [官方来源与本地运行快照](../../platform/oss-adoption/official-source-snapshots.md)
- 七组 Capability Cards（`ADP-FE-001..031`），由采用入口索引
- [组合决定与重开触发器](portfolio-decisions-and-triggers.md)
- [现用能力硬化与退出基线](runtime-hardening-and-exit.md)
- [Gate 7 评审包](gate-7-review.md)

## 3. 覆盖范围

| 来源 / 能力组 | 本轮处理 |
|---|---|
| Word PRD/架构 | Activepieces、AiToEarn、Chatwoot、Cognee、ComfyUI、Crawl4AI、Docling、Firecrawl、Graphiti、Langfuse、LightRAG、LiteLLM、MoneyPrinterTurbo、new-api、OPA、Remotion、SearXNG、Temporal 等逐项入账 |
| Phase 1 OSS 审计 | `SRC-OSS-001..020` 全部映射稳定 Card，不重写不可变快照 |
| 本地代码/运行 | pgvector、Astro、Fontsource、Docling、Crawl4AI、SearXNG、Temporal、new-api 独立标记为现用/需硬化 |
| Site 编辑与 SaaS UI | Puck 作为受阻 Spike；shadcn/ui、daisyUI、Flowbite、Storybook 等到正式前端后统一 bake-off |
| 文档与工作方法 | Diátaxis、Backstage TechDocs、Playwright 方法、GoodJob 表达法只学习，不引入运行时或外部真值 |
| 外部设计来源 | Readdy 继续遵守 ADR-019，只允许多来源净室视觉研究 |

## 4. 本阶段不做

- 不安装/升级依赖，不拉镜像，不修改 Compose、systemd、代码、Schema、OpenAPI 或 CI；
- 不创建供应商账号、采购、上传客户数据、接受商业条款或开启生产流量；
- 不选择正式 SaaS 技术栈、设计工具或 UI 库赢家；
- 不做 Puck、知识图、媒体生成、自动化、会话、观测平台 Spike；
- 不把 `INTEGRATE / DEV_AS_BUILT_HARDEN` 写成生产批准；
- 不因为许可证宽松而跳过素材、模型、字体、渠道、个人数据、ToS 和供应链审查。

## 5. Gate 7

Gate 7 只批准候选组合、采用词汇、Adapter/SoR 边界、准入/重开门、责任帽和退出要求。通过后 Phase 8 只允许做文档治理、lint、归档提案与 Release Bundle，不自动授权任何外部能力实现。

收到明确 Gate 7 决定前，停止 Phase 8。
