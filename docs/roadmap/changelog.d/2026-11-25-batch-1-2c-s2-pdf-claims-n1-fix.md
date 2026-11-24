---
date: 2026-11-25
pr: 1094
title: "feat(claim): Batch 1.2-C 消除文档 Claim 事务 N+1 风暴与 S2 PDF 辅助事实抽取"
---

- 起因：`document-claim-basis.ts` 的 `effectiveApprovedClaimsInTransaction`、`documentClaimDependenciesStillCurrent`、`currentDocumentClaimDependencies` 与 `claim.service.ts` 的 `listForCompany` 在单事务内按 Claim 逐条串行查库（4N–6N 次查询）；`Claim.statement=null`（源失效时脱敏态）在文档 Claim 校验辅助函数缺少显式保护；同时 S1a 强类型文档原句引用之上缺少 S2 辅助 PDF 事实抽取能力。
- 改动：
  - 在 `apps/api/src/claim/document-claim-basis.ts` 新增常量次（≤4 次 `findMany`）批量绑定校验函数 `loadDocumentClaimBindingsInTransaction`，抽离共享纯校验器 `verifyLoadedDocumentClaimBinding`，将 `effectiveApprovedClaimsInTransaction`、`documentClaimDependenciesStillCurrent`、`currentDocumentClaimDependencies` 与 `claim.service.ts` `listForCompany` 全部收敛为 O(1) 批量查询（同时保持对极简单元测试 mock `tx` 的安全回退）；
  - 为 `hasValidDocumentClaimApprovalAudit`、`loadDocumentClaimBindingInTransaction` 与 `loadDocumentClaimBindingsInTransaction` 补齐 `Claim.statement: string | null` 零异常保护（null 陈述一律判无效，绝不抛错）；
  - 新增 `apps/api/src/seller-knowledge/seller-document-claim-extractor.ts` 并在 `SellerDocumentClaimsService` 接入 `suggestClaimCandidates` 与 `createAssistedDrafts`，支持多语种 B2B 核心事实维度（认证/参数/产能/起订量/交期/市场/企业概况）确定性抽取与可选模型建议复核——每条候选均经 `locateQuoteByteRange` + `documentClaimQuoteBytes` 服务端 UTF-8 字节边界验证，未锚定原句的建议一律丢弃，且落库严格走 S1a `createInTransaction` 停留在 `NEEDS_REVIEW`（绝不绕过人工审批与 proofVersion=4）。
- 测试：新增并全量通过 `document-claim-basis.spec.ts`（常量查询次数、N=8 批量验证与 `statement=null` 单测）、`claim.list-document-source.spec.ts`、`seller-document-claim-extractor.spec.ts` 及全部 `claim`/`seller-knowledge` 回归套件，通过 `G9/G15/G16/G17`、`execution-authority-policy`、`nest build`、`lint`、`docs:verify`、`benchmark:discovery` 与 `gitleaks`。
- 未做：Batch 1.3 的反 `info@` 4 轨决策链穿透、合规多通道外联与 Ring-1 P0 安全/GDPR/配额封堵归入下一批次；宿主机 env 迁移与运行镜像发布待 Batch 1.2/1.3 合并后统一推进。
