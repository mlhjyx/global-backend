---
date: 2026-11-18
pr:
title: Pass the company finder remaining cap down to the single-contact core
---

- 起因：公司级富集核心只按公司帽在联系人之间做门，却把单人 core 的 finder 上限固定为 3；四人各三家全 miss 时前三人买 9 次后末人仍能再买 3 次，越过平台默认每公司 10 次的形状上限。
- 改动：
  - `enrichCompanyContacts` 的公司 finder 帽改为 `min(传入帽, MAX_ENRICH_FINDER_CALLS_PER_COMPANY)`，传入更大值不再放大上限。
  - 调单人 core 时透传 `maxFinderAttempts = min(剩余公司余额, maxProvidersPerContact ?? MAX_FINDER_ATTEMPTS)`；减记仍用单人 core 真实 `finderAttempts`，不事后 clamp。
  - 单人 core、资格 selector、缓存 fallback、provider 顺序、A 档阈值、预算/来源/身份/金额框架、schema、锁与 API 均未改。
- 测试：`enrich-company-contacts.spec.ts` 新增四人×三家 RED/回归、公司帽夹紧、小帽取最小、gate 关闭/熔断/INVALID 缓存交错、budget0/抑制/无配置/deadline 零出网、A 档尾池、真实 core+真实 adapter 计数 fake fetch 与旧序列有序子序列断言；零真实出网、无 DB/模型调用。
- 未做：真实 vendor/付费/数据库/运行服务未验证；金额预留与 unknown 持久恢复仍按原任务保留，未据此宣称完整 A 包或部署通过。
