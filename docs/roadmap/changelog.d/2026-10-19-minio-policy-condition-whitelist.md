---
date: 2026-10-19
title: Whitelist the condition operators a MinIO policy may put on s3:prefix
---

- 起因：#659 把两条 `s3:ListBucketVersions` 授权改成 `ForAllValues:StringLike` 加 `"Null": {"s3:prefix": "false"}`，因为 MinIO 对重复的 prefix 参数，只要任一个值匹配就放行，而 ListObjectVersions 按第一个值列出。部署合同 spec 只用正则禁止了普通 `"StringLike"`，复审 NIT-3 指出 `StringEquals`、`StringNotLike`、`ForAnyValue:*` 同样只看任一值，却没有被禁。
- 改动：`scripts/runtime-deployment-contract.spec.mjs` 把 bootstrap.sh 写入的三份 IAM 策略（runtime、cleanup、personal）解析成 JSON，逐条断言以下几点（白名单，不再逐个写黑名单）：
  - `s3:prefix` 只能出现在 `ForAllValues:StringLike` 或 `Null` 下，`Null` 的值必须是 `"false"`；
  - 每条 Allow 的列出授权都同时带这两个条件；
  - 不列出任何东西的语句不准提 `s3:prefix`；
  - runtime 与 cleanup 各恰好一条列出授权，personal 没有。
  另加一条单测，逐个喂入五种其他运算符、缺 Null 守卫、Null 为 true、没有条件、给非列出语句加 prefix，都必须报违规。
- 测试：当前 bootstrap.sh 下 18/18 通过。在 personal 策略里多加一条用 `StringEquals` 或 `ForAnyValue:StringLike` 的列出授权：原来的 spec 0 失败、照样放行，新 spec 失败。把 runtime 那条授权的运算符改成 `StringEquals`、`ForAnyValue:StringLike`、`StringLike`，也都失败。
- 未做：#659 复审的 NIT-2（真 MinIO spec 的 `denied()` 只要 403 就算被拒）和「把真 MinIO spec 放进 CI」一起做，这样收紧后的断言每次都在真 MinIO 上验证。
