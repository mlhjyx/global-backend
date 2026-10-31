# 平台撤销自动触发：dev 有界试运行（不含 fence）

本记录是 2026-11-01（UTC）在 xin 的 dev 环境对 gain-saas P9「平台撤销自动触发」做的有界试运行：验证了事件源 → 逻辑请求 → 用真实预算钥签发 → 投递到真实后端 → 后端验签与错误分类 → 终态 `NO_LIVE_TARGET` 的完整链路。**没有触碰围栏**（没有真实 authority 被撤销），也没有 unpause 任何 schedule。

## 绑定身份

- gain-saas：`main@a8d9340`（PR #25 squash），试运行用同一提交构建的独立实例（端口 4030）
- 后端：运行中的 managed 镜像 `7cea82b9`（`5f661ac0`，准入 v2 与撤销接收端自 #706 起未变）；本仓事实基线 `origin/main@25d7d324`（仅文档变更）
- 数据库：dev `gain_saas`（127.0.0.1:5433）迁移到 `20261101090000_r4_revocation_autotrigger`；后端 `global_dev`

## 试运行方式（不重启线上 gain-saas）

systemd 的 `gain-saas-web` 需要 root 重启，本次不改线上进程，而是用同一构建产物起第二个实例：

```text
PORT=4030 R4_TLS_PORT=18457 R4_MTLS_PORT=18458 \
R4_LEASE_HEARTBEAT_ENABLED=false \
R4_REVOCATION_TRIGGER_ENABLED=true R4_REVOCATION_AUTO_CONFIRM=true \
R4_DEPLOYMENT_BINDING_FILE=/tmp/r4-binding-dryrun.json \
PROCESS_ROLE=web node dist/main.js
```

- `AUTO_CONFIRM=true` 是**试运行覆盖**（生产按设计 D4 保持 false）；`R4_LEASE_HEARTBEAT_ENABLED=false` 避免影响线上租约。
- 绑定文件用**临时副本**（真实 `deploy/r4/deployment-binding.json` 未改）；副本加 `revokedAt`/`revokeReasonCode`/`revokedBy`/`revokeNote` 触发「部署绑定显式撤销」事件源。

## 观察到的结果

1. **迁移**：新表 `r4_revocation_request` / `r4_revocation_attempt` / `r4_platform_policy_state` / `r4_revocation_sequence` 建立；部分唯一索引 `r4_revocation_request_active_schedule_key` 生效（同一 schedule 只允许一个未结请求）。
2. **策略基线**：实例启动后为三个有 egress 的 schedule 建立 `ENABLED` 基线（首次见到只建基线，不触发撤销）。
3. **无 live Grant 时**：绑定撤销事件产生 3 个请求（source `BINDING_REVOKED`，reason `OPERATOR_HOLD`），投递循环找不到未过期的 Grant，全部记 `NO_LIVE_TARGET` 终态；**没有任何后端调用**（无出网可撤销）。
4. **验签与错误分类**：向 `r4_platform_grant` 插入一条 10 分钟后过期的假 Grant（jti `9a7c2e1d…`，不对应任何 authority），并把绑定副本的 `revokedAt` 前移产生新请求。投递循环用真实执行预算钥签发撤销命令并 POST `/api/v1/platform-authority/revocations`；后端返回 **403 `PLATFORM_REVOCATION_SCOPE_MISMATCH`**（签名与 claims 通过校验，但找不到匹配的 committed authority），尝试记录 `outcome=SCOPE_MISMATCH`、`http_status=403`，15 秒后重试同一候选（第 2 次尝试，仍 403）。
5. **收敛**：删除假 Grant 后，下一次重试找不到 live 候选，请求转 `NO_LIVE_TARGET`。
6. **后端未被改变**：试运行前后 `platform_egress_schedule_fence` 逐行一致（`acq-sweep` ACTIVE / generation 3 / fence_sequence 1；其余 schedule 不变），`platform_revocation_receipt` 仍为 1 行（2026-10-31 的手工实测），没有新增 fence 或 receipt。

## 这份记录证明了什么

- 事件源（绑定文件 `revokedAt`）→ 逻辑请求 → 持久序列分配 → 撤销命令签发（真实预算钥）→ 投递 → **后端验签** → 确定性错误分类与退避重试 → `NO_LIVE_TARGET` 终态，全链路在真实组件上成立。
- 没有 live Grant 时不会凭空 fence，也不会挂起或阻塞 capability（`NO_LIVE_TARGET` 不计入积压）。

## 这份记录不证明什么

- **没有证明成功 fence 与 ACK 走新触发路径**：那需要一条真实 admitted 的 `PLATFORM_GRANT`，会关闭 schedule 的出网围栏；受审计重开路径就绪前不做（设计 D4）。成功的签发→投递→fence→ACK 只在 2026-10-31 用手工脚本验证过（[证据](2026-11-01-platform-admission-v2-and-revocation-fence.md)）。
- 未验证 `AUTO_CONFIRM=false` 的人工确认门在真实界面上可用（仅单测）；未验证运营台页面的真实交互。
- 未验证 Grant 签发门（策略 DISABLED / 未结撤销 / 绑定撤销）在线上进程中的行为（单测覆盖；线上仍是未启用的旧进程）。
- 试运行实例是独立进程，不是 systemd 的线上实例；线上部署、迁移与开关仍需运维窗口。

## 试运行后的清理（如实记录）

- 试运行实例已停止（SIGTERM），临时绑定副本已删除；`gain-saas-web` 线上实例未重启。
- 假 Grant 行已删除。
- `gain_saas` 库保留试运行产生的 6 个 `NO_LIVE_TARGET` 请求与 2 次尝试（审计历史，不删）；策略基线 3 行与序列计数器保留（后续真实撤销从 seq 3 起）。
- 真实部署绑定文件未改（`revokedAt` 计数 0）。

## 复现要点

1. `pnpm --filter @gain-saas/server build`，起第二个实例（端口与 mTLS/TLS 端口避开线上；心跳关闭）。
2. 临时绑定副本加 `revokedAt`；观察 `r4_revocation_request` 与 `r4_revocation_attempt`。
3. 如需验证验签与错误分类，向 `r4_platform_grant` 插入一条未过期、无对应 authority 的 Grant，再观察 403 `PLATFORM_REVOCATION_SCOPE_MISMATCH`。
4. 清理假 Grant 与临时文件；不要改真实绑定文件，不要对真实 admitted Grant 触发撤销（除非已安排受审计重开）。
