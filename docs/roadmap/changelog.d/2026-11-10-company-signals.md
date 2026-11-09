---
date: 2026-11-10
title: 社媒信号采集——changedetection/RSSHub 归因落库 company_signal
---

- 起因：免费社媒信号栈（changedetection.io @ 127.0.0.1:5055、RSSHub @ 127.0.0.1:1200，RUNBOOK §16）已上线，但信号仍停在两个服务里，引擎无法查询、也无法用于触发式外联。本批把两类信号归因到 canonical_company 并落库为可查询的公司信号（只读公开页面/公开信息源，不含任何平台写操作自动化）。
- 改动：
  - 迁移 `20261110020000_company_signal`：新表 `company_signal`（`workspace_id` 必填、`company_id` 可空 FK `canonical_company` ON DELETE SET NULL、`provider_key`、`signal_kind`（rss_item|page_change）、`source_url`、`title`、`excerpt`、`observed_at` timestamptz、`fingerprint` char(64)、`ingest_key`；唯一 `(workspace_id, ingest_key)`；索引 `(workspace_id, company_id, observed_at DESC)`）；ENABLE+FORCE RLS + `current_workspace_id()` 租户策略；app_user 授予 SELECT/INSERT/UPDATE，并同步 `docs/governance/app-user-table-privileges.json`。Prisma model `CompanySignal` 同步。
  - `apps/api/src/signals/company-signals.ts`：RSS2/Atom 解析（fast-xml-parser；CDATA 与缺失字段宽容、缺 title/link 计 dropped）、changedetection watches 映射（`last_changed > 0` 才算信号）、指纹 `sha256(provider|source_url|title|observed_at 秒)`、域名归因（精确 > 子域 > 同注册域；未匹配 `company_id = null` 仍落库）、`createMany(skipDuplicates)` 幂等写入；返回 `{inserted, skipped, matched}`。
  - CLI `apps/api/scripts/signals/ingest-signals.mts`：`--workspace` 必填、`--rss <route|url>` 可重复（缺省读 `SIGNAL_RSS_ROUTES`，逗号分隔）、`--include-watch-changes`；在 `set_config('app.current_workspace_id')` 事务内执行一次并打印计数，源级失败退出码 1、参数错误退出码 2。
- 测试：新增 `company-signals.spec.ts` 18 例（RSS2/Atom 解析含 CDATA 与缺字段、指纹稳定/去重、域名归因精确/子域/无匹配、changedetection 映射、编排重跑幂等、源级失败隔离；fetch 注入 fake，不触网）；`pnpm --filter @global/api test` 全量 13115 例，4 个文件为负载超时（单跑 50/50 通过，非本次改动）；`pnpm --filter @global/api build` 绿；`node scripts/check-file-budgets.mjs` OK；迁移在本机一次性库过 Prisma 漂移门 / G5 RLS 目录门（175 张表、121 张 workspace RLS）/ app_user 权限清单门（27 例），并在 dev 库以 app_user 实测 RLS（无上下文 0 行、目标 workspace 23 行、他 workspace 0 行）。真实数据演示：Nees Pumpen 官网 RSS 10 条全归因、RSSHub 路由 12 条未归因（github.com）、changedetection 页面变更 1 条未归因（临时演示 watch，演示后已清理）；重跑插入 0、跳过 23（幂等）。
- 未做：changedetection `/diff/{uuid}` 正文未落 `excerpt`（列表元数据已足够触发，正文拉取留待后续）；调度接线（Schedule / run 内 activity）未做，本批只有 CLI 手动执行；未归因信号的规则回填与人工归因界面未做。
