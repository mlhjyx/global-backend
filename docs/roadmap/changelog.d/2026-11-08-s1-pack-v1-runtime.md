---
date: 2026-11-08
title: Add pack registry tables, strategy resolution snapshots and service-kind skills
---

- 起因：S1 Pack v1 第 2 步（设计 `docs/superpowers/plans/2026-11-08-s1-pack-v1.md`，S1-D1~D10 已批准；S0 已于 2026-11-07 发车）——把 S1-1 的 Pack 规范落成注册表与运行时解析，并为服务型技能扩出 skill-kind。
- 改动：
  - 迁移 `20261108130000_pack_v1`：七张新表（pack_package / pack_draft / pack_version / pack_activation / pack_enablement / eval_receipt / strategy_resolution_snapshot），FORCE RLS；发布版本/激活/回执/策略快照 append-only，目录仅状态与激活列可 app_user 更新；`docs/governance/app-user-table-privileges.json` 同步。
  - 迁移 `20261108130100_skill_service_kind`：`skill_version` 的 task contract 列可空、新增 `service_handler`，CHECK 保证每行恰好一种绑定。
  - 运行时：Pack registry store（raw SQL）+ `createDbStrategyResolver`（选择器选包、复用确定性冲突裁决、≤2000 字策略简报、内容寻址策略快照、`PACK_VERSION_DRIFT` fail-closed、30s 缓存）；worker/relay 启动期 owner seed 7 个内置内容包（幂等；版本漂移大声失败；只补缺省平台激活）。
  - SKILL.md v1.1：`platform.skill-kind`（model_task | service）、`platform.tenant-default`、`platform.service-handler`（闭集：sanctions.screen.v1 / quoting.incoterms.v1）；service 技能不得绑定 task contract 或声明工具；`tenant-default: disabled` 需显式 workspace 启用（新错误码 `SKILL_TENANT_NOT_ENABLED`）。三个存量技能升到 1.1.0（行为不变）。
- 测试：单测 122 例（pack 选择/冲突/漂移/快照幂等、策略简报确定性、迁移静态契约、service-kind 正负、tenant-default 语义）；真库一次性库实测：RLS service 组 5 例、双 seed 幂等、策略解析与停用过滤、技能 1.1.0 解析、ACL 19 例与 raw-SQL 2 例；`gctl check --fast` 与 `docs:verify` 全绿。
- 未做：Pack Studio ops API 与评测回执写入（S1-3）；两个新技能与导入 A 档（S1-4）；策略简报接入现有检索链路（S1-4 新技能消费）。
