# 采用组合决定与重开触发器

> 文档 ID：`BASE-FE-P7-001`
> 状态：`READY_FOR_GATE_7_REVIEW`
> Owner：`OWN-SEC-COMMERCIAL` + 各 Capability Owner

## 1. 目标组合

本组合优先维护可替换的平台边界，而不是追求项目数量。最终产品能力由我方 Contract、对象真值、状态机、权限、审计和设计系统承重；外部项目最多提供受控实现、服务或方法。

| 组合层 | Card | 当前动作 | 为什么现在这样做 |
|---|---|---|---|
| 已在使用 | `001/002/005/018/019/021/022/024` | `INTEGRATE / HARDEN` | 代码或 Ubuntu 开发运行已有事实，停止治理会产生更大漂移；但没有生产放行 |
| Site 编辑候选 | `003` | `ADAPT / SPIKE_BLOCKED` | Puck 形状与 SiteSpec 方向接近，但正式前端、编辑 API、权限/Claim 和设计源缺失 |
| 禁止用途 | `004` | `AVOID` runtime/code/assets/training/RAG；只 `LEARN` | Readdy 是商业平台且 provenance 风险已由 ADR-019 裁决 |
| SaaS UI / 质量工具 | `006/007/008/029/030` | 先 `DEFER`；Playwright 方法 `LEARN` | 正式 repo/框架/design source/CI 未定位，现在选型只会把 Mock 偏好写成事实 |
| 增长/互动 | `009/010/011` | 方法 `LEARN`，运行时 `DEFER` | 对应产品域尚 `NOT_DEV_READY`，且渠道/embedding/企业目录/PII 门未闭环 |
| 媒体 | `012/013/014` | 方法 `LEARN` 或 `DEFER` | 当前产品无批准纵切；模型/节点/素材/公司许可/GPU 风险远高于即时收益 |
| 知识 / RAG | `015/016/017` | `DEFER / CONTROLLED_BAKEOFF` | 当前 Docling+BGE-M3+pgvector 已有基线；必须先证明关系/时序/召回的增量价值 |
| 采集备选 | `020` | `DEFER / FALLBACK_ONLY` | Crawl4AI 已有受控边界，Firecrawl 只在等价性或运维失败时重开 |
| 策略/网关/观测备选 | `023/025/026` | `DEFER / TRIGGERED` | 现阶段用内置 policy、new-api、现有 evidence；避免双路由/双预算/双观测真值 |
| 文档方法 | `027/028/031` | `LEARN / CURRENT_METHOD` | 直接改善阅读路线、所有权和用户闭环，无运行时耦合 |

## 2. 重开触发器

| Card | 允许重开的必要触发器 | 重开仍需的 Gate |
|---|---|---|
| `003` Puck | 正式 React SaaS repo/CI；SiteSpec edit API；Claim impact；Workspace allowed actions；设计 source/token 已定位 | 隔离 Spike 方案 + Security/License + round-trip/迁移/退出 Fixture |
| `006..008` UI 基底 | 正式前端 repo 与框架确认，`BLK-FE-001/002` 关闭 | 一次同 Fixture bake-off，只选一个主基底 |
| `009` AiToEarn | Growth 最小纵切获批，首个渠道和账号治理明确 | 渠道 ToS/权限/速率/补偿/导出逐项门 |
| `010` Activepieces | 用户可编排自动化进入已批纵切，Temporal 无法满足用户配置场景 | Core/EE/embedding/Cloud 边界、租户隔离、动作 allowlist、退出导出 |
| `011` Chatwoot | Conversation 最小纵切获批，Conversation SoR/API/PII Owner 明确 | Community/Enterprise/渠道条款、数据隔离、全量导出删除 |
| `012..014` 媒体 | 有批准的视频/媒体用户结果、预算和资产权利模型 | 相同脚本/资产/模型/成本/质量/许可/退出 bake-off |
| `015..017` 知识候选 | 基线在已定义关系/时序问题上达不到阈值 | 同 corpus、同问题、同引用/删除/租户/成本对照；胜者只接 `RetrievalGateway` |
| `020` Firecrawl | Crawl4AI 在批准 SLO/可维护性上失败，或缺失必须能力 | AGPL/Cloud/出境/SSRF/robots/成本/契约等价性 |
| `023` OPA | 多域策略复杂度、策略发布/解释/复用需求超过内置规则成本 | `PolicyEngine` 合同、deny-by-default、bundle supply chain、回退双算 |
| `025` LiteLLM | new-api 退出演练失败或关键已批 provider 无法接入 | 同模型路由/预算/evidence fixtures，禁止长期双网关真值 |
| `026` Langfuse | 现有 trace 无法回答批准的 Eval/Prompt/Cost 问题 | 脱敏、保留、租户、EE 功能、导出删除和成本门 |
| `029/030` Storybook/Playwright | 正式组件库、前端路由和 CI 可运行 | addon/browser 镜像/视觉基线/E2E 账号与隔离门 |
| `028` Backstage | 文档规模/团队数量使静态门户和 registry 维护成本不可接受 | 平台 Owner、SSO/RBAC、插件供应链、运维/迁移与退出评审 |

“触发器出现”只允许重新研究，不等于自动采用。

## 3. Build 与 Buy 的位置

Phase 7 没有新增 Build/Buy 施工，但明确哪些东西不能外包：

- **必须 Build**：`ProviderAdapter`、`RendererPort`、`EditorAdapter`、`RetrievalGateway`、`PolicyEngine`、`ModelGateway`、我方状态/错误合同、allowed actions、审计、成本/证据账、Fixture 与退出导出。
- **可能 Buy**：托管抓取、商业 embedding、企业渠道、视频许可或观测服务；只有自托管总成本/风险更高且采购、隐私、SLA、数据地域和退出合同同时过门时才重开。
- **不能 Buy 掉的责任**：产品对象 SoR、身份/权限、合规目的、数据准确性、客户承诺、失败补偿和供应商替换责任。

## 4. 防止重复建设与供应商扩散

1. 一个能力域同时只允许一个 primary runtime；备用只保留可执行迁移 Fixture，不长期双写真值。
2. 新候选先证明现有 Card/Adapter 无法满足，不因“更热门”新增栈。
3. UI 项目按同一设计 token/Scenario/a11y/体积/维护成本比较，禁止按 demo 好看选型。
4. RAG/图按相同 corpus 和删除/引用完整性比较，禁止以单个精彩回答代替评测。
5. 采集/模型/渠道项目必须把第三方内容与服务条款纳入成本，不能只比 API 成功率。
6. 候选未进入当前产品纵切时，默认 `LEARN` 或 `DEFER`，不创建“先接上以后再用”的集成。

## 5. 重新评审输出

任何 Card 重开必须产生一份版本化 delta：触发器、用户结果、现有基线失败证据、候选版本/许可、数据流/威胁模型、Adapter 合同、同条件对照、成本、Owner、退出演练和推荐决定。不得直接改 Registry 状态后施工。
