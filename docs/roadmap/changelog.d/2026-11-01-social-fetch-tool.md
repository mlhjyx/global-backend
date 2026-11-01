---
date: 2026-11-01
title: Fetch social-layer pages through a dedicated typed-projection tool
---

- 起因：第六班验收 run `1c233bb6` 在联系人阶段以 `GENERIC_OPERATION_ARTIFACT_INVALID` → `BudgetOperationReplayError` 失败——社媒适配器用 `http.get` 抓 Wayback availability（带 `?url=` 查询串）与快照页（14 位时间戳、大小写混合路径），而这两类工具是 subject-bound artifact，其持久化 URL 契约（无 query、纯小写、数字 <9 位）由 `artifact-expected-facts.ts` 强制，社媒目标 URL 天生违反。单测 mock 了 broker，无法暴露。
- 改动：
  - 新工具 `social.fetch`（typed projection `social-fetch/v1`，PERSONAL_DATA，`{url,status,text≤36k 字符}`，目标主机白名单 = Wayback + LinkedIn/Xing 个人页）：社媒层三条抓取（availability JSON、档案快照、直抓）改走它，不经工件层；`perDomainCrawlDelayMs=3000` 由 broker 的 Redis limiter 执行，因此移除适配器内的进程级节拍器（熔断保留，仍为进程级）。
  - 治理同步：工具清单 19→20、callsite 清单 social-presence 的 3 条 `http.get` 改为 `social.fetch`（总数 41 不变）；`contact.find_decision_makers` 的 allowedTools 以 `social.fetch` 替换 `http.get`；回执生产者、domain-ack 绑定、durable-result-strategies、catalog projection（含边界夹具与顺序锁定）、policy 常量与 spec 全部更新。
- 测试：新工具 4 用例（主机白名单/文本界限/egress 拦截/投影往返）；social-presence 用例改 mock 为 `social.fetch`；全量 API 单测通过；execution-authority-policy 20 工具/41 callsites PASS。
- 部署：无迁移。上线后需重跑联系人验收（上一轮 5 名具名联系人已落库——2 家公司 Geschäftsführer/技术销售带邮箱+电话——失败只发生在有社媒候选的公司）。
- 未做：旧验收 run 中已产生的 `BudgetOperationReplayError` remnant 会按 #684 的残留吸收逻辑在后续请求中自然消化；跨进程熔断仍为进程级（记录在案）。
