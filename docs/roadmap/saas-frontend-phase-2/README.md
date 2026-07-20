# Phase 2 产品体验与信息架构基线

> 文档 ID：`BASE-FE-P2-000`
> 状态：`READY_FOR_GATE_2_REVIEW`
> 工程事实基线：`origin/main@676c6cdc175326927ec341a2d585168aa0a1a374`
> 产品来源基线：Gate 1 冻结审计包 + 当前权威链 + 五份 Word 历史输入
> 核验日期：2026-07-20
> 适用范围：统一 SaaS 产品体验与 IA；当前主线深挖“独立站管理”，其他产品域只建完整地图与边界

## 1. 本包是什么

本目录是批准计划的 Phase 2 决策包，不是正式 PRD、UX Spec、设计稿或前端技术方案。它把 Gate 1 已核验的来源、代码、契约、Word 和本地原型转成一套可供产品负责人拍板的体验基线：目标用户、核心任务、产品域、对象、页面、导航、Workspace Shell、指标与冲突方案。

本包坚持四条边界：

1. “独立站管理”是统一 SaaS 内的一级产品区域；Astro 公开站是该区域的版本化输出，不是第二套 SaaS 前端。
2. 全 SaaS 建完整产品地图，但当前只把 Site Builder 的“资料/素材 → Build → 状态/取消/恢复 → 可信开发预览”作为建议首个纵切。
3. 旧 Word、本地 Mock 原型和竞品只能提供假设或方案；不能覆盖当前权威链和 `main` 实现。
4. 本包的“推荐”仍是待产品负责人批准的建议；没有批准的导航、角色、页面承诺、指标和 ownership 继续标记 `OPEN_DECISION`。

## 2. 事实标签

| 标签 | 含义 |
|---|---|
| `FIXED` | 当前权威链或产品负责人已经明确的事实 |
| `AS_BUILT` | 当前 `main` 代码/机器契约已有，且有相称证据 |
| `FROZEN` | 已有能力保留维护，但当前不新增施工 |
| `EXTERNAL_OWNED` | 已明确由 SaaS 或其他系统拥有，本仓只定义接缝 |
| `PROPOSED` | Word、原型、竞品或本包提出的待批准方案 |
| `HYPOTHESIS` | 需要用户研究或行为数据验证的产品假设 |
| `OPEN_DECISION` | 必须由有权 Owner 拍板，不能由文档作者静默决定 |

“页面存在”“接口存在”“构建成功”“有不可变 Release”均不自动等于“用户可发布”或“生产可用”。

## 3. 交付物

| 文档 | 解决的问题 |
|---|---|
| [用户、问题与旅程基线](user-problem-and-journey-baseline.md) | 我们优先为谁解决什么问题，完整产品的核心任务和纵向旅程是什么 |
| [产品域与跨模块对象图](product-domain-and-object-map.md) | 产品域如何分工，对象如何跨域流动，公开站输出处于什么位置 |
| [对象生命周期与 SoR 登记](object-lifecycle-and-sor-register.md) | 核心对象由谁拥有、状态如何变化、哪些当前存在、哪些只是目标态 |
| [页面与能力目录](page-and-capability-catalog.md) | 整个 SaaS 到底需要哪些前端页面/面板，各自状态、对象和依赖是什么 |
| [导航与 Workspace Shell 方案](navigation-and-workspace-shell-options.md) | 一级入口、全局 Shell、跨模块入口的 3 个选项与推荐是什么 |
| [成功指标与埋点假设](success-metrics-and-instrumentation.md) | 如何判断能力解决了用户问题，哪些表面数字不能当成功 |
| [IA 冲突与决策登记](ia-conflict-and-decision-register.md) | 哪些来源互相冲突，Gate 2 具体要拍板什么 |
| [Gate 2 评审包](gate-2-review.md) | 决策摘要、推荐组合、风险和批准清单 |

Phase 1 冻结证据入口：

- [Gate 1 审查包](../saas-frontend-phase-1/gate-1-review.md)
- [能力多轴状态矩阵](../saas-frontend-phase-1/capability-status-matrix.md)
- [冲突登记](../saas-frontend-phase-1/conflict-register.md)
- [实现证据矩阵](../saas-frontend-phase-1/implementation-evidence-matrix.md)

## 4. Phase 2 结论摘要

1. 建议首批设计伙伴继续聚焦 B2B 制造、工贸一体和传统出口企业；日常主操作者建议定为海外增长/外贸运营，老板/出海负责人承担经济购买与高风险批准，销售/BD 接收机会和回写结果。该组合与当前 Site Builder、买家智能和产品边界最一致，但仍需 Gate 2 批准。
2. 建议完整产品采用“用户任务 + 业务对象”的混合 IA：`今日 / 客户开发 / 独立站管理 / 增长执行 / 互动与商机 / 洞察` 六个产品入口；企业知识、审批、任务、异常、集成、团队和设置进入全局 Shell 或相应对象上下文。该方案不删除能力，只减少一级入口。
3. 建议 `CompanyProfile / Offering / Claim / Evidence / Asset` 作为多个产品域共享的企业事实底座；Site Builder 消费它们，不复制第二份公司真相。
4. 建议第一个可交付纵切止于“可信开发预览”：用户补资料和素材、看到缺口与处理状态、启动 Build、理解成本/步骤、取消或恢复失败，最后打开由 active READY Release 支撑的预览。公开发布、域名、回滚 UI、询盘和站点分析各自单列后续能力。
5. 现阶段最大的产品风险不是页面少，而是原型把 Mock 能力、当前后端能力和未来承诺混在同一页；正式页面必须显示能力状态和限制，禁止出现无后端语义的“发布”“SSL 已启用”“询盘数据”等假完成。

## 5. Gate 2 边界

本包完成后停止。只有产品负责人对下列内容给出明确决定，才进入 Phase 3：

- 首批目标客户和日常主操作者；
- 一级 IA 和“独立站管理”的准确位置；
- Workspace Shell 的全局入口；
- 核心对象归属与跨仓 Owner；
- 首个用户可见纵切和不得承诺的能力；
- 成功指标、反指标和第一批验证窗口。

Phase 3–8、正式 `docs/frontend/` 文档体系、设计稿、前端实现、Schema/API/基础设施修改均不在本包授权范围内。
