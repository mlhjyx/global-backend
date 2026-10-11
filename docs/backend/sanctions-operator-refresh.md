# 制裁名单运营刷新 runbook

> 生命周期：`GUIDE`
> 生命周期依据：[平台 schedule 准入设计](../superpowers/plans/2026-10-10-platform-schedule-admission-and-writer-grants.md) §2 方案 B0（PR #625，产品负责人 2026-10-10 拍板）引入的运营命令

R4 冻结期间平台 schedule 保持暂停，`sanctionsRefreshWorkflow` 不运行。三份官方制裁名单改由运营者用一条命令刷新；打开制裁门是之后单独的 owner 步骤（§4）。

## 1. 做什么，不做什么

- 用数据库属主连接（`DATABASE_URL`）下载 OFAC SDN、OFAC Consolidated、EU FSF 三份官方名单，经 `SanctionsRefreshService` 的无回执分支写入 `sanctions_entity`。归一、内容摘要、撤下与版本逻辑都是服务原有的，没有另写一份。
- 每个源一次写入在同一个属主事务里完成，中途失败整体回滚，库里仍是上一版名单。
- 更新 `sanctions_source` 的 `record_count`、`publish_date`、`last_refreshed_at`、`last_fetch_status`，与服务原有写法相同。**不改 `status`**：三个源保持原状态。
- 不经平台 schedule，不产生预算回执。下载不经 ToolBroker（它对平台调用扣住 `sanctions-download/v1`），但 source_policy 判定用的是 ToolBroker 自己的 `checkSourcePolicy`：未登记、SUSPENDED、用途不含 `sanctions_screening` 都拒绝。
- 名单里的个人、船舶、飞机只计数、不入库：OFAC 只留 `sdnType = Entity`，EU 只留 `subjectType = enterprise`。OFAC Consolidated 与 SDN 同一 XML 结构，共用 OFAC 解析器。

## 2. 安全边界

- **只连属主**：先查当前角色。`app_user` 一律拒绝；其他角色既不是超级用户、也不拥有 `sanctions_source` 和 `sanctions_entity` 的，同样拒绝。
- **只下官方地址**：每个选中源的 `url` 与 `format` 必须与种子里的官方端点逐字一致（OFAC 为 `sanctionslistservice.ofac.treas.gov`，EU 为 `webgate.ec.europa.eu`），任何一个不符，整次运行在下载前拒绝。
- **下载走 guarded HTTP**：只连公网地址，每一跳重新解析并钉住 IP（OFAC 会 302 到 AWS GovCloud 上的 S3 预签名地址），最多 3 次跳转；单跳截止时间默认 600 秒（`--timeout-seconds` 可调 30–1800，只有运营下载能超过运行时的 30 秒上限）；大小上限 32 MiB；最后一跳必须是 https；媒体类型必须是 XML；严格 UTF-8；再过 artifact 路径同一道 XML 安全检查（拒 DOCTYPE 与实体声明）。
- **只重试瞬时故障**：连接中断、超时、DNS 解析失败、HTTP 429/5xx，每个源最多试 4 次，间隔 5、15、45 秒。来源策略拒绝、非公网地址、超过大小上限、非 XML、XML 安全检查不过、其他 HTTP 状态都不重试。
- **输出不含敏感内容**：只打印计数、日期与主机名，不打印 URL、预签名查询串、连接串或名单里的名字。

## 3. 运行

在合入本命令之后的 main 上建一个 worktree（根 checkout 不装 `node_modules`），装依赖并链接 `.env`：

```bash
cd /global/backend && node scripts/create-codex-worktree.mjs sanctions-refresh
cd /global/backend/.codex/worktrees/sanctions-refresh
gctl link-env "$PWD"
pnpm install --frozen-lockfile --prefer-offline
pnpm --filter @global/db generate
pnpm --filter @global/contracts build
cd apps/api
node --import tsx scripts/refresh-sanctions-lists.mts --source=all --dry-run   # 下载、解析、对比，不写
node --import tsx scripts/refresh-sanctions-lists.mts --source=all             # 写入
node --import tsx scripts/refresh-sanctions-lists.mts --source=ofac_sdn --timeout-seconds=1800   # 单源重跑
```

- `--source` 必填：`all`，或 `ofac_sdn`、`ofac_consolidated`、`eu_fsf` 的逗号列表。
- 退出码：0 全部成功，1 有源失败，2 拒绝或参数错误。
- 输出：每个源一段文字（下载字节数与主机、发布日期、保留的实体数、按类型剔除的条数）。dry run 另给「将新增 / 更新 / 不变 / 撤下」与收缩保护判定，写入给实际的新增 / 更新 / 不变 / 撤下。末行是一条 JSON（`sanctionsOperatorRefresh`），便于存证。
- 用完按收尾清单删除这个 worktree。

失败与重跑：

- **单个源下载或校验失败**（瞬时故障已试满 4 次）：该源记 `last_fetch_status = 'FAILED'`，库里名单不动，其余源继续。重跑该源即可。
- **数据库错误**：该源的写入整体回滚，记 `FAILED`，本次运行停止（服务对无法归类的错误一律停止）。排查后重跑。
- **收缩保护**：解析出 0 个实体，或少于现有活跃行的一半，拒绝写入并记 `FAILED`，防止坏下载清空名单。
- **幂等**：同一份名单再跑一次，不新增、不改内容、不撤下，只把 `last_seen_at` 与 `last_refreshed_at` 推到本次时间（服务原有语义）。
- 本机经代理访问时，DNS 解析与连接偶尔失败，大文件也可能很慢或中途断开。试满 4 次仍失败的源单独重跑，必要时调大 `--timeout-seconds`。
- SDN 已接近 32 MiB 上限（2026-10 约 29 MB）。超限时以 `SANCTIONS_OPERATOR_DOWNLOAD_TOO_LARGE` 失败、不写入，届时须评审后提高上限（平台执行合同与执行权限策略里都钉着这个值）。

## 4. 打开制裁门（单独的 owner 步骤）

写入成功、核对行数与发布日期之后，经产品负责人按 D9 批准，以属主连接执行：

```sql
BEGIN;
UPDATE sanctions_source
   SET status = 'ENABLED', updated_at = now()
 WHERE key IN ('ofac_sdn', 'ofac_consolidated', 'eu_fsf')
   AND last_fetch_status = 'DONE'
   AND record_count > 0;
-- 期望 UPDATE 3；不是 3 就 ROLLBACK，先查 last_fetch_status
SELECT key, status, record_count, publish_date, last_refreshed_at, last_fetch_status
  FROM sanctions_source
 ORDER BY key;
COMMIT;
```

回退（kill switch，立即对新建索引生效）：

```sql
UPDATE sanctions_source SET status = 'DISABLED', updated_at = now()
 WHERE key IN ('ofac_sdn', 'ofac_consolidated', 'eu_fsf');
```

## 5. 新名单何时生效

- 只有 `ENABLED` 且有活跃实体的源进入筛查索引。刷新 `DISABLED` 的源，对筛查没有任何影响。
- **customer worker**：启动时建一次索引；之后每次 qualify（`scoreCandidates`）开始时重建。打开或刷新后，下一次 qualify 就用新名单，不用重启。
- **API**（`decide` 的硬门）：启动时建索引，之后每 `SANCTIONS_INDEX_REBUILD_MS`（默认 1 小时）重建。所以最长 1 小时后生效；要立即生效，重启 API 运行时。这段时间里 `decide` 仍用旧索引；打开前的旧索引为空，筛查结果是 `not_screened`，不拦截。
- 不需要、也没有新增重建机制。

## 6. 证据与代码

- 命令：`apps/api/scripts/refresh-sanctions-lists.mts`；编排 `apps/api/src/sanctions/sanctions-operator-refresh.ts`；下载 `apps/api/src/sanctions/sanctions-operator-download.ts`。
- 真库测试：`apps/api/src/sanctions/sanctions-operator-refresh.postgres.spec.ts`（CI 步骤「Sanctions operator refresh on PostgreSQL」），覆盖：拒绝 `app_user`、dry run 不写、只入实体、元数据更新且 `status` 不变、重跑不变、新版本的增改撤、写入中途失败整体回滚、SUSPENDED 拒绝下载、本节的打开语句与索引生效。
