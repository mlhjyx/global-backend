---
date: 2026-11-23
pr:
title: Formal schema and CI integration for contact enrichment safety
---

- 起因：私有首片的联系人补强安全纵切只有纯/假端口层，缺真实数据库 schema、迁移、RLS/授权、漂移基线与 CI 实证，无法作为可部署结构合入 main。
- 改动：
  - 迁移 `20261123074206_contact_enrichment_safety` 新建 `contact_enrichment_execution` 与 `contact_enrichment_execution_step` 两张业务索引表：FORCE RLS 与 workspace 策略、app_user 仅 SELECT/INSERT 与窄列 UPDATE（无 DELETE）、HTTP/run 明确 nullable 唯一身份、execution/slot 唯一、原 budget operation 一一映射、非终态 in-flight fence、复合 scoped FK（contact/company 列级 SET NULL 不清 workspace）、scope_key 派生与冻结/封口触发器。
  - 扩展 `generic_operation_artifact_expected_facts_valid_v1` 的精确 schema 分支，新增 `contact-email-find-hunter/v1` 六项 HTTP expected facts 全 NULL；mark/load/settle/apply 原约束链经该校验函数收紧，不泛放未知 schema。
  - `schema.prisma` 增两张业务模型；`docs/governance/app-user-table-privileges.json` 登记新表授权；`.github/workflows/ci.yml` 把两份真实 PG 套件接入既有 API PG job（RLS 以 app_user 执行），迁移链在新库上先行 deploy。
  - 两份 Copy 治理文件合并当前 main 内容后 HASH_ONLY 重签。
- 测试：`enrichment-safety.migration.spec.ts` 与 `enrichment-execution.repository.postgres.spec.ts` 在真实 PostgreSQL 上以 app_user 执行（无 skip、收集数大于零），覆盖目录/RLS/授权/无 DELETE/复合 FK/列级 SET NULL/部分唯一索引/封口与 DSR 分支/并发 fence；Prisma 漂移门与治理目录门按实变登记；api build/typecheck 与受影响 safety 套件通过。
- 未做：运行时模块装配、具体 SQL 存储适配器与真实供应商调用仍未接线；不部署、不发车、不改服务/R4/权限；`durable-result-strategies.json` 治理清单扩展与 code-first OpenAPI 快照留在后续窗口。
