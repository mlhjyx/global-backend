---
date: 2026-11-09
title: Add the registry frame foundation (data model, loader v0, deterministic merge v0, recall audit scaffold)
---

- 起因：GainOS v3.0 第 3 章（召回与枚举，P2）第一波——召回率从未测量、注册库源缺失的原因是「分母不存在」。本步先做与外部网络无关的地基：frame 数据模型、CSV/JSON 装载器 v0、确定性硬键归并 v0、召回审计脚手架与域名解析接口占位（ch03 T3-01/T3-03/T3-16/T3-20/T3-12 的子集）。
- 改动：
  - 迁移 `20261109100000_registry_frames`：新增 5 张平台表（无 RLS，app_user 只读，写入只经平台 ops/owner 连接）——`registry_frame`（帧定义）、`registry_snapshot`（文件级快照元数据 + sha256 可回放）、`registry_entity`（归一实体，业务键 `(scheme, reg_number)` + contentHash）、`registry_entity_change`（append-only ADDED/UPDATED/WITHDRAWN/REAPPEARED 事件，唯一键幂等）、`registry_entity_link`（硬键 CONFIRMED / 软键 PROPOSED 的跨帧链接与人工复核队列）；同步 `docs/governance/app-user-table-privileges.json`。
  - `apps/api/src/registry/`：帧配置校验（`frame-types.ts`）、RFC 4180 CSV 与点分路径 JSON 解析（`frame-parse.ts`）、单行归一与 contentHash（`frame-normalize.ts`）、装载计划纯函数（`frame-loader.ts`，连续两个快照缺席才 WITHDRAWN、重放幂等）、装载编排（`frame-importer.ts`，同 sha256 快照幂等、行级校验 fail-closed、`--allow-partial`）、确定性归并 v0（`merge.ts`：LEI/注册号交叉引用 CONFIRMED，VAT/域名 PROPOSED，名称 trigram 只生成候选对）、域名解析接口占位（`domain/domain-resolver.ts`：search/ct/cc 三路 provider 契约 + fixture 实现）、召回审计计算（`recall-audit.ts`：Wilson 95% CI、分层确定性抽样、固定模板报告）、Prisma store（`frame-store.prisma.ts`，owner 连接）。
  - `scripts/frames/`：`import-frame.mts`（装载 CLI，支持 `--dry-run`/`--allow-partial`/`--propose-links`）、`recall-audit.mjs`（审计 CLI，Node 原生 type-strip 直接运行）、2 个 frame 配置 + 2 个 fixture（Companies House 风格 CSV、GLEIF 风格 JSON）+ 召回审计样例输入。
- 测试：vitest 覆盖 CSV/JSON 解析边界（引号/换行/BOM/缺列）、行级归一（状态/法律形式映射、LEI/VAT/域名非法即拒）、装载幂等（同文件重导零写入、变更检测、单次缺席不退出/两次才 WITHDRAWN、重现 REAPPEARED）、硬键归并（LEI CONFIRMED、namespace 隔离、identifiers 交叉引用、VAT/域名 PROPOSED、trigram 候选不自动合并、输入顺序无关）与 Wilson/抽样/报告；`scripts/frames/recall-audit.spec.mjs`（node --test）覆盖审计 CLI 的 census/抽样/落盘/参数失败；两个 fixture 通过 `import-frame` 端到端装载（内存 store）。
- 未做：真实注册库接入（T3-04 起）、MinIO 快照对象存储与 Temporal 工作流（T3-03 完整版）、Splink 概率归并（T3-16 后续）、Tier A 人工裁决与 run2 状态机接线（T3-20 后续）、域名候选的真实搜索/CT/CC 网络适配器（T3-11/T3-12 后续，本波只有接口 + fixture）。
