# 官方来源与本地运行快照

> 文档 ID：`OSS-FE-009`
> 状态：`READY_FOR_GATE_7_REVIEW`
> 核验日期：2026-07-20
> Owner：`OWN-SEC-COMMERCIAL`、`OWN-PLATFORM`

本文件把四种容易混淆的证据拆开：外部项目源码快照、官方滚动文档、仓内依赖锁定和本机运行镜像。任何一列都不能替另一列证明生产准入；许可证结论是工程初审，不是法律意见。

## 1. 证据层级

| 层级 | 回答的问题 | 不能证明 |
|---|---|---|
| 不可变上游 commit + 根许可证 | 某一时点公开仓库的代码和根许可是什么 | 本地正在运行该版本；插件、模型、素材和企业目录继承根许可 |
| 官方滚动文档 / ToS | 当前官方如何描述功能、商业边界和条款 | 历史时点条款；本地实现已经符合；第三方权利已清除 |
| package lock / Dockerfile pin | 仓内声明要构建什么版本 | 该产物已运行；运行环境安全或可恢复 |
| image ID / service version | 2026-07-20 Ubuntu 开发机实际运行什么 | 镜像可复现、生产可用或已完成升级回滚 |

Phase 1 已为二十个候选固定不可变 commit、根许可证和本地关系，唯一明细在[外部对标与 OSS 审计 §8](../../roadmap/saas-frontend-phase-1/external-benchmark-and-oss-audit.md#8-oss-官方版本与许可证索引)。Phase 7 不复制那张表制造第二真值，而是把它映射到采用 Card，并补本地运行和新增候选。

## 2. Phase 1 不可变来源到采用 Card 的映射

| 来源 ID | 项目 | Card | 2026-07-20 决策 |
|---|---|---|---|
| `SRC-OSS-001` | Puck | `ADP-FE-003` | `ADAPT / SPIKE_BLOCKED` |
| `SRC-OSS-002` | Astro | `ADP-FE-002` | `INTEGRATE / AS_BUILT_CODE_HARDEN` |
| `SRC-OSS-003` | Temporal | `ADP-FE-022` | `INTEGRATE / DEV_AS_BUILT_HARDEN` |
| `SRC-OSS-004` | OPA | `ADP-FE-023` | `DEFER / POLICY_SCALE_TRIGGER` |
| `SRC-OSS-005` | Langfuse | `ADP-FE-026` | `DEFER / OBSERVABILITY_BAKEOFF` |
| `SRC-OSS-006` | Activepieces | `ADP-FE-010` | `DEFER / COMMERCIAL_EMBED_AND_SOR_GATE` |
| `SRC-OSS-007` | Chatwoot | `ADP-FE-011` | `LEARN / NO_RUNTIME`；运行时 `DEFER` |
| `SRC-OSS-008` | Docling | `ADP-FE-018` | `INTEGRATE / DEV_AS_BUILT_HARDEN` |
| `SRC-OSS-009` | Crawl4AI | `ADP-FE-019` | `INTEGRATE / DEV_AS_BUILT_HARDEN` |
| `SRC-OSS-010` | Remotion | `ADP-FE-014` | `DEFER / COMPANY_LICENSE_AND_PRODUCT_TRIGGER` |
| `SRC-OSS-011` | AiToEarn | `ADP-FE-009` | `LEARN / NO_RUNTIME`；运行时 `DEFER` |
| `SRC-OSS-012` | MoneyPrinterTurbo | `ADP-FE-012` | `LEARN / PIPELINE_DECOMPOSITION`；运行时 `DEFER` |
| `SRC-OSS-013` | ComfyUI | `ADP-FE-013` | `DEFER / GPL_NODE_MODEL_SUPPLY_CHAIN_GATE` |
| `SRC-OSS-014` | Cognee | `ADP-FE-015` | `DEFER / CONTROLLED_BAKEOFF` |
| `SRC-OSS-015` | Graphiti | `ADP-FE-016` | `DEFER / CONTROLLED_BAKEOFF` |
| `SRC-OSS-016` | LightRAG | `ADP-FE-017` | `DEFER / CONTROLLED_BAKEOFF` |
| `SRC-OSS-017` | Firecrawl | `ADP-FE-020` | `DEFER / FALLBACK_ONLY` |
| `SRC-OSS-018` | SearXNG | `ADP-FE-021` | `INTEGRATE / DEV_AS_BUILT_HARDEN` |
| `SRC-OSS-019` | new-api | `ADP-FE-024` | `INTEGRATE / DEV_AS_BUILT_HARDEN` |
| `SRC-OSS-020` | LiteLLM | `ADP-FE-025` | `DEFER / CONTINGENCY_BAKEOFF` |

许可证和商业边界仍以该不可变索引及对应官方链接为准；本表只负责 Card 路由。

## 3. Phase 7 新增来源

| Card | 项目 / 方法 | 官方来源 | 当前本地关系 |
|---|---|---|---|
| `ADP-FE-001` | PostgreSQL + pgvector | [pgvector 根 LICENSE](https://github.com/pgvector/pgvector/blob/master/LICENSE) | Compose 使用 `pgvector/pgvector:pg16`；实际 image ID 见下表 |
| `ADP-FE-004` | Readdy | [Terms of Service](https://readdy.ai/terms-of-service) + [ADR-019](../../adr/registry.md) | 只允许多来源净室视觉研究；不接入运行时/训练/RAG/蒸馏 |
| `ADP-FE-005` | Fontsource | [自托管与版本化说明](https://fontsource.org/docs/getting-started/introduction) + [font-files LICENSE](https://github.com/fontsource/font-files/blob/main/LICENSE) | renderer lockfile 固定 Noto Sans 两个包；字体 family 许可另审 |
| `ADP-FE-006` | shadcn/ui | [根 LICENSE](https://github.com/shadcn-ui/ui/blob/main/LICENSE.md) | 未采用；正式 React 前端出现后才允许 bake-off |
| `ADP-FE-007` | daisyUI | [核心 LICENSE](https://github.com/saadeghi/daisyui/blob/master/LICENSE) | 未采用；附加 Blueprint/MCP/商业资产不得按核心许可推定 |
| `ADP-FE-008` | Flowbite | [开源说明](https://flowbite.com/docs/getting-started/introduction/) + [商业许可边界](https://flowbite.com/license/) | 未采用；Core、Pro、Blocks、Figma 分开评审 |
| `ADP-FE-027` | Diátaxis | [官方框架](https://diataxis.fr/) | 只采用四类文档方法，不引入运行时 |
| `ADP-FE-028` | Backstage TechDocs | [官方文档](https://backstage.io/docs/features/techdocs/) | 只学习门户/所有权/就地文档方法，当前不部署 Backstage |
| `ADP-FE-029` | Storybook | [根 LICENSE](https://github.com/storybookjs/storybook/blob/next/LICENSE) | 正式前端/组件库未定位，暂不安装 |
| `ADP-FE-030` | Playwright | [根 LICENSE](https://github.com/microsoft/playwright/blob/main/LICENSE) | 学习场景与证据方法；正式 SaaS 前端出现后才接 E2E |
| `ADP-FE-031` | GoodJob | [Gitee 项目](https://gitee.com/sendoh-huang/GoodJob/) | 只吸收功能工作簿、用户闭环和取舍表达；不复制代码/导航/声明 |

这些滚动页面的内容会变化。若 Card 被重新打开，Owner 必须重新固定 commit/版本、保存许可证/ToS 核验日期并比较差异，不能引用本表日期继续放行。

## 4. 本地依赖与开发运行证据

| Card | 本地证据（2026-07-20） | 结论 / 缺口 |
|---|---|---|
| `ADP-FE-001` | `global-postgres`：config `pgvector/pgvector:pg16`；image ID `sha256:1d533553fefe4f12e5d80c7b80622ba0c382abb5758856f52983d8789179f0fb` | 开发运行事实；tag 不是 immutable deployment manifest，生产 HA/恢复未由此证明 |
| `ADP-FE-002` | `apps/site-renderer` lockfile：`astro@5.18.2`；package range `^5.7.0` | 代码 as-built；独立站公开发布链仍未运行 |
| `ADP-FE-005` | lockfile：`@fontsource/noto-sans@5.2.6`、`@fontsource/noto-sans-arabic@5.2.7` | 已自托管；需生成逐字体 license manifest 与字形/体积证据 |
| `ADP-FE-018` | `global-docling`：config `ghcr.io/docling-project/docling-serve:latest`；image ID `sha256:a8a3f8bb7b4da118fd5921519819080defc4e742e4626c5f39b1628ff31f3348` | 开发运行事实；`latest` 漂移，生产前必须 pin digest/版本并验证恶意文档隔离 |
| `ADP-FE-019` | 仓内 wrapper 固定 Crawl4AI `0.9.1` 上游 digest；`global-crawl4ai` 本地 image ID `sha256:6b78d644b150c51098c8a1113a74208f984d20fa8d5d939332b002b9473c8e45` | 已有 egress/SSRF 防护和真机矩阵；生产隔离、容量、升级回退仍未证明 |
| `ADP-FE-021` | `global-searxng`：config `searxng/searxng:latest`；image ID `sha256:11ffedd387dc9cf99e881250c67861470384e55194a86f76df76aa0034a28a1a` | 开发运行事实；`latest` 漂移，引擎条款/限流/生产运维仍是门 |
| `ADP-FE-022` | systemd `temporal-dev.service` active；CLI `1.8.0`、Server `1.31.2`、UI `2.50.1`；TS SDK lock `1.20.3` | 开发持久工作流已运行；CLI/Server/UI/SDK 版本必须分别管理，生产集群与 DR 未证明 |
| `ADP-FE-024` | `global-new-api`：config `calciumion/new-api:latest`；image ID `sha256:428018a37c0b26c163a3367c18401161707cd0e08d0f26a3dde9ff0caa05e34c` | 开发模型网关已运行；`latest` 漂移、AGPL/供应链、升级/回退与生产密钥面未闭环 |

这里的 image ID 只标识本机当前 image，不等于一个可跨环境重建的上游 digest。真正部署前应把批准的 repo digest、SBOM、签名/来源、配置 schema 和回滚产物一起写进 Release 证据。

## 5. 许可证与权利拆分红线

| 情形 | Phase 7 处理 |
|---|---|
| MIT/Apache/PostgreSQL License | 只覆盖其许可范围内代码；notice、依赖、商标、数据、模型、字体、素材、输出和服务条款分别核验 |
| 开源核心 + Enterprise/EE 目录 | Activepieces、Chatwoot、Langfuse、LiteLLM 等必须按目录/功能定位，不能把企业能力计入 OSS 基线 |
| AGPL 服务 | new-api、SearXNG、Firecrawl 在网络服务/修改/分发场景下由法务确认义务；Adapter 不消除许可证义务 |
| 专用或商业许可 | Remotion 按实体规模/用途重新核；Readdy 服从 ToS 与书面授权，不按 OSS 处理 |
| 插件、节点、连接器 | ComfyUI 节点/模型、Activepieces pieces、Chatwoot 渠道、UI Pro 资产逐项登记，根许可不传染式兜底 |
| 生成和抓取内容 | 代码许可不授予网页、图片、字体、音频、视频、客户素材、第三方数据或渠道内容使用权 |

## 6. 重核触发器

出现以下任一事件，Card 自动退回 `REVIEW_REQUIRED`：

- 安装新依赖、升级 major/minor、切镜像或新增插件/模型/连接器；
- 从内部工具改为对客户暴露、SaaS embedding、托管服务或生产流量；
- 处理个人数据、客户机密、跨境数据、账号凭据或可执行用户内容；
- 上游许可证、ToS、企业目录或商业定价变化；
- Adapter 被绕过、OSS 数据库开始承载业务 SoR、无法完整导出/删除/回放；
- 原 Owner 离岗、退出演练超期，或生产只能依赖未 pin 的 `latest`。
