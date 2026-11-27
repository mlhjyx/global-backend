---
date: 2026-11-27
pr:
title: 修复旁路模式寻源入池清零、模型超时未降级及裸漏 500 问题
---

- 起因：现网暴露两项获客主线阻塞：① `LEGACY_EXECUTION_BUDGET_MODE=bypass` 下 L0 召回按 `legacy` 模式落库 `raw_source_record` 而不写旧 RS256 授权回执 `discovery_query_receipt`，但 `canonicalizeRun` 仍强制走 `admit_discovery_company_materialization_v1`，导致召回 231 家后立即抛 `DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INCOMPLETE_HOLD`、入池 0 家、整轮 FAILED；② `icp.design` 调 `new-api` 非流式主模型遇上游卡死 169.6s 触发 180s `TimeoutError` 时，旁路模式未自动切备用通道，且 `TimeoutError` 裸漏 500 `INTERNAL`、日志缺失错误名与堆栈。
- 改动：在 `discovery-company-materialization.ts` 中与 `discovery-query-governed-execution.ts` 对齐，旁路模式下校验合约绑定后直接复用 `canonicalizeLegacyDiscoveryRun` 完成去重归一、抑制核验与证据入池（`enforce` 模式保持受治理 C-TX 门禁不变）；在 `structured-task-runtime-bridge.ts` 中为旁路模式有跨通道备选模型的主调用设置 100s 首跳超时并支持 `TimeoutError` 自动切换备用通道；在 `model-upstream-http-boundary.ts` 中将 `TimeoutError` 映射为 `502 MODEL_UPSTREAM_UNUSABLE (MODEL_UPSTREAM_TIMEOUT)`；在 `http-exception.filter.ts` 中安全读取原生 `DOMException` 的 `name`/`message` getter 与应用堆栈。
- 测试：`discovery-company-materialization.bypass.spec.ts`、`discovery-company-materialization.activities.contract.spec.ts`、`structured-task-runtime-bridge.spec.ts`、`model-upstream-http-boundary.spec.ts`、`http-exception.filter.spec.ts`、`pnpm --filter @global/api build` 及全套文档/治理门禁通过。
- 未做：未修改 `enforce` 模式下的受治理物化门禁与 D13 确定性故障判定；本地展会库与付费数据源开启通过宿主机配置与 `data_provider` 状态控制。
