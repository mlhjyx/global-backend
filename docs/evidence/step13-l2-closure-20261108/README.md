# M2 步 13 收口：L2 审批门与发送即停的部署态负向验收（2026-11-08，TEST-ONLY）

> 结论先行：在**终班部署产物**（gain-saas `ec1610d`，dist 构建于 2026-11-08 20:14:24 CST）上，
> 以隔离 TEST 库 + TEST 标签 + 本机 Mailpit sink 实跑步 13 收口的负向集——
> **③ 无审批直发 / ⑦ 审批重放（已发送、跨批次、过期）/ ⑥ 退订与回复后同批次后续即停**
> 全部按预期在 **API 层被拒绝或跳过并记录结果码**；**⑤ 逐封审计行**（SENT/SKIPPED）包含
> 批准人/时间、收件人与模板哈希、合规依据与结果码。同时发现 **4 个实现缺口**（属步 11-x，
> 上报 m1-5 线，本次未改动其代码）：
> ① DNC 客户端对引擎 HTTP 错误 fail-open（403 仍照发，已实证）；
> ② 引擎不存在 `/outreach/dnc/suppress` 路由，平台级抑制同步是 404 no-op；
> ③ 审计包 `packageHash` 每组装一次就变（含 `generatedAt`）→ `persistedAt` 永远为 null，
> 且每次发送重复落行（含复跑计数见 G3）；
> ④ 批次门拒绝的尝试不产生任何审计工件（无持久化包、无逐封行、无门事件），
> 与「⑤ 含被拒」的字面要求不符。
>
> **未发任何真实邮件**：实例出口白名单仅 `127.0.0.1`，收件域为 RFC 预留 `.test`；
> 部署中的 4020 实例保持 `OUTREACH_SEND_ENABLED` 缺省关闭（TEST 实例仅在测试进程内显式打开）。

## 1. 环境与口径

- **被测产物**：gain-saas `main@ec1610d`（11-2 #104 批次+草稿审批、11-3 #106 逐封 L2 门/审计包/
  SMTP sink、11-4 #107 退订/回复即停/DNC 跳过），`apps/server/dist` 构建于 2026-11-08 20:14:24 CST，
  systemd `gain-saas-web` 于 20:14:27 重启（部署态）。测试进程直接运行**同一 dist 产物**
  （`node dist/main.js`），不是源码直跑。
- **引擎**：`global-api` 运行镜像 `build_sha=65c14c1c`（attested=true，image `sha256:beb58d59…`），
  含 11-1 #883 的 `POST /api/v1/outreach/dnc/check`（scope `compliance:manage`）。
- **Sink**：复用 m1-5 的 Mailpit 容器 `gainos-mailpit-test`（`axllent/mailpit:v1.27.4`，
  `127.0.0.1:11025` SMTP / `18025` HTTP），**未另起 sink、未占用新端口**。
- **隔离库**：`gain_saas_13_l2_test`（负向集）与 `gain_saas_13_l2_dnc`（DNC 探针），
  均从 main 的 prisma migrations 全量 deploy；测试空间
  `M2 13 L2 验收（TEST）`（`19130c8b-65fe-4d56-9838-3b81d58be297`）。
- **TEST 实例**：端口 14030/14031，`OUTREACH_SEND_ENABLED=true`（仅进程内），
  `OUTREACH_SEND_BATCH_LIMIT=1`（负向集，用于构造同批次后续仍在队列的邮件），
  `OUTREACH_SMTP_*` 指向本机 sink，DKIM `mail.gainos.test / test20261108`（私钥在 `/tmp`，未入库）。
  **为不影响平台权威**：`R4_LEASE_HEARTBEAT_ENABLED=false`、`R4_REVOCATION_TRIGGER_ENABLED=false`、
  `EVENT_CONSUMER_ENABLED=false`，R4 TLS/mTLS 监听改为 18457/18458、18459/18460（避开生产的
  18447/18448）。部署中的 4020 实例未做任何改动。
- **会话**：在 TEST 库直建 workspace/user/membership，按 `SessionService` 同语义签发
  HS256 会话（`SESSION_SECRET` 取自服务 env，未落盘未回显），全部请求走真实
  `TenantGuard`/`AdminGuard`/HTTP 控制器——负向拒绝发生在 **API 层**，与 UI 无关。

## 2. 负向结果（逐条，证据见 `cases/`）

| # | 用例 | 请求 | 响应 | 落库/旁证 |
| --- | --- | --- | --- | --- |
| ③a | 批次未提交审批即发送 | `POST /api/outreach/batches/{id}/send` | **409 `OUTREACH_BATCH_NOT_QUEUED`** | `outreach_send` 0 行；批次仍 `DRAFT`（`case1-*`） |
| ③b | 已提交、待审批即发送 | 同上 | **409 `OUTREACH_BATCH_NOT_QUEUED`** | 审批 `PENDING`、批次 `PENDING_APPROVAL`、0 发送（`case2-*`） |
| ③c | 批准后草稿被篡改（逐封须引用与内容匹配的批准） | 同上 | **409 `OUTREACH_CONTENT_CHANGED`** | 0 发送（`case3-*`） |
| ⑦a | 已发送批次重放 | 同上 | **409 `OUTREACH_BATCH_ALREADY_SENT`** | 首次 201 SENT 1 封，重放 0 封（`case4-*`） |
| ⑦b | 用 A 批的 approvalId 裁决/重放 B 批 | `POST /api/outreach/batches/B/approvals/{approvalOfA}/decide` | **404 `OUTREACH_APPROVAL_NOT_FOUND`** | B 批审批仍 `PENDING`（`case5-*`） |
| ⑦c | 批准过期后发送（expiresAt 已过期，UTC 安全写法篡改 TEST 行） | `POST .../send` | **409 `OUTREACH_APPROVAL_EXPIRED`** | 0 发送（`case6-*`） |
| ⑥a | 同批次后续仍在队列的邮件：两次发送之间该联系人完成退订 | `POST /api/public/outreach/unsubscribe`（一次性 token，来自种子邮件）+ 第二次 `send` | 第二次 **201 `COMPLETED`，SKIPPED 1，error=`OUTREACH_OPTED_OUT`** | Mailpit 无新增；`outreach_send` SKIPPED 行 + `DRAFT_SKIPPED` 事件（`case7-*`） |
| ⑥b | 同批次后续仍在队列的邮件：两次发送之间收到回复（NEGATIVE） | `POST /api/outreach/replies` + 第二次 `send` | 同上：**SKIPPED 1，`OUTREACH_OPTED_OUT`** | 回复写 `OPT_OUT`（`lawfulBasis=consent_withdrawal`）；Mailpit 无新增（`case8-*`） |

- L2 门断言：上述 ③/⑦ 全部为 **HTTP 4xx + 闭集错误码**；不存在「UI 藏了按钮、API 仍放行」的情况。
  逐封发送引用有效批次审批的实现口径：批次 `QUEUED` + `approval.state=APPROVED` +
  `approval.contentHash==batch.contentHash` + 未过期 + 每封 `approvedBy/approvedAt/contentHash`
  齐备（③c/⑦c 的拒绝即这些条件的反证）。
- 「回复即停/退订即停」是**发送前逐封判定**（最新同意 OPT_OUT 优先，其次 DNC），
  跳过的草稿标记 `SKIPPED` 并留下结果码，无需人工取消批次。

## 3. 审计包（⑤）与逐封字段

`GET /api/outreach/batches/{id}/audit-package` 返回 `outreach-audit-package/v1`（样例：
`cases/audit-package-*.json`）。逐封字段映射：

| 要求 | 审计包位置 | 实测 |
| --- | --- | --- |
| 谁批 / 何时 | `approval.decidedBy` / `approval.decidedAt`（另 `selfApproval`） | ✅ 有值 |
| 收件人与模板引用 | `drafts[].recipientEmail` / `drafts[].subjectHash` / `drafts[].bodyHash` / `drafts[].contentHash` | ✅ 有值 |
| 合规依据 | `drafts[].complianceBasis`（`consentStatus`/`consentSource`/`lawfulBasis`/`approvalContentHash`） | ✅（退订/回复后为 `OPT_OUT` / `consent_withdrawal`） |
| 结果码 | `drafts[].sends[]`（`status`、`error`、`messageId`、`attempt`、`sentAt`） | ✅ SENT 有 messageId；SKIPPED 有 `OUTREACH_OPTED_OUT` |
| 事件链 | `events[]`（`BATCH_CREATED/…/DRAFT_SKIPPED/BATCH_COMPLETED`） | ✅ |
| 被拒尝试 | —（见缺口 G4） | ❌ 无任何持久化工件 |

邮件侧旁证（`cases/sample-email.eml`，token 已脱敏）：`DKIM-Signature v=1`（rsa-sha256,
d=mail.gainos.test, s=test20261108）、`List-Unsubscribe` + `List-Unsubscribe-Post:
List-Unsubscribe=One-Click`、`Message-ID …@mail.gainos.test`。

## 4. 发现（属步 11-x，上报 m1-5 线；本次未改其代码）

| # | 严重度 | 位置 | 现象与证据 |
| --- | --- | --- | --- |
| G1 | **高（合规）** | `apps/server/src/outreach/outreach-dnc.checker.ts`（`check()` 只读 body，不校验 HTTP 状态） | 引擎 DNC 检查返回 **403** 时（stub 引擎实证，`cases/dnc-stub-403.json`），批次仍 **201 SENT、Mailpit +1**——DNC「调用方必须 fail closed」未成立；对照：**连接失败**时正确 **503 `OUTREACH_DNC_UNAVAILABLE`、+0**（`cases/dnc-transport-refused.json`）。修复方向：`check()` 对 `result.status !== 200` 抛错（与 catch 同一 fail-closed 路径）。 |
| G2 | 中 | gain-saas `EngineOutreachDncChecker.suppressGlobal` → 引擎 `POST /outreach/dnc/suppress` | 引擎只有 `/outreach/dnc/check`（backend #883 controller 仅一个路由），抑制同步实测 **HTTP 404**（测试实例日志 `平台级抑制同步失败…HTTP 404`）。租户内 OPT_OUT 正常，**跨租户平台抑制实际是 no-op**（warn-only）。 |
| G3 | 中 | `assembleAuditPackage` 把 `generatedAt` 计入 `hashJson(packageData)` | 同一批次每次组装 `packageHash` 都不同：`GET audit-package` 的 `persistedAt` **恒为 null**；`outreach_audit_package` 每次 `send` 调用前后各持久化一次且 hash 各不相同（本测试空间 18 个批次——含一次完整复跑——共 26 行，单批实测最多 4 行）。审计事实在 `outreach_send`/`outreach_batch_event` 中仍完整，但「内容寻址 + persistedAt 对账」失效。 |
| G4 | 中（口径） | `sendBatch` 门拒绝路径（无审批/过期/内容失配/已发送） | 拒绝只返回 HTTP 409，**不写** `outreach_send`/持久化审计包/门事件/`audit.record`。若 ⑤ 要求「被拒的每封也有审计行」，实现需补一条门拒绝事件（当前实现按「整批拒绝、不发送任何一封」设计，逐封行只在 SENT/SKIPPED/FAILED 产生）。 |

补充说明：⑦c 首次试跑曾显示「过期批准仍发送成功」，经查是测试脚本用 `psql now()`（会话时区）
写入 `timestamp without time zone` 造成 +8h 偏移的夹具错误，改用 `(now() at time zone 'utc')`
后按预期拒绝——**不是实现缺陷**，如实记录以免误导。

## 5. 边界（本证据不覆盖什么）

- 只验证**同一部署产物**在 TEST 配置下的行为；未在生产 4020 进程上打开发送开关，也未向任何
  真实收件人发信（`.test` 域 + 回环 sink）。
- 真实 IMAP/webhook 入站、真实收件方的 SPF/DKIM/DMARC 判定与进箱率仍属 11-5。
- 单次运行；名单/退订状态以 TEST 库当次为准。
- DNC 命中分支用 stub 引擎 403 与连接拒绝两条对照证明 fail-open/fail-closed；真实引擎 200
  空结果路径在负向集发送中隐式走通（未注入命中名单）。

## 6. 复现要点

```bash
# 1) 隔离库（本机 gain-saas 5433）
createdb ... gain_saas_13_l2_test   # 或 psql -c 'CREATE DATABASE …'
DATABASE_URL=…/gain_saas_13_l2_test pnpm --filter @gain-saas/server exec prisma migrate deploy
# 2) 同一 dist 产物起 TEST 实例（发送开关仅进程内；R4 循环关闭、端口避开生产）
PORT=14030 DATABASE_URL=…/gain_saas_13_l2_test OUTREACH_SEND_ENABLED=true OUTREACH_SEND_BATCH_LIMIT=1 \
  OUTREACH_SMTP_HOST=127.0.0.1 OUTREACH_SMTP_PORT=11025 OUTREACH_SMTP_STARTTLS=false … \
  R4_LEASE_HEARTBEAT_ENABLED=false R4_REVOCATION_TRIGGER_ENABLED=false R4_TLS_PORT=18457 R4_MTLS_PORT=18458 \
  node dist/main.js
# 3) TEST 空间 + 会话（SessionService 同语义 HS256），4) 按 cases/ 的请求复跑
```

`cases/summary.json` 为逐用例机读结果（③a/③b/③c/⑦a/⑦b/⑦c/⑥a/⑥b 全 `ok:true`；
⑤ 的行级断言全过，仅 `sentPackagePersisted` 因 G3 为 false，已单列为发现）。
