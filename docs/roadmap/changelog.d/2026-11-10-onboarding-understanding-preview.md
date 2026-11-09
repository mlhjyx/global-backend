---
date: 2026-11-10
title: 注册即建档第 1 步——理解预览与 onboarding facts 端点（ONBOARDING-PREVIEW-1）
---

- 起因：产品负责人 2026-11-10 批准「注册即建档」客户旅程重构（先官网 → 理解预览 → 勾选完成注册）。当前 onboarding 让客户手填六项事实，理解结果在注册完成后才出现；行业是自由文本，无法受控。第 1 步把顺序反过来：官网先提交，理解结果变成客户可勾选的候选，行业改受控词表。
- 改动：
  - **档案保存受控行业码**：`company_profile.industry_code TEXT NULL`（迁移 `20261110100000_company_industry_code`，可空无回填）；`industry` 继续存展示标签，供旧界面与上游 NACE 词面映射读取。`CompanyDto` 增加 `industryCode`。
  - **`GET /api/v1/companies/:companyId/understanding-preview`**（acquisition:read）：只读聚合一次真实 understanding run 的落库结果——状态（not_started/queued/running/ready/failed）、`stage:code` 失败标签、已分析页数（knowledge_source type=website 按 URI 去重）、行业候选（profile.industry 经 term_alias 精确/子串归一到 canonical_taxonomy(kind=industry)，归不上只给原文）+ 受控词表、产品候选（offering 带来源页/原文）、市场候选（summary/claim 陈述里确定性识别的国家名，拉丁别名 ≥4 字符避免 "contact us" 类误报，命中才建议并附原句）。
  - **`POST /api/v1/companies/:companyId/onboarding-facts`**（acquisition:write，无 Grant）：客户勾选结果写回同一档案；industryCode 以词表校验并回填标签；products upsert 为 Offering(source=onboarding) 并清理本路径管理的旧行；同事务复用 `synthesizeProfileClaimDrafts` 生成 NEEDS_REVIEW Claim 草稿。只允许 DRAFT/REVIEW，ENRICHING 返回 409 ONBOARDING_FACTS_NOT_ALLOWED，避免 understanding 的 extract_profile 稍后覆盖客户选择。
  - **PATCH /companies/:id** 接受 `industryCode`；改成自由文本行业时清空旧受控码，保持两列同源。
  - **审查修复**：接受重试即清 `understandingFailedAt/LastError`（预览从 failed 回 queued，并恢复 10 分钟重复启动守卫）；onboarding-facts 拒绝「DRAFT + 官网 + 无失败标记」（已排队）的写入并拒绝 JSON null；市场国家只认词边界（Romania 不再命中 Oman/Niger/Mali），产品/市场/页数只收与当前官网同站的溯源；市场候选补 `labelEn/labels`。
  - 两个新操作的 `operation-descriptions` 与 OpenAPI 契约重导出。
- 设计约束：不新增 AI Task、不新增工具调用点、不新增预算 purpose/quote operation——预览复用 `POST /companies`（既有 understanding.run 预算），完成路径零模型调用。因此未改 `scripts/execution-authority-policy.*`、`builtin-tools.ts` 与 quote envelope。
- 测试：`src/company` 47 例（新增市场词边界、同站过滤、排队态守卫、JSON null 等 5 例）、operation-descriptions/authz-openapi/controller-authz 合计 75 例全绿；`nest build`、spectral、G9 体量门、`governance:verify`、`execution-authority-policy.spec`（合并最新 main 后 17 例）全绿；OpenAPI 重导出 139 paths（+2）；Copy 固定源回执重签（合并最新 main 后 UNCHANGED）。
- 未做：SaaS 侧 onboarding 反向流程（gain-saas 仓单独 PR）；逐页抓取失败/预计时间的 run 事件投影（第 2 步）；NAF→NACE 全表映射（T3-05）与词表扩容仍按原路线。
