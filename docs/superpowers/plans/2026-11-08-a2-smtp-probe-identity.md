# A2 落地设计 · SMTP 探测发送身份修复（2026-11-08）

> 生命周期：`APPROVED`
> 生命周期依据：交接总纲 WP A2（产品负责人 2026-11-08 批准 Phase 1 顺序 B1→B5，A2 紧随 B 线）；调研结论「SMTP 探测发送身份不对导致 mail_from_rejected 抬高 RISKY 占比」见 `~/.claude/plans/reports/2026-11-08-contact-roadmap.html`。

## 1. 问题（现网事实）

- `apps/api/src/adapters/smtp-probe.ts` 的 `SENDER_DOMAIN = env ?? 'example.com'`；`builtin-tools` 用 `verify@example.com` 做 MAIL FROM，EHLO 也用 `example.com`。`example.com` 是保留域名，部分 MX 直接拒绝其信封发件人 → `mail_from_rejected` → `email-guesser` 把整域短路成 `unreachable`（同一会话对全部候选恒成立）。
- 结果：可探测域的 RCPT 裁决率被压低（验收口径 56% → ≥90%，105 次 `mail_from_rejected`）。
- 现有裁决逻辑（`decideEmailVerdict`）本身是诚实的（mailFromOk 不过一律 RISKY），问题只在发送身份与重试手段。

## 2. 设计（零对外契约变更）

1. **发送身份显式化**：
   - `EMAIL_VERIFY_SENDER_DOMAIN` 缺省改为自有域名 `gainos.easyiothings.com`（可 env 覆盖；不再回落到 `example.com`）。
   - 新增 `EMAIL_VERIFY_HELO_HOST`（缺省=发送域）：EHLO 参数用真实 FQDN，与 MAIL FROM 同域。
2. **MAIL FROM:<> 退路（传输层内完成）**：`smtpRcptProbe` 第一会话若 MAIL FROM 被 4xx/5xx 拒，自动重开一连接，用空信封发件人 `MAIL FROM:<>` 再跑同一组 RCPT。**返回的 `code` 语义 = 「产出这些 RCPT 结果的会话」的 MAIL FROM 响应码**；两会话都被拒才返回被拒码（上层照旧判 `mail_from_rejected`）。工具输出/投影 schema/消费者零改动。
3. **不再整域短路**：`email-guesser` 的 `mail_from_rejected → unreachable` 保留但只在**两种发件人都被拒**时出现（注释更新）；此前它覆盖了本可裁决的域。
4. **可测试性**：`smtpRcptProbe` 增加可选 `port` 参数（默认 25），新增传输层 spec 用真实本地 SMTP 服务器脚本化对话（含回退路径）。
5. **域隔离（部署侧约束，写入文档）**：探测用发送身份与未来的群发发信域必须分离（A8 送达性模块为群发建独立子域/IP 池）；本 PR 只固定探测侧身份可配置。

## 3. 非目标 / 已知取舍

- 观察性：回退发生时不改输出契约，仅在 worker 侧不额外暴露「本次用了空信封」。如需统计，后续在工具 trace 增加枚举字段（须同步投影 schema 与治理清单）。
- Reacher/email-verifier 对照基准与真实域名的裁决率复测是部署后验收动作（需要真实出网端口 25 与发车），不在本 PR 内完成。
- 探测 IP 与发信 IP 的隔离依赖宿主代理/路由（运维项），代码侧只保证身份可配置。

## 4. 测试

- 传输层 4 例：正常会话（EHLO 参数=配置主机名、单连接、码序解析）；MAIL FROM 554 → 空信封回退成功（两连接、返回回退会话的码）；两种发件人都被拒（返回被拒码、不崩溃）；连接失败（reachable=false）。
- 既有工具/provider/guesser spec 全绿（语义未变）。
- 部署后验收：同一批德国域复测，`mail_from_rejected` 占比与 RCPT 裁决率（对照 56% 基线）。

## 5. 回退

纯代码；回退=revert。域名为 env 可覆盖，运维可即时换回。
