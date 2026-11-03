---
date: 2026-11-03
title: Strip German academic titles before contact dedupe and require role evidence on social profiles
---

- 起因：M5 第三轮 Golden Set（`docs/evidence/2026-11-03-contact-golden-set-m5.md` §9）确认三类质量问题：德语学位串 `Dipl.-Wirt.-Ing.` 让同一人两条记录各占一行；社媒索引候选只要 headline 含公司名就放行，`gerry garry - Abendi` 这类「公司名之外无职位词」的垃圾档案漏网；第一轮遗留的 9 条存量误报只增不减。
- 改动：
  - `person-name`：身份归一的学位串白名单补齐德语多段学位（`Dipl.-Wirt.-Ing.`、`Dipl.-Kfm.` 等），带点的单 token `Ing.` 仅在名前位置剥离；`normalizePersonName` / `personNameKeyVariants` / `foldedPersonNameKey` 与 resolver 的 Tier 2 随之收敛，真实姓名 token（`Erik Ing`、`Anna Wirt`）不误伤。
  - `contact-extraction.cleanPersonName`：抽取边界复用同一剥离函数，落库姓名为净化后的形（顺带消除 `diplwirting.havlicek@…` 这类被称号污染的邮箱猜测）。
  - `social-presence`：`parseSocialResults` 在 #744 的公司佐证之外新增「专业佐证」门——headline 去掉人名与公司 token 后必须仍有职位/职能词，否则丢弃并记 `social_uninformative_dropped`；德语复合职位词（`Einkaufsleiterin`）按词内子串识别。
  - `apps/api/scripts/cleanup-contact-false-positives.mts`：一次性按显式 contact id 删除存量误报/重复行，默认 dry-run，`--apply` 才执行，禁止删除带 VALID 联系方式的行（除非显式放行）。
- 测试：`person-name` / `person-identity` / `contact-extraction` / `social-presence` 新增用例覆盖称号合并两方向与垃圾档案计数；单测与 `gctl check` 见 PR。
- 未做：同名异公司的公司级消歧（#744 已记为后续）；存量清理的 `--apply` 属产线动作，等用户确认后执行。
