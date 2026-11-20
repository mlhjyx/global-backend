---
date: 2026-11-20
pr:
title: Add signed and receipt-backed manufacturer relationship corroboration
---

- 起因：仅官网画像不足两个来源分层，厂家独立详情可补充经销关系，但不得从搜索摘要、不同域名或普通 attributes 伪造行业证明。
- 改动：显式 `manufacturer-network/v1` 执行快照进入请求哈希、报价、outbox、relay、Workflow 与活动；新报价额外计 50 次定向查询、50 次精确详情抓取，八字段 Binding 与 workflow version 2 不变。新增默认 DISABLED 厂家 adapter，逐源/路径/用途审核、逐目标控制独立性、真实 Broker 回执与持久 manifest/Subject 同事务绑定。只从本 run 受控不可变记录装配 T2，判定引用严格绑定该页 spans；保留原 manifest 采集与到期时间。短 canonical 名仅可用逐目标审核所引用的独立 FieldEvidence UUID/原值 UTF-8 摘要补充精确法人名；同租户/主体、green、许可/match、时效及目标自域/已审登记源全部重验，不改 canonical，不做模糊或子串身份匹配。
- 测试：包含旧 Grant、错 revision/快照、来源/主体/权限/时效负例；真实 Broker、PG 预算/manifest/Subject/ACK/写回/实际 v2 判定与事务故障重放验证。最终执行命令、覆盖率及限制见本任务实施报告。
- 未做：无真实企业/provider/模型调用、生产配置或账本改动、部署、SaaS 合同消费者升级、业务数量或人类验收。厂家来源仍须独立审核配置后才能启用；INOXPA 共有导航不能构成经销关系证明。
