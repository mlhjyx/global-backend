---
date: 2026-11-04
title: Stop treating generic company words as social-profile company evidence
---

- 起因：r14 镜像验收（[r14 证据](../../evidence/2026-11-04-contact-run-acceptance-r14.md) §3）发现社媒层残留类——公司名本身是业务通用词（`technical.de` 的公司名就叫「Technical」）时，headline 只要含该词就满足公司佐证，把别家公司员工（标题含「at Redline Technical…」/「at Treefrog Cinegraphix」）收进联系人。
- 改动：社媒 L3 守卫把泛词（technical/industries/solutions/consulting/engineering/services…，含德语对应词）与有区分度的公司名 token 分开：泛词**单独命中不再构成公司佐证**；此时必须见到完整域名（边界匹配，拒绝 `technical.design` 这类同前缀 TLD）或多词公司名的完整短语才放行。丢弃计入新诊断 `social_generic_name_dropped`。
- 测试：`social-presence.provider.spec.ts` 新增 6 例（含 global_dev 两条存量残留行的 headline 回放，姓名/档案 URL 已虚构化）；`APP_DATABASE_URL= pnpm --filter @global/api test` 与 `gctl check --fast` 全绿。
- 未做：库中已收录的两条脏行不在本 PR 删除（存量数据，清理走 `cleanup-contact-false-positives.mts` 显式 id 流程，等产品负责人确认）。
