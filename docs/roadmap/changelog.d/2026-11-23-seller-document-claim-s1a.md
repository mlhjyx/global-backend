---
date: 2026-11-23
pr:
title: Seller document typed review claim seam S1a
---

- 起因：卖方文档原句只能经自由文本或 Site bridge 进入 Claim；缺 typed 文档来源引用、精确 quote 绑定、审批 proof 与固定消费者的当前有效性门，删除也停留在软删。
- 改动：
  - 新增 `claim_document_evidence`（唯一迁移槽 `20261123110000`）：document/parse/chunk/quote 字节精确引用、binding/request 摘要、FORCE RLS、app_user 仅 SELECT/INSERT、document live FK 列级 SET NULL 不清 workspace/company；`seller_document.parse_revision` 随新 chunks/metadata/ready 同事务递增，旧 ready 完整文档迁移回填首个修订。
  - 新增 `GET chunks` / `POST claim-previews` / `POST claim-drafts`：服务端重读文档/分块与 UTF-8 边界、重建 quote/bindingHash/requestDigest；草稿首写必为 NEEDS_REVIEW，同来源/陈述跨请求者重放原件，异体 409。
  - 审批/拒绝/撤销文档分支：`expectedVersion` 必填，proofVersion 4 绑定人审身份/时刻/版本与精确引用；数据库 guard 保留 Site bridge 与 v3 proof 路径，仅 origin-only 文档 Claim 走 v4。
  - 固定消费者：ICP 用同一有效 loader 并携 typed 依赖；generation/outreach/campaign/understanding-preview 显式拒绝或排除文档分支；market-candidate-sets 校验当前绑定与摘要（仅文档 Claim 纳入 bindingHash，旧非文档来源摘要字节不变）；Claim 列表在来源不可用/失权时只给状态与审计事实，statement 一并置 null 不再渲染可能等于原句的历史文本；当前来源有效的 NEEDS_REVIEW 草稿仍可按当前绑定读到原句，但审批消费门独立拒收未批准草稿；Site 桥不接收文档 ref。
  - 内部 `seller_document` 清理：复用 DeletionRequest/Receipt/outbox，冻结目标 ID 快照、受限 DEFINER 分项擦除、blob 失败保留 ERASING/FAILED 与真实残留，完成后写 typed 回执明细与 `SellerDocumentCleanupCompleted` 事件；公共 DSR 主体闭集不变。
- 测试：真实 PostgreSQL/app_user 套件 11 项覆盖 typed 生命周期、变版/失权/删除、RLS/授权、FK SET NULL、迁移 checksum/列回读、清理分项/幂等/blob 残留与受审 definer 拒绝；产品回修补列表来源状态/statement 撤下与 NEEDS_REVIEW 当前可读、非文档摘要兼容三条用例（单元 6 项 + 真 PG 断言）；受影响的 claim/ICP/generation/outreach/campaign/understanding 单测通过。
- 未做：SaaS UI/BFF（S1b）、S2 抽取/模型/费用、公共 DSR 主体扩展、部署与运行切换。
