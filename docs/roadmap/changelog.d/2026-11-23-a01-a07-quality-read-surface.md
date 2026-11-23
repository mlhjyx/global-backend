---
date: 2026-11-23
pr:
title: Complete A01-A07 contact quality facts read surface
---

- 起因：已合联系人补强安全首片只暴露严格 closed 的 `PREREQUISITE_ONLY` 结果载体（V1），完整质量指标被固定为 null，无法按真实分母冷读 A01–A07 的存量/本轮/未解决/跳过事实；旧操作也没有可回读的同事务 before/after 证据。
- 改动：
  - 新增 `enrichment-quality-facts.ts`：在原始领域提交事务内，从已锁定的 contact_point 行、实际提交决定与该次新写入点的分类生成有界质量事实（before/after 四态、存量个人 VALID、组织渠道、类别不明、资格、新候选、本轮新有效、未解决）；不存地址/人名/凭据，不新增表或钱账。
  - 结果快照升级为 version 2：决策保持不变，旁挂同事务 `quality` 块；旧 version 1 快照保持不可用（不补写、不由当前点反推 before）。DSR 清理仍重写为空快照，质量事实随之一并清除。
  - 新增版本化只读面 `GET /canonical-companies/:id/contact-enrichment-quality-facts[/:operationRef]`（code-first，page10 keyset、no-store、统一 404、无 Grant/恢复/结算/wire）：完整时 `FULL_QUALITY_FACTS`，否则 `PREREQUISITE_ONLY` 且派生指标为 null 并列入 `unavailableMetrics`；唯一联系人分母，UNKNOWN 计入未解决而非 0。同名 V1 载体保持 closed `PREREQUISITE_ONLY`，不填 0、不改标签。
  - OpenAPI 快照重导出（新增 2 条路径，161→163）。
- 测试：质量事实纯函数、V2 parser/builder、域提交与 SQL 存储的质量块持久化/替换、V1 兼容 v2 快照、两个新 GET 的端口/权限/分页/404/PII 拒绝，以及 code-first Swagger 断言；safety 目录与两个 caller 套件共 452 项（437 通过、15 个真实 PG 套件按条件跳过），api build/typecheck 通过。
- 未做：未修改 A01–A07 运行时资格/缓存/状态机，未改动 V1 输出；未部署、未发车、不合并；真实 PG 双套件与全量 CI 由 PR 流程执行。
