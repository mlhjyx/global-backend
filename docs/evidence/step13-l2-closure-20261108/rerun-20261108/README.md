# 步 13 收口 · 缺口修复后的复跑证据（2026-11-08，TEST-ONLY）

> 结论先行：基线负向集（`../README.md`）上报的 4 个步 11-x 缺口已由 m1-5 线修复——
> gain-saas #113（G1 DNC fail-closed）、#115（G3 审计包 hash 稳定、G4 门拒绝审计工件）、
> backend #896（G2 引擎抑制写入端点）。本目录是**修复后**在补发产物上的复跑证据：
> - **G1**：stub 引擎 **403 / 200-空results / 缺条目** 三条路径全部 `503 OUTREACH_DNC_UNAVAILABLE`、sink **+0**（修复前 403 会照发）；
> - **G3**：同一批次两次 `GET audit-package` 的 `packageHash` 一致、`persistedAt` 命中、持久化行哈希可对上（第 3 行来自重放被拒的 `BATCH_REJECTED` 包）；
> - **G4**：四个门拒绝批次（未提交/待审批/内容失配/过期）均落 `BATCH_REJECTED` 事件（detail.code）+ 持久化审计包 + `audit_log(outreach.batch.rejected)`，且 `outreach_send` 0 行；
> - **核心负向 ③a/b/c、⑦a/b/c、⑥a/b 与 ⑤ 行级断言全部复跑通过**（无回归）；
> - **G2**：引擎切换后复验通过——退订触发的平台抑制写入 2xx，`outreach_global_suppression` 落行（见 §3）。

## 1. 被测产物与口径

- **gain-saas `main@71afd55`**（#113 G1 + #115 G3/G4/G5 已合入并补发）：`apps/server/dist` 构建于
  2026-11-08 20:46:21 CST，systemd `gain-saas-web` 20:47:06 重启；复跑实例直接运行**该部署 dist**。
- 隔离库 `gain_saas_13_l2_test`（基线同库；本轮新批次为 `summary.json` 中记录的 id），
  Mailpit sink `127.0.0.1:11025`（复用 m1-5 环境），TEST 空间与请求口径同基线
  （`OUTREACH_SEND_ENABLED` 仅测试进程内打开；R4 租约/撤销循环关闭；生产 4020 开关保持关闭）。
- 引擎镜像：G1/G3/G4 复跑时为 `65c14c1c`（gain 侧已修，引擎无关）；G2 复验时已切换为
  `5c969c33`（含 backend #896 抑制写入端点）。
- 未发真实邮件；`.test` 域 + 回环 sink。

## 2. 复跑结果

### 2.1 核心负向（无回归）

| # | 结果 | 证据 |
| --- | --- | --- |
| ③a 未提交审批直发 | 409 `OUTREACH_BATCH_NOT_QUEUED` | `cases/case1-no-approval-draft.json` |
| ③b 待审批直发 | 409 `OUTREACH_BATCH_NOT_QUEUED` | `cases/case2-no-approval-pending.json` |
| ③c 批准后内容被改 | 409 `OUTREACH_CONTENT_CHANGED` | `cases/case3-content-changed.json` |
| ⑦a 已发送重放 | 409 `OUTREACH_BATCH_ALREADY_SENT` | `cases/case4-replay-sent-batch.json` |
| ⑦b 跨批 approvalId | 404 `OUTREACH_APPROVAL_NOT_FOUND` | `cases/case5-cross-batch-approval.json` |
| ⑦c 过期批准 | 409 `OUTREACH_APPROVAL_EXPIRED` | `cases/case6-expired-approval.json` |
| ⑥a 退订后同批后续即停 | `COMPLETED`, SKIPPED 1 `OUTREACH_OPTED_OUT`，sink 无新增 | `cases/case7-unsubscribe-stops-queued.json` |
| ⑥b 回复后同批后续即停 | 同上 | `cases/case8-reply-stops-queued.json` |

### 2.2 G1（DNC fail-closed）——修复后

| 引擎响应（stub） | 期望 | 实测（`cases/dnc-*.json`） |
| --- | --- | --- |
| 403 JSON | 503 `OUTREACH_DNC_UNAVAILABLE`，sink +0 | ✅ 503，+0（`dnc-stub-403-rerun.json`；修复前为 201 SENT、+1） |
| 200 `{data:{results:[]}}`（非空输入） | 同上 | ✅ 503，+0（`dnc-empty200.json`） |
| 200 但缺请求邮箱的哈希条目 | 同上 | ✅ 503，+0（`dnc-missing-entry.json`） |
| 连接拒绝（基线已证） | 同上 | ✅（见基线 `../cases/dnc-transport-refused.json`） |

m1-5 实现按「请求的每个 canonical 邮箱哈希必须出现在返回集合」判缺条目（重复邮箱同哈希不误报），
单元测试覆盖 403/503/缺 results/缺条目/畸形。

### 2.3 G3（审计包 hash 稳定 / persistedAt）与 G4（门拒绝审计）

`cases/case9-audit-package.json` / `cases/case9-checks.json`：

- G3：同一批次两次 GET → `packageHash` 相同；`persistedAt` 非空；持久化表存在该 hash 的行
  （本批 3 行 = 发送前后两次 + 重放被拒的 `BATCH_REJECTED` 包各 1 行，互不重复）。
- G4：四个被拒批次逐一具备 `BATCH_REJECTED`（`detail.code`=拒绝码、actor=租户用户）、
  持久化审计包（行数 ≥1）、`audit_log.action='outreach.batch.rejected'`，`outreach_send` 0 行。
  说明：`contentChanged` 批次的 `persistedAt` 为 null 属**内容寻址的正确语义**——拒绝时持久化的
  是「篡改态」包，复跑脚本随后复原稿面，current 组装 hash 与历史包不同；历史包按 append-only 保留。
  逐封行维持「门拒绝=整批不发送」设计（不为未发生的发送伪行）。

## 3. G2（平台级抑制写入）——引擎切换后复验（✅）

引擎镜像已切换为 `build_sha=5c969c33`（含 backend #896 的 `POST /outreach/dnc/suppress`）。
复验（`cases/g2-suppress-write.json`，同一 TEST 实例、真实引擎）：

| 步骤 | 结果 |
| --- | --- |
| 已批准批次发送（隐式验证 `/outreach/dnc/check` 200 正常路径） | 201 SENT 1 封 |
| 邮件内一次性 token → `POST /api/public/outreach/unsubscribe` | 201 `{unsubscribed:true, alreadyUsed:false}` |
| gain-saas `suppressGlobal` → 引擎 `/outreach/dnc/suppress` | 2xx（日志无新增「平台级抑制同步失败」；此前 3 条均为切换前历史） |
| 引擎库 `outreach_global_suppression` | 新增 1 行：`email_hash=5e8203a7…`（= sha256(canonical email)）、`reason=unsubscribe` |

## 4. 边界

- 只验证同一补发产物在 TEST 配置下的行为；未在生产 4020 进程打开发送开关，未发真实邮件。
- DNC 异常路径用 stub 引擎注入；真实引擎的 200 正常路径以发送链路隐式覆盖。
- 单次运行；名单/退订状态以 TEST 库当次为准。
