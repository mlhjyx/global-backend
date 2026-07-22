# Phase 9 资料与知识引导受控 Fixture

> 文档 ID：`DESIGN-FE-P9-004`
> 层级：`L2 / Controlled interaction fixture`
> 状态：`DRAFT`
> 事实 Owner：`OWN-PRODUCT`
> 设计 Owner：`OWN-DESIGN`
> 关联：`GATE-FE-P9-000`
> 最后核验：2026-07-23

## 1. 目的与非含义

本 Fixture 约束“客户如何把自己的资料交给平台”这一交互，不冻结某个行业的固定字段，也不再用于生成三套视觉方向。

它只允许设计当前文档、代码和 OpenAPI 可以支持的通用资料路径：引导填写、文件/图片上传、网站或店铺导入、KB 解析、动态缺口和人工复核。它不是数据库种子、行业模板 schema、OpenAPI 扩展、正式 Page Manifest 或已上线承诺。

以下内容均已废弃并只保留 `SUPERSEDED_RESEARCH_PROVENANCE`：

- “买家详情 + RFQ 技术资格化”三图；
- 固定 CNC 产品、材料、公差、MOQ、产能和证书的“资料准备度工作台”；
- 为上述示例预设 `ProductFamily/Variant/TechnicalSpecification/ReadinessAssessment/RFQ Lite` 对象。

## 2. Current 事实边界

### 2.1 当前可依赖的通用输入

| 输入 | Current 合同/对象 | 设计允许表达 |
|---|---|---|
| 最小 Intake | Site intake | 建站目标、基础企业信息和入口；不是完整企业档案 |
| 引导填写 | Site Profile 五组：`companyProfile/trustAssets/onlineAssets/brand/contact` | 分步填写、保存、跳过、稍后继续；每组替换和并发提示 |
| 文件和图片 | Asset presign → upload → commit → processing/ready | 批量上传、格式/大小、处理状态、失败重试、删除影响 |
| 知识库 | KbDocument/KnowledgeSource、documents/chunks/gaps | 文档列表、来源、解析状态、可定位片段、动态缺口和补充入口 |
| 网站/店铺资料 | source=`storefront` 或 `web_research` 的目标输入 | 授权 URL、抓取范围、导入预览和权利确认；不画成 current 完整 ImportRun |
| 产品/服务 | Offering + `attributes` + source/evidence | 按客户行业出现的可扩展字段；不宣称是通用规格库 |
| 可信事实 | Claim/Evidence/Asset | “客户填写/模型提取/已审核/可公开”分层，不把上传等同于批准 |

### 2.2 当前没有的合同

- 没有独立 `IndustryPack` runtime schema 或行业字段 API；它只能作为未来引导元数据候选。
- 没有独立 ProductFamily、ProductVariant、TechnicalSpecification、Certification、CapacityProfile 或 ReadinessAssessment 聚合。
- `KbStatus.gaps` 是 Brand/Profile/Build 产生的派生输出，不是可写业务对象，也不保证建站前已经存在。
- 没有完整 Site Import、公开 Publish/Domain/TLS、Conversation、Opportunity 或 RFQ API。

## 3. 用户任务

主要 Actor：首次建站或补资料的企业负责人、运营人员。

目标：用自己手头最方便的方式提供足够资料，知道系统已经收到什么、正在处理什么、哪些内容需要确认，并能随时退出后继续。

主动作根据当前状态变化：

```text
空白 → 选择“填写资料 / 上传文件 / 导入网站”
已提交 → 查看处理进度
有待确认项 → 审核提取结果
有缺口 → 补充资料或标记暂不提供
可开始建站 → 生成站点草稿
```

不使用统一“准备度百分比”。能否生成草稿、哪些内容被限制以及下一动作必须分别说明原因。

## 4. 动态引导模型

### 4.1 固定的只有问题类型，不固定业务答案

| 问题类型 | 示例表达 | 出现条件 |
|---|---|---|
| 企业基础 | 企业名称、业务类型、所在城市 | 通用 Profile 需要 |
| 品牌与联系 | 品牌名、目标语言、公开联系方式 | 建站目标需要；contact 走隔离边界 |
| 产品/服务 | “你主要提供哪些产品或服务？” | 所有企业均可使用自由描述或上传资料 |
| 行业补充 | 规格、材料、认证、产能等可配置字段 | 只有行业元数据、目标市场或已上传资料触发；字段必须带来源和 `PROPOSED` schema 状态 |
| 信任资料 | 证书、案例、展会、专利或其他证明 | 客户实际拥有时出现；不要求每个客户都提供同一种资料 |
| 在线资料 | 官网、店铺、社交或 Google Business | 客户选择导入时出现 |

任何行业问题都必须允许：`不知道`、`暂不提供`、`不适用`、`稍后补充`。系统不得用行业平均值、模型猜测值或别的客户数据自动填成事实。

### 4.2 推荐交互结构

```text
资料与知识
├─ 概览：资料来源、处理状态、待确认项、下一动作
├─ 引导填写：通用五组 + 按条件出现的行业问题
├─ 文件与图片：上传、解析、来源、权利和删除影响
├─ 网站/店铺导入：URL、授权、范围、预览和确认
└─ 待确认：模型提取候选、冲突、缺口和人工审核
```

这是一组 Site Onboarding/资料页，不是新的一级导航或独立“企业准备度系统”。Today 只投影有截止时间或阻塞影响的任务。

## 5. 状态 Fixture

| 场景 | 页面必须显示 | 主动作 | 禁止误导 |
|---|---|---|---|
| `EMPTY` | 三种入口、可跳过说明、最少必填范围 | 开始填写/上传/导入 | 不显示大量固定规格空表 |
| `UPLOADING` | 单文件进度、成功/失败分离、取消影响 | 继续上传或处理失败项 | 上传完成不等于解析完成 |
| `PROCESSING` | 文档处理状态、已保留原文件、可离开页面 | 查看任务 | 不保证即时完成或虚构百分比 |
| `REVIEW_REQUIRED` | 原文锚点、提取候选、置信/冲突提示、逐项接受/修改/忽略 | 完成审核 | 模型提取不等于批准事实 |
| `GAPS_AVAILABLE` | gap 原因、建议补充方式、是否阻塞当前建站目标 | 补充或标记稍后 | gap 不是独立 Readiness 对象 |
| `DRAFT_ALLOWED` | 草稿可使用的资料、被排除的未核验内容、仍可稍后补充 | 生成站点草稿 | 草稿不等于公开发布 |
| `STALE_OR_CONFLICT` | 来源日期、冲突内容、受影响 Site/Claim | 复核来源 | 不用一个绿色 Badge 覆盖冲突 |

## 6. 五张用户确认视觉基线如何使用

| 基线 | 在本 Fixture 中借鉴 | 不继承的示例内容 |
|---|---|---|
| Today 工作队列 | 优先级、原因、负责人、截止时间、动作和运行进度 | 示例客户、邮件域名、KPI 数字 |
| Site Editor | 左侧结构、中间真实预览、右侧上下文设置，顶部版本/预览动作 | CNC 图片、ISO 文案、固定产品模块 |
| Buyer Development | 列表—选中对象—证据/动作的高密度结构 | 示例评分、公司、联系人和数据源结论 |
| Unified Inbox | 队列—会话—商机上下文三栏与 AI 草稿区 | RFQ 阶段、预计金额、技术结论 |
| AI Task Strategy | 面向管理员的任务档位、预算、覆盖权限和用量反馈 | 具体模型真实性、积分数和已实现策略 API |

视觉基线只批准瓷白工作面、深墨文字、克制品牌蓝、细边框、低阴影、稳定 Shell、清楚的表格密度和按任务选择一至三栏。它不批准任何示例业务事实或后端能力。

## 7. 明确禁止

- 把 CNC、泵、电子、纺织或任一行业的字段设为所有客户必填；
- 无来源地生成材料、公差、粗糙度、压力、温度、产能、交期、证书编号或行业标准；
- 把文件上传、KB 抽取、Claim 审核、内容批准和公开发布合成一个“已完成”；
- 新建独立 ProductFamily/Variant/TechnicalSpecification/Certification/CapacityProfile/ReadinessAssessment 页面或数据库暗示；
- 在 Inbox 中新增 RFQ Lite、CAD 审批、报价、样品或工程评审生命周期；
- 向普通用户展示 new-api Base URL、API Key、上游 Provider 或 fallback；
- 把 `PROPOSED/TARGET_EXTERNAL/FROZEN_MAP_ONLY/BACKEND_ONLY` 画成 current 可执行功能；
- 使用真实客户 PII、生产密钥或未经授权的第三方素材。

## 8. 进入 Figma 前的核对门

1. Frame 中每个字段能回到 current 合同，或清楚标注 `PROPOSED` 的引导元数据；
2. 每个状态分别说明业务、任务、处理、证据、权限和下游影响；
3. 所有行业问题均为条件出现，并提供不知道/跳过/不适用路径；
4. 上传、解析、审核、Build、Preview、Publish 不得合并；
5. 五张基线的来源、哈希和使用范围已登记；旧图不得再次成为候选；
6. Figma file key、Owner、Variables/Library、node URL 未齐前，状态最高为 `NOT_CREATED/DRAFT`。
