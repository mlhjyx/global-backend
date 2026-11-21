---
date: 2026-11-21
pr:
title: Recover scored quick provisional leads for the same ICP
---

- 起因：正常 quick 临时候选被确定性评分迁至 REVIEW 后，原候选池与 provisional 更新仅接受 DISCOVERED，导致未完成深判的候选无法恢复。
- 改动：保留原 DISCOVERED 分支，只为 REVIEW、needs_review、fitReasons.source=quick_scan、fitReasons.tier=quick 同时成立的记录增加共享判定；候选池读取与 provisional updateMany CAS 继续使用同一函数。
- 测试：旧源码在全新隔离 PostgreSQL 上复现 poolSize=0 且 provisional 更新数为 0；修复后相关 4 文件 84 项通过，pool.ts 专项行/语句/函数/分支覆盖均 100%。覆盖真实 producer→scoreCandidates→REVIEW→pool/CAS、其他状态/队列/source/tier、跨 workspace/ICP、最终判定与制裁/人工路由竞态，以及采购准入与原 DISCOVERED 语义。
- 未做：未更改 schema、资格/采购门、Provider、来源配置、真实业务记录或已冻结执行意图；未调用模型/外部来源、部署或发起新运行。
