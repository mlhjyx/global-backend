---
date: 2026-11-04
pr:
title: Add the Run 2.0 deep-dive pipeline (per-company child workflows, stop-deep via RequestCancel)
---

- 起因：快扫产出的候选要在可停止、可续的前提下逐家深挖（设计 §6.3/§12：并发 16、上限 500、停止 60 秒内生效、已完成结果保留）。
- 改动：
  - 新子工作流 `companyPipelineWorkflow`：每家公司 profiling → fitting（mismatch 提前收工）→ signals → contacts → done，每步写 `discovery_company_job.stage` 与 `run_event`；单家失败只标 failed，不拖垮整轮。
  - 新单公司活动（不依赖本 run 的 raw lineage，直接以 canonical 公司为对象）：`profileCompanyOnce`（官网画像/Impressum，复用 durable receipt 与治理门）、`fitCompanyOnce`（四门精判）、`signalsCompanyOnce`（7 天 TTL、SUSPENDED 跳过）、`contactsCompanyOnce`（决策人 + 可选邮箱补全，带 Q25 访问审计）。
  - 父工作流深挖阶段：子工作流滚动窗口并发 16、目标上限 500；`POST /discovery-runs/:id/cancel` 用 RequestCancel（机器身份许可范围内）停止深挖——未完成公司标 skipped(DEEP_STOPPED)，run 以 CANCELLED 收尾，下一次 run 重新排队（可续）。
  - `finalizeRun`/`attestRunFinalization` 接受 CANCELLED；OpenAPI 新增 cancel 端点。
- 测试：子工作流编排单测（阶段顺序/mismatch 提前收工/单家失败隔离/取消传播）、父工作流深挖与取消单测、cancelRun 端点单测、全量 API 单测；spectral lint 通过。
- 未做：影子模式与默认切换（M0⑥）；深挖阶段独立子预算（沿用 run 账户）。
