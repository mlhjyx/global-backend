---
date: 2026-10-19
title: Whitelist the condition operators a MinIO policy may put on s3:prefix
---

- 起因：#659 把两条 `s3:ListBucketVersions` 授权改成 `ForAllValues:StringLike` 加 `"Null": {"s3:prefix": "false"}`，因为 MinIO 对重复的 prefix 参数，只要任一个值匹配就放行，而 ListObjectVersions 按第一个值列出。部署合同 spec 只用正则禁止了普通 `"StringLike"`，复审 NIT-3 指出 `StringEquals`、`StringNotLike`、`ForAnyValue:*` 同样只看任一值，却没有被禁。
- 改动：`scripts/runtime-deployment-contract.spec.mjs` 不再解析 bootstrap.sh 的文本，而是在沙箱里真实执行它（只把 `/config/`、`/tmp/` 改到沙箱），换上一个假 mc：它只应答一次正常 provisioning 会发出的调用，其余一律以 97 退出；在 `mc admin policy create` 那一刻保存它收到的策略文件。断言落在 MinIO 实际会收到的东西上：
  - IAM 面的调用（`admin`、`anonymous` 等）按顺序恰好是三条 create、三条 user add、三条 attach、三条 user info；多一条 create、attach、匿名访问、续行或缩进写出的命令都会让清单不等或让假 mc 报错。
  - 每个策略名在 create 时收到的文件必须是一份 JSON，顶层键恰好是 `Version` 与 `Statement`（MinIO 解析键名不分大小写、重复键取后者，所以 `statement` 能盖掉 `Statement`）。
  - 三份策略合起来过白名单：「列出授权」按 MinIO 允许带 `s3:prefix` 的动作（`s3:ListBucket`、`s3:ListBucketVersions`）用 `*` / `?` 通配判定；语句只能是 Allow + Action（+ Resource、Condition）；`s3:prefix` 只能在 `ForAllValues:StringLike` 或 `Null`（值为 `"false"`）下；每条列出授权两者都要带。
  - runtime 与 cleanup 的列出授权按名称逐字比对（`deepEqual`），personal-read 没有列出授权、也不提 `s3:prefix`。
- 测试：当前 bootstrap.sh 下 18/18 通过，happy path 真实跑到 `OBJECT_STORAGE_PROVISIONED`。两轮独立复审找到的 31 种绕过逐一回放，全部失败，并抽查确认是被预期的那条断言拦下：通配动作、NotAction、shell 展开与转义、换写法或重复写入的策略、`statement` 等大小写变体、缩进 / 续行 / `command mc` / 双空格写出的 create、if 块里的文件路径、对调两条 create 的文件参数、heredoc 之后用 printf / cp / 变量重赋值改写、附加额外策略、`mc anonymous set`、heredoc 终止符带尾随空格注入 `$(…)`、注释里放诱饵文本。单测对每个反例断言完整的违规清单。
- 未做：没有用 MinIO 自己的解析器做差分（复审用 minio/pkg 的 Go 探针核过通配匹配与 PREFIX_ACTIONS，0 处不一致）。#659 复审的 NIT-2（真 MinIO spec 的 `denied()` 只要 403 就算被拒）和「把真 MinIO spec 放进 CI」一起做，这样收紧后的断言每次都在真 MinIO 上验证。
