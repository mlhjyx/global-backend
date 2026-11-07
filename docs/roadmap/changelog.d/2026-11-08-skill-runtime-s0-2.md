---
date: 2026-11-08
title: Add the skill registry tables, DB resolver, pass-through adapter and startup seeding
---

- 起因：S0 Skill Runtime v0 第 2 步——让三个存量技能真正经注册表解析并写入不可变解析快照，行为保持不变（设计 `docs/superpowers/plans/2026-11-08-skill-runtime-s0.md`，已批准）。
- 改动：
  - 迁移 `20261108010000_skill_runtime_v0`：新增 `skill_package` / `skill_version` / `skill_enablement` / `skill_resolution_snapshot` 四表（FORCE RLS；平台目录行跨空间可读；版本与快照 append-only；目录仅状态列可被 app_user 更新），并同步 `docs/governance/app-user-table-privileges.json`。
  - 运行时：`StaticSkillResolver`（内置目录，测试/未接线缺省）与 `createDbSkillResolver`（平台状态 + workspace 覆盖 + 契约漂移校验，fail-closed；30s 缓存；内容寻址快照 `ON CONFLICT DO NOTHING`）。
  - 直通 adapter `executeSkillWithRuntime`：解析 + 绑定校验后把输入原样交给既有结构化任务桥；understanding 的 claims/offerings 与 discovery 的 fit 判定改经它执行，prompt/schema/模型/预算/收据逐字节不变。
  - 启动期 seed（worker + relay，owner 连接）：同版本摘要漂移会大声失败（要求 SKILL.md 版本号 +1）。
  - 停用/未登记/契约漂移：understanding 转 Temporal nonRetryable；fit 判定整轮显性失败，不再静默返回空判。
- 测试：单测 55+ 例（resolver 失败码与缓存、adapter 逐字段转发、迁移静态契约、调用点与 worker 接线源级守卫）；真库 RLS service 组 5 例（一次性库实测）；`app-user-table-privileges.postgres.spec.ts` 与 `raw-sql-parameter-types.postgres.spec.ts` 在本机 `global_test` 实测通过；`gctl check --fast` 全绿。
- 未做：ops 启停 API 与文档收尾（S0-3）；租户自定义技能（S3）。
