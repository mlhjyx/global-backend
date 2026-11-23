---
date: 2026-11-24
pr:
title: Seller document claim S1a review follow-up — cleanup definer binding, recovery and consumer negatives
---

- 起因：S1a 合并后技术审阅列出八项发现：内部清理 DEFINER 未绑定调用者租户、FAILED 无计数清理不可恢复、清理快照可超过 SQL 的 Claim 上限、ICP 来源复验与业务写入未串行化，以及固定消费者缺少真实 app_user 的负向反证（项 2/6/7 已在产品回修 `5edce740` 修复）。
- 改动：
  - 追加迁移槽 `20261124020000_seller_document_claim_s1a_followup`（原 `20261123110000` 不变）：清理 DEFINER 在任何读取前要求 `current_workspace_id()` 非空且与参数一致；接受 `FROZEN/ERASING/FAILED` 以恢复无计数失败，并拒绝已持久化计数或未软删文档的请求；Claim 目标先与指向冻结文档的 `claim_document_evidence` 求交，快照内外来 ID 不再扩大擦除；claim/evidence/refs 与 knowledge_source 按 100 行分批，移除 512 Claim 上限导致的不可收敛。
  - ICP：来源复验与业务写入之间在 `document-claim-basis` 新增共享锁序（company → 从引用行重读的活文档 → 排序 Claim），持锁复验后再写；真实双连接屏障证明并发 softDelete 被阻断、先失效则返回 `ICP_DOCUMENT_SOURCE_STALE` 且不落 ICP。
  - 固定消费者负控：新增 `document-claim-gated-consumers` 真 PG 套件覆盖外联草稿 prompt、campaign 输入与理解预览的显式排除及 ICP 两个并发用例；generation 自动选源排除文档 Claim、显式选择 400；market-candidate-sets 文档 Claim 源先 `CURRENT` 后 `UNAVAILABLE`；有效 loader/binding 断言切到真实 app_user。
- 测试：真实 PostgreSQL/app_user 套件 20/20 + 5/5 + 37/37 + 50/50；相关单测 15 套件 239/239；`nest build`、改动文件 ESLint、gitleaks 与 `gctl check --fast` 通过；对三处排除条件、ICP 锁/复验、generation 过滤、market-candidate-sets 门、DEFINER 调用者绑定/FAILED 可达性/已计数守卫/软删守卫/Claim 交集共 10 项做变异反证，目标用例逐一转红后还原。
- 未做：未改公共错误码/事件/端点语义；未重复项 2/6/7 的产品改动；未部署、未合并；公共 DSR 主体扩展与 S1b UI 不在本片段范围。
