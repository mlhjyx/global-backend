# 联系人四态与验证事件账（P1 首波）

> 生命周期：`APPROVED`
> 生命周期依据：《GainOS 深化计划 v3.0》第 2 章《联系人工程》（`/home/xin/.claude/plans/gainos-plan-chapters/02-contact-engineering.md`，产品负责人 2026-11-08 批准）§2.3.2 目标设计、§2.5 任务表 P1-01/02/03/04/19；2026-11-09 主会话下达首波施工单（四态字段与写入路径 / 验证器适配层 / 再验证编排 / catch-all 策略常量）。

## 背景与现状证据

2026-11-08 只读审计：`contact_point` 274 条邮箱中 250 条 `source_type`/`verification_method`/`catch_all` 全 NULL、24 条仅 pattern 猜测；RISKY 270 / UNVERIFIED 3 / INVALID 1，**VALID 0**。38 条 `email.verification` 证据里 27 条被 M365/GWS 反枚举短路、7 条 MAIL FROM 被拒、2 条 catch-all、2 条 RCPT 550——验证事实散落在单一证据流，没有可复算的验证账本；三处 `contact_point` 写入各写各的来源与状态。

## 本波范围（一个逻辑单元一个 PR）

| PR | 任务卡 | 内容 | 验收 |
| --- | --- | --- | --- |
| 第 1 个 | P1-01 / P1-02 部分 / P1-03 部分 | 迁移 `20261109120000_contact_point_four_state`（四态列 + 形状/等价约束；`source_type` 回填后 NOT NULL；`verification_method` 增 `third_party_api`；RISKY 回填口径与重验排期）；`contact_point_verification_event` append-only 事件账（唯一幂等键、RLS、app_user 仅 SELECT/INSERT）；纯函数状态机；三处写入路径改造；domain_blind_key 回填脚本 | 迁移在真库演练可回滚重放；回填后 0 行 NULL source_type；事件账幂等与 RLS 由 postgres spec 证明 |
| 第 2 个 | P1-04 部分 / P1-06 部分 / P1-13 部分 | `EmailVerificationProvider` 接口 + MillionVerifier 客户端（accept_all 不得判 VALID）；双正投票规则与 0–100 评分；catch-all 发送分层（≥70 正常、40–69 灰度、<40 抑制；灰度白名单仅 US/FR） | 假 HTTP 契约测试零真实出网；投票矩阵与分层边界全覆盖；provider 默认 DISABLED + source_policy 登记 |
| 第 3 个 | P1-19 部分 / P1-03 部分 | 存量邮箱再验证 CLI：批量、限流、幂等（事件账预查 + 周期桶）、审计行、dry-run；导出 `runReverifySweep` 供后续 Schedule 复用 | 内存 fake 覆盖合规门/抑制/幂等/dry-run；供应商原始裁决与四态投影分别落账 |

## 关键决策

- `status` 保留为 legacy 投影：验证路径按 `projectLegacyStatus` 写；`BLOCKED` 保留为「本次尝试的合规处置」写进旧列（既有读侧继续保守），不进四态。
- 单验证器 positive 永不判 VALID（双正规则在 PR 2 的纯函数层实施；本波尚无第二家验证器，故再验证 CLI 对单票 positive 只记 UNKNOWN 并等第二票）。
- 验证器默认 `data_provider.millionverifier=DISABLED`（kill switch），凭据缺失时诚实降级 UNKNOWN，不伪造结论。
- 迁移为「加法为主」：`source_type` 的 `SET NOT NULL` 是收紧契约（回退到旧镜像需先 `ALTER COLUMN ... DROP NOT NULL`，见 PR 回退说明）。

## 不在本波

单一写入器架构守卫（P1-02 收尾）、Emailable/Truelist/ZeroBounce 与完整验证瀑布（P1-04/05/06 续）、富集尝试账与 catch-all 策略表（P1-08/13）、`CONTACT_REVERIFY_SWEEP` Schedule（P1-19 续）、读侧迁移到 `verification_state`。
