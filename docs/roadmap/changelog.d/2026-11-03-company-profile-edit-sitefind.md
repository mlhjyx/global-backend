---
date: 2026-11-03
title: Let sellers edit DRAFT company profiles, soft-delete them, and find official websites via search
---

- 起因：卖家建档后无法补官网、无法删除测试档案，无官网的公司永远停在「待理解」；产品负责人 2026-11-03 拍板「编辑与自动找官网一起做」。
- 改动：引擎新增 `PATCH /companies/:companyId`（DRAFT 内可改名称/官网/行业/目标市场/业务邮箱，官网仍过 SSRF 守卫）、`DELETE /companies/:companyId`（软删 `company_profile.deleted_at`，列表/详情/完整度/产品视图过滤）、`POST /companies/:companyId/website-candidates`（SearXNG 两个有界查询 + 目录/社交/搜索引擎过滤 + 标题匹配排序，最多 5 条候选，人工确认后采用）；`retryUnderstanding` 放宽为「DRAFT + 有官网」可启动首次理解，并用 10 分钟排队事件防止重复启动（失败重试语义不变）。gain-saas BFF 增加三条透传路由，公司档案页新增编辑弹窗（含「自动找官网」候选列表）、删除与会话式启动理解；vben RequestClient 补 `patch` 方法。
- 测试：引擎 28 例新/改用例（编辑、软删、retry 放宽与排队防护、候选排序/过滤/去重/语言选择/搜索失败容错）；BFF 路由表规格覆盖三条新路由；全量 API 单测 10676 通过；gain-saas server 182 测试通过、web 构建通过（vue-tsc 仅余主干既有 2 条 vxe-pc-ui 声明缺失）。
- 未做：products/Offering 的编辑对账不在本期；软删档案的物理清除归 owner/DSR；「自动找官网」不自动采信（避免理解到错误公司），且对无意义名称（如「111111」）返回空由用户手填。
