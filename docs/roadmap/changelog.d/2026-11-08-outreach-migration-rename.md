---
date: 2026-11-08
title: Rename the outreach compliance migration after the already-applied campaign purpose migrations
---

- 起因：`20261108160000_outreach_compliance`（#883）合入晚于 `20261108163000/163100` 的两笔 campaign purpose 迁移，名字时间戳却更早；它在目标库尚未应用，一旦按顺序补上，运行时「按 finished_at 取最新已应用迁移」将与镜像「按名字取最新迁移」不一致，触发 `MIGRATION_REVISION_MISMATCH`（switch-backend 前提门实测拦截）。
- 改动：目录改名为 `20261108180000_outreach_compliance`（内容不变；该迁移从未在任何环境应用过，改名对已有回执零影响；代码/脚本无对该目录名的引用）。
- 测试：CI 迁移治理门与 db tests 覆盖；部署随下一班镜像以 `--with-migrations` 正常补上。
- 未做：不触碰任何已应用迁移的历史。
