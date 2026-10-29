---
date: 2026-10-29
title: Make provider-billing settlement readback opt-in and acquisition model names configurable
---

- 起因：获客网关换成新的 new-api 中转站后，产品负责人决定**不再读取中转站的账单结算**（原来 Site Builder 的按请求结算回读是 API/Worker 的硬就绪门，缺凭据就整体不就绪）；同时获客任务把模型名写死在代码里，换模型要改代码发镜像。
- 改动：
  - 结算回读改为**部署级可选能力**：`MODEL_GATEWAY_SETTLEMENT_READBACK_CREDENTIAL` 缺失即视为未启用——`runtime-admission` 的网关检查、`checkSiteBuildSettlementReadbackReadiness`、worker 与快车道 worker 的 catalog / readback 就绪保持全部跳过；凭据存在而 keyring/catalog 缺失时仍 fail-closed。未启用时付费 Site Builder 的**模型调用**在调用点拒绝（`PERSISTENT_LEDGER_UNAVAILABLE`），不会静默不结算；付费**工具调用**仍走本地 provider-wire 账本预留（建站自 9-23 冻结，这是已知限制，重新启用结算回读后恢复对账）。worker 的 provider-wire 数据库是本地账本、与账单回读无关，仍是 worker 的启动前提，就绪检查保持无条件要求。
  - 获客模型改为环境变量：`MODEL_ACQUISITION_MODEL`（抽取/分类档，默认 `deepseek-flash`）、`MODEL_ACQUISITION_REASONING_MODEL`（ICP 设计、fit 判定、查询计划、开发信草稿，默认同样 `deepseek-flash`）；身份闸门语义不变，上游必须回报所请求的模型或命中的已批准替换。
- 测试：`src/runtime` 与 `task-registry` 套件 308 项通过；新增「未配置即跳过」「部分配置仍失败」两类用例；`pnpm --filter @global/api build` 零类型错误。
- 未做：未删除 Site Builder 结算模块本身（未启用的能力仍可后续重新配置启用）；本次不改迁移与数据库。
