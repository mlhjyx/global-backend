---
date: 2026-11-05
title: Engine contract for the platform.channel_crawl execution-budget purpose (P4-P1)
---

- 起因：产品负责人 2026-11-04 批准的「平台抓取预算 purpose」决定（实现记录 `docs/implementation-records/platform-channel-crawl-budget-authority.md`，#785）进入分段实施；本 PR 为第一段（引擎契约）。渠道抓取与 M2 watches 刷新共用 `platform.channel_crawl`，必须走既有 quote → PLATFORM_GRANT → egress fence → ACK 全链，无 Grant 一律拒绝。
- 改动：两段式迁移——先 `ALTER TYPE execution_budget_purpose ADD VALUE 'platform.channel_crawl'`，再扩展形状：`execution_budget_authority` 新增 `crawl_run_id` 列，`kind_shape_check` 与 `platform_run_binding_check` 增加独立的 channel-crawl 分支（schedule 四行不变量逐字节保持），新建唯一索引 `platform_crawl_run_key`；新摄入函数 `ingest_and_admit_platform_channel_crawl_run_v1`（绑定 `request_sha256`（channelId+mode+pageCap 的 canonical 摘要）+ `crawl_run_id` + `technical_policy_revision`，账户键 `platform:<request>:<crawlRun>`，仅 `execution_budget_platform_writer` 可执行）。verifier/types/contracts 同步：闭合 claim 集合增 `request_sha256`/`crawl_run_id`，签名 claim schema 改为 if/then 双形状（schedule 形状必填四字段、crawl 形状禁 schedule 字段），`assertAuthorityPurposeShape` 增 crawl 分支且不放松 schedule 分支。
- 测试：`execution-budget-authority.types.spec`（crawl 接受/13 组负向/「schedule 带 crawl 字段」拒绝）、`execution-budget-grant.verifier.spec`（真实签名 crawl token 接受、10 组形状负向、4 组期望作用域不匹配）、`platform-authority-ingestion.service.spec`（双形状契约与跨形状混合拒绝）、新迁移静态契约 6 用例；一次性库实测：整链迁移 + 以 platform writer 调新函数成功开户、JTI 重放 replay=true、schedule 形状 token 走新函数被拒。
- 未做：策略矩阵新版工件（P4-P2，属安全方向变更，需独立 review 后另 PR）、gain-saas 签发端点（P4-P3）、抓取工作流与 409 切换（P4-P4）。`ingest_and_admit_platform_execution_budget_run_v2` 与 4 个平台 schedule 的摄入路径未改动。
