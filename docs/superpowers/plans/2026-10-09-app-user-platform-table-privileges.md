# app_user 对无 RLS 平台表的写权限收口设计

> 生命周期：`APPROVED`
> 生命周期依据：产品负责人 2026-10-09 会话内确认 §5 全部按建议：一次收齐（P1-A）、新表默认只读（P2-A）、要清单与真库测试（P3）、平台写入者授权单独一个 PR（P4）、下一个窗口上线（P5）

事实基线：`origin/main@f302901c`（#616、#618、#617 已合，#619 CI 中）。xin `global_dev` 只做只读 SELECT（2026-10-09）。对照库：CI 钉住的同一 pgvector 镜像起一次性容器，只跑到 xin 当前的迁移版本 `20260925090000`，只绑 127.0.0.1，数据放 tmpfs，用完即删。代码位置写作「文件:行」，迁移位置写作「迁移名 L行号」。

## 0. 结论

- **根因在迁移本身，不只是 xin 漂移。** 基座迁移 `20260706033625_rls_and_app_role` L23 把当时所有表的 SELECT/INSERT/UPDATE/DELETE 授给 `app_user`，L26-29 又把它设成属主 `global` 新建表的默认权限。之后给平台表写「`app_user` 只读」的迁移多数只加了 `GRANT SELECT`、没有 `REVOKE`，所以**全新库上** `app_user` 就能写 17 张无 RLS 的平台表（`source_policy`、`data_provider` 由 #619 处理，剩 15 张）。唯一显式收回过的是 `jurisdiction_policy`（`20260711083741` L109-111）。
- **审计结果（16 张表）：**
  - 6 张只有属主（或平台写入者）写，`app_user` 写权限可直接收回：`_prisma_migrations`、`canonical_taxonomy`、`jurisdiction_policy`、`sanctions_source`、`sanctions_entity`、`patent_cache_refresh_audit`。
  - 10 张有生产路径以 `app_user` 写，但每张只用到部分操作，可以收窄：`monitored_source`、`source_fetch`、`source_entity`、`source_entity_change`、`source_signal`、`signal_ingest`、`term_alias`、`patent_inventor_cache`、`patent_lookup_request`、`patent_inventor_tombstone`。
- **xin 另有漂移：** 17 张表上 `app_user` 比迁移给的多（多数是本应只追加的证据、审计、删除回执表多了 UPDATE/DELETE），与「重跑了一次基座那条 `GRANT … ON ALL TABLES`」的效果吻合。其他角色没有漂移。
- **方案：** 一个迁移（名字排在 `20261009190000` 之后），做四件事并在结尾自检：
  1. 6 张只属主写的表收回 `app_user` 的写权限；
  2. 10 张 `app_user` 写的表收窄到实际用到的操作；
  3. 17 张漂移表恢复到迁移定义的权限（全新库上是空操作）；
  4. 改默认权限：属主新建的表对 `app_user` 默认只读，写权限必须在迁移里显式授予。
  
  另加一份 `app_user` 表权限清单和一道真库测试：迁移后的实际权限必须与清单完全一致，新表或改权限都要先改清单。
- **顺带发现两处平台写入者缺口（不在本设计内修，§3.4 单列待决）**：平台 worker 的「带回执」写入以平台写入者身份执行，但它对这些表没有任何授权；客户 worker 没有平台写入者，发现 run 的网站监控注册必然失败（已单独修复：在客户 worker 里跳过注册）。

## 1. 实测与承重假设

| # | 假设 | 结论与证据 |
| --- | --- | --- |
| A1 | 授权从哪来 | `20260706033625` L23：`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user`（覆盖当时已有的表，含 Prisma 先建的 `_prisma_migrations`）；L26-29：`ALTER DEFAULT PRIVILEGES FOR ROLE global IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user`。 |
| A2 | 后续迁移的本意 | `canonical_taxonomy`、`term_alias` 只 `GRANT SELECT`（`20260706191721` L44），代码注释也写只读（`taxonomy-resolver.ts:80`），但没有 REVOKE；制裁两张表只 `GRANT SELECT`（`20260714092640` L84-87）；`source_signal`、`signal_ingest` 显式授全部 DML（`20260711060408` L62-63）；四张采集表只靠默认权限；`jurisdiction_policy` 显式 `REVOKE INSERT, UPDATE, DELETE`（`20260711083741` L109-111）。 |
| A3 | 全新库的实际权限 | 对照库（139 个迁移）：`app_user` 对 17 张无 RLS 平台表有 S/I/U/D，`jurisdiction_policy` 只有 S。 |
| A4 | xin 漂移 | 与对照库逐表逐角色比对：只有 `app_user` 的 17 张表不同，全是 xin 多出 U 和/或 D：`article14_notice`、`brand_profile`、`brand_profile_claim_bridge`、`brand_profile_evidence_ref`、`claim`、`deletion_receipt`、`deletion_request`、`evidence`、`jurisdiction_policy`、`lia_record`、`policy_decision_log`、`site_build_task_attempt`、`site_copy_bundle`、`site_evidence_source_snapshot`、`site_publishable_claim_snapshot`、`site_publishable_claim_snapshot_item`、`site_release`。其中多张由加固迁移刻意收成只追加（例如 `20260717121000` 对两张证据快照表 `REVOKE UPDATE, DELETE`），xin 上又被授回。原因无记录；与重跑 A1 那条全表授权的效果一致。 |
| A5 | 数据库侧有没有以 `app_user` 写这些表的函数或触发器 | 没有。xin 上这 16 张表没有用户触发器；函数体里提到其中表名的只有 `write_raw_source_record_v2_legacy`（SECURITY DEFINER，以属主运行，只读 `source_entity`、`monitored_source`、`source_fetch` 做绑定核对）。 |
| A6 | 连接与角色 | `app_user`：`PrismaService`（`prisma.service.ts:56-61`，`APP_DATABASE_URL`；运行时准入拒绝非 `app_user` 的地址，`runtime-admission.ts:69-88`）。属主：由 `DATABASE_URL` 建的客户端（`worker.ts:321`、`platform-worker.ts:98`、`outbox-relay.service.ts:147-148`、`data-rights.service.ts:39`）。平台写入者：`platform-worker.ts:99`（`EXECUTION_BUDGET_PLATFORM_WRITER_DATABASE_URL`，登录角色只属于 `execution_budget_platform_writer`）。`site_build_provider_wire` 登录角色同时属于 `app_user` 和 `runtime_worker`，继承 `app_user` 的权限。 |
| A7 | `_prisma_migrations` 谁读写 | 运行时不写，只有 `prisma migrate deploy` 写。`app_user` 读：`assertMigrationCompatible`（`runtime-process-lease.ts:562-578`，worker、平台 worker、API 心跳）与 readiness（`runtime-readiness.service.ts:347-358`）；provider-wire 登录经 `app_user` 成员身份读（`site-build-provider-wire.database.ts:241-246`）；relay 以属主读。 |
| A8 | 「两分支」写法 | 采集、网站监控、intent 投影、信号入库四个服务都是：工具调用没有持久回执时 `persist(prisma)`（`app_user`）；有回执时在平台写入者的事务里写（`domain-ack.ts:228`）；有回执却没有平台写入者时抛 `DOMAIN_ACK_PLATFORM_TRANSACTION_UNAVAILABLE`（控制错误）。 |

## 2. 逐表审计

「需要」一列是生产代码实际用到的 `app_user` 权限。运维脚本（`apps/api/scripts/`）不计入，见 §6。

| 表 | 数据 | 生产写入者（进程 · 角色） | `app_user` 需要 | 建议 |
| --- | --- | --- | --- | --- |
| `_prisma_migrations` | 迁移账本 | 仅 `prisma migrate deploy`（属主） | S | 收回 I/U/D |
| `canonical_taxonomy` | 平台参考数据 | 无运行时写入者；只有运维脚本 `seed-taxonomy.mjs:27`（属主） | S | 收回写 |
| `jurisdiction_policy` | 平台治理规则 | `jurisdiction-policy.seed.ts:84`：API `DataRightsService`（属主）、worker 启动（属主，`worker.ts:350`） | S | 迁移本就只读；修 xin 漂移 |
| `sanctions_source` | 平台 | seed（属主：`worker.ts:358`、relay `:220`）；刷新（平台 worker，属主或平台写入者） | S（筛查读，`sanctions-screening.service.ts:59`） | 收回写 |
| `sanctions_entity` | 平台 | 刷新 `persist`（属主或平台写入者；`sanctions.download` 目前被 Broker 扣住，`tool-broker.ts:63-65`） | S（`sanctions-screening.service.ts:67`） | 收回写 |
| `patent_cache_refresh_audit` | 平台审计 | 平台 worker（属主或平台写入者） | 无 | 收回全部 |
| `monitored_source` | 平台 | 客户 worker 发现 run 注册监控（`intent-projection.service.ts:121,137`，无回执分支）；平台 worker 采集、监控巡检（无回执分支） | S/I/U | 收回 D |
| `source_fetch` | 平台 | 平台 worker：`acquisition.service.ts:95,139`、`website-watch.service.ts:117` 总以 `app_user` 建行与记失败；DONE 走两分支 | S/I/U | 收回 D |
| `source_entity` | 平台 | 平台 worker 采集、监控（两分支） | S/I/U | 收回 D |
| `source_entity_change` | 平台 | 平台 worker createMany（两分支）；90 天清理 `website-watch.service.ts:299` deleteMany（`app_user`） | S/I/D | 收回 U |
| `source_signal` | 平台（零个人数据） | 客户 worker 外部意向巡检 upsert（`signal-ingest.service.ts:318`）、过期 `:134`（`app_user`） | S/I/U | 收回 D |
| `signal_ingest` | 平台账本 | 客户 worker `signal-ingest.service.ts:355,376,381`（`app_user`） | S/I/U | 收回 D |
| `term_alias` | 平台参考数据 | API 查询规划与客户 worker 发现活动的 LLM 冷路径 `taxonomy-resolver.ts:483`（`app_user`，在 `withWorkspace` 里） | S/I/U | 收回 D；另见 §8 |
| `patent_inventor_cache` | 平台缓存（盲键） | Art.17 擦除 `deletion.activities.ts:184` deleteMany（客户 worker，`app_user`）；刷新（平台 worker） | S/D | 收回 I/U |
| `patent_lookup_request` | 平台队列 | 客户 worker `enqueuePatentLookupsForRun`、API 发现联系人缓存未命中，均为 `patent-inventor-cache.ts:224` upsert（`app_user`）；平台 worker 更新 | S/I/U | 收回 D |
| `patent_inventor_tombstone` | 平台（Art.17 墓碑） | Art.17 擦除 `deletion.activities.ts:180-183` createMany（`app_user`，ON CONFLICT DO NOTHING） | S/I | 收回 U/D：墓碑只增不改 |

注：以上 16 张表都没有 `workspace_id`，都是平台数据。数据库侧没有以 `app_user` 写它们的函数或触发器（A5）。

## 3. 方案

### 3.1 迁移 `2026101x……_app_user_platform_table_privileges`

- 名字排在 `20261009190000` 之后（运行时要求库里最新迁移与镜像一致，见 §6）。单事务，`lock_timeout 5s`。不建函数，不涉及 search_path。
- 对 §2 的 16 张表：`REVOKE ALL … FROM PUBLIC, app_user`，再 `GRANT` 表中「需要」一列的权限。先全收再精确授予，结果与库原来的状态无关，漂移也一并消掉。表级 REVOKE 会连同同类列级权限一起收回。
- 对 A4 的 17 张漂移表：恢复到对照库的权限（表级与列级都以对照库为准，施工时逐表从对照库导出，不手写）。全新库上是空操作。
- 默认权限：`ALTER DEFAULT PRIVILEGES FOR ROLE global IN SCHEMA public REVOKE INSERT, UPDATE, DELETE ON TABLES FROM app_user`。属主新建的表对 `app_user` 默认只有 SELECT，写权限必须在建表迁移里显式 `GRANT`。序列的默认权限不变（插入要用）。
- 结尾自检（仿 #619 的 DO 块）：清单里每张表上 `app_user` 的实际权限必须与期望完全一致（含经成员身份、`SET ROLE`、ADMIN 选项可得的权限）；默认权限里不再有对 `app_user` 的 INSERT/UPDATE/DELETE。不符即 RAISE，整个迁移回滚。

### 3.2 权限清单与真库护栏

- 清单 `docs/governance/app-user-table-privileges.json`：`public` 下每张表 → `app_user` 的表级权限（列级权限单列），由迁移后的库生成，经审阅提交。
- 真库测试（接进 CI 已有的 PostgreSQL 步骤）：
  - 迁移后的实际权限与清单逐表一致；默认权限符合 §3.1。新表、改权限都会让它失败，直到清单同步更新，权限变更因此必须进审阅。
  - 正向：在回滚的事务里，以 `app_user` 对 10 张写表各执行一次它实际用到的操作，都成功。
  - 负向：清单外的操作都报 42501。
- 漂移核对：同一份清单可以对 xin 做只读比对。是否接进 `gctl doctor` 另定（工作区工具，不在仓库）。

### 3.3 不改的

- 不改任何业务代码和数据；不碰有 RLS 的租户表（漂移修正除外）。
- 不改 `20260706033625` 本身（已应用的迁移不能改）。
- `term_alias` 由租户触发的 LLM 结果写进全局别名表这件事本身（§8）不在本设计内改。

### 3.4 平台写入者缺口（单列待决，不在本迁移内）

- **G1 平台写入者没有表授权。** 平台写入者的表级授权只有 `execution_budget_authority`、`execution_budget_authority_revocation`、`execution_domain_ack` 的 SELECT（`20260821090000` L1379-1382、`20260823000000` L313）。而采集、网站监控巡检、专利缓存刷新、制裁刷新在「带回执」时都在它的事务里写 `monitored_source`、`source_fetch`、`source_entity`、`source_entity_change`、专利三张表、制裁两张表。这些路径一旦带着回执运行就会报 42501。目前没有暴露：4 个平台 schedule 暂停，`google_patents` 是 DISABLED，`sanctions.download` 被 Broker 扣住。测试里平台事务是 mock 的。**恢复平台 schedule 或启用 `google_patents` 之前必须解决。** 建议：给平台写入者精确授予这些写入，与 DomainAck「确认与业务写入同一事务」的设计一致；不建议改回属主。
- **G2 客户 worker 没有平台写入者。** 发现 run 的网站监控注册必报 `DOMAIN_ACK_PLATFORM_TRANSACTION_UNAVAILABLE`，会让整个 run 记为 FAILED。已单独修复：没有平台写入者时在出网前跳过注册。要恢复自动注册，需要把注册交给平台 worker，另行设计。外部意向巡检（客户 worker）的信号入库同理：带回执时抛错，被吞进 `summary.errors`。

## 4. 合规与安全

- Art.17：墓碑表对 `app_user` 变成只增不改，擦除的持久性由数据库保证，不再只靠代码纪律。缓存表保留 DELETE（擦除要用）。
- 审计与证据：xin 上 `policy_decision_log`、`deletion_receipt`、`evidence` 等恢复只追加。
- 迁移账本：`app_user` 不能再伪造 `_prisma_migrations`，readiness 和迁移兼容核对读到的就是属主写下的状态。
- 利用前提与 #616、#619 相同：已能以 `app_user` 执行任意 SQL。属于纵深防御。
- 不读写任何业务数据。

## 5. 决策与权衡（产品负责人 2026-10-09 已确认，全部按建议）

| # | 问题 | 选项 | 建议 |
| --- | --- | --- | --- |
| P1 | 范围 | A：16 张平台表 + 17 张漂移表 + 默认权限，一个迁移；B：先只收 6 张属主表与漂移，`app_user` 写表的收窄以后再做 | A：一次收齐，清单与护栏同时落地 |
| P2 | 默认权限 | A：新表默认只读，写权限显式授予；B：保持现状，只靠清单测试兜底 | A：失败即关闭；清单测试会立刻指出漏授 |
| P3 | 清单与真库测试 | 要 / 不要 | 要 |
| P4 | G1 平台写入者授权 | 本设计后单独一个 PR；或并入本迁移 | 单独做：它是加权限，审阅口径不同；但必须排在恢复平台 schedule、启用 `google_patents` 之前 |
| P5 | 上线时机 | 随本次 4 个迁移的窗口；或下一个窗口 | 下一个窗口：本次窗口的 4 个迁移已在 xin 副本上预演过，这份改动面更大，先单独预演 |

## 6. 风险与回退

- **漏掉的写入者会报 42501。** 两个调用点吞错（`term_alias` 的 LLM 解析，`taxonomy-resolver.ts` 约 `:257-261`；专利查询入队，`bigquery-patents.provider.ts:148-150`、`discovery.activities.ts:1835-1837`），漏授时会静默降级而不是报错。对策：§2 的逐点审计；§3.2 的正向测试覆盖每张写表实际用到的操作；上线后用一次完整发现 run 和一次删除编排验证。
- **运维脚本：** 以 `app_user` 写这些表的脚本会失败，例如 `verify-intent-loop.mts:56-57,69`（删除、更新 `source_entity` 与 `source_entity_change`）、`intent-watch.mts`、`verify-signal-first.mts`。施工时逐个改为属主连接，或在脚本里写明需要属主。
- **部署：** 迁移与带它的镜像同一窗口上线，按名称顺序，窗口内不能有在跑的 run。先在 xin 副本（一次性容器）上预演迁移和自检。
- **回退：** 只改授权，回退就是一个把权限授回的迁移；紧急时可由属主手工 `GRANT`，事后补迁移。数据不受影响。

## 7. TDD 步骤

1. 真库测试先红：在 main 上跑，清单与实际权限不符（15 张平台表多出写权限、默认权限仍授写）。
2. 写迁移，测试转绿；迁移自检在故意多授一项权限的库上回滚。
3. 正向、负向测试：10 张写表各自的实际操作成功，清单外的操作 42501。
4. 一次性库预演：恢复 xin 的 `global_dev` 与角色副本，跑迁移；漂移表的权限与对照库一致；跑一遍发现活动与删除编排的真库用例。
5. CI 接线；changelog；运维脚本改连接。

## 8. 开放问题

- `term_alias` 是跨租户共享的参考数据，却由租户触发的 LLM 结果写入。即使权限收窄，一个租户的输入仍能影响别的租户的归一结果（数据投毒面）。是否改为「只写本租户候选、由平台审核后入全局表」，另议。
- 采集与监控四张表在平台 worker 的「无回执」分支以 `app_user` 写平台数据。G1 解决后，是否把这些写入统一到平台写入者，`app_user` 只留 SELECT。
