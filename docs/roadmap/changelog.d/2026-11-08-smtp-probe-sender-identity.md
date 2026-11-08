---
date: 2026-11-08
title: Fix the SMTP probe sender identity and retry with a null envelope sender
---

- 起因：交接总纲 WP A2——`EMAIL_VERIFY_SENDER_DOMAIN` 缺省 `example.com`（保留域名），EHLO 同域，`MAIL FROM:<verify@example.com>` 被部分 MX 直接拒绝（105 次 `mail_from_rejected`），`email-guesser` 因此把整域短路成不可达，RCPT 裁决率被压低（56% 基线）。
- 改动：
  - 探测发送身份缺省改为自有域名 `gainos.easyiothings.com`（`EMAIL_VERIFY_SENDER_DOMAIN` 可覆盖）；EHLO 参数用真实 FQDN `EMAIL_VERIFY_HELO_HOST`（缺省=发送域）。
  - `smtpRcptProbe` 增加空信封退路：MAIL FROM 被 4xx/5xx 拒时重开一连接以 `MAIL FROM:<>` 重试；返回的 `mailFromCode` 语义 =「产出这些 RCPT 结果的会话」的响应码——工具输出、typed_projection（`smtp-probe-verdict/v1`）、消费者零改动。
  - `smtpRcptProbe` 增加可选 `port`（测试用）；`email-guesser` 的 `mail_from_rejected` 短路注释更新（现在只有两种发件人都被拒才出现）。
- 测试：新增传输层 spec 4 例（真实本地 SMTP 服务器脚本化对话：EHLO 参数与单会话码序、MAIL FROM 554→空信封回退成功、双拒保留被拒码、连接失败降级）；既有工具/provider/guesser spec 全绿（54 例）。
- 未做：Reacher/email-verifier 对照基准与真实德国域复测（RCPT 裁决率 56%→≥90%、`mail_from_rejected` 归零的验收）需部署后用真实出网端口 25 执行；探测 IP 与群发发信域的隔离属 A8（送达性模块建独立子域/IP 池），本 PR 只固定探测身份可配置。
