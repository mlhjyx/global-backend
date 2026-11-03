---
date: 2026-11-03
title: Record FAILED discovery runs even when the workflow stopped before folding stored query receipts
---

- 起因：2026-11-03 的真实寻源 run（fdb7778d）在查询批量里一个查询 429 失败、另一个已成功并落收据；工作流按计划顺序先处理失败查询并停止，已成功查询的收据没被折叠进 FAILED 收尾统计，收尾的一致性核对报 `DISCOVERY_QUERY_RECEIPT_FINALIZE_DRIFT` 三次后工作流失败，run 行永远停在 RUNNING。
- 改动：① 批量循环先折叠全部成功查询、再处理失败（失败仍停止 run，命令序列不变）；② `finalizeRun` 对 `status='FAILED'` 以库内已落盘收据为准补齐派生统计，不再因工作流侧不完整而拒绝写入——成功/部分成功路径的严格漂移校验保持不变；③ 相应收紧/更新 BI-25 的单测语义（未见的收据现在随 FAILED 记录，阶段错误照常上报）。
- 测试：新增工作流级用例（批量中一个失败、一个成功 → FAILED 统计含已落盘收据）与收尾级回归用例（FAILED + 空 perQuery 仍记录派生收据）；`discovery.activities`（300 例）、`workspace-authority.workflow`（90 例）通过；全量单测 10672 通过，余下 browser-readiness-probe/platform-revocation-http/git-reviewed-evidence 的单文件复跑均通过（xin 负载假红，CLAUDE.md §6）。
- 未做：不改变成功路径的收据一致性语义；未给失败的 run 增加自动重跑；`DISCOVERY_QUERY_RECEIPT_STORE_INVALID` 等存储损坏仍按原样拒绝。
