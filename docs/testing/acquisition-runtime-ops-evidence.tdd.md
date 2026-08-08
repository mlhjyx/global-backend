# AI 获客运行治理 TDD 记录

状态：`SOURCE_TESTED` / `NO_LIVE_SIDE_EFFECTS` / `POSTGRES_DISPOSABLE_NOT_RUN` / `TEMPORAL_REAL_REPLAY_NOT_RUN`

## 范围

本记录覆盖 signal ingest lease/fencing、Schedule code/ops ownership、workflow receipt、worker heartbeat、任务队列拆分、健康聚合端口和隔离 PostgreSQL verifier admission。它不把源码测试等同于部署、真实迁移、真实 Temporal replay 或服务健康。

## RED 证据

| Commit | 预期失败 |
|---|---|
| `152d2ae6c9619dc896baebb5d5241cd1b3adacd1` | signal 并发重复 egress、expired lease recovery、stale fencing 三项真实失败；其余新模块为缺失模块/合同失败 |
| `2f940b66da13123596a3adc3b4943667e9223aa3` | Schedule create race 与非法 cadence 六项真实失败 |
| `c0d6043` | fleet fatal shutdown、当前 build 判定、Schedule runtime observation、describe failure、成功 workflow budget truncation 共 8 项真实失败 |
| `e25df4` | Schedule evidence freshness 两项真实失败 |
| `e4e39b5` | lease 续租后被 successor 抢占仍写 signal、Schedule 修复前 receipt 假绿、health 忽略 hash mismatch、危险 overlap/catchup policy 未纳入治理，共 5 项真实失败 |

RED 测试先独立提交，生产实现没有混入这些提交。

## 测试矩阵

| 风险 | 机械断言 |
|---|---|
| 同窗并发重复出网 | 只有 lease owner 进入 broker；竞争方返回 `lease_busy` |
| 过期 attempt | expired PENDING 可 reclaim，fence/attempt 递增 |
| stale owner | 持久化、续租与 `OK` settle 在同一事务/账本行锁下执行；token/fence 失配时零 signal 写入且不能覆盖 successor；settle 失败回滚 signal |
| lease 状态约束 | migration + disposable PG verifier 验证 live lease/settle |
| Schedule 字段漂移 | workflow type、queue、args、timeout/schema、overlap=`SKIP`、catchup=1m 全部进入 hash；漂移自动修复 |
| 运维字段被覆盖 | cadence/spec、paused、note、remaining actions 对象引用和值保持 |
| Schedule 修复假绿 | update 后立即 re-describe；只有 post-update hash 精确一致才写 `RECONCILED`，失败/残留漂移均 FAILED |
| create race | `ScheduleAlreadyRunning` 后重新 describe/reconcile，不误报 startup failure |
| Schedule 观察失败 | describe/update 失败写闭合 FAILED receipt，不保存错误文本 |
| workflow replay | mock replay contract 中 `patched=false` 不发 Local Activity；真实 history replay 尚未运行 |
| workflow PII | args/result/error message 不进入 receipt；只保留机器码与 bounded 数值 |
| budget truncation | FAILED 机器码和成功结果精确 boolean 均能写入 receipt |
| 多队列故障域 | 任一 Worker run fatal 后其余全部 shutdown/drain，原始 failure 保留 |
| build/heartbeat | 只看 freshness 内 active heartbeat；旧 row 不冒充当前构建 |
| health Schedule | missing/paused/late/unobservable/stale evidence/missed/skipped 全部显性化 |
| verifier 安全 | 无显式授权、远端、共享、非 disposable、名称不匹配均在 client 前拒绝 |

## 已执行命令与结果

以下命令均在隔离 worktree、固定基线分支上运行；没有加载 `.env`、没有连接真实服务：

```text
pnpm --filter @global/api exec vitest run <runtime-ops and touched-boundary specs>
  PASS: 13 files / 133 tests

pnpm --filter @global/api test -- --run
  PASS: 278 files / 4358 tests

pnpm --filter @global/api exec vitest run <7 critical specs> --coverage <7 source includes>
  PASS: 7 files / 77 tests
  COVERAGE: statements 89.81% / branches 87.41% / functions 91.50% / lines 93.03%
  PER-MODULE BRANCHES: all 7 included critical modules >= 80%

pnpm --filter @global/api lint
  PASS: 0 errors；修复本切片 warning 后仅保留 7 个基线既有 warning

pnpm --filter @global/api build
  PASS

DATABASE_URL=<loopback schema-only placeholder> pnpm --filter @global/db exec prisma validate
  PASS（只解析 schema，不连接数据库）

DATABASE_URL=<loopback schema-only placeholder> pnpm --filter @global/db generate
  PASS（只生成 client，不连接数据库）

pnpm --filter @global/contracts build
  PASS

pnpm docs:verify
  PASS: 112 Markdown / 54 controlled / 0 errors；1 个 Site Builder 既有表格 warning

pnpm code-intelligence:scan
  PASS: 937 files / 8433 nodes / 19206 edges / 0 errors；5 个静态 warning（clean commit）

pnpm --filter @global/api exec tsx scripts/verify-runtime-ops-postgres.mts
  EXPECTED FAIL-CLOSED: 无显式 isolated admission 时在数据库 client 前拒绝；真实 verifier 仍为 NOT_RUN
```

ContractGraph 是派生静态证据，不替代尚未执行的 PostgreSQL/Temporal 运行证据；最终 clean commit 再执行一次相同扫描以绑定 exact head。

## 明确未执行

- `prisma migrate deploy`；
- disposable PostgreSQL verifier；
- 真实 Temporal server/replay/worker restart/Schedule catchup；
- API/worker/Compose/systemd 重启；
- provider、网页抓取、模型或任何付费调用；
- Git push、PR、merge。

真实环境验证必须另行获得精确目标和运行授权，并生成不含 PII 的 evidence/Release Bundle。
