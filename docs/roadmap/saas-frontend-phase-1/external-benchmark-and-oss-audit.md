# Phase 1 外部对标与 OSS 初审

> 文档 ID：AUD-FE-P1-007
> 状态：`COMPLETE_FOR_GATE_1`
> 核验日期：2026-07-20
> 边界：这是来源与风险审计，不是采购、采用、集成或 License 法律意见

## 1. GoodJob 核验基线

- 项目：[sendoh-huang/GoodJob](https://gitee.com/sendoh-huang/GoodJob/)
- 本次可复现快照：`5732e2092b48837929e7bf1f3588f3940dccd7be`，提交时间 2026-07-17，主题“版本1.09，地图合规性校验”
- 快照内文档：13 份 Markdown + 2 份文本说明；Markdown 约 2,344 行
- 限制：Gitee 本次刷新要求认证，无法证明该提交仍是远端最新 HEAD。因此以下结论只对上述精确快照负责，不写成“当前线上最新状态”。

## 2. 值得吸收的不是页面，而是工作方式

### 2.1 功能设计工作簿

GoodJob 的 [README](https://gitee.com/sendoh-huang/GoodJob/blob/master/README.md)、[自动获客设计](https://gitee.com/sendoh-huang/GoodJob/blob/master/LEAD_FINDER_DESIGN.md)、[权限设计](https://gitee.com/sendoh-huang/GoodJob/blob/master/PERMISSION_DESIGN.md) 和 [导航重构设计](https://gitee.com/sendoh-huang/GoodJob/blob/master/NAVIGATION_REDESIGN_DESIGN.md) 常把一项能力写成：

```text
用户问题和场景
→ 页面入口与首屏
→ 信息架构
→ 方案比较/自我质疑
→ 数据/API/权限
→ 阶段性取舍与人工兜底
→ 实施清单
→ 验收/使用/FAQ/限制
```

这种表达让产品、业务、设计和开发能围绕同一用户闭环沟通。我们应将其升级为有稳定 ID、Owner、状态、证据和 superseded 关系的 `Capability Pack`，而不是复制根目录平铺方式。

### 2.2 数据的协作属性

GoodJob 不只写 RBAC，还区分团队客户/商机与个人待办/备忘录。这提醒我们在 Workspace 角色之外必须定义：对象是否团队共享、个人私有、待审批、可导出、可继承、可由管理员查看。独立站管理至少要覆盖素材、草稿、Claim、Evidence、预览、发布、回滚、询盘和分析数据的范围矩阵。

### 2.3 不同受众的不同产物

设计方案、实现总结、快速开始、详细指南、FAQ 和风险说明不是同一文档。后续目标体系应采用 [Diátaxis 的四类文档方法](https://diataxis.fr/start-here/)（教程、操作指南、参考、解释）做受众分流，再用我们的权威链和证据门控制真值。

### 2.4 从功能到下一动作

结果页不是终点。查询/生成之后应明确如何进入客户、任务、商机、审批、导出、发布或人工处理。这个“下一动作”方法应进入场景模板、验收和埋点，而不是只画页面。

## 3. GoodJob 不能照搬的部分

| 问题 | 本次快照证据 | 对我们的约束 |
|---|---|---|
| 文档平铺且无权威入口 | 文档主要位于根目录，没有 owner/status/superseded 总账 | 保留现有产品边界、as-built、ADR、status 权威链；新增人类可读能力层 |
| 状态陈述滞后 | `DEVELOPMENT_STATUS.md` 写 E2E 5 项，实际 Playwright 列出 47 项 | 状态数字必须由机器生成或链接到本次运行证据 |
| 设计与实现矛盾 | WhatsApp 设计主张不使用 `whatsapp-web.js`，实现总结/package 实际引入 | 冲突不能在多份正文中静默存在；进入 conflict/decision register |
| “全绿”缺可靠证据 | 本次普通 backend/frontend self-test 通过，但完整 E2E 为 38 passed / 9 failed | 编译、自测和少量 happy path 不得替代完整 E2E/发布证据 |
| 重复且无替代关系 | 同一功能有设计、总结、访问、升级、演示等多份相近说明 | 每个事实只允许一个 owner；其他文档引用，不复制 |
| 自评代替评审 | “多轮专家审核通过”等措辞没有可核验审核身份与 finding 处置链 | 评审必须记录真实 reviewer、finding、resolution、提交和日期 |

本次 E2E 的 9 个失败集中在：协作收件箱等待超时、移动端同路径、地图国家筛选、Lead Finder provider/统计/部分失败、provider 连接测试、分页数量和验证队列状态。这些失败说明 GoodJob 的用户场景覆盖值得学习，也说明文档状态必须回到真实运行结果。

## 4. 可直接采用的方法，不引入运行时依赖

| 方法来源 | 可学习内容 | 建议状态 | 理由 |
|---|---|---|---|
| [Diátaxis](https://diataxis.fr/) | 按 tutorial/how-to/reference/explanation 分流 | `LEARN` | 解决“一份文档服务所有读者”的混乱，不改变产品架构 |
| [Backstage TechDocs](https://backstage.io/docs/features/techdocs/) | docs-like-code、就近维护、统一发现与搜索 | `LEARN` | 先吸收工作方式，不需要现在部署 Backstage |
| [Storybook](https://storybook.js.org/docs/writing-stories/) | 组件状态故事、可复现 fixture、可视化文档 | `SPIKE_LATER` | 本地原型没有组件证据库；需等正式前端 ownership/框架拍板 |
| [Storybook testing](https://storybook.js.org/docs/writing-tests/) | 交互、可访问性和视觉测试复用同一 story | `SPIKE_LATER` | 可把设计、开发和验收连成一条证据链 |
| [Playwright visual comparisons](https://playwright.dev/docs/test-snapshots) | 页面/组件截图回归 | `LEARN` | 主工作区已有 Playwright 资产，但还没有受控基线 |
| [Playwright accessibility testing](https://playwright.dev/docs/accessibility-testing) | 自动 a11y 扫描加人工核验 | `LEARN` | 后续纳入质量门；自动扫描不能覆盖全部 WCAG |

## 5. 建站与现有基础设施候选

| 候选 | 官方证据与事实 | 本地关系 | Phase 1 初判 | 进入采用决策前的硬门 |
|---|---|---|---|---|
| [Astro](https://docs.astro.build/en/basics/rendering-modes/) | 默认支持静态输出；可按内容/路由构建 | 当前 renderer 已使用 | `AS_BUILT_INTERNAL` | 生产 Release、运行时 schema、组件 fail-loud、升级/供应链验证 |
| [Astro Content Collections](https://docs.astro.build/en/guides/content-collections/) | 为结构化内容提供 schema 和类型能力 | 当前 SiteSpec 消费未使用 | `LEARN/SPIKE_LATER` | 不得另造第二内容真值；须证明与 SiteSpec/CopyBundle 的边界价值 |
| [Puck](https://puckeditor.com/docs) | React 可嵌入视觉编辑器；宿主拥有数据 | 本地未发现采用 | `SPIKE_LATER` | 权限、schema 迁移、组件白名单、协同/审计、许可版本、退出导出 |
| [Puck permissions](https://puckeditor.com/docs/api-reference/permissions) | 提供全局、组件和动态权限控制 | 可借鉴编辑器动作门 | `LEARN` | 不能代替服务端 Workspace/对象权限 |
| [Readdy code export](https://docs.readdy.ai/features/code-editor) | 官方说明可导出 React/Tailwind/TypeScript | 本地 SaaS 与 10 个模板均含 Readdy 生成痕迹 | `VISUAL_REFERENCE_ONLY` | 逐资产来源/权利审计；禁止直接转为训练/RAG/模板库 |
| [Readdy Terms](https://readdy.ai/es/terms-of-service?lang=es) | 条款包含输出、平台训练/opt-out、反向工程和竞争性 AI/ML 使用限制 | 本地模板 provenance/许可未登记 | `HOLD` | 法务/账户条款版本、输入素材权利、输出复用范围、删除/退出计划 |

## 6. 工作流、策略、观测和集成候选

| 候选 | 官方证据与事实 | 本地关系 | Phase 1 初判 | 关键风险/下一证据 |
|---|---|---|---|---|
| [Temporal](https://docs.temporal.io/) | Durable Execution；Workflow 必须可重放，Activity 应处理幂等 | 当前固定 DAG/长任务已使用 | `AS_BUILT_INTERNAL` | 不等于生产部署；继续保留 history replay、cancel、retry 和补偿测试 |
| [OPA](https://www.openpolicyagent.org/docs/latest/) | 通用 policy engine，将决策与执行分离 | 当前未采用 | `DEFER` | 外部数据不是 OPA 的事实源；先明确策略规模、延迟、bundle、审计和故障语义 |
| [Langfuse observability](https://langfuse.com/docs/observability/overview) | LLM traces/evals/metrics | 当前有自建 evidence/cost/route 体系 | `SPIKE_LATER` | 多租户、PII、数据出境、自托管、版本许可、与现有 EvidenceRef 去重 |
| [Langfuse prompt management](https://langfuse.com/docs/prompt-management/overview) | prompt 版本、发布与回滚 | 本地 task route/policy 已有真值 | `LEARN/SPIKE_LATER` | 不得形成第二个 prompt/route 真值；企业功能/审计能力需单独核价核权 |
| [Activepieces license](https://www.activepieces.com/docs/about/license) | 核心与 enterprise/商业目录采用不同授权范围 | 本地未采用 | `SPIKE_LATER` | embedding 为付费能力；必须核定 SaaS 嵌入许可、tenant isolation、secret vault、退出导出 |
| [Activepieces embedding](https://www.activepieces.com/docs/embedding/overview) | 嵌入方案属于商业产品能力 | Word 把它列作工作流候选 | `HOLD` | 不得按“开源所以可免费嵌入”估算 |
| [Chatwoot](https://github.com/chatwoot/chatwoot) | 开源全渠道客服/收件箱项目 | 原型有互动页，未发现接入 | `SPIKE_LATER` | 社区/付费功能边界、渠道条款、PII/留存、Workspace/联系人 SoR、webhook 幂等 |

## 7. 文档、采集、媒体候选

| 候选 | 官方证据与事实 | 本地关系 | Phase 1 初判 | 关键风险/下一证据 |
|---|---|---|---|---|
| [Docling](https://github.com/docling-project/docling) | 代码为 MIT；模型/第三方资产可能另有许可 | 已用于 KB | `AS_BUILT_INTERNAL` | 文件类型/恶意文档、模型许可、资源上限、版本 pin、输出证据 |
| [Crawl4AI](https://github.com/unclecode/crawl4ai) | Apache-2.0 开源网页抓取框架 | 已用于公开网页采集 | `AS_BUILT_INTERNAL` | 合规用途、egress/SSRF、robots/ToS、浏览器供应链；仓库当前已有额外护栏 |
| [Remotion license](https://github.com/remotion-dev/remotion/blob/main/LICENSE.md) | 使用专门许可证；某些公司规模/场景需要公司许可证 | Word 作为视频候选 | `HOLD` | 旧 Word 的“开源可直接集成”不能沿用；先做主体规模、SaaS/渲染场景和费用核验 |

## 8. 已登记但尚未完成官方深审的候选

以下名称来自 Word/研究输入，Phase 1 已登记，但因尚未完成版本、许可证、维护状态、数据权利和本地等价能力核验，统一为 `PENDING_OFFICIAL_REVIEW`：AiToEarn、MoneyPrinterTurbo/MoneyPrinter 系列、ComfyUI、Cognee、Graphiti、LightRAG、Firecrawl、SearXNG、new-api、LiteLLM。它们不得出现在正式实施路线的“已选型”栏。

后续每项必须形成 Capability Card，至少比较 `Learn / Build / Adapt / Integrate / Buy / Avoid / Defer`，并记录官方版本、License/模型权重、SaaS/嵌入/再分发权、多租户、数据边界、Adapter、故障语义、成本、测试、Owner 和退出计划。

## 9. 对我们工作方式的具体改进

1. 每项能力先提交一页 Capability Brief，再进入页面/架构；Brief 必须有用户问题、证据、替代方案、范围、风险和成功指标。
2. 设计评审使用标准 Scenario/Fixture，产品、原型、组件 story、API contract、E2E 和用户指南共享同一个场景 ID。
3. 每个长任务必须演示成功、空、排队、部分成功、失败、取消、超时、权限不足、预算耗尽和人工兜底，不只演示 happy path。
4. 文档的“完成”由机器证据和 Gate 决定；禁止作者自称“专家审核通过”。
5. 竞品结论必须写“我们学什么、为什么适合、哪里不适合、如何验证”，不能变成功能抄单。
6. OSS 默认进入候选登记，不默认进入依赖；License、安全、数据权利、替代与退出是采用前置，而不是发布前补作业。
