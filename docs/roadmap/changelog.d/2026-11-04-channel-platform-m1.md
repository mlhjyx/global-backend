---
date: 2026-11-04
pr:
title: Add the channel data-source platform (registry, tenant enablement, CSV import, config-driven crawler v0)
---

- 起因：完整设计 §4/§11 M1——新增渠道不改代码：管理后台配 API/爬取/导入三形态，渠道养池、run 消费池；Q27 把展会渠道改成行业驱动的动态发现、导入验收用系统生成的 10 行示例 CSV。
- 改动：
  - 新表 `source_channel`（平台注册表，治理字段 + 失败率连 3 轮 >30% 自动停用）、`source_channel_enablement`（租户只能启用已批准渠道）、`source_channel_run`（每次运行的抓取量/产出/失败）、`imported_buyer`（租户私有导入原始行与去重键）；`company_channel_sighting.channel_id` 接上外键。
  - 导入通道端到端：CSV 解析（RFC4180/分号/BOM/5000 行上限）+ 列映射 + 预览（去重/抑制命中，不写库）+ 提交（按域名/名称+国家去重、过抑制门、物化 canonical + sighting + 批次明细）；示例 CSV（10 行）。
  - 通用爬虫 v0（配置驱动）：零依赖 HTML 选择器子集、列表/详情抽取、https-only、页数上限与单域限速；抓取执行经 ToolBroker（robots 强制）——其平台抓取预算权威获批前，preview/run 端点 fail-closed 409（不绕过闸门）。
  - 启用硬闸门：license+tosUrl+robots 结论齐全，robots=C 永不启用、crawl 仅允许 A。
- 测试：CSV/映射/示例、选择器、爬虫（详情/页数截断/失败计数/配置拒绝）、治理闸门、启用、导入端到端与预览、运行统计与自动停用、迁移静态契约；全量 API 单测与 docs/governance。
- 未做：抓取通道的真实执行（等平台抓取预算权威决策）；行业驱动展会发现端点（依赖抓取出网）；管理后台页面（gain-saas 侧 PR）。
