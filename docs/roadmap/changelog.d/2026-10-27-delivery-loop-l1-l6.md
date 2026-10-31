---
date: 2026-10-27
title: Implement the lead delivery loop reason codes, outcomes and LeadPackage
---

- 起因：交付闭环设计（2026-10-10 批准）的 L1–L6 一直未实现，周报里的原因码 / 注册地址 / 建议联系路径列全空，客户也无法回写线索结果。
- 改动：
  - BI-20 原因码：拒绝与正向结果枚举、Fit 原因码的确定性推导，`lead_decision.reason_code`（reject 必填，缺省返回 422）。
  - BI-23 反馈：新表 `lead_outcome`（只追加、FORCE RLS、app_user 仅 SELECT/INSERT）与 `POST /leads/{id}/outcomes`、`POST /reports/weekly/feedback`（客户填好的周报 CSV 原样上传，逐行校验）。
  - BI-19/21：`LeadPackage` 读模型与 `GET /leads/{id}/package`；`LeadQualified` v1 新增可选交付字段（公司画像、标识、联系路径与建议路径、信号、证据 URL、Fit 原因码），旧载荷仍通过。
  - BI-15：建议联系路径的确定性规则与固定合规备注；周报填充「为什么现在 / 原因码 / 注册地址 / 建议联系路径」列。
  - L6：从 Impressum 抽公司注册地址（独资商号不存），接入 `website_profile` 与属性白名单。
  - E7：有域名的公司同时按「名称+国家」键匹配平台信号。
  - 新增迁移 `20261027120000_lead_delivery_loop`，只加表/列/索引与权限，不回填。
- 测试：零容器单测覆盖原因码推导、LeadPackage 组装、反馈 CSV 解析与写库、迁移静态契约、注册地址解析与属性白名单；`gctl check --fast`。
- 未做：`field_evidence.source_url` 列与写入点补写、有效期按字段最新取值、线索级成本分摊、开发信草稿模型任务与 `lead_outreach_draft`、周报开发信列；迁移执行与镜像上线留待验收 run 结束后的窗口。
