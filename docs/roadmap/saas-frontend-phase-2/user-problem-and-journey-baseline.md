# 用户、问题与旅程基线

> 文档 ID：`BASE-FE-P2-001`
> 状态：`READY_FOR_GATE_2_REVIEW`
> 事实基线：`origin/main@676c6cdc175326927ec341a2d585168aa0a1a374`
> 说明：`FIXED`/`AS_BUILT` 是事实；`RECOMMENDED`/`HYPOTHESIS` 等待 Gate 2 或用户研究

## 1. 产品问题，不从导航倒推

当前权威产品承诺是把企业模糊的出海目标转成“去哪、找谁、为什么现在、下一步怎么做”，并以真实互动和商业结果验证质量。Word 母本把用户痛点归纳为市场认知、数据、表达、执行、转化和证明六类断层；这个结构有解释力，但仍是历史研究综合稿，不等于已经通过一手访谈验证。

| Problem ID | 用户问题 | 当前常见替代做法 | 已有证据 | 状态 |
|---|---|---|---|---|
| `PRB-FE-001` | 不知道先进入哪个市场，也无法解释选择依据 | 搜索、展会经验、代理商报告、Excel 汇总、老板经验 | Word 母本；买家智能后端已有多源事实能力 | `HYPOTHESIS`，后端能力 `FROZEN` |
| `PRB-FE-002` | 不知道哪些公司值得联系、为什么现在、联系人是否可信 | 数据库批量导出、人工搜索、邮件验证工具、CRM 名单 | 当前后端存在发现/富集/Signal/LeadQualifiedPackage 真链路 | 问题 `HYPOTHESIS`；供给 `AS_BUILT/FROZEN` |
| `PRB-FE-003` | 企业事实、产品资料、认证和素材分散，无法稳定复用于内容和网站 | 网盘、聊天记录、宣传册、旧官网、平台店铺、人工复制 | Site Builder intake/profile/asset/KB/Claim/Evidence 已部分落地 | `AS_BUILT` 地基，体验未验证 |
| `PRB-FE-004` | 没有专业海外独立站，或旧站长期不更新、事实不可信、不能持续运营 | 找建站公司、WordPress/SaaS Builder、自做模板、只依赖 B2B 平台店铺 | Site Builder PRD；当前后端生成与 Release 链 | 问题 `HYPOTHESIS`；能力主线 `APPROVED` |
| `PRB-FE-005` | 内容、发布、邮件、社媒、网站和销售动作散落在多个工具中 | 多个 AI 工具、社媒工具、邮箱、CRM、人工复制 | Word/竞品输入；本地页面仅 Mock | `HYPOTHESIS/EXTERNAL_OWNED` |
| `PRB-FE-006` | 回复、表单和互动无法统一识别、分派并进入销售承接 | 邮箱/社媒各自处理、表格转交、CRM 手工录入 | Word 输入；本仓明确不拥有 Conversation/Opportunity | `HYPOTHESIS/EXTERNAL_OWNED` |
| `PRB-FE-007` | 无法证明市场、客户、内容、渠道和成本是否带来机会 | 平台报表拼接、月度人工汇报、归因猜测 | 产品范围有 QGO/SAO/Outcome 指标；当前 SaaS 无真实数据面 | `HYPOTHESIS/EXTERNAL_OWNED` |
| `PRB-FE-008` | 失败、超时、额度耗尽或外部服务异常时不知道影响和恢复动作 | 联系客服、重复点击、重新开任务、放弃已完成结果 | Site Builder 已有 durable workflow、取消、cost ledger、稳定错误 | 工程 `AS_BUILT`；用户体验未建 |

不能将竞品功能表当作问题证据。进入真实产品交付前，至少需要 5–8 名目标用户的任务回放，核验问题频率、当前替代方案、失败成本和愿意切换的条件。

### 1.1 为什么现在需要先定体验与 IA

- Site Builder 已成为唯一施工主线，并已具备 intake、资料、素材、KB、Build、成本、不可变 Release 和开发预览地基；现在具备做一条真实纵切的工程条件。
- 本地 React 原型已经横向覆盖大量产品页面，但核心数据仍是 Mock，继续从页面数量推进会放大“看起来完成、实际不可用”的偏差。
- 买家智能后端能力真实但冻结；若不先建立完整产品地图，后续文档容易因当前主线而误删既有产品能力。
- Word、当前权威文档和原型存在多套导航、角色、对象和发布承诺；在写正式 PRD/UX 或迁前端框架前必须先关闭承重冲突。
- 这些是本地项目时机证据，不是市场规模或付费意愿证据；后两者仍需用户研究和 Pilot。

## 2. 建议目标客户顺序

| Segment ID | 客户类型 | 最强进入场景 | 与当前能力匹配 | 建议 |
|---|---|---|---|---|
| `SEG-FE-001` | B2B 制造、工贸一体、传统出口企业 | 海外独立站、进口商/采购商发现、经销商招募、企业信任资料 | Site Builder 当前主线；买家智能历史能力也以该类场景最强 | `RECOMMENDED_PRIMARY` |
| `SEG-FE-002` | 中国 SaaS 与科技企业 | 目标账户、内容获客、伙伴招募 | 买家智能部分适用；独立站 B2B 制造特性需再验证 | `SECONDARY_HYPOTHESIS` |
| `SEG-FE-003` | 专业服务与出海服务商 | 事件驱动获客、专家协同 | Word 输入较多，当前真实产品链较少 | `DEFERRED_VALIDATION` |
| `SEG-FE-004` | 出海营销代理商/集团多 Workspace | 多客户交付、审批、白标、成本治理 | Workspace/委派/白标未形成真实合同 | `FUTURE_OPTION` |
| `SEG-FE-005` | DTC、电商、本地生活 | 商品、广告、达人和订单增长 | 需要不同 Commerce Growth Motion | `OUT_OF_INITIAL_SCOPE` |

Gate 2 推荐：批准 `SEG-FE-001` 为第一阶段目标客户；其余保持产品地图可扩展，但不进入首批页面承诺。

## 3. 建议角色与责任帽子

同一人在小企业里可能兼任多种角色，但权限、成功标准和页面视角仍应分开。

| Actor ID | 角色 | 核心结果 | 高频动作 | 数据/权限关注 | 状态 |
|---|---|---|---|---|---|
| `ACT-FE-001` | 老板/出海负责人 | 看清投入、市场、风险和商业结果 | 批准目标、预算、公开事实和高风险动作；看经营摘要 | Workspace 管理、最终批准、成本与结果 | `RECOMMENDED_ECONOMIC_BUYER` |
| `ACT-FE-002` | 海外增长/外贸运营 | 建立持续的获客和独立站运营系统 | 资料完善、客户开发、建站、Campaign、内容和复盘 | 业务对象编辑、常规执行、异常恢复 | `RECOMMENDED_PRIMARY_OPERATOR` |
| `ACT-FE-003` | 市场/内容/品牌运营 | 让企业表达可信并持续更新 | 素材、Claim、页面内容、多语言、发布与品牌审核 | 内容范围、素材权利、公开范围 | `RECOMMENDED_SPECIALIST` |
| `ACT-FE-004` | 销售/BD | 获得并推进可跟进机会 | 审核 Lead、处理互动、接受/拒绝机会、回写结果 | 联系人最小可见、Owner、SLA、CRM 接缝 | `RECOMMENDED_DOWNSTREAM_OPERATOR` |
| `ACT-FE-005` | 审批人（品牌/法务/企业事实） | 阻止错误或无权利内容对外使用 | 审核 Claim、认证、素材、内容、数据用途和高风险动作 | 待审批范围、证据、适用市场、撤销 | `RECOMMENDED_APPROVER` |
| `ACT-FE-006` | Workspace 管理员/IT 安全 | 控制成员、集成、策略和事故 | 成员、角色、Secret、集成、审计、Kill Switch、删除 | 租户隔离、授权、审计和恢复 | `RECOMMENDED_ADMIN` |
| `ACT-FE-007` | 数据/运营/客户成功 | 保证数据、任务和服务可恢复 | Provider/作业监控、人工补救、SLA、采用辅导 | 受控诊断、不能默认读取所有个人数据 | `HYPOTHESIS_OPERATOR` |
| `ACT-FE-008` | 代理商项目经理 | 多 Workspace 标准化交付 | 切换客户、委派任务、客户审批、报告、成本 | 跨 Workspace 绝对隔离、委派权限 | `FUTURE_HYPOTHESIS` |
| `ACT-FE-009` | 海外买家/站点访客 | 快速判断供应商可信并发起有效询盘 | 浏览公开站、核对能力/认证、提交询盘 | 公开内容、隐私和同意 | `EXTERNAL_ACTOR` |
| `ACT-FE-010` | 平台运营/安全人员 | 诊断系统异常且不破坏租户信任 | 告警、受控支持、供应商降级、删除/事故处理 | 最小权限、审计、受控 impersonation | `INTERNAL_ACTOR` |

### 3.1 当前不能假定的权限

- 管理员是否默认可查看员工的个人草稿、待办或私有备注；
- 谁能批准 Claim、认证资产、站点公开发布和域名切换；
- Managed 服务团队可以操作到什么程度；
- Sales 是否能看到完整联系人数据；
- 代理商能否跨 Workspace 汇总、导出或复制资产。

这些均进入 Gate 2/4 权限设计，前端隐藏不能替代服务端授权。

## 4. 核心 Jobs-to-be-Done

| Job ID | 当…… | 我希望…… | 以便…… | 主要角色 | 产品域 | 状态 |
|---|---|---|---|---|---|---|
| `JOB-FE-001` | 首次进入平台 | 用最少信息建立可信企业草案 | 立即看到平台理解了我的业务 | ACT-002 | 企业事实、Onboarding | `RECOMMENDED` |
| `JOB-FE-002` | 企业资料分散或冲突 | 看见来源、缺口、冲突和批准状态 | 避免 AI 或员工公开错误事实 | ACT-002/003/005 | 企业与信任 | `RECOMMENDED` |
| `JOB-FE-003` | 没有可运营的海外官网 | 快速生成带自己企业信息的安全 Demo | 先看到结果，再决定继续投入 | ACT-001/002 | 独立站管理 | `APPROVED_DIRECTION` |
| `JOB-FE-004` | Demo 过于粗糙 | 补资料、素材、风格和目标市场后生成更可信预览 | 获得可审核、可继续维护的站点版本 | ACT-002/003 | 独立站管理 | `RECOMMENDED_FIRST_VERTICAL` |
| `JOB-FE-005` | 生成耗时或失败 | 知道当前步骤、成本、影响和恢复动作 | 不重复烧钱且保留旧预览 | ACT-002/007 | 独立站管理/运营 | `RECOMMENDED_FIRST_VERTICAL` |
| `JOB-FE-006` | 不知道先做哪个市场 | 比较需求、竞争、风险和证据 | 选择一个可验证市场假设 | ACT-001/002 | 市场与客户开发 | `FROZEN_MAP_ONLY` |
| `JOB-FE-007` | 知道市场但不知道找谁 | 建立 ICP、样例回测和可解释客户池 | 聚焦值得验证的账户 | ACT-002/004 | 客户开发 | `FROZEN_MAP_ONLY` |
| `JOB-FE-008` | 需要协调增长动作 | 把目标、受众、内容、渠道、预算和批准组织成计划 | 可控地执行并知道何时停止 | ACT-002 | 增长执行 | `PROPOSED/EXTERNAL_OWNED` |
| `JOB-FE-009` | 需要对外表达 | 基于已批准事实生成并审核多语言内容 | 保持品牌和事实一致 | ACT-003/005 | 内容与渠道 | `PROPOSED` |
| `JOB-FE-010` | 收到回复或询盘 | 识别意向、分派 Owner 并保留上下文 | 形成销售可承接机会 | ACT-004 | 互动与商机 | `EXTERNAL_OWNED` |
| `JOB-FE-011` | 销售接受或拒绝机会 | 记录原因、下一步和结果 | 让系统真正学习质量 | ACT-004/001 | 商机与洞察 | `EXTERNAL_OWNED` |
| `JOB-FE-012` | 投入预算后 | 解释哪些市场、客户、内容和渠道影响了结果 | 决定保留、调整或停止 | ACT-001/002 | 洞察与学习 | `PROPOSED/EXTERNAL_OWNED` |

## 5. 端到端旅程目录

### `JRN-FE-001` 首次进入到安全 Demo

- 角色：ACT-001/002。
- 起点：SaaS 注册或首次 Workspace 建立。
- 目标：最少输入后看到印有企业信息、但不虚构事实的 Demo。
- 建议步骤：身份/Workspace（SaaS）→ 公司名、行业、产品、目标市场、业务邮箱等最小 intake → 幂等提交 → Demo Build → 引导消息 → 打开开发预览。
- 当前事实：后端 intake 会无条件创建 `Site + demo_v0 BuildRun`；返回 `generating_demo`；preview URL 需站点 READY/PUBLISHED 后从 Site 读取。前端原型未接真实 API。
- 失败恢复：ACK 不可用时仅允许同一 Idempotency-Key 安全重放；不能再次创建站点。
- 开放问题：注册前后 token/BFF 接缝、SaaS 引导消息存储、P95 用户体验证据。

### `JRN-FE-002` 资料补全到可信开发预览（建议首个纵切）

- 角色：ACT-002 主操作；ACT-003 补素材；ACT-005 处理事实批准。
- 起点：已有 Site 和可查看 Demo。
- 终点：用户打开由 active READY `SiteRelease` 支撑的最新开发预览，并理解已降级/缺失内容。
- 步骤：进入独立站管理 → 查看站点概况与资料缺口 → 分组保存 Profile → 上传并 commit 素材/文档 → 查看 Asset/KB 处理状态 → 处理 Claim 缺口/冲突（当前尚无公开 API）→ 选择当前允许的 scope/style/locale → 启动 Build → 查看步骤、成本和 degraded 状态 → 取消或恢复失败 → 打开预览。
- 当前可接合同：13 个 Site Builder OpenAPI 操作覆盖 intake、site、profile、asset、KB、build 和 cancel。
- 当前内部事实：R1-min 已建立不可变 Release、摘要校验、active pointer 和隐藏 preview resolver；没有 Release 列表/回滚/公开发布 API。
- 必须诚实显示：`en/de-DE` 才是生成语言；style 只有 `modern-industrial/precision-light`；Build 可能 degraded；质量环未全部激活；“预览”不等于“公开发布”。

### `JRN-FE-003` 审核到公开发布、域名和回滚

- 角色：ACT-002/003/005/006。
- 起点：可信开发预览。
- 终点：经发布前检查的 Release 公开服务，可绑定域名、回滚并可诊断。
- 必须覆盖：PublishReview、Claim/素材/locale/表单/法务门、Release 选择、发布授权、DNS/SSL、原子切换、失败保留旧版、版本对比和回滚。
- 当前状态：`APPROVED_NOT_BUILT` 的产品方向；R1-min 只提供内部 Release 地基。公开 API、SaaS UI、生产 DNS/证书/SLA/询盘门未完成。
- Gate 2 不能把该旅程并入首个“已承诺”纵切。

### `JRN-FE-004` 市场假设到可解释 LeadQualifiedPackage

- 角色：ACT-001/002/004。
- 起点：企业/产品和市场目标。
- 终点：带身份、证据、评分、联系与合规结论的不可变合格线索包。
- 当前状态：后端多源发现、资格、信号和事件交付已有真实服务证据，但新增开发冻结；SaaS 页面仍是 Mock。
- 设计要求：冻结不等于从产品地图删除；页面状态必须显示来源、拒绝原因和 Reachability，而不是只给一个总分。

### `JRN-FE-005` 合格线索到销售接受和结果回写

- 角色：ACT-004/001。
- 起点：SaaS 消费 `LeadQualifiedPackage`。
- 终点：Opportunity 从候选到 QGO/SAO/Closed，并把结构化结果回流作为学习标签。
- 当前状态：对象归 SaaS；本仓没有 Opportunity 主状态。原型机会页不能作为实现证据。
- 必须拍板：SaaS SoR/仓库、拒绝原因、Owner/SLA、CRM 同步和结果回写合同。

### `JRN-FE-006` 企业事实跨域复用

- 角色：ACT-002/003/005。
- 起点：资料、上传文档、官网研究或人工输入产生候选事实。
- 终点：经批准、在适用范围内的 Claim 被网站、内容或销售资料引用；撤销后下游可追踪影响。
- 当前事实：CompanyProfile/Offering/Claim/Evidence 及 Site Builder bridge/snapshot 已存在；公开 Claim 审核 UI/API 不完整。
- 设计要求：不为 Site、Content、Campaign 分别建立第二份公司事实；所有引用显示来源、批准、有效期和适用范围。

### `JRN-FE-007` 长任务失败到可恢复

- 角色：ACT-002/007。
- 起点：Build、素材处理或外部 Provider 出现等待、失败、预算耗尽、取消或 ACK 不明。
- 终点：用户理解影响范围，旧结果仍可用，能够安全重试、补资料、联系运营或停止。
- 当前事实：Build/Asset 有稳定状态和错误码，Temporal/ledger/fencing/Release 保留旧结果；前端未实现统一长任务中心。
- 设计要求：失败必须回答“发生了什么、影响什么、系统保留了什么、下一步是什么”。

### `JRN-FE-008` 多 Workspace 代理商交付

- 角色：ACT-008。
- 起点：代理商管理多个客户 Workspace。
- 终点：按客户隔离资料、任务、审批、成本和报告。
- 当前状态：Word 提案；当前身份/委派/白标/跨 Workspace 汇总均无权威合同。
- 结论：保留在产品地图，不进入首批 IA 细节和用户承诺。

## 6. 用户研究与验证队列

| Research ID | 要验证的假设 | 建议方法 | 证据会改变什么 |
|---|---|---|---|
| `RES-FE-001` | B2B 制造企业是否把“独立站持续运营”视为高频问题，而非一次性交付 | 5–8 个目标企业访谈 + 旧站/平台店铺现场回放 | 首批 segment、Site 管理定位、持续维护能力 |
| `RES-FE-002` | 海外增长/外贸运营是否是真正日常操作者 | 角色与任务日志访谈 | 默认首页、权限、导航顺序 |
| `RES-FE-003` | 先看 Demo 再补资料是否提高继续完成意愿 | 原型任务测试/A-B pilot | Onboarding 顺序和 TTFV 指标 |
| `RES-FE-004` | 用户能否理解 Claim、Evidence、approved、degraded | 可用性走查 + 微文案测试 | 事实审核入口和术语 |
| `RES-FE-005` | 用户最常从哪里进入：今日任务、客户对象还是独立站对象 | 卡片分类 + 首周任务日志 | 一级 IA 和快捷入口 |
| `RES-FE-006` | 发布前用户愿意承担哪些检查与审批 | 事故/风险情景访谈 | PublishReview 和权限门 |
| `RES-FE-007` | 失败时用户首先想做什么 | Build/上传失败原型测试 | 错误恢复和运营升级 |
| `RES-FE-008` | 哪个结果让老板愿意续费：站点发布、有效询盘、QGO 还是人工节省 | 购买者访谈 + pilot 复盘 | 北极星、套餐和成功报告 |

## 7. Gate 2 推荐

1. 首批客户选择 `SEG-FE-001`。
2. 默认日常操作者选择 `ACT-FE-002`，并以 ACT-001、003、004、005、006 形成协作闭环。
3. 首个产品纵切选择 `JRN-FE-002`；`JRN-FE-003` 单列后续能力，不把内部 Release 地基包装成公开发布。
4. 批准 `RES-FE-001`–`008` 为发现队列，不把 Word 里的用户和采用障碍冒充已验证研究结论。
