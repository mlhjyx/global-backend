---
date: 2026-11-10
title: Add DISCOVERY_UNCAPPED to replace product caps with safety bounds
---

- 起因：2026-11-10 产品负责人拍板「预算不由平台决定」——挖掘的产出被平台产品帽（每查询每源 25 条记录、run 总池 500、每源每轮 ≤100 家公司、快扫池 500、模型联网搜索工具环 6 轮/10 次、联系人阶段整轮 $2）钳制，与客户充值余额无关；计划 `docs/superpowers/plans/2026-11-10-deep-acquisition-vnext.md` §3 W1。
- 改动：
  - 新增开关 `DISCOVERY_UNCAPPED`（默认 off，畸形值回退 off）：off 时行为逐字节不变；on 时上列产品帽改为**防爆安全界**，各由 env 可调（`DISCOVERY_MAX_PROVIDER_RECORDS` 默认 1000、`DISCOVERY_RUN_POOL_CAP` 默认 10 万、`DISCOVERY_STRUCTURED_SOURCE_RUN_CAP`/`DISCOVERY_TRIAL_*` 默认不再裁剪、`DISCOVERY_QUICK_SCAN_POOL_LIMIT` 默认 5 万、`DISCOVERY_MODEL_WEB_SEARCH_MAX_ROUNDS/TOOL_CALLS` 默认 24/100），默认值远高于客户余额可支付量级。
  - 真正的收紧条件落到执行预算：quote 只给估算包络上界，签发侧按 Grant cap = min(估算包络, 客户可用余额) 钳制（引擎 quote 合同刻意不含商业字段），引擎账本逐次 reserve/settle，余额耗尽是唯一停止条件；联系人阶段整轮 $2 产品帽在去帽模式下退场，仅保留每家 $0.20 安全界。
  - 去帽模式下计划提示的配额话术改为余额准入语义；每源查询预算默认换算回 66 条（= 全部计划查询数），不再先于余额裁剪查询副本；executionLimits 增加 `discoveryUncapped: 1` 审计标记（off 时字段缺席）。
  - 限流与出口治理（ToolBroker source_policy、rate limit）不随开关变化。
- 测试：新增/扩展 execution-envelope、run-pool-cap、plan-query-sources、quick-scan、model-web-search、contact-discovery-budget、workspace-technical-budget-envelope 各 spec 的 off/on 双态断言（off 断言与既有精确数字一致；on 报价数字按真实运行填写）。
- 未做：存量计划 `2026-11-05-cheap-first-provider-routing.md` 中的产品帽口径未回改（由 vNext 计划 §5 裁决取代）；开关默认 off，部署后由验收会话确认余额闸链路再开启；gain-saas 侧余额钳制（min 的余额一半）不在本仓库。
