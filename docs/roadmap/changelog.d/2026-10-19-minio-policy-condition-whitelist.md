---
date: 2026-10-19
title: Whitelist the condition operators a MinIO policy may put on s3:prefix
---

- 起因：#659 把两条 `s3:ListBucketVersions` 授权改成 `ForAllValues:StringLike` 加 `"Null": {"s3:prefix": "false"}`，因为 MinIO 对重复的 prefix 参数，只要任一个值匹配就放行，而 ListObjectVersions 按第一个值列出。部署合同 spec 只用正则禁止了普通 `"StringLike"`，复审 NIT-3 指出 `StringEquals`、`StringNotLike`、`ForAnyValue:*` 同样只看任一值，却没有被禁。
- 改动：`scripts/runtime-deployment-contract.spec.mjs` 把 bootstrap.sh 写入的 IAM 策略解析成 JSON 再做白名单断言，不再逐个写正则黑名单。
  - 找全策略：每条 `mc admin policy create` 必须加载一个 `"$<var>"` 文件，这个文件恰好由一段 `cat > "$<var>" <<EOF` 写入；文件里不准有别的 heredoc；heredoc 里除桶变量外不准有 `$`、反引号或反斜杠，否则 shell 展开后 MinIO 看到的内容和测试看到的不同。换写法、重复写入、文件路径直传，都会失败关闭。
  - 「列出授权」按 MinIO 允许带 `s3:prefix` 的动作（`s3:ListBucket`、`s3:ListBucketVersions`）判定，并按 MinIO 的 `*` / `?` 通配匹配，所以 `"*"`、`s3:*`、`s3:L*` 也算列出授权；不能带 `s3:prefix` 的 `s3:ListBucketMultipartUploads` 等不再被误判。
  - 每条列出授权必须恰好带一个 `ForAllValues:StringLike` 模式和 `"Null": {"s3:prefix": "false"}`；`s3:prefix` 只能出现在这两个运算符下；不列出任何东西的语句不准提它；语句只能是 Allow + Action + Resource（+ Condition），Deny、NotAction 等直接报违规。
  - runtime 与 cleanup 各恰好一条列出授权，personal 没有。
- 测试：当前 bootstrap.sh 下 19/19 通过。独立复审找到的 14 种绕过写法逐一回放，新 spec 全部失败：通配动作 `s3:*`、`"*"`、`s3:L*`、`s3:*Versions`，NotAction，`$VAR` 动作，反斜杠转义，以及用 `<<'EOF'`、printf、文件路径、`cat >"$x"`、`cat > $x`、`cat <<EOF > "$x"` 写入，或重复写入的第四份策略。其中多数在第一版白名单和原来的 spec 下都会放行。单测对每个反例断言完整的违规清单，复审里存活的变异（删掉 Null 值检查、删掉 Allow 守卫、删掉模式要求、只认 ListBucketVersions、把 typeof 放宽为存在性、通配按字面匹配）现在都会失败。
- 未做：#659 复审的 NIT-2（真 MinIO spec 的 `denied()` 只要 403 就算被拒）和「把真 MinIO spec 放进 CI」一起做，这样收紧后的断言每次都在真 MinIO 上验证。
