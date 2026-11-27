---
date: 2026-11-28
pr:
title: "fix(discovery,intent): 收紧 L0.5 缺域补官网单字匹配精度并打通平台层网站监控自动纳管"
---

- 起因：现网真实 SearXNG 样本测试发现 L0.5 对单短词公司名可能误匹配非根应用子域（`app.fieldwire.com`）或靠后排位通用站点（`dispatch.com` 压过排名前三的 `dispatchgridservices.com`）；同时 `customer-worker` 无 `platformWriter` 导致现网 `monitored_source` 长期为 0 行，匹配企业始终未被纳入网站变更监控。
- 改动：收紧 `domain-resolver.ts`（过滤 `app./docs./support.` 等非根子域、限制短词子串仅在已知行业/地域词旁匹配、叠加搜索排位与多命中频次权重、按整词校验标题匹配）；在持有 `platformWriter` 的 `platform-worker` 中新增 `syncQualifiedWatchesFromWorkspaces` 活动并经 `patched('intent-sweep-auto-register-watches-v1')` 接入 `intentSweepWorkflow`，自动将各租户已匹配企业纳入 `web_watch`；同步优化 `registerWatchesForRun` 日志提示。
- 测试：更新 `domain-resolver.spec.ts`、`intent.workflow.spec.ts` 与 `intent.activities.spec.ts`，并通过真实 SearXNG 5 家现网样本验证、全量构建及全部治理门禁。
- 未做：待合入后随下一次统一镜像发布上线，并结合现网 `intent-sweep` 周期验证 `monitored_source` 自动纳管行数。
