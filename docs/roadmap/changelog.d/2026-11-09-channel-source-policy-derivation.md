---
date: 2026-11-09
title: Derive source_policy drafts from channel manifests and gate channel enablement on reviewed terms
---

- 起因：v3.0 第 6 章 CH-8——渠道 ENABLED 前必须对 `allowedHosts` 逐域有已复核的 `source_policy`（reviewStatus=APPROVED、termsStatus∈{REVIEWED_OK, REVIEWED_RESTRICTED}），官方开放数据域豁免；现状注册与治理是两套手写数据、无派生、无一致性校验。
- 改动：
  - 新模块 `apps/api/src/channels/channel-source-policy.ts`：manifest → source_policy 草稿纯函数（domain 去 www、按类别映射 source_type、api 默认 robots ALLOWS、官方白名单 `*.gov`/`*.europa.eu`/GLEIF/Wikidata/Overpass 直接 REVIEWED_OK 并注明 official-open-data）、启用闸门评估（缺失/暂停/条款未复核/crawl robots 受限四类违规）与 owner 脚本的 upsert 输入（更新不覆盖人工 terms/review/robots 结论）。
  - `ChannelService`：manifest 创建/重存的响应返回 `sourcePolicyDrafts`；详情返回逐域 source_policy 状态与违规清单；manifest 渠道启用前新增条款闸门（409 `CHANNEL_GOVERNANCE_INCOMPLETE` + `policyViolations`），官方域豁免。
  - 新 owner 运营脚本 `apps/api/scripts/apply-channel-source-policies.mts`：`--channel <uuid> [--dry-run]`，用 owner 连接幂等落库派生行——`source_policy` 保持 app_user 只读（2026-10-09 加固与 CI 权限门不变），不做运行时写权限放宽。
- 测试：派生矩阵（类别映射/www 归一/通配跳过/官方白名单/crawl robots 保持 UNREVIEWED）、闸门矩阵（缺行/暂停/未复核/受限条款/crawl robots/官方豁免多域）、服务层启用门与详情、upsert 输入不覆盖人工结论。
- 未做：渠道不再被启用后的自动停用不接线（政策 SUSPENDED 只在物理出网前由 ToolBroker 阻断，章节 §6.3.6.5 的约定）；未部署。
