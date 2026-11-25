---
date: 2026-11-25
pr:
title: "feat(enrichment): 根治盲猜占位、升级 Hunter/Prospeo 商业验真并修复 Run 2.0 脏数据与空跑"
---

- 起因：现网实测中 `email_guess` 将未通过 SMTP 验真的 `pattern_guess` 写入 `contact_point`（61 条 0% 验真），反向阻塞了商业查邮目标选择与提交冲突检查；Hunter 仍调用 `/v2/domain-search?limit=10` 导致欧洲中小买家 0 命中；Prospeo v2（`only_verified_email: true`）虽已配好密钥但未接入受控安全通道；Run 2.0 快扫 `mismatch` 未同步回写历史临时 Lead，且官网画像失败与 `weak` 线索仍空耗深挖联系人抓取时间。
- 改动：收口 `email-guess-persist.ts` 仅落库 SMTP `verified` 结果；升级 `HunterProvider` 至 `/v2/email-finder`；在 `guarded-http.ts` 与受控安全通道全链路接入 `contact_email.find.prospeo`（`contact-email-find-prospeo/v1`，含 `POST /enrich-person` 单线纪律、账本/工件/回执/报价目录、无 `VALID` 邮箱目标重放及 Prospeo 已验真结果提交，并按流程重钉 `tool-broker.ts` sha256）；在 Run 2.0 中同步清理 `mismatch` 临时 Lead 并为画像失败及非 `match` 线索加上版本化深挖门控。
- 测试：全量 `@global/api build`、受影响的 `email-guess-persist` / `hunter.provider` / `prospeo.provider` / `contact-enrichment-safety*` / `durable-results` / `execution-budget` / `discovery.run2*` 单测、以及 `execution-authority-policy` / G9 / G16 / `docs:verify` / `gitleaks` 治理快门全绿。
- 未做：待与 PR #1105 合并发版后在现网对历史 61 条未验真盲猜记录与 ~30 家无关行业旧线索做清洗，并对琏升真实光伏买家实测商业查邮验真。
