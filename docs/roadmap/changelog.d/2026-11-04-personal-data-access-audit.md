---
date: 2026-11-04
pr:
title: Add append-only personal-data access audit with 180-day retention
---

- 起因：产品负责人 2026-11-04 决定取消租户数据处理声明（完整设计 §7.4 / Q23–Q25），平台级 lawful basis 接管联系人操作；作为补偿控制，每一次个人数据访问/物化都要留访问审计（谁/何时/公司/字段类/用途），保留 180 天。
- 改动：
  - 新表 `personal_data_access_audit`（引擎迁移 `20261104100000`）：租户 RLS、append-only（app_user 只有 SELECT/INSERT）、内容最小化（只记字段类别与主体计数，不存字段值）。
  - 新模块 `apps/api/src/compliance/personal-data-access-audit.ts`：统一写入口与字段类推导。
  - 接线四处：`discover-contacts` / `guess-emails` / `contact-point/:id/verify` 三个 HTTP 路径，以及 run 内联系人物化与邮箱补全（与落库同事务，物化了却没有审计的情况不出现）。
  - `expire_personal_data_access_audit_v1` 保留期清理函数，由 raw-retention sweep 在 `personal-data-access-audit-retention-v1` patch 下按 workspace 分批调用（旧历史重放不产生新命令）。
- 测试：新增审计模块单测、迁移静态契约与 raw-retention 编排单测；全量 `APP_DATABASE_URL= pnpm --filter @global/api test` 通过（两次已知负载假红单跑均通过）。
- 未做：gain-saas 侧取消声明（另 PR）；审计的运维查询界面。
