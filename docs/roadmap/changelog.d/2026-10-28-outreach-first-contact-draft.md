---
date: 2026-10-28
title: Store a model-written first-contact draft on accepted leads and fill the weekly-report column
---

- 起因：交付闭环设计（2026-10-10 已批准）L5——周报的「开发信草稿」列一直是空的，运营拿到线索后还要自己从零写首次联系邮件。
- 改动：
  - 新增模型任务 `outreach.first_contact_draft`：输入只用公司级事实（卖方 Claim/产品、买方贸易角色/在售品牌、Fit 结论与信号），不传任何人名或联系方式；输出目标国语言的 subject/body、中文译文与被引用的事实键。
  - 新表 `lead_outreach_draft`（只追加、按线索版本号递增、FORCE RLS、`app_user` 只有 SELECT/INSERT），随 lead 级联删除；生成入口 `POST /leads/:leadId/outreach-drafts`（`acquisition:review`，走 Workspace Grant，新增预算 purpose `outreach.draft` 与技术报价操作）。
  - 草稿末尾由代码（非模型）追加卖方自己的回复入口：官网、邮箱、`wa.me` 一键聊天链接（仅 E.164）。
  - `used_facts` 校验：引用未提供的事实键或为空即丢弃草稿（502 `OUTREACH_DRAFT_UNGROUNDED`），不落库；只有最新裁决为 accept 的线索可生成（否则 422）。
  - 周报「开发信草稿」列取每线索最新一版（主题 + 正文 + 中文译文 + 「草稿，需人工审阅；平台未发送」）。
  - 平台不发送草稿，也不提供发送按钮。
- 测试：零容器单测覆盖事实表/尾注/接地校验/版本追加/重放读回/并发版本重试与周报列；`scripts/execution-authority-policy.spec.mjs` 与 durable-result 投影注册表同步扩一项并全绿。
- 未做：GrowthOS 侧尚未签发 `outreach.draft` 授权与展示草稿（前端不在本次范围）；迁移 `20261028180000_lead_outreach_draft` 仅新增文件，随下一班镜像窗口执行。
