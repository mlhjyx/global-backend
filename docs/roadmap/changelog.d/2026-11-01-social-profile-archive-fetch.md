---
date: 2026-11-01
title: Enrich social profiles from Wayback archives and live public pages
---

- 起因：M2a 的 social_presence 只读搜索索引标题；产品负责人 2026-10-31 拍板允许直爬无需登录的公开个人页（D1），并要求优先取档案副本，降低对目标站的依赖与共享出口 IP 的风险。另查明 M2a 在现网从未产出：`searxng.search` 按 personalData:false 把个人主页 URL 全部过滤，适配器拿不到任何候选。
- 改动：
  - 新工具 `social.search`（personalData:true、独立 `social-search/v1` typed projection、PERSONAL_DATA）：只返回公开个人主页（LinkedIn `/in|/pub`、Xing `/profile`）的 URL+标题，供联系人发现使用；`searxng.search` 的隐私契约保持不变。治理清单 18→19 个工具。
  - social_presence 适配器增加 L1 档案副本层（Wayback availability → http.get 读 web.archive.org 快照；只认 3 年内、200 快照，http 归一 https）与 L2 公开页直抓层（http.get 读 LinkedIn 公开页，HTML 清洗后经 contact.find_decision_makers 抽取职务/部门/邮箱），抽到的人必须同时命中候选姓名与公司名；Xing 访客页是 SPA 壳，只走档案层。
  - 每注册域 ≤1 req/3s 节拍器 + 连续 3 次目标站拒绝（403/429/999/登录墙）熔断 30 分钟；本地闸门/超时/网络错误不计熔断；熔断只门控直抓层，档案层不受影响。登录墙识别只收墙页独有短语（未登录页面的 "Join now"/"Anmelden" 导航不再误判）。计数经 stats.contacts.diagnostics 进 run 统计。
  - 修复联系人发现的两个静默空结果缺陷：core 未传 artifactSubject，crawl4ai.fetch/http.get（subject-bound）会被 Broker 持有；回执生产者名单缺 social.search/http.get，adapter 的 onDurableReceipt 会抛 DOMAIN_ACK_CONSUMER_BINDING_MISSING 并被吞。
  - 抽取管线（contact.find_decision_makers 的 prompt/durable schema）抽成 contact-extraction.ts，decision_maker 与 social_presence 共用；姓名/邮箱/电话在适配器内先本地校验（乱码邮箱只丢邮箱、不丢整条联系人）。
  - source_policy 种子新增 linkedin.com / de.linkedin.com / xing.com（REVIEWED_RESTRICTED，负责人接受的 robots 例外域）与 archive.org / web.archive.org；`decision-maker-multi-source-spec.md` 合规红线按 D1 改写；设计稿 D1–D8 全部拍板并入库 `docs/superpowers/plans/2026-10-31-contact-discovery.md`（APPROVED）。
- 测试：social-presence 18 用例（快照新鲜度/登录墙误报/HTML 实体/同名跨转写/档案与直抓流程/熔断归因/节拍/无抽取器跳过）+ 新工具 social.search 3 用例；全量 API 单测通过（1 个 revocation 时间边界用例首跑负载假红，单跑通过）；execution-authority-policy 19 工具/41 callsites PASS。
- 部署：无迁移。上线后 worker 启动 seed 会把 social_presence 置 ENABLED（现网尚无该行）；联系人阶段需要 `decision_maker` provider config 的 lawful basis（2026-11-01 已按全局 interim 写入）。**上线前实证**：验证 run 7b887405（现网镜像，仅含 M1）联系人阶段 8/8 公司失败，worker 日志全部为 `tool crawl4ai.fetch denied: GENERIC_OPERATION_ARTIFACT_SUBJECT_BINDING_HOLD`——本 PR 的 artifactSubject 修复正是为此；部署后须重跑验收。
- 未做：L1 的 Common Crawl 索引来源；跨进程（API+worker）共享的 Redis 节流/熔断（当前为进程级，最坏 2×3s 节拍）；D5「每家 ≤6 页」的跨适配器强制（decision_maker 4+首页、社媒 4，最坏 9）；D2 的 trade_fair 开关翻转（数据库 ops，另行执行）；google_patents 启用（等 patent cache 验证与刷新计划恢复）；D7 联系人独立预算账户；D8 OSS sidecar（theHarvester/social-analyzer）。
