---
date: 2026-10-19
title: Whitelist the condition operators a MinIO policy may put on s3:prefix
---

- 起因：#659 把两条 `s3:ListBucketVersions` 授权改成 `ForAllValues:StringLike` 加 `"Null": {"s3:prefix": "false"}`，因为 MinIO 对重复的 prefix 参数，只要任一个值匹配就放行，而 ListObjectVersions 按第一个值列出。部署合同 spec 只用正则禁止了普通 `"StringLike"`，复审 NIT-3 指出 `StringEquals`、`StringNotLike`、`ForAnyValue:*` 同样只看任一值，却没有被禁。
- 改动：`scripts/runtime-deployment-contract.spec.mjs` 不再解析 bootstrap.sh 的文本，而是在沙箱里真实执行它，用一个假 mc 截获 MinIO 实际会收到的调用和策略。
  - 尽量贴近 minio-bootstrap 容器：
    - 环境变量用 compose 默认值，并补上 `HOSTNAME`、`HOME`；
    - PATH 里只放钉版 mc 镜像实际自带的工具（cat、tr、id、mktemp、paste）；
    - stdin 关闭；
    - dash 和以 sh 名义调用的 bash 各跑一遍（镜像的 /bin/sh 是 bash）；
    - 首次部署和重复部署（桶已存在）也各跑一遍；
    - `/config`、`/tmp` 按完整路径词改写到沙箱。
  - 假 mc 只应答一次正常 provisioning 会发出的调用，其余一律记为「被拒」并以 97 退出，所以 `mc … || true` 也藏不住一条新命令。
  - 断言：
    - 没有被拒的调用，stderr 为空；
    - 完整、未经过滤的 mc 调用序列逐条等于预期；
    - 四种跑法得到的策略完全相同；
    - 每个策略名收到的都是一份 JSON，顶层键恰好是 `Version` 和 `Statement`（MinIO 解析键名不分大小写，`statement` 能盖掉 `Statement`）；
    - 三份策略都过白名单：「列出授权」按 MinIO 允许带 `s3:prefix` 的动作（`s3:ListBucket`、`s3:ListBucketVersions`）用 `*` / `?` 通配判定；语句只能是 Allow + Action（+ Resource、Condition）；`s3:prefix` 只能出现在 `ForAllValues:StringLike` 或 `Null`（值为 `"false"`）下；
    - runtime 与 cleanup 的列出授权按名称逐字比对，personal-read 没有列出授权。
  - 威胁模型：只防误改，以及看起来像正常改动的改动，不防蓄意绕过。用绝对路径 `/usr/bin/mc` 调用、或按只在镜像里存在的东西分支，仍然测不出来；要彻底拦住，需要在钉版 mc 镜像里跑截获。
- 测试：当前 bootstrap.sh 下 18/18 通过，四种跑法都真实跑到 `OBJECT_STORAGE_PROVISIONED`。三轮独立复审找到的 42 种写法逐一回放，41 种被拦下：
  - 第一、二轮的 31 种：通配动作、NotAction、shell 展开与转义、换写法或重复写入、`statement` 大小写变体、缩进 / 续行 / `command mc` / 双空格、if 块里的文件路径、对调 create 参数、heredoc 之后改写、附加策略、`mc anonymous set`、EOF 注入、注释诱饵；
  - 第三轮的 11 种：`mc --quiet … || true`、`mc --json … || true`、只在重复部署时走的分支、`[[ … ]]` 与 `$BASH_VERSION`、`$HOSTNAME`、compose 默认值、镜像里没有 jq、删掉 stdin 重定向（不再挂死）、`[ -d /config ]`；
  - 剩下的 1 种是用绝对路径调用 `/usr/bin/mc`，按威胁模型如实保留。
- 未做：没有在钉版 mc 镜像里跑截获（那样能把绝对路径调用一起拦住）；同文件里的旧测试往宿主机固定的 /tmp 路径写文件、并发时会互相干扰，这也没修（复审 LOW-3，早就存在）。没有用 MinIO 自己的解析器做差分（复审用 minio/pkg 的 Go 探针核过通配匹配与 PREFIX_ACTIONS，0 处不一致）。#659 复审的 NIT-2（真 MinIO spec 的 `denied()` 只要 403 就算被拒）和「把真 MinIO spec 放进 CI」一起做，这样收紧后的断言每次都在真 MinIO 上验证。
