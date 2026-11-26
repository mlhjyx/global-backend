# 存量重判批次（J21）操作手册

> 生命周期：`DRAFT`
> 生命周期依据：规划器（`rejudge-plan.ts`）、审计合规 HTTP 入口（`POST /api/v1/icps/:icpId/rejudge`）与 Temporal 编排（`rejudgeWorkflow`）已就绪；真实环境发车与灰度验收待部署后执行（2026-11-26）。

## 1. 两种入口与定位

1. **只读离线规划器** `apps/api/scripts/judgment/rejudge-batch.mts`：从 ACTIVE ICP 与 `canonical_company` 中按规划器规则切批估算成本；**严禁**开放 `--execute` 跳过执行授权直接调模型。
2. **审计合规线上入口** `POST /api/v1/icps/:icpId/rejudge`（scope `acquisition:write`，`202 Accepted`）：
   - 完整走标准 `workspace-technical-quote` -> `WORKSPACE_GRANT`（`purpose: 'icp.rejudge'`，`subjectType: 'icp'`，`subjectId: icpId`，60 分钟准入租约）-> 预检零消耗 Grant -> 事务内原子核销 + Outbox `LeadRejudgeRequested` -> Temporal `rejudgeWorkflow`（`retry: { maximumAttempts: 1 }`）-> 末段发 `QualifyRequested`（不带 `runId`）重算评分。
   - **前置硬门**：要求 `JUDGE_CONTRACT_MODE=enforce` 且 ICP 状态为 `ACTIVE`（否则 `409 INVALID_STATE`，不消耗 Grant）。
   - **三条件精准收敛**：默认 `includeFresh=false` 时，仅纳入满足以下任一条件的非 `SUPPRESSED` 公司：
     1. `needsWebsiteV2`：`refreshWebsiteProfile=true`、有域名、尚未写 `_parser_version: 'website-profile/v2'` 且 `vat_id == null`；
     2. `needsViesBackfill`：`refreshCorroboration=true`、拥有非德国等公开匿名国别的合法 EU `vat_id`、尚无 `attributes.vies` 且 `_vies_attempted` 未命中当前税号的分段哈希令牌；
     3. `needsDigestRejudge`：按当前 `loadIcpBrief` + 公司快照算出的 `(inputDigest, promptHash, rubricVersion, judgeLevel=2)` 在 `judgment_record` 中尚不存在。
     - 同一参数二次调用时若全部已收敛，直接返回 `409 NO_REJUDGE_CANDIDATES`（**零消耗 Grant、零 LLM 费用**）。
   - **人工决策保护**：重判写入 `judgment_record`（`run_id = NULL`）后，`upsertLeadFit` 仅更新 `fitVerdict`、`fitReasons` 与 `version`，L0 门拦截与末段 `qualifyWorkflow` 均保护人工已决定的 `QUALIFIED` / `CONTACTED` / `CONVERTED` 状态与队列。

## 2. 成本口径说明（排错必看）

重判链路存在两个不同用途的金额字段，运维与对账时务必区分：

| 字段 | 来源 | 口径与用途 |
|---|---|---|
| `estimatedCostMicros` | `POST /icps/:icpId/rejudge` 响应（来自 `rejudge-plan.ts`） | **均摊执行估算**：单次 L2 判定实测均值 **$0.0099 / 家**（`9900 micros`，`k=1`，不含 Panel 与官网重抓；100 家约 `$0.99`）。用于规划超帽检查（`REJUDGE_COST_CAP_EXCEEDED`）。 |
| `requiredCapMicrousd` | `POST /execution-budget/workspace-technical-quote` 响应（来自 `workspace-technical-budget-envelope.ts`） | **平台防爆最坏预留包络**：按 `4` 次逻辑调用（`1` 次 L2 + `3` 次 L3 Panel）× `2` 倍结构化输出 Wire 上界 × `20¢` = **`$1.60 / 家`**（100 家 `$160.00`）；开启 `refreshWebsiteProfile=true` 时叠加 `discovery.classify_trade_role`（`1 × 2 × 3¢ = $0.06 / 家`，100 家 **`$166.00`**）。自托管爬虫与 VIES/GLEIF/Wikidata 工具均为 `0¢`。执行期按实际调用逐笔结算，非预扣费。 |

## 3. 只读 CLI 规划

```bash
pnpm --filter @global/api exec tsx scripts/judgment/rejudge-batch.mts --workspace <uuid> \
  --max-companies 100 --batch-size 25 --cost-cap-usd 5 [--json plan.json]
```

- **超帽拒绝规划**（`REJUDGE_COST_CAP_EXCEEDED`），不静默截断——截断会让「完成率」变成假指标。要少判就显式调低 `--max-companies`（HTTP 接口同样 fail-closed，不做静默 clamp）。
- `--execute` 保持**显式拒绝**（退出码 3），执行必须走审计合规的 HTTP + Grant 链路。

## 4. 发车后的线上灰度与全量步骤

1. 确认部署迁移（`20261126120000_icp_rejudge_purpose_enum` + `20261126120100_icp_rejudge_purpose_use`）已生效、`/health/ready` 与 Worker 就绪门通过，且 `JUDGE_CONTRACT_MODE=enforce`。
2. 先对 5 家定向公司做小批灰度：调用 `POST /api/v1/execution-budget/workspace-technical-quote`（`operation: "POST /icps/:icpId/rejudge"`，带 `attemptId` 与 `companyIds`，开启 `refreshWebsiteProfile: true, refreshCorroboration: true`），签发 `icp.rejudge` Grant 后调用 `POST /api/v1/icps/:icpId/rejudge`。
3. 核查结果：确认 `judgment_record.run_id IS NULL`、VIES T1 证据无街道地址泄露、既有人工 `QUALIFIED` / `CONTACTED` 线索状态零误改。
4. 扩展至 `maxCompanies: 100`（每批 `batchSize: 25`）推进存量重判，并用新 `attemptId` 复调验证返回 `409 NO_REJUDGE_CANDIDATES`（0 消耗 Grant）。

## 5. 回滚

重判只**追加** `judgment_record` 与刷新 Lead `fitVerdict` 投影；回滚 = 把 `JUDGE_CONTRACT_MODE` 置回 `off` 并重启 API/Worker（新重判入口立即返回 `409 INVALID_STATE`），历史记录完整保留可审计。
