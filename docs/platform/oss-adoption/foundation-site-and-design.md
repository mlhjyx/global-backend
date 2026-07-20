# 基础、建站与设计候选 Capability Cards

> 文档 ID：`OSS-FE-002`
> 状态：`CURRENT` / `APPROVED_AT_GATE_7`
> Owner：`OWN-SITE-BE`、`OWN-SAAS-FE`、`OWN-DESIGN`；许可总责 `OWN-SEC-COMMERCIAL`

## `ADP-FE-001` PostgreSQL + pgvector

| 字段 | 结论 |
|---|---|
| 用户能力 / 非目标 | 为平台事实和向量检索提供可审计基线；不因向量扩展引入第二主库 |
| 当前等价与证据 | PostgreSQL+Prisma+RLS 已是主数据基线；开发容器为 `pgvector/pgvector:pg16`，运行镜像 ID 见[快照](official-source-snapshots.md) |
| 主决策 | `INTEGRATE / DEV_AS_BUILT_HARDEN` |
| License / 权利 | pgvector 使用 PostgreSQL License；仍需保留 notice，并分别管理数据库镜像、扩展和备份数据权利 |
| Adapter / SoR | Prisma/repository 和 `RetrievalGateway` 为边界；业务对象继续以我方 schema 为唯一 SoR |
| Security / 数据 | RLS、owner/app 角色拆分、备份加密、extension 升级、向量只含允许的公司事实；个人数据禁止进入 embedding |
| Test / Release Gate | migration/extension compatibility、RLS 对抗、索引召回/延迟、备份恢复、扩展升级回滚；生产拓扑和 HA 另验 |
| Owner / Exit | `OWN-DATA-BE`；退出为 PostgreSQL 原生检索或经 `RetrievalGateway` 双写迁移到替代引擎，先校验导出和重建 |

## `ADP-FE-002` Astro

| 字段 | 结论 |
|---|---|
| 用户能力 / 非目标 | 将受控 SiteSpec 物化为静态独立站；不让 Astro 成为 SiteSpec、发布状态或 SaaS 编辑器真值 |
| 当前等价与证据 | renderer 已实际依赖，lockfile 为 `astro@5.18.2`；当前产物/开发预览不等于公网发布 |
| 主决策 | `INTEGRATE / AS_BUILT_CODE_HARDEN` |
| License / 权利 | MIT；生成站点中的字体、图片、组件和业务内容仍按各自权利处理 |
| Adapter / SoR | `RendererPort(SiteSpec, assets, locale) -> immutable artifact/manifest`；SiteSpec/Release 状态归我方 Contract/DB |
| Security / 数据 | 构建 sandbox、无任意 JSX/CSS、封闭组件白名单、外链和资产引用校验、输出 digest/CSP/静态扫描 |
| Test / Release Gate | renderer contract、unknown component fail-closed、snapshot/a11y/performance、恶意内容、版本升级双构建、旧 Release 回放 |
| Owner / Exit | `OWN-SITE-BE`；保持 SiteSpec renderer-neutral，替换时用同一 Fixture 生成/比对并保留旧 Astro 版本回放窗口 |

Astro Content Collections 只作 `LEARN`：除非证明不会产生第二内容真值，否则不接管 SiteSpec/CopyBundle。

## `ADP-FE-003` Puck

| 字段 | 结论 |
|---|---|
| 用户能力 / 非目标 | 为 Site 提供受控结构/文案/主题微调；不成为权限、Claim、Release 或发布授权真值 |
| 当前等价与证据 | SiteSpec 采用 Puck-compatible 形状，但正式 SaaS 前端、Puck 依赖和编辑合同均不存在 |
| 主决策 | `ADAPT / SPIKE_BLOCKED` |
| License / 权利 | 核心 MIT；插件、宿主组件、字体和资产另审 |
| Adapter / SoR | `EditorAdapter` 只读写版本化 SiteSpec draft/diff；Puck `onPublish` 必须被改造成“提交审核/保存候选”，不能直接公开发布 |
| Security / 数据 | 服务端 allowed actions 权威；Puck global/component/dynamic permission 仅作 UI 防误触；schema/组件白名单、XSS、并发和审计必须外置 |
| Test / Release Gate | 先决条件为 `BLK-FE-001..004` 关闭；Spike 用 Site Fixture 测 round-trip、迁移、冲突、撤销、未知组件、a11y 和无 Puck renderer 回放 |
| Owner / Exit | `OWN-SAAS-FE`；持久化标准 SiteSpec 而非 Puck 私有状态，移除编辑器后仍可表单编辑/渲染/发布；Site 后端作为合同评审者 |

重开条件：正式 React 前端、SiteSpec edit API、Claim impact、Workspace allowed actions 和设计源均已定位。此前不得安装。

## `ADP-FE-004` Readdy

| 字段 | 结论 |
|---|---|
| 用户能力 / 非目标 | 仅研究版式问题与组件缺口；不作为运行时生成器、API、组件源码、素材库或训练/RAG 来源 |
| 当前等价与证据 | 本地原型/模板有 Readdy 痕迹且 provenance 不全；ADR-019 已规定 `visual_research_only` |
| 主决策 | `AVOID / RUNTIME_CODE_ASSET_REUSE`；允许 `LEARN / CLEAN_ROOM_MULTI_SOURCE` |
| License / 权利 | 商业 ToS 而非 OSS；输出归属、相似输出、训练 opt-out、平台内容/设计限制同时存在，不能由“我拥有输出”推导全部复用权 |
| Adapter / SoR | 无 Adapter、无生产 API、运行时零依赖；仅 `DesignObservation` 记录抽象问题，且需至少五个独立来源交叉形成原创规则 |
| Security / 数据 | 禁逆向、内部 API 探测、sourcemap/sourceContent、客户资料上传、密钥落文档、截图/输出进训练/RAG/组件蒸馏 |
| Test / Release Gate | 无集成测试；若未来取得书面授权，逐资产核创建者/输入/输出/地域/期限/撤回/再分发/竞争性 AI 用途与相似性 |
| Owner / Exit | `OWN-DESIGN`；退出即停止访问并删除未授权副本/引用，内部设计系统不得依赖其 URL/账户；商业/权利评审为强制 Gate |

## `ADP-FE-005` Fontsource

| 字段 | 结论 |
|---|---|
| 用户能力 / 非目标 | 自托管可版本化字体，减少远程字体隐私和可用性依赖；不宣称 Fontsource 根许可覆盖每个字体 |
| 当前等价与证据 | renderer 已锁 `@fontsource/noto-sans@5.2.6` 与 `noto-sans-arabic@5.2.7` |
| 主决策 | `INTEGRATE / AS_BUILT_CODE_HARDEN` |
| License / 权利 | Fontsource 工具/文件仓库 MIT；Noto 字体为 OFL，新增字体必须逐 family 记录原始许可与 notice |
| Adapter / SoR | design token 指向本地 font asset/weight/subset；不远程请求 Google Fonts |
| Security / 数据 | 包供应链、字形覆盖、体积、FOIT/FOUT、许可证文件和 locale fallback；禁止用户上传未授权字体直接发布 |
| Test / Release Gate | 字形/locale、subset、CLS、离线构建、CSP、license manifest、fallback 与视觉回归 |
| Owner / Exit | `OWN-DESIGN`；退出为系统字体或另一已授权自托管 family，保留 token 名不改页面语义 |

## `ADP-FE-006` shadcn/ui

| 字段 | 结论 |
|---|---|
| 用户能力 / 非目标 | 候选 SaaS 组件代码基底；不提供现成品牌、产品状态、权限或组件治理 |
| 当前等价与证据 | 正式 SaaS repo/组件库未定位；本地 Readdy/Vite 原型不能作为采用证据 |
| 主决策 | `DEFER / PRIMARY_SPIKE_CANDIDATE_IF_REACT` |
| License / 权利 | MIT；复制进仓后由我方承担维护、可访问性、依赖和 notice；底层组件/图标另审 |
| Adapter / SoR | 仅实现我方 `COMP-FE-*` 合同和 semantic tokens；禁止组件名成为业务 Contract |
| Security / 数据 | 代码生成/registry 来源 pin、供应链审查、无自动外部 fetch；复杂表格/富文本/上传组件单独威胁建模 |
| Test / Release Gate | 正式前端与设计源确定后，与其他候选用相同 Scenario 比较 a11y、i18n、密度、bundle、维护和视觉差异化 |
| Owner / Exit | `OWN-SAAS-FE`；源码在我方仓，退出按组件合同逐个替换，不保留 registry 运行时依赖；设计 Owner 参与 bake-off 验收 |

## `ADP-FE-007` daisyUI

| 字段 | 结论 |
|---|---|
| 用户能力 / 非目标 | Tailwind 主题/组件候选；不直接定义企业 SaaS 视觉或状态语义 |
| 当前等价与证据 | 未采用；正式前端和 Token values 缺失 |
| 主决策 | `DEFER / ALTERNATE_UI_BAKEOFF` |
| License / 权利 | 核心 MIT；Blueprint/MCP 等附加产品另有许可，不能按核心 MIT 推定 |
| Adapter / SoR | 只能映射 semantic token 和 `COMP-FE-*`，不得同时与其他全套 UI 库拼接 |
| Security / 数据 | 禁在生产构建中调用未批准 MCP/远程生成服务；主题升级需视觉/a11y 回归 |
| Test / Release Gate | 与 shadcn/Flowbite 按相同 Fixture 比较密度、品牌差异、a11y、CSS 体积、升级和自定义成本 |
| Owner / Exit | `OWN-SAAS-FE`；保留我方 token/组件 API，移除 CSS plugin 后页面语义不变；设计 Owner 参与 bake-off 验收 |

## `ADP-FE-008` Flowbite

| 字段 | 结论 |
|---|---|
| 用户能力 / 非目标 | 组件/图标和 Figma 参考候选；不把 Pro 页面或设计资产默认视为 OSS |
| 当前等价与证据 | 未采用；正式设计源与前端缺失 |
| 主决策 | `DEFER / ALTERNATE_UI_BAKEOFF` |
| License / 权利 | 核心组件 MIT、文档另有 CC 条款；Pro/EULA、付费 Figma/Blocks 与核心开源必须拆分 |
| Adapter / SoR | 只映射我方 token/组件合同；不复制付费 blocks 或把供应商类名作为业务 API |
| Security / 数据 | data-attribute JS、依赖、图标/插画来源与下载资产逐项审查；不引用远程 CDN |
| Test / Release Gate | 与其他候选共享 a11y、keyboard、RTL、响应式、bundle、视觉一致性和退出重构 Fixture |
| Owner / Exit | `OWN-SAAS-FE`；组件合同/Token 留在我方，供应商实现可逐项替换；设计 Owner 参与 bake-off 验收 |

## 组合约束

正式 SaaS 前端建立前，不在 shadcn/ui、daisyUI、Flowbite 之间选赢家；建立后也只允许一个主要组件基底，其他项目最多用于经过许可的单点实现或方法比较。Puck 是 Site 编辑器候选，不是通用组件库；Readdy 不是候选运行时。
