---
date: 2026-11-10
title: 未应用迁移改名到已应用迁移之后——修复合并顺序导致的 MIGRATION_REVISION_MISMATCH
---

- 起因：`20261110090000_understanding_admission_lease` 已在本机库应用；随后合并的 #996（080000_source_compliance_matrix）与 #997（070000_legal_entity_graph）名字排在 090000 之前且未应用。prisma 按名字顺序应用后，库「最新完成迁移（finished_at）」会小于镜像的 migration_revision（按名字取最大），运行时报 `MIGRATION_REVISION_MISMATCH` 拒绝启动（2026-11-10 发车 dry-run 实测拦截，未切换）。
- 改动：把两个**未应用**迁移目录改名到 090000 之后——`20261110080000_source_compliance_matrix` → `20261110110000_source_compliance_matrix`、`20261110070000_legal_entity_graph` → `20261110120000_legal_entity_graph`。仅目录改名，SQL 内容不变；已应用迁移不改名（迁移只前进）。后续在飞迁移按「合并时大于当前已应用最大名」重新取号（W3 060000 → 20261110130000 由其 PR 自行改名）。
- 测试：prisma 漂移门在一次性库全链重放通过；gctl switch-backend dry-run 的迁移顺序检查通过后发车。
- 未做：不改变任何表结构；不动运行现场。
