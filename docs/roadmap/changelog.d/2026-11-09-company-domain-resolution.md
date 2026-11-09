---
date: 2026-11-09
title: 域名解析候选与人工复核队列两表（ch03 执行面 3a）
---

- 起因：ch03 §3.9.4 的域名解析证据表与复核工单表是执行面（解析 workflow / 池导出）的落库基座；此前只有内存契约（T3-13/T3-15），没有租户级表、权限清单与 RLS 行为证据。
- 改动：
  - 迁移 `20261109180000_company_domain_resolution`：`company_domain_resolution`（业务唯一键 workspace+company+候选域名+route；`selected=true` 仅允许 `status='VERIFIED'`；复合外键随公司级联删除）与 `domain_review_task`（非 OPEN 必须有 decided_at；reason/status 封闭词表），两表 ENABLE+FORCE RLS + `current_workspace_id()` 租户策略，app_user 授予 SELECT/INSERT/UPDATE/DELETE 并同步 `docs/governance/app-user-table-privileges.json`；同公司至多一行 selected 由写入路径的 company 级 advisory lock 保证（部分唯一索引无法进 Prisma datamodel，会在漂移门报红）。迁移只入代码，未部署。
  - `apps/api/src/registry/domain/domain-resolution-store.ts` / `domain-review-store.ts`：存储契约（幂等 upsert、仅 VERIFIED 可选中、`clearSelected` 清选中后才可改判终态、工单 OPEN 幂等入队、裁决终态守卫、SLA 超期转 EXPIRED）。
  - `domain-stores.prisma.ts`：Prisma 实现——upsert 用单条 `INSERT … ON CONFLICT DO UPDATE … RETURNING (xmax = 0)`（捕获 P2002 会中止所在事务，不能用）；`selectVerified` 事务内先 `pg_advisory_xact_lock` 再清旧选新。
  - CI「Raw SQL parameter types on PostgreSQL」步骤接入新 postgres 规格（迁移后 `prisma migrate deploy` 真库）。
- 测试：内存契约单测 11 例（校验/幂等/单选中/清选中/终态/超期排序）；迁移静态契约 6 例（词表与 TS 常量对账、FORCE RLS 语句、GRANT 与清单一致、datamodel 关系映射）；真库规格 5 例（app_user+set_config 正向读写、不设 workspace 静默空集、无上下文写入 42501、跨 workspace 不可见/不可写、复合外键 23503、CHECK 23514、部分唯一索引 23505、公司删除级联）；漂移门在一次性库上零未登记差异。
- 未做：解析/复核 Temporal workflow 与池导出（批次 3b）；selected 行回写 `canonical_company.domain`；迁移落库与发车（按授权另行执行）。
