> 生命周期：`REFERENCE_ONLY`
> 生命周期依据：追加式实施日志；当前状态见 docs/status/current.md

> 【定位变更 2026-07-10】本文件已降级为**追加式实施日志（changelog）**，不再代表当前状态。当前状态见 [../status/current.md](../status/current.md)，路线见 [release-plan.md](release-plan.md)，顶层设计见 [../product-scope.md](../product-scope.md)。
> 【环境勘误 2026-07-16】历史条目中的 Mac/WSL 路径、手动 Temporal、旧模型与“Crawl4AI 已有 SSRF 防护”等只记录当时验证；当前 Ubuntu `/global/backend` 环境与安全边界以 AGENTS、architecture/current 与 release-plan 为准。

## 2026-10-10 · Lock the site-build budget for publication through an owner routine

- 起因（2026-10-10 审计 app_user 表权限时发现，一次性库复现）：带质量环的建站翻新（Temporal patch `site-builder-m1f-quality-loop-v1`，新 run 都走这条路）在发布前要带行锁读本次构建的预算（`site-builder.activities.ts` 的 `finalizeRefurbish`），防止结算在检查和发布之间改动预算的状态或原因。这一步以 `app_user` 执行，而 `20260816220000_production_parity_budget_runtime` 起 `app_user` 对 `site_build_budget` 只有 SELECT。任何行锁（FOR UPDATE / SHARE 等）都要 UPDATE 权限，所以这句一律报 `permission denied for table site_build_budget`，不论有没有匹配的行：质量环的翻新一个也走不完。单测把 `$queryRaw` 整个替身掉，原生 SQL 真库测试只做 PREPARE、不检查权限，所以没有暴露。
- 改动：
  - 新迁移 `20261010100000_site_build_budget_publication_lock`：新增 SECURITY DEFINER 函数 `lock_site_build_budget_for_publication(workspace, build_run)`。它和现有的预算结算函数一样，先核对调用方事务的工作区，再以属主身份对预算行加 `FOR UPDATE` 锁，返回发布检查要读的两个字段。行锁持续到调用方事务结束，所以发布与结算按设计串行。search_path 以 `pg_temp` 结尾；只授 `app_user` 执行。`app_user` 的表权限不变。
  - `finalizeRefurbish` 改为调用这个函数读预算。
- 测试：
  - 新的真库测试 `site-build-budget-publication-lock.postgres.spec.ts`，接进 CI「Raw SQL parameter types on PostgreSQL」一步。只跑 main 的迁移时除第一项外全部失败（函数不存在），加上迁移后 7 项全过：
    - `app_user` 自己加行锁被拒（42501）；
    - 函数返回本工作区构建的预算字段；
    - 第一个调用方的锁持续到其事务结束，另一个调用方在 200 毫秒锁超时内报 55P03，前者提交后可取得；
    - 锁住期间，结算函数 `disable_site_build_paid_calls` 同样报 55P03，改不了这一行；
    - 其他工作区的调用被拒；
    - 没有预算的构建返回空；
    - PUBLIC 不能执行，`app_user` 可以（属主与 `app_user` 的成员角色本来就能）。
  - 单测：质量环的发布经由这个函数读预算，SQL 里不再有任何行锁子句，参数是工作区与构建 ID。
  - CI 那一步的三个真库测试在一次性库上全过；建站相关 132 个测试文件 3,253 项通过。
- 部署：迁移与带它的镜像在同一窗口上线，按名称顺序；它排在 #621（`20261010090000`）之后，两者都随下一个窗口发布。
- 未做：
  - 收尾先调 `terminalCostSummary`，其中 `disable_site_build_paid_calls(…,'run_succeeded')` 会无条件改写 `disabled_reason`，且不取进度锁；所以已记下的取消、`settlement_exceeded_reservation` 等原因可能在加锁之前被覆盖，取消请求也可能在发布之前被收尾抢先。这是原有的缺口（这条路径此前根本走不通），另行处理：保留已有原因，或在进度锁下关闭预算。
  - 原生 SQL 真库测试只以属主 PREPARE，PREPARE 不检查权限。系统性的补法是对收集到的语句再以 `app_user` 执行 EXPLAIN（会检查权限），其他身份执行的语句单列白名单；另行评估。

## 2026-10-10 · Monthly dependency refresh and audit baseline renewal

- 按[依赖刷新 runbook](../backend/dependency-refresh.md) §3 做 10 月批量（接手原定的月度刷新会话，基线原定 10-14 到期）：`pnpm update -r '!sharp'` 在声明范围内更新，`package.json` 的范围下限随之改写为实际版本。实际变化的直接依赖：`ai` 7.0.124→7.0.137（及 Anthropic/OpenAI provider）、AWS S3 SDK 3.1144→3.1149、astro 7.3.5→7.3.8、OpenTelemetry core/sdk-trace-base 2.11→2.12、Langfuse 5.11→5.13、`@scalar/nestjs-api-reference` 1.2.25→1.2.28、`@redocly/cli` 2.57→2.62、`@stoplight/spectral-cli` 6.16→6.17、nx 23.2.1→23.3.0、eslint 10.11→10.12、prettier 3.9.9→3.9.10 等；传递依赖含 `@grpc/grpc-js` 1.14.6、vite 8.3.4、Sentry 10.76、puppeteer-core 25.13。Temporal SDK 在 1.24.0 之后没有新版；sharp 保持确定性图片管线的 0.35.5；OpenTelemetry 整族锁步：`sdk-node`、`exporter-trace-otlp-http` 是 0.x 版本，`^0.222.0` 不跨次版本，而 0.222.0 精确依赖 2.11.0 的稳定包，范围内更新后锁文件里 2.11.0 与 2.12.0 并存，Langfuse 运行时遥测会把 0.222.0 的 NodeSDK 与基于 2.12.0 的 span 处理器、exporter 混用；两者改为 `^0.223.0`（与 2.12.0 配套的实验版，唯一破坏性变更在浏览器端 web-common），稳定包统一为 2.12.0，遥测用例照常通过；`packages/db/package.json` 丢弃纯表面的 prisma 范围改写（解析不变），漂移集合不越出已审范围。各精确钉版同族包在锁文件里都只有一个版本。
- override：postcss 8.5.26→8.5.29（含 `</style>` 转义改进）、nanoid 3.x 3.3.18→3.3.20（含超大 ID 使进程退出的修复）、deepmerge-ts 8.0.1→8.0.2、smol-toml 1.9.0→1.9.1，安全下限不变。nx 23.3.0 不再依赖 axios，axios 整个离开依赖图：撤掉 `axios@<1.20.0` override、安全下限与前任登记（runbook：下限包离开依赖图时测试报 `version: null`）。undici 8.x、fast-uri 两条保留（astro 7.3.8 用的 unifont 0.7.5 仍要求 `undici ^8.0.0`，ajv 8.20.0 仍要求 `fast-uri ^3.0.1`）。nx 23.3.0 另外精确钉了 undici 7.29.0，全量（含开发依赖）审计因此多出 10 条 advisory（2 条高危，修于 7.29.1）；沿用 10-01 处理 nx 钉版 axios 的做法，加以漏洞区间为选择器的 `undici@>=7.0.0 <7.29.1` → 7.30.0。pnpm 按声明范围与区间是否相交来套用 override，生产路径上 `@ai-sdk/provider-utils` 的 `^7.29.0` 也与之相交，所以它同样被钉在 7.30.0（原本就解析到 7.30.0，锁文件只留一个 7.x），此后 `pnpm update` 不再移动这份 undici；只钉 nx 的 `nx>undici@<7.29.1` 写法不被来源策略接受（override 键只允许包名或包名@区间）。撤除条件：nx 不再钉低于 7.29.1 的 undici，且 provider-utils 声明的下限不低于 7.29.1。安全下限新增 7 线 undici ≥7.29.1、登记前任 7.29.0（对上一版锁文件失败、对当前通过）。全量审计回到 main 上已有的两条开发告警：Prism mock 链的 faker 与上游尚无修复版本的 braces（≤3.0.3，经开发工具链）。trace_engine 仍是已审的 0.0.65，dist-tag 守卫不变。
- Actions：`actions/setup-node` v7（82076278）→v7.1.0（949feb24，版本校验、清单拉取重试；我们只传 `node-version: 22`）；`github/codeql-action` v4.38.2→v4.38.3（只用于非必需 canary，默认 bundle 2.27.2）。`oasdiff-action` v0.1.18 暂不升：它带来的 oasdiff 1.33.0 把 schema diff 改成按图计算、改写子 schema 匹配，影响必需门 `breaking` 的判定，按上次先例需另行离线重放最近的 `openapi.json` 变更再升（本仓 44 个 schema 无循环引用，它主打的递归修复对我们无影响）。
- 新发布版本核对：pnpm 9 没有最短发布时长，164 个新锁定版本里过半发布不足 4 天（最新的 strnum 2.5.1 只有数小时）。2026-10-06T00:00Z（UTC）以后发布的、首次没查到发布时间的，加上四条 override 升级，共 126 个逐个核对 npm provenance 与发布账号：99 个带 provenance，26 个不带 provenance 但由与先前版本相同的账号发布（aws-sdk-bot、sentry-bot、DefinitelyTyped 等），1 个换了发布账号；唯一带安装脚本的 nx 23.3.0 带 provenance。chromium-bidi 由 17.0.2（带 provenance）换成 Chromium 发布账号的 157.0.8090-0（无 provenance）：带 provenance 的 puppeteer-core 25.13.0 精确钉了该版本，chromium-bidi 源码已迁入 Chromium、版本改随 Chrome，予以接受。未回退任何版本。
- 官方 registry 生产审计零 advisory（831 个依赖）；基线重新绑定到刷新提交，失效时间 2026-10-14T21:28:22Z → 2026-10-24T13:59:34Z（旧绑定 `BASELINE_SOURCE_LOCK_MISMATCH`、新绑定 `FRESH`，见[回执](../evidence/security/20261010-monthly-dependency-refresh-baseline-renewal.json)）。Copy fixed-source 回执只重签指纹（`HASH_ONLY`）。下一次月度刷新与续期须在 10-24 前合入。

## 2026-10-09 · Give discovery runs a 3-hour admission lease

- 起因（2026-10-09 xin 实测，run `733fbf03`）：发现 run 的授权（Grant）最长 5 分钟。准入后每个活动开头、每次模型或工具预留都要再核验授权是否过期，所以 run 开始约 6 分钟（5 分钟加 60 秒容差）后的第一次核验就报 `EXECUTION_BUDGET_GRANT_EXPIRED`。733fbf03 在准入后 6 分钟因此失败，而一个发现 run 预计要跑 1–1.5 小时。产品负责人 2026-10-09 选定「准入后给 run 一段租约」，并确认 3 小时、只给发现 run。设计见 `docs/superpowers/plans/2026-10-09-discovery-run-admission-lease.md`（已改为 APPROVED）。
- 改动：
  - 新迁移 `20261009170000_discovery_run_admission_lease`：
    - `execution_budget_authority` 加可空列 `admission_lease_expires_at`。准入发现 run（`WORKSPACE_GRANT` + `discovery.run` + `discovery_run`）时写入准入时刻加 3 小时，其余准入写 NULL。准入时刻只取一次，`consumed_at` 和租约用同一个值，租约恰好等于 `consumed_at` 加 3 小时。
    - 新 CHECK：租约只能出现在发现 run 行上，必须晚于 `expires_at`，且不超过 `consumed_at` 加 3 小时。app_user 对该表只有 SELECT，不能设置或延长租约。
    - `consume_workspace_execution_authority` 和 `attest_authorized_tool_budget_v1` 用 CREATE OR REPLACE 重定义，函数体逐字复制，只改租约相关的几行。attest 判断过期改用 `COALESCE(admission_lease_expires_at, expires_at)`，60 秒容差和错误码都不变。两个函数仍是 SECURITY DEFINER，attest 仍是 STABLE，属主和 EXECUTE 授权不变。search_path 写成 `pg_catalog, public, pg_temp`，与 #616 对所有 SECURITY DEFINER 函数的要求一致；迁移名排在 #616 的 `20261009160000` 之后。
    - Grant 本身不变：验签、`consume`、`open` 仍按 5 分钟窗口判断，撤销、范围、cap、耗尽和单持有者检查一字不动。迁移不回填：迁移前准入的行租约为 NULL，照旧按 5 分钟判断，xin 上卡住的 run 不会复活。
  - Prisma 模型加 `admissionLeaseExpiresAt`。schema.prisma 是 Copy 绑定文件，已重签（只变指纹）。
  - relay 启动发现工作流时加 `workflowIdReusePolicy: REJECT_DUPLICATE`。租约内 binding 一直能花钱，而默认策略允许同 ID 的上一次执行结束后再启动，同一条 `DiscoveryRunRequested` 被再次投递时会用同一个 binding 重跑。现在 Temporal 对已结束的同 ID 报 `WorkflowExecutionAlreadyStartedError`，relay 照旧记为合并、标为已投递。qualify、understanding、删除等其他启动不变。
  - 文档：架构设计写明 300 秒只约束出示与准入、reserve 的有效期取租约或 Grant 窗口；ADR-024 加 2026-10-09 补充；落地设计记下产品负责人的答复；更正 #614 条目里「授权只有 5 分钟」的说法。
- 测试：
  - 静态迁移合同 8 项（零容器）：单事务、带锁超时、不回填；新列可空、无默认值；CHECK 原文；两个函数与原定义逐字比对，只差预期的几行；只重定义这两个函数，原定义与本迁移之间没有别的重定义；Prisma 模型有该列；本迁移排在 #616 的 `20261009160000` 之后，且分支里必须已有它。最后一项挡住「先合本 PR、后合 #616」：那样 #616 的迁移会更晚部署，库里最后完成的迁移与镜像的 `migration_revision` 对不上，运行时拒绝启动；#616 合入并合进本分支之前，这一项按设计失败。`workspace-authority-lifecycle.spec.ts` 改为读取 attest 的最新定义，并检查租约口径。加迁移前，其余 7 项与 lifecycle 这一项都失败，加迁移后通过。
  - relay 2 项：只有发现工作流带 `REJECT_DUPLICATE`；用真实 SDK 客户端接一个桩 gRPC 服务，服务对已结束的同 ID 回 `ALREADY_EXISTS`，SDK 报 `WorkflowExecutionAlreadyStartedError`，relay 记为合并、事件标为已投递。改动前 2 项都失败。另在一次性 Temporal 开发服务器上实测（CLI 1.8.0 / Server 1.31.2，与 xin 相同）：同 ID 终止后，`REJECT_DUPLICATE` 报 `WorkflowExecutionAlreadyStartedError`，默认策略则另起一次执行。
  - 真库合同 `discovery-run-admission-lease.postgres.spec.ts` 10 项，接进 CI 里 `migrate deploy` 之后跑真库用例的那一步（需 `EXECUTION_BUDGET_ADMISSION_LEASE_DATABASE_TEST=1`，两个库名都必须以 `_test` 结尾）。走真实的准入服务和 `PostgresBudgetStore`，业务连接是受 RLS 约束的 app_user；用 owner 把 authority 的全部时间列整体前移来模拟时间流逝：
    - 发现 run 的租约恰为准入加 3 小时，重放同一 Grant 不改租约；其余 6 种准入为 NULL；
    - 准入 10 分钟后，发现 run 仍能核验、预留（0 微美元）和释放；其余 6 种照旧报 `GRANT_EXPIRED`；
    - 租约到期也有 60 秒容差，过后核验报 `GRANT_EXPIRED`，TS 映射为同名错误；
    - 租约内撤销、额度耗尽、换工作区、账户关闭照旧拦住；
    - 准入仍受 Grant 窗口约束：过期 Grant 不能准入，过窗后不能再 open；
    - CHECK 拒绝其他 authority 上的租约、超过 3 小时的租约、不晚于 `expires_at` 的租约，允许置 NULL；
    - 租约为 NULL 的发现 run 按旧口径判断；
    - 两个函数的 SECURITY DEFINER、易变性、属主、EXECUTE 授权（app_user、平台 writer、PUBLIC）和 search_path；
    - app_user 用同名临时表伪造 authority 行时，attest 仍读 public 的真表。
  - 一次性库（CI 钉住的同一 pgvector 镜像，只绑 127.0.0.1，数据放 tmpfs，用完即删）：只部署 main 的迁移时，真库合同 9 项失败，核心是准入 10 分钟后报 `GRANT_EXPIRED`，临时表一项在 main 上读到了伪造行；其余准入保持 5 分钟那 1 项本来就成立。部署新迁移后 10 项全过。main 的迁移、#616 的迁移（`1a1c0112`）与本迁移一起部署时，本合同 10 项和 #616 的真库护栏都通过，#616 的静态护栏对本迁移也通过。手动测试 `packages/db/test/execution-budget-authority.rls.spec.mjs` 用 #616 的版本（9 个授权函数的 search_path 都期望带 pg_temp，本 PR 不改该文件）在这样部署的新库上 29 项全过，含 20 个客户端同一 jti 并发准入。
- 未做：
  - RUNBOOK（工作区文件，不在本仓）还没补「租约内停止发现 run」：等 cap 耗尽；`temporal workflow terminate --workflow-id discovery-<runId>`；或以 app_user 设置 `app.current_workspace_id` 后向 `execution_budget_authority_revocation` 插一行，下一次核验即报 `REVOKED`，#614 之后 run 记为 FAILED。GrowthOS 仍不能撤销 workspace grant。
  - 工作流被 terminate 或 cancel 后，正在执行的活动尝试要到 startToClose 超时（15 或 30 分钟）才停，这期间它的预留仍会通过；运维 reset 工作流也会复用同一个 binding。
  - run 收尾时关闭账户、让租约提前失效，留待与 #614 的重试语义一起设计。平台 Schedule 恢复后会遇到同样的约 6 分钟失败，另行决定。understanding.run 和联系人端点仍是 5 分钟。
  - 同一计划的 run 失败后不能用新 Grant 重跑（账户键由计划决定，仍绑定旧 authority），另行跟踪。
  - 部署：#616 须先于本 PR 合入。迁移和带它的新镜像必须在同一个维护窗口上线，`migrate deploy` 会依次应用 #616 的 `20261009160000` 和本迁移。运行时要求库里最新迁移名与镜像的 `migration_revision` 完全一致，两步之间 API 与 Worker 不就绪；切换时不能有发现 run 在跑。

## 2026-10-09 · Shape public-web company records to the Raw source governance

- 起因（2026-10-09 xin 实测）：卖方 #16 的发现 run `733fbf03` 是 #611 之后第一次真正跑通公开网页搜索的 run。模型判出 21 家公司官网，21 条 raw 记录却全部 `REJECTED`（`PROVIDER_PAYLOAD_SCHEMA_INVALID`），各查询回执是接受 0、拒绝 9 / 8 / 4，所以 run 即使不提前停也建不出公司。`mapPublicWebCompanyToRecord` 交出的记录有三处不合 Raw 治理，任何一处都会拒掉整条：
  - `country` 是模型原文（`Germany`），Raw 只收两位大写字母的国家代码；
  - `products` / `keywords` 里只要有一个词不在受控业务词表（36 个英文词，属数据最小化控制）里，整条拒绝；德国官网的产品词（`Kreiselpumpen`、`submersible`……）几乎都不在；
  - Raw 要求来源页的主机名与 `domain` 完全相同，`domain` 却去掉了开头的 `www.`；G3 搜索优先以后，来源页是第一条搜索命中，通常是 `https://www.<domain>/...`。
- 改动（只改公开网页 provider；Raw 治理、词表、数据库都不动）：
  - 国家用现有词表 `lookupCountryIso` 映射（德国 / Germany / Deutschland → DE）；模型直接答了词表里的代码（`DE`、`de`）也保留；`DACH`、`Österreich`、未知的不填，不猜。
  - 产品词、关键词只留受控词表里的词，其余丢掉，不扩词表；词之间统一成一个空格（`centrifugal-pumps` → `centrifugal pumps`），大小写不同的重复只留第一个，最多 20 个（Raw 与数据库的上限，模型契约允许 32 个）。
  - 来源页取第一条主机名恰好等于 `domain` 的搜索命中，没有就用首页 `https://<domain>/`；`www.` 命中、其他子域、http 命中都退回首页。没有改成「验证器比较前去掉 `www.`」：数据库写入函数 `write_raw_source_record_v2` 对 ACCEPTED 的 public_web 行同样要求主机名等于 `domain`，只放宽 TS 验证器会让写入抛错、整条查询的事务回滚，两边一起改就要加 migration。
  - 数据库对来源 URL 的检查比 TS 严，而且对带来源 URL 的 QUARANTINED 行一样检查、一样抛错：除 `%20` 外不收任何百分号转义（`/über-uns` 会编码成 `%C3%BC…`）；联系方式规则把 `_` 当词界，`/Kreiselpumpe_SK-40_160` 里它认出 TS 认不出的 `sk-` 密钥记号。所以含 `%` 或 `_` 的命中也退回首页；没有这两个字符的 URL 是纯 ASCII，两边的规则读法一致。
  - 公司名做确定性的规范化：NFKC；弯撇号、各种破折号和搜索标题里的分隔符（`|`、`·`）换成 ASCII 的撇号或连字符；去掉双引号、包住词的单引号、®、™ 和不可见格式字符；`_` 换成空格（数据库把它当词界，`Pumpen_Secret` 两边都拒，而不是只在写入时抛错）；合并空白。带电话、邮箱或网址的名字不修，照旧由边界拒绝（回执不含原值）。规范化后只剩空串的名字按「没有名字」跳过，模型回执照常记为尝试。
  - `domain` 用联系人禁联的同一套规范化（小写、去 `www.`、国际化域名转 ASCII）；员工数只收非负整数。
  - `wikidata.org` 加进噪声域名：Raw 会把它匹配到种子里的 `www.wikidata.org` policy，数据库却不认这条 policy 覆盖裸域名，写入会抛错。
- 测试：
  - 新增 `public-web-raw-governance.spec.ts` 34 项。用例是按真实形状手写的模型输出，没有回放 run 733fbf03 的 21 条原始回答：德语产品词与受控词混杂；国家 `Germany`、`Deutschland`、`德国`、`DACH`、`Österreich`、未知、`de`；置信度缺省、null、0.9；命中 `https://www.<domain>/x`、`https://<domain>/`、`http://www.<domain>/`、子域、变音路径、带查询串、`_SK-`、`forgot_password`、非默认端口；13 种要规范化的名字；国际化域名。逐条断言丢掉的词、国家代码和实际选用的来源页。测试里另有一份数据库来源 URL 检查的 ASCII 移植（`raw_source_safe_https_url_v2` 及其联系方式规则），每个选中的来源页都要过它；12 个刁钻的同主机路径选出的 URL 两边都收。另测 20 个上限、员工数，以及带电话或 `_Secret` 的名字仍被拒（附干净名字的对照）。
  - `provider-raw-boundary.integration.spec.ts` 加 run 733fbf03 形状的记录：有覆盖公司域名的 source policy 时 ACCEPTED，没有时 QUARANTINED 且来源 URL 是数据库能存的首页。`public-web-search-first.spec.ts` 加两项（从 `www.` 命中和德语回答走完 `discoverCompanies`；Wikidata 页面不送判站），`company-lineage.provider.spec.ts` 加一项（只剩引号与商标符号的名字）。
  - 先红：换回 main 的 provider，并按 main 的 `mineDomain` 把首条命中当来源页传入，映射表 34 项中 30 项失败；没失败的 4 项是不变的行为（员工数 120、0、null，带电话的名字被拒）。走真实 `mineDomain` 的 3 项也都失败。
  - 变异：逐一撤掉 25 处改动，每次都有用例失败。
  - `src/discovery` 及相关 temporal、durable-results、searxng 用例全部通过，`governance:verify` 通过，`nest build` 与 eslint 通过。独立只读复审提出的 1 项 MEDIUM（`_SK-` 路径）与其余 LOW 已在第二个提交处理或写入下面。
- 未做：
  - Raw 按来源页主机名找 `source_policy`，而代码与种子都没有为公司官网登记 policy（本次未查库核实）。记录不再因这三处被拒，但会以 `SOURCE_POLICY_MISSING` 进 QUARANTINED，建档只读 ACCEPTED，所以公开网页发现多半仍建不出公司。怎样给公司官网放行（逐域登记还是按 provider 统一处理）要 owner 决定。若逐域登记，要登记裸域名：TS 的 `policyFor` 比较前两边都去掉 `www.`，数据库不去，`www.<domain>` 的 policy 会在 TS 匹配上、在写入时抛错。
  - TS 的 `isStableSafeHttpsUrl` 比数据库宽（百分号转义、`_` 词界），其他 provider 的来源 URL 也可能让写入抛错、整条查询回滚；本次只在 public_web 的映射里避开。更稳的做法是让 TS 的检查与数据库一致。
  - 仍会被拒的名字：只有半边引号的、带 `;`、`!`、`[]` 等边界不收的字符的。国家词表只有 8 国，`AT`、`Austria`、`Schweiz`、`United Kingdom`、`U.S.` 都映射不了；`search-localization.ts` 有一张更全的表，两张表可以合并。

## 2026-10-09 · One generic source policy for public-web company sites

- 起因：#615 之后公开网页发现判出的公司记录能过 Raw 的格式检查，但 Raw 入库要按来源页主机找 `source_policy`，公司官网都没有逐域策略，记录全部以 `SOURCE_POLICY_MISSING` 隔离；建档只读 ACCEPTED，所以公开网页发现仍建不出公司。产品负责人 2026-10-09 决定加一条通用的「公司自有官网」策略，设计见 `docs/superpowers/plans/2026-10-09-public-web-company-site-source-policy.md`（`APPROVED`：保留 365 天、`personal_data=true`、用途只在 Raw 入库强制）。
- 改动：
  - `source_policy` 加一行保留键 `public_web:company_site`。它不是主机名，Broker 的按域名查找和各处 SUSPENDED 黑名单都碰不到它。由 `DiscoveryProviderRegistry.seed` 写入，`update: {}`：APPROVED、用途 `discovery` / `enrichment`、保留 365 天、`personal_data=true`，robots 与站点条款无法逐站审，如实写 `UNREVIEWED`。运维改成 SUSPENDED 后，启动 seed 不会改回。
  - Raw 入库按同一规则选策略：先取覆盖来源主机的最具体逐域策略，SUSPENDED、缺用途的也算；没有逐域策略，且 provider 是 `public_web`、来源主机就是记录自己的域名，才用通用行。「最具体」按去掉 `www.` 后的长度算（原来按原始拼写，`www.foo.com` 会压过更具体的 `eu.foo.com`）；同一域名的几种拼写并存时 SUSPENDED 的优先；大小写只折叠 ASCII。SUSPENDED 判定挪到用途判定之前，封禁行的处置码因此是 `SOURCE_POLICY_SUSPENDED`。
  - 迁移 `20261009180000_public_web_company_site_source_policy`：新函数 `raw_source_policy_binding_v3` 在写入时按同一规则复核命令里的策略 id。`write_raw_source_record_v2_legacy` 只把策略块（`20260826130000` L911-947）换成对它的调用，其余逐字不变，`search_path` 末尾是 `pg_temp`（与 #616 一致）。新函数不是 SECURITY DEFINER，对 PUBLIC 和 app_user 收回执行权。同时修了两处 TS 与数据库的不一致，它们会让整条查询回滚：数据库比较前不去 `www.`，SUSPENDED 的 `www.<站点>` 行会让写入抛错；用途与 APPROVED 原来对隔离行也要求，缺用途的 SUSPENDED 行同样会让写入抛错，现在只对 ACCEPTED 要求。另外，通用行只在没有逐域策略覆盖该主机时可用；逐域策略必须是最具体的，ACCEPTED 时同样具体的几行都得是 APPROVED，app_user 拿父域的 APPROVED 行绕不过子域的 SUSPENDED 行。快照形状不变，迁移前写入的行重放得到同样的快照。不改表、不改 `schema.prisma`、不动授权、不碰受保护的 Broker 文件。
  - CI 加一步「Raw source company-site policy on PostgreSQL」，放在 Site Builder 评测边界之后，用前面 Raw SQL 步骤已迁移好的库。
  - provider registry 的 public_web 说明与测试锚点更新，重新生成 `docs/backend/provider-registry.md`。
- 测试：
  - 单测 21 项。`raw-source-ingestion.spec.ts` 18 项：只有通用行时 ACCEPTED；精确域名、父域、`www.` 拼写、大写拼写、缺用途这五种 SUSPENDED 都隔离，不落到通用行；逐域 APPROVED 优先于通用行；通用行 SUSPENDED、缺用途、只有 enrichment、不存在；registry 与 trade_fair 在自己的主机上也不用通用行（附逐域策略的对照）；SUSPENDED 先于用途；`www.` 父域不压过更具体的子域；并列时 SUSPENDED 优先、与读出顺序无关。另有 seed 2 项、`public-web-raw-governance.spec.ts` 1 项。改实现前其中 13 项失败，另 8 项是行为不变的回归护栏。
  - 迁移静态合同 `raw-source-company-site-policy.migration.spec.ts` 5 项：单事务与超时；只建一个函数、替换一个函数，两条 REVOKE，没有表、数据或授权语句；legacy 正文与 `20260826130000` L707-1010 逐字相同，只有 L911-947 换成调用；新函数不是 definer、不是 STABLE、表名全限定、`search_path` 末尾是 `pg_temp`；SQL 里的保留键等于 TS 常量。
  - 真库 `raw-source-company-site-policy.postgres.spec.ts` 22 项：TS 用 app_user 读到的全部策略准备记录，经真实写入器以 app_user 写入（每次都回滚），读回的状态、处置码、保留期、快照与 TS 完全一致（14 项）；数据库独有的拒绝 7 项（通用行配非 public_web、有逐域策略时用通用行、ACCEPTED 配 SUSPENDED 或缺用途、保留期不等、存在更具体的逐域行时用父域行、ACCEPTED 时并列行有 SUSPENDED、逐域行不覆盖该主机）；函数属性 1 项。一次性容器（CI 钉的 pgvector 镜像，tmpfs，用完删除）上先只部署 main 的迁移：9 项失败（6 项一致性用例在写入时抛错；拒绝用例里 1 项没有拒绝，1 项在对照步骤就因旧写入器不认 `www.` 拼写而抛错；1 项函数不存在）；加上新迁移后 22 项全部通过。
  - 变异：把迁移里通用行的 provider 检查、逐域行的覆盖检查各删掉一次，都只有对应的那 1 项失败。
- 部署：迁移与镜像在同一窗口上线，换的时候不能有 run 在跑；迁移按名称顺序部署，#616 的 `20261009160000_…` 与 admission lease 的 `20261009170000_…` 在本迁移之前。新镜像启动、relay 完成 seed 之前，public_web 记录仍按缺策略隔离（fail-closed）。
- 未做：下游抓取（官网画像、信号富集、网站监控）不读通用行，仍按 Broker 的 advisory 规则放行（产品负责人答复：不约束下游）；public_web 写 field_evidence 的许可是 `licensed`、与 registry 的 `SOURCE_SPECIFIC` 不一致，另开小改；`source_policy.domain` 的格式 CHECK 以后再做；app_user 对 `source_policy` 与 `data_provider` 的写权限由另一个 PR 收回。部署后用同一个 ICP 跑有界样本，需要单独授权。

## 2026-10-09 · Leave an in-flight repair wire to its owner

- 起因（#610 第三轮独立复审，改动前就有）：建站付费路径上，结构化输出的修复调用拿到 `ProviderWireInFlightError`（修复用的物理调用已不是 `ALLOCATED`，归别人处理）时，Router 的修复 `catch` 把它包成 `ProviderOutputUnresolvedError`。付费路径专门处理「调用进行中」的分支（不结算、保留预留）因此认不出，Router 转而按两次调用去结算这次支出。
- 改动：修复 `catch` 把 `ProviderWireInFlightError` 与 `ExternalActionDeniedError` 一样原样抛出。付费路径于是记 `MODEL_WIRE_IN_FLIGHT` trace，抛 `PaidOperationUnknownError(MODEL_WIRE_IN_FLIGHT)`，不结算、不停用付费调用，与首次调用遇到「调用进行中」时一致；AiTask 把它当终态，不换模型。
- 首次物理调用的结算不受影响：修复调用能分配之前，首次调用的精确回执已由 provider 写入并终结，数据库的分配函数也要求首次调用已结算。支出保持 `RESERVED`，两次调用的预留原样占着，由终结修复调用的一方（目前是 provider-spend 恢复任务）按持久回执结算，首次调用的费用不会丢。改动前 Router 会以 `FAILED`、`call_count` 2 去结算：真库守卫会拒绝（实际物理调用只有 1 次），随后以 `MODEL_SETTLEMENT_DATABASE_ACK_UNKNOWN` 停用整个 BuildRun 的付费调用，`MODEL_WIRE_IN_FLIGHT` trace 也丢了。
- 可达性：按现有 SQL，只有恢复任务把分配后满 24 小时仍未发出的修复调用收为 `NOT_DISPATCHED`、又还没结算支出时才会出现，属于防御性修复。
- Router 是受保护文件：复核追加到 `docs/evidence/execution-authority-fence-review-20261001.md`，指纹 `c9fc50b3…` → `bf31b8ee…`。独立复审（只读代理）没有 CRITICAL、HIGH 或 MEDIUM。LOW 五项中，复核记录里改动前后果的细节与代码注释的措辞已改正；相邻的修复准备路径、恢复任务少数情况下停在未结算这两项都不比改动前差，记在复核记录里。
- 测试：新增 3 项，改动前都失败（拿到包装后的 `ProviderOutputUnresolvedError`）。settlement-v1 照真实 provider 的 `READBACK_ONLY` 走一遍：首次调用的回执与终结各写一次，修复调用不终结，不结算支出、不停用付费调用；付费门夹具下同样不结算，trace 为 `MODEL_WIRE_IN_FLIGHT`；非付费路径上调用方拿到的就是原来那个实例。模型网关、执行预算、AiTask 与付费门相关测试 767 项通过，执行授权策略检查 16 项通过。

## 2026-10-09 · Public-web search results fit their durable contract

- 起因（2026-10-09 xin 实测）：
  - 卖方 #15 的发现 run 启动 18 秒即失败。第一条公开网页查询的第一次 SearXNG 搜索就报 `BUDGET_OPERATION_REPLAY_UNAVAILABLE`，重试也一样，预算操作停在 RESERVED。
  - 原因是 ToolBroker 要把搜索结果投影成持久结果 `searxng-search/v1`：每条只允许 `url`、`title`，最多 20 条，而且是封闭记录，多余字段直接拒绝。8 月 21 日的治理加固定下这份契约，并有测试明确拒绝摘要。但 `searxng.search` 工具一直原样返回 SearXNG 的结果：每页 35–45 条，每条带 `content`、`engines`、`score` 等 20 多个字段。投影因此每次都失败，broker 按设计报错，也不允许再发第二次物理请求。
  - 8 月下旬 broker 开始执行这份契约以来，凡是在 run 预算内调用这个工具都会失败：公开网页发现一次都跑不通，名录源（xin 上未启用）也一样。建站品牌调研走付费账本路径，只持久化来源站点、不做投影，不受影响。之前没有发现，是因为 xin 上第一次真实发现 run 在 10-08，那次的两条查询都走公司注册源，不调用搜索。
- 改动：
  - `searxng.search` 的输出直接按持久契约整理：
    - 每条只保留 `url` 与 `title`，最多 20 条。
    - `url` 缺失、超过 2,048 字符，或不是投影接受的文本（非 NFC、含 NUL 或孤立代理项）时，整条丢掉，不改写网址。
    - `title` 转成投影接受的文本：去掉 NUL，孤立代理项换成 U+FFFD，再做 NFC 规范化；超过 2,000 字符时截断，不拆开代理对。以前只要一个标题不合规，整页搜索就会投影失败。
    - 领英个人主页（`linkedin.com/in/`、`/pub/`）和 XING 个人主页（`xing.com/profile/`）整条丢掉：它们的网址和标题写出具体的人。工具声明不含个人数据（`personalData: false`），而这些结果会被持久保存，且不能按数据主体请求删除。公司主页（如 `linkedin.com/company/`）保留。
  - 摘要和引擎元数据不再离开工具。在通用预算路径上，现场结果与重放恢复的结果完全一致。
  - 工具输出类型改为只含 `url` 与可选 `title` 的 `SearxngSearchResult`。公开网页与名录源按这个类型读取结果，名录源对缺失的标题补空串。
  - 公开网页判站的证据从「标题 + 摘要 + URL」变为「标题 + URL」：去掉每条命中里恒为空的「摘要」行，提示词和 `discovery.extract_company` 任务说明同步改为「标题与 URL」。
- 测试：
  - `builtin-tools.searxng.spec.ts` 共 5 项：
    - 43 条真实形状结果只剩 `url`/`title`、共 20 条、不含摘要里的人名与邮箱，且能通过投影；
    - 缺失或超长的 `url` 被丢掉，超长 `title` 被截断；
    - 恰好处在上限的 `url`（2,048）和 `title`（2,000）原样保留；
    - NFD、OHM SIGN、NUL、孤立代理项、跨截断点的表情符号都被整理成可投影的标题，网址不合规的整条丢掉；
    - 个人主页在取前 20 条之前被丢掉，公司主页保留。
  - 公开网页判站的提示断言不再出现「摘要」。上面的 Unicode、个人主页两项和这条提示断言，在改动前都失败。
  - 另用 xin 本机的真实 SearXNG 核对：卖方 #15 计划里的搜索串，改动前 15 次全部投影失败，改动后每次 20 条、全部通过。独立复审经真实 ToolBroker 与重放路径跑了 3 条查询，现场与重放结果一致。
- 未做：要不要把截短、去除人名后的摘要也纳入持久契约，以提高判站质量。这需要改 8 月定下的数据最小化规则，留给 owner 决定。

## 2026-10-09 · Keep source_policy and data_provider read-only for app_user

- 起因（2026-10-09 xin 只读核查，owner 当天决定「收回，只留读」）：
  - `global_dev` 上 app_user 对 `source_policy`、`data_provider` 有 SELECT、INSERT、UPDATE、DELETE。两张表的建表迁移本意只给 SELECT（`20260706164026` 第 35 行、`20260706160025` 第 253 行），但更早的 `20260706033625_rls_and_app_role` 设了默认权限：owner 以后建的每张表都自动给 app_user 增删改查。全新库（CI）也是这样。
  - 两张表都没有 RLS。`source_policy` 是 Raw 摄取与 ToolBroker 的逐域放行/封禁名单，`data_provider.status` 是数据源开关（新数据源以 DISABLED 播种，真测后才改 ENABLED）。能以 app_user 执行 SQL 的会话（例如 SQL 注入）可以放行任意域名、打开 DISABLED 的数据源。site-build provider-wire 登录是 app_user 的成员，也继承了这些写权限。
- 改动前先核对写入路径：两张表只经 owner 连接（`DATABASE_URL`）写入。运行时是 outbox relay 与 worker 启动时的播种（`provider.registry.ts` 的 `seed()`、`sanctions-seed.ts` 的 `seedSanctions()`），此外只有 Copy Sonnet 评测种子脚本（专用 owner 连接，拒绝 app_user）和 `apps/api/scripts/verify-*.mts` 运维脚本。应用代码没有以 app_user 写这两张表，也没有对它们加行锁（行锁要 UPDATE 权限）。截至 main，数据库里引用它们的函数只有 `write_raw_source_record_v2_legacy`，它是 owner 为 `global` 的 SECURITY DEFINER。`packages/db/test` 里写这两张表的夹具都以 `global` 执行。四个运行时角色、platform writer 和它们的登录（含 provider-wire 登录）在 `global_dev` 上都没有直接授予的表级或列级权限，也不能 SET ROLE 到 owner 或超级用户。
- 改动：
  - 新迁移 `20261009190000_governance_tables_app_user_read_only`：单事务，`lock_timeout` 5 秒、`statement_timeout` 30 秒。对两张表从 PUBLIC、app_user、四个运行时角色和 `execution_budget_platform_writer` 收回 INSERT、UPDATE、DELETE、TRUNCATE、REFERENCES、TRIGGER（表级收回同时去掉同类的列级权限），app_user 保留 SELECT。最后检查这些角色和它们的全部成员（运行时登录、platform writer 登录、provider-wire 登录）：不论直接授予、经 PUBLIC、经成员继承、只授在某一列上，还是能 SET ROLE（或给自己授予它管理的角色）到有写权限的角色、owner 或超级用户，都算还能写，这时报 `GOVERNANCE_TABLE_WRITE_PRIVILEGE_REMAINS` 并列出角色，整个迁移回滚。不改数据、表结构和默认权限。
  - 新增真库用例 `governance-table-privileges.postgres.spec.ts` 和 CI 步骤「Governance tables read-only for app_user on PostgreSQL」，放在 Site Builder 评测边界之后。用例检查四件事：app_user 只有 SELECT（列级权限也算）；除表 owner、超级用户和 PostgreSQL 内置的 `pg_*` 角色外，没有任何角色能直接或经 SET ROLE 写这两张表；没有视图或规则引用这两张表（默认权限也会给 app_user 新视图的写权限，视图以视图 owner 的身份写底表）；以 app_user 连接真去执行 INSERT、UPDATE（改的就是 `review_status` / `status` 这两个开关列）、DELETE、TRUNCATE 都报 permission denied，读照常。两个连接地址只给一个时用例报错，不会静默跳过。
- 部署：
  - 迁移与镜像在同一窗口上线，迁移按名称顺序执行。运行时拿最后执行完的迁移与镜像里名称最新的迁移比对，所以已有库（xin）上不能先单独执行本迁移、再执行名称更早的 `20261009160000_security_definer_search_path_pg_temp`（#616）、`20261009170000_discovery_run_admission_lease`（分支 `claude/discovery-run-admission-lease`）、`20261009180000_public_web_company_site_source_policy`（分支 `claude/public-web-company-site-policy`）：那样会以 `MIGRATION_REVISION_MISMATCH` 拒绝启动。要么等它们先上线，要么在同一次 `migrate deploy` 里一起执行。这条规则没有门禁强制。
  - 如果本迁移先合并、而且先上线了，那三个迁移就必须改名，排到 `20261009190000` 之后再上线；#616 改名还要同步改它静态检查里的 `HARDENING_MIGRATION` 和 140 的计数。最省事的是让本 PR 最后合并，或者与它们在同一个窗口一起上线。
  - 自检失败时 Prisma 会把本迁移记为失败，之后的部署都会停住（P3009）：先收回报出的权限，再 `prisma migrate resolve --rolled-back 20261009190000_governance_tables_app_user_read_only`，然后重新部署。`global_dev` 按上面的核对不会触发。
- 测试（一次性容器，与 CI 同一 pgvector 镜像，tmpfs，只绑 127.0.0.1）：
  - 只跑 main 的迁移时，新用例的权限检查与写入尝试全部失败。app_user 实际能把 DISABLED 的数据源改成 ENABLED、把全部 policy 改成 APPROVED、登记新域名、删光 `source_policy`。
  - 同一个库加跑新迁移后，4 项全部通过，上面这些写法都报 permission denied。owner 播种（registry 与 sanctions）照常，先删掉一行再播种也能补回；同样的播种改用 app_user 会被拒绝。
  - 从零迁移、按 CI 顺序开通运行时角色后，新 CI 步骤原样通过；runtime lease、provider-wire、platform writer 三个权限验证脚本照常通过；不带环境变量时用例跳过。
  - 迁移自检：预先给运行时登录直接授予 INSERT、只在 `status` 列上授予 UPDATE，让运行时登录能 SET ROLE（不继承）到一个有 INSERT 的角色，或者只持有该角色的 ADMIN 选项（它可以先给自己授权再切换过去），四种情况迁移都报错，权限保持原样。app_user 自己的列级 UPDATE 会被表级收回一并去掉。迁移重复执行没有副作用；另一个会话对两张表持有 ACCESS EXCLUSIVE 锁时，迁移照样在 240 毫秒内完成。
  - 用例自检：迁移之后再给 app_user 列级 UPDATE、建一个 `source_policy` 上的视图、或让运行时登录能 SET ROLE 到写入角色，用例都会失败。
- 未做：
  - `_prisma_migrations` 应优先处理：全新库上 app_user 也能写它，而运行时就绪门与 provider-wire 的就绪检查都信任这张表里的迁移记录。
  - xin 的 `global_dev` 另有 17 张表的 app_user 权限比迁移的结果宽，例如 `jurisdiction_policy`、`policy_decision_log`、`deletion_receipt`、`brand_profile*`、`site_*` 快照表。按各迁移的执行时间推断，7 月 22 日之后、8 月 31 日之前有人对全部表重新授过权。只有 xin 这样，全新库是对的。怎么修复要 owner 决定。
  - 全新库上 app_user 对另外 14 张没有 RLS 的表也有增删改，其中 `sanctions_source`（制裁名单源开关）、`sanctions_entity`（名单本身）、`canonical_taxonomy`、`term_alias` 与这次的问题同类。这次没有动，需要 owner 逐张决定。
  - 默认权限没改：owner 以后新建的表和视图仍默认给 app_user 增删改，只读的平台表要在建表迁移里显式收回；新用例只盯这两张表。

## 2026-10-09 · Record the real source page and drop mangled or off-domain public emails

- 起因（2026-10-08 独立复审，#609 待续里列的三项）：手动联系人发现 `discoverContacts` 抓公司首页和最多两个联系、Impressum、关于、法律页，用 `extractPublicContacts` 抽邮箱，再由 `buildPublicContacts` 建联系人。复审发现三处缺陷：抽邮箱的正则只认 ASCII，又会从词中间开始匹配，`müller@acme.de` 被抽成 `ller@acme.de`，`Jörg.Schmidt@` 被抽成 `rg.schmidt@`，错地址作为个人联系人挂到公司名下；个人邮箱的 `sourcePage` 一律记首页，而抽取结果本来就带着邮箱所在的页（多半是 Impressum），GDPR Art.14 要说明的来源因此不准；页面上其他域名的邮箱（建站公司、外部数据保护官、gmail）也被当成这家公司的联系人。
- 改动：
  - 抽取正则不再从词中间开始：前一个字符是拉丁字母（含变音字母）、组合附加符、数字或本地部分符号时，不从这里开始匹配，中间隔着软连字符、零宽空格这类隐形格式字符也一样；前面是「字母 + 撇号」时也不开始，撇号认 `'`、`’`、`´`、`ʼ` 等常见写法（`o'brien@`、`O´Brien@` 不再变成 `brien@`）。本地部分含拉丁变音字母的地址因此整条丢弃，不保留原样：`cleanEmail`、禁联规范化与邮箱验证都只认 ASCII，原样地址在持久化时会被判无效，也加不进禁联名单。百分号编码的本地部分（`mailto:m%C3%BCller@…`）和以 `.` 开头的本地部分同样丢弃。中文、俄文等非拉丁文字紧贴地址时按文字边界处理，`邮箱sales@…` 照常抽取；代价是非拉丁字母与 ASCII 混在同一个本地部分时（真实地址里极少见）会从边界处切开，切出以 `.` 开头的片段时丢弃。复审建议的 `(?<![\p{L}\p{N}._%+-])` 挡不住分解写法的变音（u + U+0308）和 `o'brien@`，还会漏掉紧贴中文的地址，所以没有照搬。
  - `buildPublicContacts` 只留公司域名或其子域上的邮箱。两边都先用联系人持久化判域名禁联的同一套规范化（小写、去 `www.`、国际化域名转 ASCII）再比较，`notacme.de`、`acme.de.evil.com` 都不算。其他域名的地址直接丢弃、不存；先筛再取前 5 个，丢弃的地址不占名额，电话给第一个真正留下的联系点。
  - 个人邮箱的 `sourcePage` 改为该邮箱实际被抓到的页（同一地址出现在多页时取先抓到的页，首页在前），并按公司来源的同一规则（`provenanceUrl`）去掉账号口令、查询串与片段。这条规则也会把路径里像邮箱或长串数字的片段打码，这样的来源页 URL 打不开。说不出来源页的个人邮箱不存；抓到的页都是 http(s) 地址，实际不会发生。抽取结果本来就带 `sourceUrl`，`PublicContact` 与联系人记录的结构都不变。
- 影响范围：联系人发现只有手动接口 `discoverContacts` 走这里，它要求显式的合法依据；发现 run 不受影响。卖方企业理解（`persistPublicContacts`）用同一个抽取器，只受第一项影响：卖方官网上的 `müller@` 不再被存成 `ller@`。已核对 xin 的 `global_dev`：`canonical_contact` 为 0 行，卖方公司档案里存的公开联系方式也为空，不需要处理存量。
- 测试：新增 12 项。抽取器 5 项：`müller@`、`Jörg.Schmidt@` 整条不抽，ASCII 地址不变；分解写法的变音、`o'brien@`、百分号编码都不截成半个地址；紧贴中文、俄文的地址照常抽取，混写切出的 `.petrov@` 丢弃；软连字符、零宽空格与各种撇号写法不让匹配从词中间开始；同一地址取先抓到的页。联系人构造 6 项：来源页是邮箱实际所在的页；来源页不带账号口令、查询串与片段；其他域名的地址被丢弃且不占名额；国际化域名规范化后再比较；说不出来源页的个人邮箱不存且不占名额；公司域名无法规范化时一个都不留。另有 1 项接线测试：模拟抓首页和 Impressum，个人邮箱记 Impressum 为来源，变音地址和其他域名的地址都不出现。把两个源文件换回 main 的实现跑这 12 项，11 项失败；「同一地址取先抓到的页」记录的是原有行为，前后都通过。
- 未做：
  - 官网域名和邮件域名不同的公司（官网 `acme-pumpen.com`、邮箱 `@acme.de`，或集团统一域名），邮箱现在不再收录，这多半是最常见的损失。丢弃是静默的，目前不记数量。
  - 小公司用 gmail、t-online 这类免费邮箱作对外联系方式的，这类地址现在不再收录。
  - 公司档案的域名本身是子域（如 `de.acme.com`）时，上级域名 `acme.com` 的邮箱也会被丢弃。
  - 卖方企业理解没有加域名过滤，卖方官网上建站公司的邮箱仍会进公司档案的公开联系方式。
  - 电话没有域名可比，仍把抓到的第一个电话（首页优先）给首个联系点。

## 2026-10-09 · Record a discovery run as FAILED when a stage stops it

- 起因（BI-25；2026-10-09 xin 核查）：发现工作流只在正常路径调用 `finalizeRun`。某个阶段重试用尽后失败（例如 Fit 阶段遇到被切断的模型流，或 DeepSeek 的 `insufficient_system_resource`），或者查询循环、尽力而为的阶段遇到控制错误时，工作流直接失败，`discovery_run` 停在默认的 RUNNING，也没有统计。xin 上现有 3 个这样的 run，分别在存下 0、2、1 条查询回执后中止。最近一个的 worker 日志显示，原因是查询执行报 `BUDGET_OPERATION_REPLAY_UNAVAILABLE`（控制错误）；另外两个的日志已随容器重建丢失。
- 改动：
  - 工作流把从载入计划到专利预热的各阶段放进一个 try。任一阶段抛出没被吸收、由 Temporal 上报的失败（重试用尽的活动失败、控制错误、超时或取消）时，先调用 `finalizeRun` 记 FAILED，再抛出原错误，工作流照旧失败，控制错误照旧可见。stats 带查询阶段的计数（含查询回执，形状与正常收尾一致，`finalizeRun` 的回执核对照常通过）、`queries`、`failures`，以及 `failure: { stage, errorType, control }`。三项分别是：失败的阶段；活动最后一次尝试的失败类型（沿 cause 链取第一个应用类型或代码，没有时取最内层类名，只收标识符形状的值，否则记 `UNCLASSIFIED`）；共享分类器是否判为控制错误（它从严，超时和取消也算）。不记任何错误消息。Fit 阶段丢了一次模型调用时，这里通常记的是 `BudgetOperationReplayError`，因为重试会撞上失败那次已结算的预算操作；原始原因在 worker 日志和 ai_trace 里。
  - 状态一律记 FAILED，不记 PARTIAL。活动失败时工作流拿不到结果，无法证明这一阶段已经存下多少。FAILED 不改计划状态，也不写 QualifyRequested，控制错误不会触发后续工作。计划虽保持 READY，目前却不能用新授权再执行一次：预算账户按计划 ID 生成，仍绑定旧授权，`open_authorized_tool_budget_v1` 会报 `EXECUTION_BUDGET_GRANT_REUSED`，要重跑得新建计划，这一限制另行处理。
  - 补写放在不可取消的作用域里，取消的 run 也能收尾；补写本身失败时，抛出的仍是阶段错误。工作流代码自身的缺陷（例如活动返回了畸形结果）不在这里收尾：Temporal 让工作流任务失败并重试，修好的版本还能接着跑。正常收尾失败时不补写 FAILED，以免覆盖一次可能已经提交的结果。授权之前的旧历史跳过，它们的 `finalizeRun` 反正会被 parked。
  - 以 patch `discovery-failure-finalize-v1` 守卫，只在出错时检查，成功的 run 不多记标记；patch 之前录下的历史重放时命令序列不变。
  - `finalizeRun` 记 FAILED 时只关闭仍是 RUNNING 的 run：已有的结果（包括已记的 FAILED）一律不改，重试也不会再发第二条 `DiscoveryRunCompleted`。锁 run 行的查询为此多取 `status` 一列。
  - `finalizeRun` 记 FAILED 时，核验结果为授权已结束（`EXECUTION_BUDGET_GRANT_EXPIRED`、`EXECUTION_BUDGET_AUTHORITY_REVOKED`、`EXECUTION_BUDGET_AUTHORITY_EXHAUSTED`）也照常写入。FAILED 不花钱，也不启动任何后续工作。发现 run 的授权只有 5 分钟（另有 60 秒时钟容差；准入租约落地后改为准入后 3 小时，见同日「Give discovery runs a 3-hour admission lease」），撤销和额度耗尽也都以控制错误结束 run；不放行的话，这些 run 照样停在 RUNNING。数据库在作用域核对和授权查找之后才会报这三种代码，所以授权仍属于本工作区；撤销和过期时不再核对 run 的预算账户，写入仍按 run 与计划 ID 绑定，受工作区行级安全约束。DONE/PARTIAL、其他核验失败和没有 v2 信封的旧调用照旧拒绝。
- 测试：
  - 工作流（模拟活动）：Fit 重试用尽后记 FAILED，查询计数与正常路径逐项一致，之后的阶段不再执行，原错误照旧抛出。计划载入、归一、Fit、富集的普通失败，查询、归一、官网画像、Fit、富集的控制错误，以及三个尽力而为阶段的控制错误，都记 FAILED 并带对应阶段。第 2 条查询遇到控制错误时保留第 1 条的回执；Raw 治理回执之前的历史不带回执字段；取消时在不可取消的作用域里记 FAILED；补写失败时抛阶段错误；正常收尾失败时不补写；工作流代码缺陷不补写，也不检查新 patch；成功 run 的收尾参数逐项不变，且不检查新 patch；没有 patch 的历史和授权之前的历史都不补写。原有的「控制错误不收尾」用例改为「记 FAILED 后抛出，从不记 DONE/PARTIAL」。
  - 工作流接真实的 `finalizeRun`：工作流建的 FAILED stats 通过回执核对并写入；数据库里有工作流不知道的回执时报漂移，不写入，抛出的仍是阶段错误。
  - 打包重放（真实 Temporal 重放器）：patch 之前「Fit 最后一次尝试失败→工作流失败」的历史照旧重放；patch 之后「Fit 失败→标记→`finalizeRun`→工作流失败」的历史可以重放。去掉 patch 守卫时两项都报不确定性错误；main 上的代码只能重放前一项。
  - 活动：三种授权结束代码下 FAILED 照常写入，计划不改，不写 QualifyRequested；已结束的 run（DONE、授权过期后的 PARTIAL、已记的 FAILED）不被 FAILED 覆盖；DONE/PARTIAL 照旧拒绝；作用域不符、授权无效、核验不可用照旧拒绝；没有 v2 信封照旧 parked。
  - 失败描述（纯函数）8 项：不复制消息和细节；取活动自身的失败类型，而不是它包着的泛化 cause；控制标记与共享分类器一致；只读数据属性；有环或过深的 cause 链有界。
- 未做：
  - Fit 活动的重试退避不改。现在两次重试之间只等约 1 秒、2 秒，但加长没用：重试时同一家公司的模型调用用的是同一个预算操作键，失败那次已经结算、没有可重放的结果，后两次尝试都会立刻报 `BUDGET_OPERATION_REPLAY_UNAVAILABLE`，退避再长也只是推迟失败。要让暂时的上游故障能靠重试恢复，得先让预算账本把「已知失败」存成可重放的结果（见 10-07、10-08 条目）。改活动选项本身不影响重放：重放只比对活动类型和顺序，不比对超时与重试策略（已有的重放测试里，查询活动按 120 秒超时录制，代码里是 15 分钟，照样能重放）。
  - 也没把这类模型失败改成不可重试。那样 stats 能直接记 `ProviderTransportError`，也省掉两次无用的尝试，但改的是 Fit 活动的重试语义，另行评估。
  - 本条合入时，发现 run 的授权只有 5 分钟。每个活动开头、每次模型或工具预留都会核验授权是否过期，所以 run 开始约 6 分钟后的第一次核验就会以 `EXECUTION_BUDGET_GRANT_EXPIRED` 失败；本次让这样的 run 记为 FAILED。之后的「发现 run 准入租约」（同日「Give discovery runs a 3-hour admission lease」）让发现 run 准入后按 3 小时租约核验；超过租约仍报同一错误码，照样记为 FAILED。
  - 仍会停在 RUNNING 的情况：授权恰好在最后一个阶段和正常收尾之间过期（正常收尾被拒）；数据库里有工作流不知道的查询回执，例如某次尝试已经提交、之后的重试又失败（回执漂移，正常收尾也一样）；工作流输入的授权本身不合法；工作流代码自身的缺陷。
  - xin 上现有的 3 个 RUNNING run 不处理。它们的工作流已经结束，不会再收尾，要清理须单独决定。

## 2026-10-09 · List pg_temp last wherever a routine sets its search_path

- 起因（2026-10-09 设计发现准入租约时核实）：只要 search_path 里没写 pg_temp，PostgreSQL 就会**最先**在当前会话的临时 schema 里找表。xin 的 `global_dev` 上，PUBLIC 有建临时表的权限，`app_user` 和运行时各登录角色都由此获得这项权限。函数里引用的表又多半不带 schema，于是：
  - `public` 下 126 个 SECURITY DEFINER 函数的 search_path 是 `pg_catalog, public`，它们以属主权限运行。能以 `app_user` 执行 SQL 的会话，只要建一张同名临时表，就能让这些函数去读伪造的行。一次性库上实测：`tool_budget_status` 读到了会话伪造的预算账户，在下游报 `TOOL_BUDGET_HISTORICAL_TERMINAL`，而正常情况下它查不到这个账户、应该返回空。
  - 另有 83 个 SECURITY INVOKER 函数（其中 21 个是触发器函数）自带同样的设置。函数自带的设置会替换调用方的设置；在 SECURITY DEFINER 函数里被调用或由它触发时，它们以那个函数的属主身份运行，同样会先找临时表。独立复审发现了这一类。
  - 利用的前提是已能以 `app_user` 执行任意 SQL（例如 SQL 注入或应用被攻破），属于纵深防御缺口。另有 42 个函数本来就把 pg_temp 放在最后；22 个没有自带 search_path 的函数沿用调用方的设置，在加固后的 SECURITY DEFINER 函数里会继承以 pg_temp 结尾的路径。
- 改动：
  - 新迁移 `20261009160000_security_definer_search_path_pg_temp`：
    - 对每个 search_path 恰为 `pg_catalog, public` 的函数或过程（不论 DEFINER 还是 INVOKER）执行 `ALTER … SET search_path = pg_catalog, public, pg_temp`，按 PostgreSQL 手册的做法把 pg_temp 放在最后。
    - 只改这一项设置，函数体、属主、易变性、安全属性和授权都不变；扩展自带的函数跳过；不动数据。
    - 迁移结束前做两项核对：所有带 search_path 设置的函数都以 pg_temp 结尾；每个 SECURITY DEFINER 函数都设了 search_path。任何一项不满足，整个迁移回滚。
  - 静态护栏 `apps/api/src/prisma/security-definer-search-path.spec.ts`：零容器，随单测一起跑。
    - 解析迁移的顶层语句，跳过注释和函数体，并处理美元引号、带 `$` 的标识符和 `E''` 字符串。
    - 此后的迁移里，凡是设置 search_path 的 CREATE 或 ALTER，都必须以 pg_temp 结尾；`DEFAULT`、`FROM CURRENT`、`RESET search_path` / `RESET ALL`，以及把整串写进一个引号（会被当成一个 schema 名）都算违规。SECURITY DEFINER 函数必须设 search_path。
    - 冻结「加固迁移及其之前」的迁移个数（140）。名字排在它前面的新迁移会直接失败：这样的迁移在已有的库上会在加固之后执行，可能把加固撤回。
  - 真库护栏 `apps/api/src/prisma/security-definer-search-path.postgres.spec.ts`，接进 CI 已有的「Raw SQL parameter types on PostgreSQL」一步。迁移后的库要满足同样两项要求；并以 `app_user` 建同名临时表复现上面的攻击，`tool_budget_status` 仍只读 `public`。
  - 手动测试 `packages/db/test/execution-budget-authority.rls.spec.mjs` 会迁移到最新状态，再检查 9 个授权函数的 search_path，期望值改为带 pg_temp。其他只验证某个迁移时点的手动测试不改。
- 测试：
  - 静态护栏 6 项：
    - 22 个解析探针，覆盖上面每种写法与 INVOKER、触发器函数；
    - 转义字符串和引号内分号不会拆错语句；
    - 旧迁移里能找到 150 多个待加固的定义，证明护栏不是空跑；
    - 冻结个数；
    - 加固迁移之后没有违规；
    - 加固迁移本身是单事务、只改设置。
  - 一次性库（CI 钉住的同一 pgvector 镜像，只绑 127.0.0.1，数据放 tmpfs，用完即删）：只跑 main 的迁移时，真库护栏报 209 个函数（126 个 DEFINER、83 个 INVOKER），攻击复现成功；加上新迁移后两项都通过。按 CI 那一步的方式再跑原有的 raw SQL 测试，也全过。
  - 与 xin 的 `global_dev` 逐个比对全部 273 个函数（迁移集相同，只少本次迁移）：函数体摘要、属主、易变性、安全属性、strict、leakproof、cost、parallel、ACL 和其他设置完全一致，只有 209 个函数的 search_path 末尾多了 pg_temp。
- 未做：
  - 没有收回 PUBLIC 在库上的建临时表权限。补齐 search_path 已经堵住这条路，两道护栏防止回退；`packages/db/test` 里几个手动安全测试正是以 `app_user` 建临时对象来证明加固有效，收回权限会让它们失去意义。以后要再加一层，可以在库级执行 `REVOKE TEMPORARY … FROM PUBLIC`。
  - 函数体里用动态 SQL 新建的函数，静态护栏看不到，由真库护栏兜底。
  - 部署：迁移要和带它的镜像在同一窗口上线，因为运行时要求库里最新的迁移与镜像的 migration_revision 一致。计划和准入租约（`20261009170000`）、来源策略（`20261009180000`）一起按名称顺序发布。

## 2026-10-09 · Skip watch registration in a worker without the platform writer

- 起因（2026-10-09 审计 app_user 写入平台表时核实）：发现 run 的倒数第二个阶段 `registerWatchesForRun` 为 Fit 判为 match、有域名、未被抑制、允许外部处理的公司注册网站监控。注册前要经 `http.get` 读 sitemap；这些读取在 run 预算下一定建预留（零成本工具也一样），又挂在公司主体上走产物路径，只要有一次读取完成就带回持久回执（404 与被 SSRF 护栏拦下的结果也会落产物）。监控是平台行，带回执的写入只能在平台写入者的事务里确认（`intent-projection.service.ts` 的 DomainAck 分支），可客户 worker 从不持有平台写入者（`worker.ts` 给发现活动的依赖里没有它）。于是注册必报 `DOMAIN_ACK_PLATFORM_TRANSACTION_UNAVAILABLE`。这是控制错误，阶段的「尽力而为」兜不住，工作流照样上抛：这样的 run 会在线索已经写入之后失败，带 `discovery-failure-finalize-v1` 补丁的记为 FAILED（阶段 `watches`）。此前没有 run 走到这一步，所以没有暴露。
- 改动：`registerWatchesForRun` 先照常数出候选公司；进程没有平台写入者时，在任何出网之前返回「候选 N、注册 0、跳过 0」，并在 worker 日志里写明原因。有平台写入者的路径不变。不改工作流，不需要 patch：活动结果的形状没变，`finalizeRun` 不校验这一项。
- 测试：新增「没有平台写入者时不注册、不读任何 sitemap」：模拟的 `http.get` 返回真实形状的结果与 http-get 产物回执。去掉守卫时活动以 `DOMAIN_ACK_PLATFORM_TRANSACTION_UNAVAILABLE` 失败（复现了上面的故障），加上守卫后正常返回、`http.get` 一次也没调。原有的「主体被拒的公司跳过」改为带平台写入者，仍走到出网那一步，且不开平台事务。发现活动、工作流授权、抑制线性化与 intent 相关 10 个文件 259 项通过；独立复审无 CRITICAL / HIGH / MEDIUM。
- 未做：
  - 发现 run 现在不再自动注册网站监控（这条路在客户 worker 里本来就走不通）。要恢复，得把注册交给持有平台写入者的平台 worker，例如由 run 只记下候选、平台侧的 intent sweep 去读 sitemap 并写监控；另行设计。平台的 4 个 schedule 目前都暂停，已注册的监控本来也不会被巡检。
  - `IntentProjectionService.registerWatch` 自身仍会先出网、落产物，最后才因没有平台写入者而失败；唯一的生产调用点已在出网前拦住。在它内部提前检查要连带改动多处依赖「有 broker、无平台写入者」的用例，留给监控注册的重新设计一并处理。

## 2026-10-09 · Give app_user only the table privileges its code uses

- 起因（设计 `docs/superpowers/plans/2026-10-09-app-user-platform-table-privileges.md`，产品负责人 2026-10-09 确认 §5 全部按建议：一次收齐、新表默认只读、要清单与真库测试、平台写入者授权另起 PR、下一个窗口上线）：
  - 基座迁移 `20260706033625_rls_and_app_role` 把当时所有表的增删改查授给 app_user，又把同样的授权设成属主 `global` 以后新建表的默认权限。之后给无 RLS 平台表写「app_user 只读」的迁移多数只 `GRANT SELECT`、没有收回其余权限，所以全新库上 app_user 也能写 15 张没有 RLS 的平台表（#619 已收回 `source_policy`、`data_provider`）：迁移账本 `_prisma_migrations`（运行时就绪门和迁移兼容核对都信它）、制裁名单两张表、词表、专利缓存刷新审计，以及本应只增不改的 Art.17 墓碑等。能以 app_user 执行 SQL 的会话（例如 SQL 注入）可以伪造迁移记录、改写制裁名单、删掉墓碑。属于纵深防御，利用前提与 #616、#619 相同。
  - xin 的 `global_dev` 另有漂移（只读查目录核实）：17 张表上 app_user 比迁移给的多出 UPDATE、DELETE（`jurisdiction_policy` 还多 INSERT），多是证据、审计、删除回执这类加固时收成只追加的表（`evidence`、`policy_decision_log`、`deletion_receipt`、`brand_profile*`、`site_*` 快照等），授权者都是 `global`。其他角色、列级权限、默认权限都与全新库一致。
- 改动前逐张核对 app_user 的写入路径，结论与设计 §2 一致：6 张只由属主或平台写入者写；10 张有生产路径以 app_user 写，各只用到部分操作（Prisma 的 upsert 要 SELECT、INSERT、UPDATE，createMany skipDuplicates 只要 INSERT，带条件的 deleteMany / updateMany 还要 SELECT）。这些表上没有以 app_user 写入的函数或触发器，也没有行锁查询。17 张漂移表的生产写入也都在迁移定义的权限之内（`evidence` 的 upsert 更新部分为空，实测只发 SELECT 和 INSERT）。
- 改动：
  - 新迁移 `20261010090000_app_user_table_privileges`（单事务，lock_timeout 5 秒、statement_timeout 30 秒，不建函数，不改数据和表结构）：
    - 16 张平台表先 `REVOKE ALL … FROM PUBLIC, app_user`，再只授代码用到的操作：`_prisma_migrations`、`canonical_taxonomy`、`jurisdiction_policy`、`sanctions_source`、`sanctions_entity` 只读；`patent_cache_refresh_audit` 无权限；`monitored_source`、`source_fetch`、`source_entity`、`source_signal`、`signal_ingest`、`term_alias`、`patent_lookup_request` 读、增、改；`source_entity_change` 读、增、删（90 天清理）；`patent_inventor_cache` 读、删（Art.17 擦除）；`patent_inventor_tombstone` 读、增（墓碑只增不改）。
    - 另 16 张漂移表（`jurisdiction_policy` 已在上面）同样先全收，再恢复成迁移定义的权限。授权语句从迁移到 #619 的一次性库导出，不手写；全新库上不改变任何东西。
    - 默认权限：属主以后新建的表对 app_user 只给 SELECT，写权限要在建表迁移里显式授予；序列的默认权限（USAGE、SELECT）不变。
    - 结尾自检：public 下每张表上 app_user 的有效权限必须与迁移里的期望表（113 张，与清单一致）完全相同。算进来的有：直接授予、经 PUBLIC、只授在某一列上，以及 app_user 沿成员关系（直接或间接，不论 INHERIT、SET、ADMIN 选项）能到达的每个角色的权限：只持有 ADMIN 选项的角色，也能先授给自己、切换过去，再往下切。这些角色里有超级用户或表属主，就算全部权限。这些角色都不能持有 WITH GRANT OPTION；给它们或 PUBLIC 的默认权限必须恰好是上面两条。表多、表少或权限不符都报 `APP_USER_PRIVILEGE_MISMATCH` 并列出差异，整个迁移回滚。`REVOKE ALL` 以属主身份执行，只能收回属主授出的权限；别的授权者授出的权限会被自检拦下、整体回滚，不会悄悄留下。
  - 权限清单 `docs/governance/app-user-table-privileges.json`：public 下每张表 → app_user 的权限（只授在列上的权限另列在 `columns`，目前没有），加上属主的默认权限；从迁移后的一次性库生成，按字节序排列。
  - 真库用例 `apps/api/src/prisma/app-user-table-privileges.postgres.spec.ts`，CI 新增一步「app_user table privileges on PostgreSQL」，放在 #619 那一步之后。两个连接地址只给一个时报错；只接受回环地址上的 `global_test`，不许带任何连接参数（`?host=` 之类会把连接改指别处），两个地址必须指向同一个库；不给时整组跳过，但清单格式检查（键有序、权限名合法、无重复）随单测一起跑。用例检查：
    - 迁移后实际权限与清单逐表一致（口径同迁移自检，含沿成员关系能到达的角色）；这些角色都不持有 WITH GRANT OPTION；默认权限与清单一致；属主现建一张表和一个序列，app_user 分别只得到 SELECT 和 USAGE、SELECT（事务回滚）。
    - 正向：以 app_user 在必回滚的事务里执行 10 张写表实际用到的写法：网站监控注册与页集合并、采集抓取与快照 diff、90 天清理（直接调 `WebsiteWatchService.purgeStaleEvents`）、信号 upsert 与账本记账（含记错误的分支）、过期翻转（直接调 `SignalIngestService.expireStale`）、别名写回、专利查询入队与读缓存（直接调 `enqueuePatentLookup`、`readPatentCache`）、Art.17 墓碑与缓存擦除。另按 claim 桥的写法，对 `claim`、`evidence` 做空更新的 upsert（新建、重放各一次）：Prisma 现在把它拆成 SELECT 加 INSERT，只追加的 `evidence` 不需要 UPDATE；哪天升级后改成 `INSERT … ON CONFLICT DO UPDATE`，这条会先在 CI 里失败。
    - 负向：清单外的 SELECT、INSERT、UPDATE、DELETE、TRUNCATE 全部报 42501：113 张表共 324 次尝试，每条都要是「permission denied for table <该表>」。语句各自只需要那一项权限、不碰任何行。
  - 运维脚本：`apps/api/scripts/verify-intent-loop.mts` 的清场和「伪造上周基线」改走 owner 连接（app_user 已不能删 `source_entity`），注册、抓取、投影仍走 app_user。其余以 app_user 写这些表的脚本（`intent-watch.mts`、`verify-signal-first.mts`、`verify-patent-cache-codex-p93.mts`、删除编排两份等）用的都是生产同样的写法，不用改；`verify-data-rights.mts` D4、`verify-site-builder-r4-a1.mts` 等「app_user 改不了只追加表」的检查，在 xin 上从此会如期被拒。
- 部署：
  - 下一个维护窗口上线（产品负责人选定），与带本迁移的镜像同一窗口，按名称顺序排在 `20261009160000`（#616）、`20261009170000`（#618）、`20261009180000`（#617）、`20261009190000`（#619）之后。运行时拿最后执行完的迁移与镜像里最新的迁移比对。窗口内不能有在跑的发现 run、删除编排或平台 schedule。
  - 最好等那 4 个迁移先随上一个窗口上线：这样本迁移自检失败时什么也不改，库仍停在 `20261009190000`，旧镜像照常能用。Prisma 会把本迁移记为失败、之后的部署停住（P3009）：按报出的差异修正权限，`prisma migrate resolve --rolled-back 20261010090000_app_user_table_privileges`，再重新部署。若 5 个迁移挤在同一次 `migrate deploy` 里，前 4 个会先提交，自检一失败，新旧镜像都会以 `MIGRATION_REVISION_MISMATCH` 拒绝启动，直到修正后重新部署。
  - 窗口前用同一口径对 `global_dev` 做只读预检（app_user 连接、只读事务、只查目录）。2026-10-10 已做一次：表集合与清单完全相同；只有 #619 和本迁移改写的 34 张表权限不同（都是多出的写权限），其余 79 张一致；没有只授在列上的权限，没有 WITH GRANT OPTION，app_user 没有任何成员关系，默认权限只多了要收回的增删改。窗口前再跑一次，出现别的差异先处理。
  - 平台写入者的表授权（设计 §3.4 G1）不在本 PR，另起一个 PR；恢复平台 schedule 或启用 `google_patents` 之前必须先合。
  - 回退：只改授权，回退是一个把权限授回的新迁移；紧急时可由属主手工 `GRANT`，事后补迁移。数据不受影响。
- 测试（一次性容器，与 CI 同一 pgvector 镜像，tmpfs，只绑 127.0.0.1，用完即删）：
  - 只跑 main 的迁移时新用例 12 项里 4 项失败：清单比对列出上面 15 张表多出的写权限，默认权限仍授增删改，新建表 app_user 能增删改，负向尝试里 22 次本应被拒的 UPDATE、DELETE、SELECT 被允许、6 次 INSERT 被允许（只因非空约束失败）。同一个库加跑本迁移后 12 项全部通过。
  - 迁移自检：分别注入 15 种漂移后重跑迁移，都报 `APP_USER_PRIVILEGE_MISMATCH` 并点名那一项；表权限、默认权限、成员关系和事先多授的一项写权限都保持原样，证明整体回滚。15 种是：未涉及的表上多一项表级权限、只授在某一列、授给 PUBLIC、经继承的成员身份、能 SET ROLE 但不继承、只持有 ADMIN 选项、持有 ADMIN 选项的角色还能再 SET ROLE 到有写权限的角色、能 SET ROLE 过去的角色持有 WITH GRANT OPTION、默认权限授给 app_user 能到达的角色、能 SET ROLE 到属主（超级用户）、不限 schema 的默认权限、给 PUBLIC 的默认权限、少一项应有权限、app_user 自己持有 WITH GRANT OPTION、清单外的新表。清掉注入后迁移可重复执行。独立复审发现初版只看一跳的 SET 与 ADMIN，漏掉「ADMIN 之后再往下切」的链（复现：只持有某角色的 ADMIN 选项、该角色能 SET ROLE 到超级用户时，初版自检放行）；现已改成沿成员关系的全闭包，grant option 与默认权限的检查也扩到这些角色。
  - 用例自检：迁移后分别注入 9 种漂移（多一项表写权限、只授在某列、默认权限给写、经 SET ROLE 获得写、ADMIN 之后再往下切获得写、能 SET ROLE 过去的角色持有 grant option、默认权限给 app_user 能到达的角色、收回一项需要的写、app_user 持有 grant option），用例都会失败，清掉后恢复通过。连接地址带 `?host=` 或两个地址指向不同的库时，用例直接报错。
  - xin 预演：从全新库迁移到 xin 当前的 `20260925090000`，按只读查到的 xin 目录重放 17 张表的漂移授权和运行时登录角色的成员关系，与 xin 比对表权限（全部角色）、默认权限、成员关系都一致；然后一次 `migrate deploy` 跑完 5 个待上线迁移，全部通过；新用例 12 项、#619 的用例 4 项通过；最终权限与全新库逐表一致。
  - 按 CI 顺序在一次性库上重放 build-test 的全部 PostgreSQL 步骤（运行时登录、provider-wire、平台写入者的开通与核验，原有真库用例，#619 与本 PR 的新步骤）：全部通过。
- 未做：
  - 平台写入者的表授权（G1），见上。
  - 序列不在清单里：app_user 对 2 个序列只有基座迁移给的 USAGE、SELECT，代码不用 setval；需要时再纳入。
  - 新表默认只读会把「忘了授写」推到运行时：清单从迁移后的库生成，忘了授写时清单与库一致、CI 照样绿，要到代码运行才报 42501。今后新建 app_user 要写的表，在建表迁移里显式授权、同一 PR 更新清单，并在本用例里补一条以 app_user 执行的正向写入。
  - `term_alias` 由租户触发的模型结果写进跨租户共享的别名表（设计 §8），权限收窄后仍是数据投毒面，另议。
  - 采集与监控四张表在「无回执」分支以 app_user 写平台数据。网站监控注册没有回执时（没有 broker，或 sitemap 请求全部失败、退回只监控首页）以 app_user 建 `monitored_source`；#620 合入后客户 worker 不再注册，到时 app_user 是否还需要 INSERT，与 G1 一起再看。G1 之后是否统一由平台写入者写、app_user 只留 SELECT，另议。
  - 用同一份清单对 xin 做只读漂移比对、接进 `gctl doctor`（工作区工具，不在本仓库）。
  - #619 的迁移自检同样只看一跳的 SET 与 ADMIN，#616、#619 的真库用例同样不拒 `?host=` 连接参数；本 PR 未改。

## 2026-10-08 · Treat single-name mailboxes as personal contacts

- 起因（2026-10-08 BI-14 公司联系点设计调研）：手动联系人发现用的 `buildPublicContacts` 靠 `/^[a-z]+[._-][a-z]+$/i` 判断邮箱是否属于个人，只有 first.last 这种形状才算。`max@`、`mueller@`、`mm@` 这类单名或缩写邮箱因此被存成「公开联系点 (max@)」，不标个人数据，也不写 person.profile 证据。这违背 GDPR Art.4 和「只做公司级数据」的红线。仓库其他地方（采集清洗 `cleanEmail`、联系人持久化、邮箱验证合规门）早已改用白名单：只有职能邮箱算非个人。
- 改动：
  - 改用 `cleanEmail(...).kind` 判断。职能邮箱白名单里的地址算公司联系点，包括 `sales2@`、`info-eu@` 这类带数字或地区后缀的写法；其余一律按个人处理，标 `personalData` 与 `sourcePage`。
  - 只有 first.last 形状继续反推姓名。其他个人邮箱推不出「名 + 姓」，改用占位名「个人邮箱 (max@)」。独立复审发现：如果从 `mueller@` 推出 "Mueller"，邮箱格式学习会把这类单名当成 `first` 命名法的样本；`datenschutz@`、`technik@` 一多，就会压过真实的 `j.schmidt@`。占位名和旧的「公开联系点」一样解析不出姓名，不会进入学习。
  - 输出结构不变，仍然只有首个联系点带电话。
- 影响范围：只有手动联系人发现接口 `discoverContacts` 调用它，该接口要求显式的合法依据；发现 run 不经过这里。xin 的 `global_dev` 里没有已存的联系人，不需要处理存量。
- 测试：新增 5 项，分别覆盖：单名与缩写判为个人并给占位名（改动前失败）；白名单职能邮箱仍是公司联系点；单名个人邮箱不进入格式学习，`j.schmidt@` 仍学成 `first.last`；大小写、加号地址与白名单外的职能词；`max__x@` 给占位名。把实现改回「所有个人邮箱都反推姓名」时，后 4 项中的相关断言失败。
- 已知取舍：白名单外的职能邮箱（如 `datenschutz@`、`technik@`）也按个人处理，宁可多标、不能漏标；补充白名单会同时放宽邮箱验证合规门，留作单独评估。

## 2026-10-08 · Prepare every raw SQL statement against the real schema in CI

- 起因：xin 上第一次发现 run 因 `uuid = text` 失败（#605）。单测里 `$queryRaw` 都是模拟的，参数类型、列名、函数签名从来不在真库上检查，这类错误因此能在 main 上待一个多月。
- 新增真库测试 `apps/api/src/prisma/raw-sql-parameter-types.postgres.spec.ts`。它用 TypeScript 类型检查器收集 `apps/api/src` 里全部原生 SQL：`Prisma.sql`、`$queryRaw`、`$executeRaw`，连同嵌套片段、条件分支、`Prisma.join` 以及 `.map` 生成的片段。每个参数按 Prisma 实际绑定的类型声明（字符串 `text`、整数 `bigint`、日期 `timestamptz`、对象 `jsonb` 等），在已迁移的库上 `PREPARE` 后立即 `DEALLOCATE`，不执行、不写入。172 条语句、193 个变体全部检查，一条都不跳过。另一项测试在真库上实测 Prisma 的绑定类型，防止升级后检查器失准。CI 在「Suppression lock」之后新增一步运行它。
- 它一上线就查出 8 处此前没人发现的缺陷，本次一并修复：
  - 发现 run 建档时计算证据清单摘要的 SQL 少一个右括号。这是 c9723c8d 引入的，08-31 起每次执行都是语法错误，`canonicalizeRun` 必然失败。现在改成与数据库函数相同的表达式。
  - 预算账本「标记结果未知」与两版「带产物清单结算」，把 HTTP 状态当 `bigint` 传给 `smallint` 参数，只要状态不是 null 就找不到函数。加 `::smallint`。
  - 通用产物写入（工作区、平台）同样加 `::smallint`。
  - 个人产物清理的「完成」「重试」把尝试次数当 `bigint` 传给 `integer`，原始数据过期把条数上限也传错了。加 `::integer`。
  - 建站成本对账巡检的翻页条件含聚合 `MAX(...)`，却放在 WHERE 里，带游标翻到第二页必然报错。移到 GROUP BY 之后的 HAVING。
- 验证：撤掉 #605 的 `::uuid` 或撤回括号修复时，新测试分别报 `uuid = text` 和语法错误；相关模块单测 5,707 项通过。

## 2026-10-08 · Room for reasoning tokens in acquisition model tasks

- 起因（2026-10-08 xin 实测）：换到含 #602 的镜像后，卖方 #8、#9 的 ICP 设计连续两次失败，网关记 2,654 输入、4,096 输出，正好卡在任务上限，后端报 `ProviderOutputError`（输出被截断），每次仍按网关口径扣约 0.51 美元。10-07 卖方 #7 那次用了 3,510，已经贴近上限。deepseek-v4-pro 是推理模型，推理 token 与答案共用同一个 `max_tokens`。
- 改动：获客注册表里走 deepseek-v4-pro 的 11 个任务（企业理解 3 个、ICP 设计、查询规划、分类归一、资格判定、公司抽取、名录抽取、贸易角色、决策人抽取）输出上限统一为 8,192，原来 10 个是 4,096、贸易角色是 2,048。上限只约束单次调用，网关按实际生成的 token 计费，没截断的调用花费不变；报价按 `maxCostCents` 计，金额不变，只是策略摘要随之变化。
- 这对发现 run 同样重要：抽取、资格判定一旦截断就是模型失败，按现有规则会让整个 run 中止。
- 测试：注册表新增 1 项（11 个任务都在 deepseek-v4-pro 上且上限为 8,192）；ICP 预算包络与运行时桥接两项改为读到 8,192，越界反例改为 8,193。

## 2026-10-08 · Keep person data out of the trade-role model prompt

- 起因（2026-10-08 设计调研）：官网画像在规则判不出贸易角色时调用 `discovery.classify_trade_role`，提示里直接拼了首页前 12,000 字与 Impressum 前 4,000 字的原文。Impressum 按法律要写代表人、负责人和联系邮箱，所以总经理姓名、个人邮箱与电话会原样发给模型网关；当前模型经 OpenOx 调用 DeepSeek，属于第三国处理。存储侧早已脱敏（证据只留公司级片段），发给模型的这一侧没有。
- 改动：发给模型前先删人员行（沿用 `PERSON_MARKERS`，另加 Vertreten durch / vertretungsberechtigt / Verantwortlich / Prokurist / Datenschutzbeauftragter / Kontaktperson 等标签；标签单独成行时连下一行的值一起删），再用 `scrubPiiKeepingTaxIds` 给邮箱、电话打码，商业登记号与增值税号保留。规则分类与 Impressum 标识符解析仍在本机读原文，不受影响。
- 测试：新增一项（先红后绿）：含代表人、负责人、个人邮箱与电话的首页和 Impressum，发给模型的提示里不出现这些值，HRB 与 USt-IdNr. 仍在。

## 2026-10-08 · Planning tasks get the provider's 16,000-token output ceiling

- 起因（2026-10-08 xin 实测）：#604 把 pro 任务的输出上限放到 8,192 后，卖方 #10 的查询规划输出了 10,568 个 token 仍然成功，卖方 #11 的规划却在 8,192 处被截断（134 秒，`ProviderOutputError`，接口返回 500）。OpenOx 对 `max_tokens` 的执行前后不一致，规划类回答本身也可能超过 8,192。截断的代价不止一次调用：同一个 ICP 的规划请求共用一个预算账户，调用过模型后这个 ICP 就再也生成不了计划；ICP 设计同理，一家卖方只有一次设计机会。
- 改动：`icp.design` 与 `discovery.query_plan` 的输出上限改为 16,000，即网关 provider 允许的最大值；其余 9 个 pro 任务仍是 8,192。网关按实际生成的 token 计费，报价仍按 `maxCostCents` 计，金额不变，只是策略摘要随之变化。
- 运行时：按约每秒 72 个 token 估算，写满 16,000 个 token 约需 225 秒。注册表里这两个任务的 `timeoutMs`（180 秒）没有代码读取，实际生效的是进程级 `MODEL_TIMEOUT_MS`；xin 上是 240 秒，换到本镜像时提到代码允许的最大值 300 秒。
- 测试：注册表测试拆为两项（9 个任务 8,192，两个规划任务 16,000）；ICP 报价包络读到 16,000。

## 2026-10-08 · Pin legacy-javascript against dist-tag drift in the OCI build

- main 自 698b4518 起，CI 的「Build and inspect immutable OCI runtime」报 `runtime SBOM omits installed packages: legacy-javascript@0.0.3`（64614baf 时还是绿的），会构建镜像的 PR（改了代码的 PR）的 `build · typecheck · test` 也随之变红。原因：`@paulirish/trace_engine` 0.0.65（经 lighthouse）把 `legacy-javascript` 声明为 dist-tag `latest`，上游在 10-07 22:13Z 与 10-08 00:08Z 先后发布 0.0.2、0.0.3；镜像构建以全新元数据缓存执行 `pnpm deploy`，装进 0.0.3，而 SBOM 按锁文件记 0.0.1。同样以 `latest` 声明的 `third-party-web` 早已用精确 override 钉住（见 `dependency-security-remediation.spec.mjs` 的 deploy 回归测试）。
- 根 overrides 新增 `legacy-javascript` 0.0.1，即锁文件里已审过的版本，锁文件只改 overrides 段。本机用空缓存执行 `pnpm --filter @global/api deploy --prod --frozen-lockfile`：main 上装进 0.0.3，加 override 后为 0.0.1（`third-party-web` 两次都是 0.29.2）。新增防回归测试：trace_engine 以 dist-tag 声明的依赖必须都有精确 override，且等于锁文件中唯一的解析版本；去掉这条 override 时测试失败。
- 生产审计零 advisory（830 个依赖）；基线按锁文件变动重新绑定到钉版提交，`valid_until` 不变；旧绑定 `BASELINE_SOURCE_LOCK_MISMATCH`、新绑定 `FRESH`，见[回执](../evidence/security/20261008-legacy-javascript-dist-tag-pin.json)。Copy fixed-source 回执只重签指纹。
- 跟进（独立审查，#603）：锁文件不记录依赖的声明写法，所以防回归测试同时钉住 trace_engine 的已审版本 0.0.65。将来 lighthouse 带进别的 trace_engine 版本时，测试会失败，要求先复核它以 dist-tag 声明的依赖、同步名单与 override，再更新已审版本。这道守卫只覆盖 trace_engine；别的包新增 dist-tag 依赖，仍要等 OCI 构建的 SBOM 检查发现。本条目第一项的受影响范围已就地更正为「会构建镜像的 PR」（纯文档 PR 不跑 OCI 那一步）；同时修正了安全合同页的当前合同段、依赖刷新手册，以及 deploy 回归测试的注释。

## 2026-10-08 · Keep Chinese words out of discovery search strings

- 起因（2026-10-07 xin 实测，卖方 #7 的查询计划）：6 条查询里，公开网页查询的关键词约一半是中文，例如「工业泵 分销商 进口商」。规划器的提示把关键词写成「含本地语言变体」，又要求中文 rationale，ICP 本身也是中文，于是模型中德混写。公开网页源取前 3 个关键词，再拼上过滤条件里的产品与行业词（按设计可以是中文，供规范词表映射），所以德国市场的 3 条搜索里有 1 到 2 条是中文，抽取费基本白花。名录源也会把中文行业词和「德国」这样的地区词拼进检索串。
- 规划提示按 ICP 的目标市场写明关键词语言，例如「必须全部用德语书写……不得出现中文」；涉及多种语言时要求每条查询的关键词用该查询所在国家的语言；认不出市场时要求用当地语言、无法确定时用英语。任务描述同步改为关键词用目标市场语言、不要用中文；过滤条件里的行业、国家词仍可用中文。
- 搜索串构造：支持的 7 种搜索语言都不用中日韩文字，所以公开网页源与名录源都先剔除空词和含汉字、假名、谚文的词，再取前几个。全是中文时不发起检索，名录源也不再退回通用的 manufacturing。名录源的地区依次取可写的地区词、国家词、目标国的当地名称（例如 Deutschland）；给了地理范围却一个都写不出（例如「加拿大」不在国家表里）时不检索，免得搜成全球名录。顺带去掉名录主题词的重复（只有关键词、没有行业词时同一个词会拼两次）。
- 目标市场解析：能拆开用顿号、全角逗号、分号连写的市场（例如「德国、奥地利」）；去掉「（德语区优先）」这类括注的正则写成线性时间，避免超长输入卡住事件循环（独立审查实测旧写法 10 万字符要 10 秒以上）。
- 用 10-07 那份真实计划核对：会执行公开网页检索的 3 条查询，9 条搜索串全部是德语。
- 测试：搜索语言工具 14 项、公开网页源 2 项、名录源 4 项、ICP 服务 3 项，实现前均为红。

## 2026-10-08 · Reclaim superseded image variants before reserving a new set

- 起因是 sharp 修复（#599）独立审查时发现的问题。图片管线版本号是 recipe hash 的一部分，所以每次升级 sharp 或 libvips 都会生成一整套新变体。预留时有两道预算：每个资产最多 120 行、冻结清理计划最多 128 个对象，它们都把该资产所有版本的行算在内；而旧行只有在删除资产时才会清掉。结果是：大图产品图每版 30 个变体，保留 3 套旧版本后再处理，就会报 `asset cleanup object budget exceeded (151>128)`。预算也不能改成只数当前版本，因为它守的是删除合同：删除资产时，全部变体要冻结进一条不超过 128 个对象的清理命令。
- 构建选图（`controlled-build-assets.ts`）改为只从资产 `derivedKeys` 清单发布的变体里选。此前按 role、id 取第一条 ready 变体，新旧版本并存时，选中哪一版是随意的。没有清单或清单无法解析时，不提供 tenant 变体，页面回落到目录图；首次处理定稿失败、只留下部分 ready 行的资产就属于这种情况。
- 新增 `image-variant-reclaim.ts`。`processAsset` 在 reconcile 之后、预留之前回收已被取代的变体，连同它们的对象和 attempt key。被取代的定义是：状态为 ready 或 failed，且同时满足三条——不在清单里；没有未失败的 SiteVersion 的 spec 引用它；不在本次计划里。
  - 为什么要看 spec 引用：页面和区块级的局部构建会把当前版本的 assets 合并进新 spec，并按 variantId 逐条物化；成功的版本回滚后也会重新成为构建基础。失败的版本不会再被构建，不计入。没有可回收的候选时，不扫描 site_version。
  - 整个回收在一个事务里完成，持有资产行锁（与预留、提升、定稿、资产删除是同一把）。存储操作在事务开始后 20 秒截止；删除对象前若剩余时间不足 5 秒（例如等锁或查询太久），就跳过本轮。每批删除要全部落定后才报错，不会在锁释放后还有删除在进行。
  - 先删对象并确认已不存在，再删行，先删子行再删父行。顺序之所以如此，是因为 ready 行在数据库层不可改状态：删不掉的「行在、对象没了」只会在同一 recipe 再次被计划时按完整性错误失败关闭；反过来留下孤儿对象，资产删除时就无从清理。
  - 以下情况跳过回收，并记 warn 日志：站点有 `building` 的 SiteVersion、清单无法解析、剩余时间不足。之后的预留若失败，报错会附上跳过原因。回收成功时记一条 info 日志。
  - 超过 128 个对象、来源不符、对象删不掉时，失败关闭。
  - 回收没被跳过时，一个资产保留的是：清单那套、正在生成的那套，外加未失败的站点版本仍在引用的行。最后这一部分会随版本数和管线升级次数增长，目前远低于预算。预算、删除合同和清理活动都不变。
- `reconcileAttemptKeys` 的来源校验和 attempt key 提取改用同一组函数，报错文案不变。
- `verify-site-builder-m1c.mts` 的容量夹具改为租约有效的 processing 行，同时按 `asset_variant_state_payload_check` 去掉 hash、size 和 error 字段（已用库里实际部署的约束表达式对夹具值求值核对）。回收不碰这类行，所以「120 行时拒绝预留」的真栈断言保持原意。按用户确认的验收范围，本次没有在真栈上运行这个脚本。
- 新增用例：
  - 服务层「三套旧版本 + 第四版 30 个计划」：修复前报 151>128，修复后回收 60 行并预留成功。
  - 服务层另有：调用顺序；跳过时报错带原因；未跳过时报错原样抛出。
  - 回收模块 15 项：含锁条件与查询条件、版本引用保护（排除失败版本）、无候选时不扫描、存储窗口从事务开始计时、剩余时间不足时跳过。
  - 清单解析 13 项、构建选图 4 项。
- xin 的 `global_dev` 目前只有 1 个资产带变体：12 个变体，0.35.3，清单完整，构建结果不受影响。

## 2026-10-08 · Discovery runs can lock their own run row

- 起因（2026-10-08 xin 实测）：xin 上第一次执行发现 run（卖方 #10 的查询计划），工作流启动 5 秒即失败，worker 报 `DOMAIN_ACK_DISCOVERY_QUERY_LINEAGE_UNAVAILABLE`。Postgres 日志里的真实原因是 `operator does not exist: uuid = text`：提交查询结果时用原生 SQL 按 run ID 锁 `discovery_run` 行，Prisma 把字符串参数按 text 绑定，而 `discovery_run.id` 是 uuid。这种写法自 90f005de（2026-08-30 接入受治理的查询血缘）起就在，此后任何查询走到提交这一步都会失败。`finalizeRun` 用的是同一个加锁函数，所以失败的 run 也没法标成 FAILED，一直停在 RUNNING。单测用模拟的 `$queryRaw`，不检查参数类型。
- 改动：两处锁 run 行的查询给参数加 `::uuid`（`discovery-query-governed-execution.ts`，以及 `discovery.activities.ts` 的 `lockDiscoveryRunReceiptState`）。同一次排查扫了全部原生 SQL：建站成本对账巡检的翻页条件 `s.workspace_id > ${cursor.workspaceId}` 有同样的问题（翻到第二页才触发），一并加 `::uuid`。其余把参数传给 uuid 列或 uuid 形参的地方都已带类型转换。
- 验证：在 xin 的 Postgres 上用 text 形参的预备语句复现，旧写法分别报 `uuid = text`、`uuid > text`，加转换后正常执行。三个现有测试新增断言：锁 run 行和翻页条件的 SQL 在参数后带 `::uuid`；去掉转换时这三项失败。
- 未做：在真库上跑发现链路的回归测试（CI 的 Postgres 步骤目前不覆盖这条链路），留作后续。

## 2026-10-08 · One unusable model answer no longer fails a discovery run

- 起因（2026-10-08 xin 实测）：
  - 卖方 #14 的发现 run 启动 12 秒即失败。查询执行时给分类词归一的 `taxonomy.normalize` 调用，模型只回了 11 个 token，不是 JSON。归一器本来会把模型失败当作「没归一上」继续，但 `isExecutionControlError` 把 `ProviderOutputError` 判成了控制错误。原因是这个类带 `usage`、`callCount` 等字段，判定函数遇到不认识的形状一律从严。错误于是一路抛出，Temporal 重试时又被预算账本挡住（同一次调用已结算、没有可重放的结果），整个 run 失败。
  - 同样的误判让公开网页抽取、Fit 判定、官网画像等处「单家失败不影响其余」的退路，在真实模型失败时一处都不生效。现有测试用的是普通 `Error`，所以没发现。
  - 卖方 #13 的 ICP 设计报 `ProviderOutputError`，trace 里只有类名。查 new-api 日志才知道是上游 TLS 连接在第 140 秒断开（`scanner_error: tls: bad record MAC`），new-api 仍补发本地估算的用量块并正常结束流，后端把半截 JSON 当成了「模型输出不是 JSON」。
- 改动：
  - `execution-control-error.ts` 新增按类显式登记的「可恢复的模型失败」。登记的只有 `ProviderOutputError` 与 `TaskOutputValidationError`，代表一次回答不能用：非 JSON、schema 不合格、超长截断、任务闸门拒收。有确定性退路的调用方可以吸收这类错误。
  - 判定只认实例的直接原型，所以子类不登记就仍是控制错误。已登记的实例自身 `code`/`type`/`name` 带控制标记时仍按控制错误处理。字段只按数据属性读取，`cause` 链照常追查。
  - 仍然失败即停：
    - 传输失败，即流不可读、被截断、格式错误、上游错误事件、响应体不是 JSON，改抛新的 `ProviderTransportError`；
    - 身份不符（`ProviderIdentityError`）、网关 HTTP 错误；
    - 修复被抑制或修复准备失败，改抛新的 `ProviderOutputUnresolvedError`，并带上原错误作为 `cause`。修复调用本身失败时，只有「修复又回了不能用的答案」才可恢复，网络或传输失败同样改抛 `ProviderOutputUnresolvedError`；
    - `finish_reason` 或 Responses `status` 表示上游整体出错时（如 DeepSeek 的 `insufficient_system_resource`、`failed`），报 `ProviderTransportError`；只有 `content_filter`、工具调用与 `incomplete` 算单次回答不可用，各有原因码；
    - 200 响应体带 `error` 或没有 `choices`，报 `ProviderTransportError`（`CHAT_COMPLETIONS_BODY_INVALID`），不再当成空回答；
    - 结算未知（`ProviderSettlementError`）、合规拦截。
    - 传输、身份、HTTP 这几类失败通常一次 run 里每个调用都会遇到，逐家吸收会让 run 跑完却一家都没判。
  - 流式响应自始至终没有 `finish_reason` 时，报 `CHAT_COMPLETIONS_STREAM_TRUNCATED`，用量照带，结算不变。上游忽略 `stream`、直接回完整 JSON 的情况不受影响。
  - `ProviderOutputError` 增加 `reasonCode`：显式给定（必须是大写代码），或取消息开头的大写代码，否则为 `PROVIDER_OUTPUT_UNCLASSIFIED`，从不含模型文本。几处描述性消息补了代码，结算错误用自身的 `errorCode`，合规拦截为 `EXTERNAL_ACTION_DENIED`。`ai_trace.error_message` 从类名改为 `类名:原因码`。
  - 被吸收的失败要体现在 run 状态里，绝不静默漏判假 DONE：`qualifyFitForRun` 统计没判出来的公司（`unjudged`），大于零时 run 至少 PARTIAL。它不单独判 FAILED，因为计数只覆盖活动的最后一次尝试，之前的尝试可能已存下结论，FAILED 会让这些结论不进评分。官网画像统计没判出贸易角色的数量（`unclassified`），只进 stats。旧历史重放时缺这两个字段，状态不变。
  - 登记入口拒绝 `Error`、内置错误类与宿主错误类（`DOMException`、WebAssembly 错误类），并有测试限定全仓只有两个文件提到该函数、只有两个类被登记。
  - 响应体或流事件里显式的 `"error": null` 不算错误。
  - Router 是受保护文件：两轮复核追加到 `docs/evidence/execution-authority-fence-review-20261001.md`，指纹 `0ad768f0…` → `c9fc50b3…`。
- 测试：
  - 判定函数：可恢复的三种形态（含普通 `Error` 包着可恢复错误）；从严的六类；`cause` 链里的控制错误；未登记的子类；自带控制代码的实例；访问器或原始值形式的 `cause`；原型陷阱抛错的 Proxy。
  - 流：截断（内容不完整、内容完整但缺 `finish_reason`、文本生成）都报 `ProviderTransportError`，各种流形状有各自的原因码；缺 `finish_reason` 的普通 JSON 响应照常接受。
  - router：trace 记原因码；修复后仍不合 schema 时不记 schema 细节；结算未定时抛 `ProviderOutputUnresolvedError`，判为控制错误，且只调用一次模型。
  - 退路：词表归一与官网画像遇非 JSON 回答走退路；官网画像遇传输失败照常上抛。
  - 第二、三轮：上游整体出错的 `finish_reason` 与 `failed` 报传输错误，`content_filter` 与 `incomplete` 可恢复；错误响应体报传输错误，`"error": null` 照常接受；修复又回坏答案仍可恢复，修复遇网络失败判为控制错误；Fit 判定吸收一次失败后 `unjudged` 为 1、遇传输失败照常上抛；run 状态在有未判公司时为 PARTIAL、不会把查询全失败抬成 PARTIAL、旧历史不变；登记入口拒绝内置与宿主错误类，全仓只有两个类被登记。
  - 模型网关、执行预算、发现、Temporal 活动与工作流（含打包重放）、模型运行时与建站付费相关测试 2,627 项通过；第三轮复审跑的全量 API 单测 8,970 项通过；执行授权策略检查 16 项通过。
- 未做：
  - 吸收失败后若同一活动因别的原因重试，重放那次已结算的调用仍会被预算账本拒绝。要彻底解决，需要把失败也存成可重放的结果。
  - 官网画像分类失败被吸收后，会写入一份没有贸易角色的画像，30 天内不会重新画像。这两项都不比改动前更差，因为改动前同样的失败会让整个 run 直接失败。留作后续。
  - 非付费路径上 `fetch` 本身失败（网关不通、请求头超时）抛的是普通 `TypeError`，各处退路会吸收它。这是改动前就有的行为；修复调用里的这类失败本次已改为控制错误。
  - 控制属性在活动边界上丢失：Temporal 只保留类名，工作流层面目前靠重试撞上预算重放错误才失败即停。这也是改动前就有的问题。
  - Fit 阶段遇传输失败时 run 仍停在 RUNNING（BI-25）：改动前所有模型失败都会这样，现在只剩传输类。要在工作流里兜底并收尾，另开任务。
  - 建站付费路径上，修复调用把 `ProviderWireInFlightError` 包起来，结算时认不出来（改动前就有），另开任务。

## 2026-10-07 · Reviewed DeepSeek v4 pro identities and pro routing for acquisition tasks

- 起因（2026-10-07 xin 实测）：获客分组唯一的网关渠道（OpenOx）对同一个 `deepseek-v4-pro` 会报三种名字：`deepseek-v4-pro`、流式块里常见的 `deepseek.deepseek-v4-pro`、非流式应答里常见的 `deepseek-v4-pro-ga-260813`。身份闸门只认精确名，ICP 设计等 pro 调用因此间歇以 `ProviderIdentityError` 失败，而网关侧调用其实已正常结束。该渠道还把 `deepseek-v4-flash` 映射到 pro、应答报 pro 名，所以 flash 任务 100% 被拒，发现 run 跑不出结果。
- `model-identity.ts` 为 `deepseek-v4-pro` 登记这两个已审别名，只在 `openai-chat-completions` 传输下成立；其他名字（含 `gpt-5.6-*`）照旧失败关闭，pro 的名字也不能冒充 flash 请求。别名表是全局的，结算路径上请求 `deepseek-v4-pro` 的 chat-completions 调用同样适用，包括建站默认关闭的回退路由；三个名字指同一模型，结算仍按请求名。
- 流式应答里出现的每个模型名都要过身份闸门，非字符串的名字同样拒收。此前重组只保留最后一块的模型名，内容块来自别的模型族、最后一块报已审别名时会被当作 pro 放行；这个缺口自 #593 起就在，本次加别名后一并补上。来源记录取产出内容那几块的模型名；只要有内容块没报模型名，就不声称上游身份，记为 `requested_fallback`。
- provider 的文本与结构化生成记录来源时，用与 `complete()` 相同的传输（收拢为 `transportFor`），别名调用如实记为 `upstream_response` 并保留上游名字；`resolutionProvenance` 的传输参数改为必填，漏传即编译失败。
- 8 个 flash 档获客任务（企业理解 3 项、`discovery.extract_company`、`discovery.classify_trade_role`、`discovery.extract_list`、`contact.find_decision_makers`、`taxonomy.normalize`）改为经 `ACQUISITION_FLASH_TIER_MODEL` 请求 `deepseek-v4-pro`。xin 网关的扣费日志显示 flash 请求与 pro 请求都按倍率 37.5 扣费、都由上游 pro 服务，所以真实成本与速度不变。`maxCostCents` 不变：后端按自身价目表结算，与网关计价相差很大，另行对齐。这是针对唯一部署的网关的固定选择，有第二个部署之前要改成按部署配置。核验脚本 `verify-broker-closure.mts` 改为从任务注册表取模型。
- 部署注意：无结算调用的预算操作键含请求模型名，工作区报价修订号含 `requestedAlias`。换镜像前须确认没有在途的获客工作流和待重试的授权，否则在途调用可能以新键再发一次。
- 测试：相对 main 为红的有别名解析 2 项、provider 3 项（前缀名流式、日期名非流式、文本生成记录上游名）、任务合同表 1 项（改为 pro，并补上 `discovery.classify_trade_role`）。「混合模型族的流被拒」「真实混合流记录内容块的别名」「非字符串模型名被拒」「内容块无名时不声称上游身份」在前一版实现上为红。另有 7 项负向守护（缺传输或错传输 3、其他模型族 1、pro 冒充 flash 2、整段别的模型族的流 1）修复前后都应为绿。
## 2026-10-07 · Give discovery query execution and the fit pass a 15-minute activity timeout

- 起因（2026-10-07 xin 实测与审查）：获客任务改用 deepseek-v4-pro 之后，发现工作流里的查询执行要串行跑抽取批次与分类归一，资格判定逐家调用一次模型，都会超过原来 2 分钟的活动超时。超时后活动重试，撞上没有结果的重放，整个 run 失败。
- 改动：这两个活动改走 15 分钟超时的代理，重试次数不变，仍为 3 次。其余活动仍为 2 分钟，信号富集等慢活动仍为 30 分钟。活动类型与输入不变，当前没有进行中的发现工作流。
- 撤回了本 PR 第一版的「单项模型失败只跳过」。审查发现它在受治理的血缘校验下照样中止，重放时只是把失败推迟一步，还会把额度耗尽这类系统性故障变成逐家扣费、没有结果也没有失败原因的空跑。共同根因是预算账本分不清「已知失败」和「结果丢失」，另行设计。
- 测试：新增按语法树核对每个活动所用超时的测试 2 项，修改前为红。

## 2026-10-07 · Production advisory remediation (sharp)

- GHSA-wq5f-xc86-pv6w（高危，`sharp <0.35.5`，10-06 13:43Z 发布）：sharp 预编译 libvips 自带的 librsvg 有释放后重用，解码 SVG 时在 glibc Linux 上可能导致远程代码执行。main 自 10-06 17:16Z（`49dfd9f1`）起每次 push 的 `production advisory baseline freshness · canary` 都报 `BASELINE_STALE`，到 `c248c59b` 共 5 次。
- `apps/api` 的精确钉版 0.35.4→0.35.5，即上游修复版（librsvg 2.62.91→2.63.2，libvips 8.18.6→8.18.7，`@img/sharp-libvips-*` 1.3.3→1.3.4）。`pnpm update -r sharp --lockfile-only` 让 astro 的可选依赖 `^0.35.4` 与 Temporal worker 打包链上 webpack 压缩插件的可选 peer 解析到同一个 0.35.5，锁文件里仍只有一份 sharp 和一份 libvips；没有加 override，锁文件也没有别的变化。sharp 与 26 个 `@img/*` 平台包的 integrity 与官方 registry 一致。
- 图片管线版本号随之变为 `sharp-0.35.5-vips-8.18.7-m1c.1`。它是 recipe hash 的一部分，所以 0.35.4 渲染的衍生图不会被复用，下次处理时按新版本重新渲染；钉版本的用例同步改为 0.35.5。管线与 media-foundation 的 3 个用例文件共 172 项通过。
- 修复前的暴露面：API 图片管线只把魔数为 JPEG/PNG/WebP 的字节交给 sharp，解码后再核对格式，而且只在强制 `VIPS_BLOCK_UNTRUSTED=1` 的子进程里解码，该设置下 libvips 拒绝 SVG 输入（0.35.4 与 0.35.5 均实测）；渲染器不用 `astro:assets`，Temporal 打包也不用 webpack 图片压缩。没有产品路径解码过 SVG，但有漏洞的二进制确实随运行镜像发布。
- 安全下限新增 `sharp` ≥0.35.5、登记前任 0.35.4：对上一版锁文件失败，对当前锁文件通过。生产审计回到零 advisory（830 个依赖）。基线重新绑定到修复提交，`valid_until` 不变（2026-10-14T21:28:22Z，月度刷新与续期仍须在此之前合入）；旧绑定 `BASELINE_SOURCE_LOCK_MISMATCH`、新绑定 `FRESH`，见[回执](../evidence/security/20261007-sharp-advisory-remediation.json)。Copy fixed-source 回执只重签指纹。

## 2026-10-06 · Production advisory remediation (http-cache-semantics, smol-toml)

- 10-01 重绑之后，官方 npm 审计库新收录 2 条生产 advisory，都只在 site-renderer 的 astro 链上：GHSA-ch52-4w7c-c8xp（高危，`http-cache-semantics <=4.2.0`，未列修复版本：max-stale 处理可能把一个用户的缓存响应发给另一个用户），main 的定时 freshness canary 自 10-03（ac024fd5）起报 `BASELINE_STALE`；GHSA-r4xh-jqrq-34v2（中危，`smol-toml <=1.8.0`，1.9.0 修复：构造的 TOML 让 `parse()` 退化为二次方时间），10-05 23:41Z 才发布。
- `http-cache-semantics` 4.2.0→4.3.0：4.3.0 于 10-04 发布，就在 astro 自己声明的 `^4.2.0` 范围内，所以只用 `pnpm update -r http-cache-semantics` 定向重解析，不加 override，锁文件也没有别的变化。**这不是实质修复**：维护者以 RFC 9111 §7.3 允许该行为为由把上游报告（issue #56）判为不成立并关闭，4.3.0 里 `satisfiesWithoutRevalidation` 的 max-stale 分支一字未改；4.3.0 只是不在 advisory 现行范围内，另外收紧了 Vary 匹配（任意位置的 `*`、只认自身属性）。astro 只在 `assets/build/remote.js` 里用它在构建期判断远程图片缓存是否新鲜，本仓渲染器不用远程图片，也没有服务多个用户的共享缓存，报告描述的跨用户泄露不适用。若 advisory 日后把范围扩到 4.3.0，需另作安全决策。
- `smol-toml` 精确 override 1.7.1→1.9.0（依赖方的范围仍接受有漏洞的版本，override 保留）。1.9.0 重写了解析器，返回 null 原型对象，并拒绝少数畸形输入；消费者只有 astro 与 nx。
- 安全下限表把 smol-toml 上调到 1.9.0、新增 `http-cache-semantics` ≥4.3.0，登记前任 1.7.1、4.2.0：对上一版锁文件失败，对当前锁文件通过。生产审计回到零 advisory（830 个依赖），两个新包的 integrity 与官方 registry 一致；渲染器契约测试与 Astro fixture 构建矩阵通过（27+4、31/31），nx 照常运行。基线重新绑定到修复提交，`valid_until` 不变（2026-10-14T21:28:22Z，下一次刷新与续期仍须在此之前合入）；旧绑定 `BASELINE_SOURCE_LOCK_MISMATCH`、新绑定 `FRESH`，见[回执](../evidence/security/20261006-production-advisory-remediation.json)。Copy fixed-source 回执只重签指纹。

## 2026-10-06 · Domain ACK prelock readable by Prisma

- 自 2026-08-30 的 authority-first 预锁（`20aa1839`）起，`PostgresDomainAckRepository` 用 `$queryRaw` 执行 `SELECT public.lock_execution_domain_ack_authority_first_v1(…)`。该函数返回 `void`，Prisma 无法反序列化 `void` 列：锁已经拿到，随后在客户端抛出 `Failed to deserialize column of type 'void'`，事务回滚，HTTP 层只报 `INTERNAL`。因此每一个带回执的领域 ACK 都会失败：ICP 设计、查询计划、发现抽取、分类、Fit 的结果都写不进业务表，`execution_domain_ack` 在本机真库里从未有过一行。单测用的是假事务，所以没有发现。PostgreSQL 日志里也没有错误，因为 SQL 本身执行成功了。
- 改为 `SELECT 1 AS locked FROM public.lock_…(…)`：调用移到 FROM，语句返回普通整数；锁的语义与参数不变。新增回归测试：假事务按 Prisma 的真实行为，在 select 列表里出现 void 函数时抛错。修复前该测试为红。另以 app_user 对真库重放一次 ICP 落库事务（随后回滚）：修复前在 domain ack 这一步失败，修复后 ACK 为 `APPLIED`，ICP 与 13 条规则均写入成功。

## 2026-10-06 · Optional streaming for unsettled chat completions

- 网关 provider 新增可选开关 `MODEL_GATEWAY_STREAM_CHAT_COMPLETIONS=true`。打开后，未结算（无 `paidCost`）的 chat-completions 调用以 SSE 流式请求（`stream` + `stream_options.include_usage`），在本地拼回与非流式完全相同的结果（内容、finish_reason、上游模型、usage），后续的模型身份、用量对账和 finish_reason 校验都不变。结算调用（Site Builder 的 request-bound settlement）始终不走流式。默认关闭。
- 起因（2026-10-06 xin 实测）：上游中转 `openox.tech` 在 Cloudflare 后面，非流式长生成约 125 秒时被以 524 断开，直连和经 new-api 都一样，所以 ICP 设计、查询计划这类长输出任务会失败；同一请求改用流式（不经 VPN）146 秒正常完成。解析器严格校验，以下情况一律失败关闭：无法读取正文、data 行不是合法 JSON、流里带上游错误、流里没有任何补全块。上游忽略 `stream`、直接返回普通 JSON 时按普通响应处理。

## 2026-10-06 · Execution authority policy back in the gates

- `scripts/execution-authority-policy.spec.mjs` 自 #586 起登记在 `MANUAL_SPECS`：策略检查在 main 上报 25 个问题，10-06 的 main（`49dfd9f1`）仍是同样 25 项、没有新增。其中 24 项是检查脚本跟不上重构，不是代码违规：10 项是模型投影表在 #449 改成双引号，脚本只认单引号；11 项是五个平台 Tool 改经 `platformExecutionToolContract("<id>")` 声明 id、schema 与产物上限，脚本只认字面 `id: "<id>"`；1 项是专利计费上限改为指向平台合同常量的别名；2 项是 #578 新增的 `discovery.classify_trade_role` 未登记，且它以常量调用 `getTask(WEBSITE_PROFILE_TASK)`，源码清单扫描漏掉了它。脚本现按平台合同解析这些间接引用（含 `as const`、跨行与别名常量），以引号无关的方式匹配映射，把同文件字符串常量的 `getTask` 计入清单，无法解析的大写常量参数报 `EXECUTION_AUTHORITY_MODEL_TASK_UNRESOLVED`。
- 剩下 1 项是受保护的 `router-model-gateway.ts` 指纹，自 d5e4bc42（8-26）起不再匹配。[围栏复核](../evidence/execution-authority-fence-review-20261001.md)逐提交核对了 `b8dd5eb0` 以来改动四个受保护文件的全部提交：要么语义不变，要么新增 fail-closed 控制，唯一的放宽是已批准的 G3 5.1 按调用主体绑定（#565，当时已顺带更新了 ToolBroker 两个文件的指纹）。10-01 之后四个文件都没有再改，Router 当前内容仍是复核时的 `446e5771…`；10-06 另做了一次独立复审，逐行确认了复核结论，另提三点不影响更新指纹的后续事项（结算 `REPLAY` 判定的注释与 SQL 不符、平台出网授权实际还依赖未钉住的 `source-tools.ts`、客户侧中途拒绝的预留释放），一并记在复核记录文末。据此把 Router 指纹更新为 `446e5771…`，检查失败时的提示也改为「先复核、记录复核，再更新指纹」。
- 该 spec 现由 `governance-contracts.spec.mjs` 导入，随 required 的 `governance · traceability · release` 与 build 作业的 `docs:verify` 执行，`MANUAL_SPECS` 删去该项（剩 2 项）。去掉这条导入时，可达性门报 `SPEC_UNREACHABLE`。
- 合并前的独立代码复审找到新解析逻辑会漏报的几种写法。这些写法当前代码里都没有，但都已改为按失败处理：
  - 产物上限按首个记号读取：`LIMIT * 10`、`[…].concat(more)`、`86_400 * 365` 都会被当成合规。现在要求取值是紧接 `,` 或 `}` 的单个记号。
  - `getTask` 改用语法树扫描，也能识别 import 别名、`?.`、`!` 和成员访问。参数不是字面量、也不是同文件常量的调用，只允许 Router、运行时桥、ToolBroker、预算信封这四处登记过的通用查找（`EXPECTED_GENERIC_MODEL_TASK_LOOKUPS`）；把 `getTask` 当作值传递（如 `ids.map(getTask)`）同样报错。
  - 同名常量被声明多次，或经 `import { A as B }` 改名绑定的，按无法解析处理。只有恰为 `const x = platformExecutionToolContract("<id>");` 且只声明一次的绑定，才按平台合同解析。
  - 新增：运行时的封闭清单 `MODEL_RESULT_TASK_IDS` 必须与期望的 Model 任务清单完全一致（`EXECUTION_AUTHORITY_MODEL_RESULT_TASKS_MISMATCH`）。
- 对修复的复查又发现四处问题，均已补上：
  - 加了锚定之后，`match()` 会跳过不合规的首个 `maxBytes:`，转而命中同一 Tool 执行体里的另一个同名属性。现在用 TypeScript 解析该 Tool 唯一的 `durableResultStrategy` 对象，只读它的直接属性，块内其他同名键与注释都不再能顶替。
  - 以函数参数或解构遮蔽的同名常量此前没有识别。现在 `getTask` 的常量参数按语法树上的全部绑定判断：只认文件内唯一的字符串 `const`。
  - 以新名字再导出 `getTask` 此前没有识别。
  - `import def, { A as B }` 形式的改名此前没有识别。
- 在仓库副本上做了 21 项变异，全部被拦下：
  - 先前的 7 项：Router、ToolBroker 各改一个字节，平台合同里 `crawl4ai.render` 的 schema，专利计费上限常量，`icp.design` 的投影值，把 trade-role 任务常量改成未登记的 id，以未定义常量调用 `getTask`；
  - 复审给出的反例及据此补充的 9 项：产物上限三种表达式、`getTask` 经对象成员 / 小写常量 / 作为值传递、常量 import 改名、被遮蔽的任务常量、运行时任务清单多一项；
  - 复查给出的 5 项：制裁与 `http.get` 的上限表达式落到后面的同名属性、在策略对象之前放一个同名键、参数遮蔽任务常量、以新名字再导出 `getTask`。

  新增用例在加固前的脚本上均失败。spec 由 10 项增至 16 项。`governance:test` 由 276 项增至 292 项，xin 上 load 12 时 48 秒，其中本 spec 约 18 秒。

## 2026-10-06 · Model settlement REPLAY must be this attempt's own

- `settle_site_build_spend` 与 `settle_unknown_site_build_spend` 对任何已不是 RESERVED 的行都返回 `REPLAY`，而且这一判断在 fence 校验之前。Router 原先把 `REPLAY` 一律当作结算成功，首次调用也不例外。可是 provider-spend 恢复任务（`completeProviderSpendReconciliation`）会把仍为 RESERVED 的模型支出结算为 UNKNOWN，或结算为结果为空的 FAILED（`MODEL_OUTPUT_UNAVAILABLE_AFTER_RECOVERY`）。原调用若只是慢，随后会拿到 `REPLAY`，把自己的输出当作成功返回，而账本记的是「输出不可用」。没有预算泄漏，也不会多发一次调用，但交出去的结果不是持久记录。
- 现在首次结算返回 `REPLAY` 即冻结（`SETTLEMENT_REPLAY`，停用该 BuildRun 的付费调用）；失败与零调用释放路径也一样，与 `STALE_FENCE` 的处理一致。唯一一次 ACK 重试返回的 `REPLAY`，要经新增的只读方法 `SiteBuildCostLedger.confirmSettlementReplay` 回读该行，确认 status、fence、计费依据、调用次数、结果、meta 与错误码都正是本次写入的内容，才接受；否则冻结（`SETTLEMENT_REPLAY_UNCONFIRMED`）。只比较 fence 与调用次数不够：恢复任务以该行自身的 fence 结算，调用次数又由触发器固定，所以 meta 与错误码也要比较。超出预留时记录的 `CAP_VARIANCE` 也计入比较。不需要迁移。
- `router-model-gateway.ts` 是受保护文件。复核记录追加在[围栏复核](../evidence/execution-authority-fence-review-20261001.md)文末（独立复审：无 CRITICAL/HIGH；MEDIUM 一项已修复；LOW 一项按设计保留），指纹 `446e5771…` → `0ad768f0…`。新增 Router 用例 6 个、账本用例 13 个（先确认为红；去掉 meta 与错误码比较后，区分恢复任务的 4 个用例会失败）。`paid-execution-gates` 中 ACK 丢失后重放的用例改为要求回读确认。没有用真实 PostgreSQL 做往返：现有 live spec 会在共用的 `global_dev` 留下夹具，所以没有跑。

## 2026-10-06 · Platform wire dispatch fence

- 平台出网自 7c87ea80 起按每次物理调用授权，前提是工具把 `sourcePhysicalWire(ctx, "<wire>")` 交给适配器，适配器也只经这个调度器发请求。四个适配器（`requestPublicHttp`、`crawlUrl`/`crawlHtml`、`queryAlgoliaExhibitors`，以及转交调度器的 `isAllowedByRobots`）在没拿到调度器时会直接发请求，这是客户侧路径的正常行为。因此只要平台工具或适配器丢了调度器，请求就会绕过平台出网授权，ToolBroker 也照样接受结果。这几处都不在 Router/ToolBroker 指纹围栏里（#592 围栏复审后续事项 2）。
- 用户选定静态接线检查，不把这些文件整份钉住（`source-tools.ts` 自 8-01 起改过 16 次）。新增 `scripts/execution-authority-wire-dispatch.mjs`，作为 `execution-authority-policy` 的一部分在 required 门里运行：
  - 接受调度器的导出适配器函数构成封闭清单，共 5 个；
  - 终端适配器的每个发送调用（`fetch` / `execute`）都必须位于唯一的 `executePhysicalWire` 闭包内，闭包只能经 `dispatchPhysicalWire ? await dispatchPhysicalWire(executePhysicalWire) : await executePhysicalWire()` 执行；
  - 转交型适配器所在文件里，所有 `requestPublicHttp` 调用都必须在它内部，并把收到的调度器原样转交；
  - 活跃平台工具（从平台合同推导，跳过 `disabled_no_egress`）的 `execute`，及其调用到的同文件辅助函数里，每个适配器调用都必须带一个 `sourcePhysicalWire(ctx, "<wire>")`，而且 wire 必须是调度器按合同会接受的那一个；合同声明的每个 wire 都必须用到；不得直接调用 `fetch`、Node 网络模块，或未登记的适配器函数；
  - `sourcePhysicalWire` 的故障即拒绝函数体按文本钉住。
- 合并前的独立复审在不改变「静态检查」选型的前提下找到若干绕过写法，均已改为按失败处理：
  - 平台工具能触达的导入改为白名单。只允许已登记的 wire 适配器，以及 `EXPECTED_PLATFORM_TOOL_IMPORTS` 中的平台合同、`ExecutionControlError`、`assertToolExternalActionAuthorized`、`decodeJsonBytes`、`EgressBlockedError` 与 `createHash`。从其他模块导入、动态 `import()`、`globalThis` / `fetch` 作为值使用、axios / child_process 等网络模块都报错。
  - 工具会顺着它引用的所有同文件声明继续检查，包括回调、别名和方法对象。这样也覆盖了经 robots 的 `request` 钩子注入未经调度的请求。wire 适配器只能被直接调用，不能当作值传递。
  - 终端适配器：同文件中任何能发请求的声明，都不得在闭包外被引用（传递求出，例如 `executePinnedHttp` 与 `crawlUrl`）；闭包内只能发一次、不在循环里；调度条件必须读取函数自身的调度器参数，且该参数不得被重新赋值、删除或遮蔽。
  - 转交型适配器：`requestPublicHttp` 只能作为带调度器调用的被调函数出现，包装器只能经收到的调度器执行。
  - 合同行不得含 spread，且只认 `deepFreeze` 与 `technicalRow` 两个构造器；文件里只能有一个名为 `sourcePhysicalWire` 的绑定；兼容 `.js` 后缀导入与 const 箭头函数形式的适配器。
- 第二轮独立复审又找到一批绕过写法，同样改为按失败处理：
  - 适配器文件的导入改为白名单：只允许网络模块与 `EXPECTED_WIRE_ADAPTER_IMPORTS`（`bounded-fetch-response`、`guarded-http`、`url-guard`、平台合同），其他导入报 `WIRE_ADAPTER_IMPORT_UNREGISTERED`；`process.getBuiltinModule` / `process.binding` / `module.require` / `eval` / `Function` 这类运行时加载器在适配器文件与平台工具里都报错。
  - robots 文件只能经 `requestPublicHttp` 发请求：文件里出现网络模块、网络全局或其他 wire 适配器即报 `WIRE_ADAPTER_FORWARD_MISSING`。
  - 终端适配器的 send 别名（`dependencies.executePinned ?? executePinnedHttp`）里不得有调用或新建函数，防止提前发送或包进重试。
  - 调度器参数只读：`dispatchPhysicalWire` 只能出现在调度条件里；options 参数只能以 `<param>.<property>` 读取，不得整体传出、别名、经成员改写（含 `Object.assign`）、删除或遮蔽。
  - `executePhysicalWire` 闭包内的那一次发送必须直接位于闭包，不能藏在嵌套函数（如 `Promise.all([..].map(...))`）里。
  - 平台工具对象不得被展开、重新赋值或经 `Object.assign` / `defineProperty` 改写（`PLATFORM_TOOL_REDEFINED`），保证被检查的 `execute` 就是注册运行的那个。
- 当前代码零问题。在仓库副本上做了 29 项变异，全部被拦下：
  - 先前 15 项：工具丢了调度器、传 `undefined`、使用未声明的 wire、直接 `fetch`、调用未登记的适配器、经本地辅助函数绕过、`sourcePhysicalWire` 去掉平台拒绝、三个终端适配器绕过闭包或调度、robots 的三种转交缺陷、新增接受调度器的适配器、合同新增却从未用到的 wire；
  - 第一轮复审补充 7 项：robots 的 `request` 钩子、`globalThis.fetch`、从非适配器模块导入、`executePinnedHttp` 预检、`crawlHtml` 未经调度调用 `crawlUrl`、调度器参数被置空、把 `requestPublicHttp` 当作值传给 `loadRobots`；
  - 第二轮复审补充 7 项：适配器文件导入白名单外模块、robots 文件裸 `fetch`、send 别名包进调用、`Object.assign` 改写调度器参数、闭包内经嵌套函数发送、工具里 `process.getBuiltinModule("node:https")`、注册时展开工具对象替换 `execute`。

  spec 共 17 项，其中第一轮 8 项、第二轮 4 项在各自加固前的检查上失败。
- 定位：这是防回归的检测器，不是出网边界。白名单模块内部（例如平台合同模块）若藏有发送，本检查看不到。复审建议在 ToolBroker 加运行时兜底（平台调用必须至少经过一次调度），用户 2026-10-07 决定不加：它只多抓「完全没经过调度」这一种情况，而这种情况静态检查已经覆盖；它会误杀 robots 缓存命中且被禁抓时的零请求结果；4 个平台 schedule 仍处于暂停状态。真正的边界应在网络层做：platform worker 只能经过一个校验授权的代理出网。恢复平台 schedule 或上 pilot 前再评估。

## 2026-10-01 · @grpc/grpc-js security floor

- 9-30（UTC）官方 advisory 库新收录 2 条 `@grpc/grpc-js` 生产 advisory：GHSA-m9gg-hp2v-232j（高危，特定配置下 `getAuthContext` 可能把未经授权的证书当作已授权返回）与 GHSA-f596-whhp-79r4（低危，服务端把方法处理器抛出的部分错误信息放进状态消息发给客户端），受影响 `>=1.14.0 <1.14.5`。main 锁文件里是 1.14.4（经 `@temporalio/*` 1.23.0 与 OpenTelemetry 的 OTLP gRPC exporter 引入）。这两条在 GitHub 上 9-30 15:35Z 发布，但 #576 在 16:13Z 的官方审计仍为 0（npm 审计库收录滞后），所以 #576 合入后（22b1ca31，19:45Z）main 的 `production advisory baseline freshness · canary` 立即报 `BASELINE_STALE`，`current_advisories` 正是这 2 条，直到 e7ee633d 都没变。
- #583 的月度刷新已把它解析到 1.14.5（Temporal SDK 1.24.0 的声明范围内，不需要 override），合入后 main（590b9f3e）的 canary 恢复 `FRESH`、零 advisory。#583 的回执只记录了刷新后的审计，没有写到这 2 条，在此补记。
- 按 runbook，`scripts/dependency-security-remediation.spec.mjs` 新增 `@grpc/grpc-js` 下限 1.14.5，并把 1.14.4 登记进 `VULNERABLE_PREDECESSORS`：对 e7ee633d 的锁文件该下限失败，对当前锁文件通过。锁文件、override 与漏洞基线都不变。

## 2026-10-01 · Dev-dependency alert refresh (axios, brace-expansion)

- 官方全量审计（含开发依赖）在 main 上报 16 条：axios 12 条（7 高危，`<1.20.0`）、brace-expansion 3 条（2 高危，`>=4.0.0 <5.0.12`）、`@faker-js/faker` 1 条（高危，`<=10.4.0`）；生产审计为 0。axios 与 brace-expansion 都来自 nx 23.2.1（当前最新版）自己的精确钉版——`axios 1.18.1`、`minimatch 10.2.5`（后者以 `^5.0.5` 解析出 brace-expansion 5.0.9）——所以 `pnpm update` 移不动。
- 加两条以漏洞区间为选择器的精确 override：`"axios@<1.20.0": "1.20.0"`、`"brace-expansion@>=4.0.0 <5.0.12": "5.0.12"`（minimatch 3/5 用的 1.x、2.x 线不在区间内，不受影响）。锁文件只变这两个包：axios 1.18.1→1.20.0，brace-expansion 5.0.9 并入 5.0.12；nx 照常运行。安全下限表新增 axios ≥1.20.0、brace-expansion（自 4.0.0 起）≥5.0.12，并登记前任 1.18.1、5.0.9：对上一版锁文件失败，对当前锁文件通过。
- 全量审计由 16 条降到 1 条，只剩 faker 5.5.3（`@stoplight/prism-cli` → `json-schema-faker`，仅 contracts 的 mock 开发依赖）：强制换成 faker 10 会让 json-schema-faker 失效，继续开放。Go 侧原生 Temporal 镜像的 otel 3 条低危已于 10-01 按可容忍风险关闭，下次重发该镜像时升级。
- 生产审计仍为零 advisory（830 个依赖）；基线重新绑定到本提交，`valid_until` 不变（2026-10-14T21:28:22Z）；旧绑定 `BASELINE_SOURCE_LOCK_MISMATCH`、新绑定 `FRESH`，见[回执](../evidence/security/20261001-dev-dependency-alert-refresh.json)。Copy fixed-source 回执只重签指纹。

## 2026-10-01 · Egress guard recognizes mihomo IPv6 fake IPs

- xin 的 Clash Verge（mihomo，TUN + fake-ip）打开 IPv6 后，公网域名同时解析出 198.18.x 与默认 `fake-ip-range6` 里的 `fdfe:dcba:9876::x`。出网护栏 `net-guard.ts` 与 Crawl4AI 镜像里的 `fakeip_resolver.py` 都只认 198.18/15：只有全部答案都是假 IP 时才改查固定 Cloudflare DoH，混进 IPv6 假 IP 后就按私网拒绝。结果是 `POST /companies` 对任何官网都报 `INVALID_URL`，抓取也会全部失败。
- 两处都把 `fdfe:dcba:9876::/64` 认作 mihomo 假 IP。规则不变：只有**全部**答案都是假 IP 才走 DoH，DoH 的答案照旧要过全局地址校验；该 /64 之外的 ULA、假 IP 与真实私网的混合答案仍直接拒绝。TS 与 Python 两侧都补了正反例。Crawl4AI 是本机自建的 `global-crawl4ai:local`，下次重建时生效；后端随下一次运行时镜像生效。

## 2026-09-30 · Website profiling in the discovery run (G3 slice 5.4b, part 2)

- discovery run 在归一之后、Fit 之前新增「官网画像」阶段 `profileWebsitesForRun`：按公司绑定主体抓首页与 Impressum，把贸易角色、置信度与来源、是否自有制造、在售品牌与两个品牌信号、法定名称、登记号（带法院）、税号、证据片段写入 `website_profile` 命名空间，登记号与税号作为带校验的语义标识符进入属性白名单。主体被拒只跳过该公司并计入 PARTIAL，控制错误照旧让 run 失败；30 天内画像过的公司不重抓；每个 run 至多 50 家。工作流以 patch `discovery-website-profile-v1` 守卫，旧历史重放不变；阶段为尽力而为，失败时 Fit 照常判定。
- 新数据源 `website_profile` 默认 DISABLED，登记进 provider 注册表、source-class 清单与生成文档，实测后再开启。发现 run 的技术报价补上这一阶段（每家 2 次抓取 + 1 次分类，上限 50 家）。
- Fit 第 2 部分：候选信息带上 `website_profile`（不含登记号与税号），任务说明写明官网画像是角色门与商业模式门的直接证据、在售外国尤其中国品牌是进口分销的强信号。依据：G3 规格 §3 ⑤、§5.4；设计 §3.3、§4 第 7–8 项。有证据的名称修正与次级去重键留待 5.4c。

## 2026-09-30 · Website-profile provider and trade-role task (G3 slice 5.4b, part 1)

- 新增 `WebsiteProfileProvider`（尚未接入 run）：以已建档公司为主体（`artifactSubject`）抓首页与 Impressum，两次抓取都由 ToolBroker 按调用绑定主体。规则分类器能下结论就不调模型，否则调用新任务 `discovery.classify_trade_role`（flash 档，闭合 schema：贸易角色 distributor/wholesaler/manufacturer/mixed/service/other、置信度、是否自有制造、在售品牌、至多 3 条证据）。品牌取词典匹配加模型补充；Impressum 解析出登记号、税号和法定名称。禁令类拒绝与控制错误向上抛出，由调用方按公司跳过或让 run 失败；Impressum 缺失或模型普通失败时保留确定性结果。
- 证据只留公司级：含 Geschäftsführer、Inhaber、Ansprechpartner、Herr/Frau 等人员标记的片段整条丢弃，其余打码电话与邮箱。新任务已登记进 typed projection、回执事实、domain-ACK 与治理清单（`durable-result-strategies.json`、`execution-authority-callsites.json`）。依据：G3 规格 §3 ⑤、§5.4；设计 §3.3。

## 2026-09-30 · Website-profile rules and identifiers (G3 slice 5.4a)

- 新增纯函数（尚未接线）：Impressum 解析，产出 HRB/HRA+登记法院（次级去重键 `de-hrb:<法院>:<号>`）、带校验位的德国税号，以及只接受资合公司形式（GmbH/AG/SE/UG/KG 组合/eG）的法定名称；独资商号（e.K.）与任何人员行一律不取。在售品牌词典附带品牌国别，用来标出「在售中国品牌」和「在售外国品牌」两个信号。贸易角色规则分类器只有结论明确时才跳过模型。
- 主体绑定的 `crawl4ai.fetch` 产物文本改用专用归一化：保留 `DE136695976` 这类税号（原通用打码会把它当成电话），截断上限从 2 万提到 7.5 万码点（仍在 300 KB 合约之内），首次结果与重放一致。Site Builder 的证据归一化与 `scrubPii` 不变。依据：G3 规格 §3 ⑤⑥、§5.4。
- 接手时的审查修正：登记法院未知时不产出去重键（登记号只在同一法院内唯一，`de-hrb:unknown:<号>` 会把不同公司并成一家）；法院识别补上「des Amtsgerichts München」「Registergericht: München」「Registergericht: AG Köln」几种写法，也修正了把后面的「HRB」读进法院名的问题；法定名称截到公司形式为止，丢掉同一行的宣传语；Leo、DAB、Zenit 等本身是常见词或人名的品牌，裸名只在谈到泵、或同一行还有其他明确品牌时才计入，Impressum 里「Geschäftsführer: Leo …」这类行不再被当成「在售中国品牌」。

## 2026-09-30 · Fit judges by the ICP trade role (design §4 step 8, part 1)

- `discovery.qualify_fit` 的四个门原本按「设备制造类买家」写：商业模式门把中介判为 weak，材质门、工艺门对分销商也不适用，分销商 ICP 下的真分销商会被系统性判成 weak。现在 ICP 摘要带上确定性的 `icp_trade_role`（与 5.3 同一套识别规则），任务说明按角色判：distributor 时，采购并转售实物产品的分销商、批发商、进口商、经销商判 pass，只做信息撮合的平台、目录或门户判 weak，同类产品制造商仍按角色门判为竞品；ICP 未对材质或工艺提出要求时视为不适用、判 pass；manufacturer 或未指定角色时，原有判定不变。候选信息新增已抽取的能力关键词（`keywords`），分销证据多在其中。
- 第 2 部分（官网画像给出的贸易角色与在售品牌作为 Fit 证据、评分加减分项）随 5.4 进行。依据：设计 §3.3、§4 第 8 项。

## 2026-09-30 · Company-subject binding for signal enrichment and watch registration (G3 slice 5.5)

- 信号富集（数字足迹 `crawl4ai.render`、结构化收割 `http.get` + `crawl4ai.render`）与网站监控注册（sitemap `http.get`）此前不带主体，调用全部落在主体绑定禁令上。更糟的是，这类拒绝属于控制错误，只要 run 里有公司通过 Fit=match，整个 run 就会在信号富集这一步失败。现在这两处按公司传入 `artifactSubject`（`ExecutionContext` 新增该字段，provider 展开进 ToolContext；`registerWatch` 直接绑定它正在注册的公司），抓取结果按 5.1 的合同以该公司为主体落对象存储。
- 按公司失败语义：主体被 tombstone、SUPPRESSED 或绑定失效时，只跳过这家公司，不写任何属性（已产生的回执照常 ACK），计入 `skippedSubjects`，run 至少记为 PARTIAL，stats 中可见。预算、授权、对象存储不可用等控制错误照旧让 run 失败。
- 联系人发现（decision_maker、public_web 联系人页）有意不接入，继续保持禁令：它不在公司级链路内，报价也仍是 unavailable。这比规格 §5.5 列的范围更保守。依据：G3 规格 §3.1、§4.2、§5.5。

## 2026-09-30 · Technical quotes for discovery runs and company creation (G2)

- `POST /query-plans/:planId/execute` 与 `POST /companies` 的技术报价不再恒为 unavailable，GrowthOS 可以为发现 run 和卖方企业建档签发 Grant。报价是整条链路的物理预留上限（每次模型调用按结构化输出的 2 次 wire 上限预留），逐阶段累加：词表归一、`public_web` 搜索与判站、名录页、单次检索类源（wikidata/osm/ted/openfda/展会）、Fit、GLEIF/Wikidata 富集、信号富集、网站监控注册；建档 = 首页加至多 6 个子页的抓取与逐页抽取。联系人发现仍返回 unavailable（不在公司级链路内）。
- 各阶段上限集中到 `discovery/execution-envelope.ts`，provider、workflow 与报价引用同一常量。借此补上两处此前无界或未强制的上限：robots.txt 声明的 sitemap 根最多读 4 个；每条计划查询送去词表归一的行业词最多 4 个、国家/地区词最多 2 个（原先每个过滤字段最多 32 个值，每个未命中词一次模型调用）。计划查询上限改为 planner 的 64 条加 TED、openFDA 冷路径各 1 条，共 66 条，并在执行时强制（原 64 条上限从未被检查）。
- 按现有上限，一次 run 的预留上限约 5,587 美元，其中 Fit（最多 11,550 家 × 每家预留 40 美分）约占 83%；实际费用按真实用量结算。卖方企业建档约 5.87 美元。依据：设计 §3.1 / §4 第 3 项（G2）。

## 2026-09-30 · ICP trade role carried into keyword discovery queries (G3 5.3 follow-up)

- 5.3 让关键词搜索按 `filters.trade_side` 等构造贸易角色词，但 `discovery.query_plan` 的过滤器 schema 没有 `business_model`，planner 也不一定填 `trade_side`，真实链路上角色词可能根本不出现。现在生成查询计划时，若 ICP 的 `company_attributes.trade_side`（优先）或 `business_model` 能识别出角色，就把规范值 `distributor` / `manufacturer` 写进未带角色的 planner 查询；planner 自己写了角色的保持不变，TED、openFDA 冷路径查询不受影响。写入发生在计划落库前，人工确认计划时可见。

## 2026-09-30 · Monthly dependency refresh and audit baseline renewal

- 按[依赖刷新 runbook](../backend/dependency-refresh.md) §3 做本月批量：`pnpm update -r '!sharp'` 在声明范围内移动约 260 个锁定包，`package.json` 的范围下限随之改写为实际版本。实际变化的直接依赖：NestJS common/core/platform-express 11.2.3→11.2.7、`@nestjs/throttler` 6.5.0→6.7.1、Temporal SDK 1.23.0→1.24.0、`ai` 7.0.105→7.0.124（及 Anthropic/OpenAI provider）、astro 7.3.2→7.3.5、AWS S3 SDK 3.1134→3.1144、jose 6.2.3→6.2.12、fast-xml-parser 5.11.0→5.11.2、`@redocly/cli` 2.53.2→2.57.0、eslint 10.10→10.11、typescript-eslint 8.70→8.71、prettier 3.9.7→3.9.9 等；传递依赖含 AI SDK 链的 undici 7.29.1→7.30.0、vite 8.1→8.3、webpack 5.110→5.111、Sentry 10.70→10.75。未纳入大版本：NestJS 12、`actions/dependency-review-action` v5。
- `pnpm update` 不移动精确钉版，同族包因此显式处理：`apps/api` 精确钉的 `@temporalio/common`、`@temporalio/proto` 与其余 `@temporalio/*` 一起到 1.24.0——有界失败诊断转换器继承 SDK 的 `DefaultFailureConverter` 并自建失败类，必须与 worker/client 同版本；1.24.0 让 `ApplicationFailure` 保留原生 `Error.cause` 链，转换器、控制与重放共 71 个用例照常通过。`sharp` 用 `!sharp` 排除：确定性图片管线精确钉 0.35.4，否则 astro 链会带出 0.35.5 和第二份 libvips。`packages/db/package.json` 是仍与 Copy 固定源一致的绑定文件，丢弃它纯表面的范围改写（prisma 解析本来就是 6.19.3），漂移集合不越出已审范围。
- 撤掉 `multer` override：`@nestjs/platform-express` 11.2.6 起自己钉 2.4.0 且是唯一消费者，解析不变。undici、fast-uri 两条保留（unifont 最新 1.0.2 仍要求 `undici ^8.0.0`，ajv 8.20.0 仍要求 `fast-uri ^3.0.1`）。
- Actions：`github/codeql-action` v4.38.0→v4.38.2（默认 CodeQL bundle 2.27.1，只用于非必需 canary）；`oasdiff/oasdiff-action` v0.1.15→v0.1.17（镜像内 oasdiff 1.31.0→1.32.1，入口脚本只加了 shellcheck 注释，`review: "false"` 与 `OASDIFF_INTERNAL` 的隐私合同不变；两个版本离线重放本仓最近 40 次 `openapi.json` 变更，finding 逐条一致）。
- 官方 registry 生产审计零 advisory（830 个依赖）；基线重新绑定到刷新提交，失效时间 2026-10-14T16:13:14Z → 2026-10-14T21:28:22Z（旧绑定 `BASELINE_SOURCE_LOCK_MISMATCH`、新绑定 `FRESH`，见[回执](../evidence/security/20260930-monthly-dependency-refresh-baseline-renewal.json)）。上一次续期同在当天，所以只顺延数小时，下一次刷新仍须在 10-14 前合入。Copy fixed-source 回执只重签指纹（`HASH_ONLY`）。

## 2026-09-30 · Dependency security floors wired into the governance gate

- `scripts/dependency-security-remediation.spec.mjs` 自 8-15 引入后从未被任何 runner 执行（不在 `governance:test` 入口、package 脚本、workflow 或 `gctl check` 里），#551 之后在 main 上 2/5 失败却无人察觉；安全合同页所说的「真实 deploy 版本不漂移」验证也因此一直没有在跑。现由 `governance-contracts.spec.mjs` 导入，随 required 的 `governance · traceability · release` 与 build 作业的 `docs:verify` 执行；`governance-path-contracts.spec.mjs` 拒绝移除该导入。
- 语义由「精确快照必须存在 + root overrides 全等」改为锁文件上的已审下限：例行升级（如 @nestjs/core 11.2.3→11.2.7）不再误报，而修补版旁边混入的旧版本（如 qs 6.14.0 与 6.16.0 并存）此前两层断言都会放过，现在失败；撤掉已被上游范围覆盖的 override 不受影响，但 override 只能精确钉到正式版本（范围、别名、git/URL 来源都失败）；锁文件里 URL/git/file 来源的同名包按无法比较处理并失败；已登记的漏洞前任（原先分在两张表，现合为 `VULNERABLE_PREDECESSORS`）必须低于下限，防止下调下限；`third-party-web` 仍由真实 pnpm deploy 回归钉住。对 9-30 修复前的 main 锁文件，下限正好报出 fast-uri 3.1.6、multer 2.3.0、undici 8.10.0。
- 代价实测：整份 spec 在 xin（4 核共用、load 12–21）上 2.7–4.3 秒；deploy 回归连续 20 次与 6 路并发 ×5 轮共 50/50 通过，load 37 时最慢 20 秒（单命令超时 50 秒、用例 120 秒）；在 load 35 的完整 `governance:verify` 中占 19.7 秒。

## 2026-09-30 · Scripts specs must be reachable from a CI runner

- 上一条不是孤例：`scripts/` 下另有 8 个 spec 从未被任何 runner 执行。逐个在 xin（4 核共用、load 12–22）上跑：`governance-main-worktree-sync-filesystem`（18 项，0.8 秒）、`runtime-artifact-contract`（13 项，0.4 秒）、`verify-platform-authority-policy-import`（2 项，0.4 秒）、`worktree-inventory`（8 项，0.9 秒）全过且零容器，现由 `governance-contracts.spec.mjs` 导入，随 required 的 `governance · traceability · release` 与 build 作业的 `docs:verify` 执行。
- `governance-github-readback.spec.mjs` 与 `governance-github-readback.mjs` 是 #566 删除 approval/readback 簇时漏掉的两个文件（名字不带 `-` 后缀），它们导入的 5 个 spec 与 4 个模块已随该簇删除，加载即报 `ERR_MODULE_NOT_FOUND`；按该簇已获批准的删除一并移除。
- 三个按设计不进零容器门的 spec 登记为手动（`MANUAL_SPECS`，各带理由与运行命令）：`platform-authority-policy-import.cross-repo` 需要 GrowthOS 权威检出，本机经 `node scripts/verify-platform-authority-policy-import.mjs` 实测 `VERIFIED`（4.0 秒）；`runtime-worker-namespace-lease.postgres` 起一次性 PostgreSQL 容器，默认跳过，设 `RUN_RUNTIME_WORKER_NAMESPACE_POSTGRES=1` 时 7 项全过（24.9 秒，容器已自动清理）；`execution-authority-policy` 在 main 上 6 项中 1 项失败，策略检查报 25 个问题：钉住的 `router-model-gateway.ts` 指纹自 d5e4bc42（8-26）起就不再匹配，Tool、Model 任务与投影清单也跟不上现有源码。重新钉 Router/ToolBroker 围栏要单独做安全复核，本次只登记、不改。
- 新增 `scripts/governance-spec-reachability.mjs`：只读 workflow 步骤的 `run:` 命令（折叠、字面、引号与多行标量整段读取，字面 `if: false` 关掉的步骤或作业不算），`pnpm <script>` 展开为根 package.json 脚本，收集同一命令段里 `node`/`tsx` 的 `--test` 参数，再沿 spec 与辅助模块的 import 求闭包（按 TypeScript 语法树判断，注释、字符串与纯类型导入不算）。`governance:test` 的独立根 `governance-path-contracts.spec.mjs` 断言 `scripts/` 下每个 `*.spec.*`/`*.test.*` 都可达或已登记为手动；登记缺理由或运行命令、已被 runner 执行、文件已删，以及 runner 用 glob 或指向不存在的 spec，都会失败。在仓库副本上做的 15 项变异（删导入、用块注释注掉导入、新增孤儿、删 CI 步骤、把运行步骤换成 echo、用 `if: false` 关掉步骤或唯一运行它的作业、glob runner 等）全部被拦下。`governance:test` 由 221 项增至 276 项，xin 上 load 15–17 时 51–64 秒（改动前 load 14.6 下 45 秒）。

## 2026-09-30 · Production advisory remediation and audit baseline renewal

- 9-28/29（UTC）官方 advisory 库新收录 15 条生产 advisory，9-30 起 main 的 `production advisory baseline freshness · canary` 报 `BASELINE_STALE`（#568、#569 合入后的运行均如此）：undici 8.10.0 共 11 条（3 高危，经 astro→unifont，仅 site-renderer 链）、fast-uri 3.1.6 共 3 条（2 高危，经 `@temporalio/worker` 的 webpack→ajv）、multer 2.3.0 共 1 条（经 `@nestjs/platform-express`）。
- fast-uri、multer 的安全 override 升至 3.1.8 / 2.4.0（后者也是 `@nestjs/platform-express` 11.2.7 自带的版本，并去掉了 concat-stream / typedarray）；另加以漏洞区间为选择器的 `undici@>=8.0.0 <8.10.2` → 8.10.2：pnpm 对声明范围与该区间相交的 undici 依赖生效（这里是 unifont 的 `^8.0.0`），AI SDK 的 `^7.29.0` 不相交，undici 7.29.1 未改动。按包过滤的 `pnpm update` 不会移动这份传递副本，还会扰动 vitest 的 peer 快照，所以沿用 lodash/uuid 那种精确钉版；unifont 自身要求 ≥8.10.2 后应撤掉这条 override。三个新包的 integrity 与官方 registry 一致，离线 `pnpm deploy` site-renderer（镜像构建路径）得到的也是 undici 8.10.2；本仓 API 没有文件上传路由，site-renderer 用 `@fontsource` 自带字体、不经 unifont 下载，两处升级触及的运行面都很小。
- 官方 registry 生产审计清零（870 个依赖）；基线重新绑定到修复提交，失效时间由 2026-10-03 延至 2026-10-14T16:13:14Z（旧绑定 `BASELINE_SOURCE_LOCK_MISMATCH`、新绑定 `FRESH`，见[回执](../evidence/security/20260930-advisory-remediation-baseline-renewal.json)）。Copy fixed-source 回执只重签指纹；`scripts/dependency-security-remediation.spec.mjs` 同步到新的安全下限（目前没有入口执行它）。

## 2026-09-25 · Search-first company discovery (G3 slice 5.3)

- `public_web` 发现阶段不再抓官网：SearXNG 的搜索语言随 ICP 目标国（德奥瑞 → `de`，法 → `fr`……，未知 → `en`）；查询串 = 品类词 × 目标国语言的贸易角色词（分销商 ICP → Großhandel/Händler/Vertrieb，角色来自 `trade_side`/`business_model`/`establishment_type`），不再硬加 `manufacturer company`；候选域名额外过滤非目标国 ccTLD；`discovery.extract_company` 只凭同一域名的搜索标题、摘要与 URL 判站并抽取，任务白名单去掉 `crawl4ai.fetch`。记录的 `parserVersion` 为 `public_web/v2-search`。官网页面改为在建档之后、以公司为主体抓取（5.4）。
- `directory` 名录页在建档前没有真实主体，抓取被主体绑定禁令拒绝时只跳过该页，不再让整个发现 run 失败；预算、授权等控制错误照旧上抛。
- 未升 lineage/materialization 合约版本：producer（`discovery.extract_company`）与结果 schema（`discovery-extract-company/v1`）不变，搜索回执本来就作为辅助回执处理；materialization 合约版本钉在 SQL 触发器与 activation 表中，升版不带来额外可验证性。依据：G3 规格 §3、§4.3、§5.3（版本一项按上述理由偏离，已在 PR 说明）。

## 2026-09-25 · Skippable artifact-subject denials (G3 slice 5.2)

- 新增 `artifactSubjectSkipReason`：沿 cause 链识别 ToolBroker 的四类禁令拒绝（主体 HOLD、tombstone、SUPPRESSED、绑定失效），供按公司处理的富集阶段跳过该公司，而不是让整个 run 失败。预算、授权、存储不可用等控制错误照旧上抛；`isExecutionControlError` 不变，所以发现阶段（无主体）的行为不变。`resolveRunStatus` 新增 `skippedSubjects`：有跳过时至少为 PARTIAL，但不会把全失败的 run 抬成 PARTIAL。依据：G3 规格 §4.2、§5.2；调用方在 5.4 接入。

## 2026-09-25 · Per-call artifact subject binding (G3 slice 5.1)

- `crawl4ai.fetch` / `crawl4ai.render` / `http.get` 的主体绑定禁令改为按调用判断：调用方在 `ToolContext.artifactSubject` 给出已建档的公司或联系人时，ToolBroker 先在 RLS 事务内核对主体属于本 workspace、未被 DSR tombstone、公司（或联系人所属公司）未被 SUPPRESSED，全部通过才发请求；抓取结果按工具声明的 `PERSONAL_DATA`、1 天 TTL 经 `GenericOperationArtifactService` 落对象存储，以 artifact 引用原子结算，重放时从校验过的对象字节还原。没有主体的调用（发现阶段建档前、平台 sanctions）保持原禁令；存储配置缺失时一律拒绝，不回退到内联结算。
- 新增迁移 `20260925090000_artifact_subject_execution_hold`：app_user 对 tombstone 表无表权限，执行前检查经只读 SECURITY DEFINER 函数完成，守卫与其余 v1 主体函数一致。治理锁 `artifactPhysicalExecution.status` 改为 `PER_CALL_SUBJECT_BINDING`。依据：G3 规格（2026-09-24，用户批准）§4.1、§5.1。本条不含失败语义（5.2）与发现阶段改造（5.3），产品链路尚未有调用方传入主体。

## 2026-09-22 · Native Temporal loopback ingress and customer namespace provisioning

- 原生 Linux dockerd 不为只接 `internal` 网络的容器映射宿主端口，`temporal-platform` 的 `127.0.0.1:17233` 在任何 Linux 宿主上都从未生效（Docker Desktop 用自带端口转发掩盖了它），`network_mode: host` 的 Backend 因此连不到原生 Temporal。改为：Temporal 不发布端口、仍只接 internal 网络；新增 `temporal-platform-ingress`（官方 HAProxy 3.4 LTS，按 digest 钉住，uid 99、只读、无能力、无密钥），只把 `127.0.0.1` 转发为纯 TCP 到 `temporal-platform:7233`，TLS 与 JWT 授权仍端到端。relay 另接一个关闭 masquerade 与 ICC、无 IPv6 的网桥，能发布端口但不能出网。
- 保留准入拒绝 Temporal 自身的任何宿主端口，钉住 relay 的镜像、入口、用户、挂载、网络、loopback 端口与网桥选项；relay 配置并入原生源码摘要，启用需要从包含本改动的提交重新发布原生镜像。
- 共享 provision 现在同时创建 `default`（`roles.json` 授予 customer worker/client 的命名空间）：7 天保留、不带任何归属标记，漂移报 `TEMPORAL_CUSTOMER_NAMESPACE_DRIFT` 且不自动修复；已按 `--retention 7d` 手工创建的宿主不受影响。disposable harness 用产品 relay 配置证明宿主网络路径，machine-worker 探针不再自建 `default`（这正是缺口此前未被发现的原因）。原生 dockerd 真实运行见[记录](../evidence/temporal-platform-loopback-ingress-20260922.md)；不是 RuntimeEvidence 或保留部署。

## 2026-09-21 · Dev-dependency alert refresh

- vitest / @vitest/coverage-v8 升至 4.1.11；baseline-browser-mapping 经传递升级至 2.11.25；Prism 模拟服务链上 `postman-collection` 固定依赖的 lodash、uuid 以精确范围 override 升至 4.18.1 / 11.1.1（上游最新版仍固定旧版本）。升级后本地启动模拟服务，`/api/v1/health` 返回 200。
- `@faker-js/faker` 5.5.3 保留：仅 `@global/contracts` 的 Prism 开发依赖使用，上游精确固定且 10.x API 不兼容；模拟服务只渲染本仓 OpenAPI 示例，`helpers.fake` 模板注入不可达。Go OTel 三项低危告警随 Temporal 服务镜像另行处理。
- 生产审计仍为零 advisory；漏洞基线重新绑定到新锁文件（旧绑定 `BASELINE_SOURCE_LOCK_MISMATCH`，新绑定 `FRESH`，见[回执](../evidence/security/20260921-dev-dependency-alert-refresh.json)），`valid_until` 2026-10-03 未延长。Copy fixed-source 回执只重签指纹。
## 2026-09-21 · PR decision card retired; standing merge authorization

- 移除 `nontechnical decision card freshness` 必需检查及其 `pull_request_target` 工作流、`pr-decision-card-status/v4` 解析器与测试；PR 模板改为四行不经机器解析的「给产品负责人的说明」。原因：卡片按其自身合同只是未验证声明、授权字段恒为 `NOT_AUTHORIZED`，检查不能验证真实性也不承载授权，却让每次推送都失效（两天 123 次运行、40 次失败、42 次取消）。历史合同见 Git provenance 与[真实验证记录](../ai-development/decision-card-live-validation.md)。
- 产品负责人以 `DEC-AIDEV-004` 授予常规 PR 常设合并授权：开发代理独立审查通过、必需检查全绿、线程清零且基于最新 main 后可合并；ruleset/设置/权限、部署发布与付费调用不在其内。`required-contexts.json` 中 ≥1 批准 + CODEOWNERS 的远期目标保持不变。
- Copy fixed-source 回执只因 `package.json` 删去一条脚本而重签指纹；漂移集合与 `STALE_HOLD / NOT_AUTHORIZED / BLOCKED` 不变。
- #549 合入后经产品负责人授权修改 `protect-main`：移除决策卡 required check（余 5 项），并关闭 strict，以免每次合并后其余 PR 串行重跑；替代保护见 [CI 合并自动化](../backend/ci-merge-automation.md#2026-09-21-ruleset-变更产品负责人授权)。

## 2026-09-20 · Dependency queue and source-status closeout

- 按批准顺序接入 Redocly2.53.2（#539）、Langfuse5.11.1（#540）、配对S3 3.1134.0（#541）与AI SDK补丁（#543）。工具链更新与本次状态修订组成最后候选；最终 head、hosted checks、独立审查与 merge 分别从原#533的successor记录回读，不预设本文自身未来SHA。完整来源与验证边界见[本轮证据](../evidence/dependency-queue-closeout-20260920.md)。
- 保留 Copy 固定 binding 和 `STALE_HOLD / NOT_AUTHORIZED / BLOCKED`，只重算实际源码的派生指纹；保留无关平台 metadata，工具链候选恢复10项共享解析降级。真实MinIO、本地SDK/loopback与现有测试不升级为retained runtime、Release、UAT或Pilot/GA。
- 修正状态页中#407仍开放、#451仍待办以及把2026-09-12运行观察当作当前事实的旧文字；原文Git provenance、历史evidence和产品完整C1–C5/QGO、Site验收、Billing延期边界保留。#494/#495实际分别MERGED，随后#497收口；不把实际历史改写成最初计划的superseded路线。
- 216个历史worktree候选的commit/tree完成独立恢复回读，ignored材料、owner release与精确删除授权仍独立处理；没有据此删除未知分支或现场。根main只经受控governor跟随，实际同步与全量处置结果由批末回执确立。
- 生产审计零advisories不等于baseline freshness。迁移任务的#542合入并发布后明确释放依赖窗口；本工具链候选重新采集精确生产审计，实际旧绑定HOLD、新绑定FRESH，保留原政策/到期时间/verifier及全部历史回执。其他owner的R4、身份admission与Program C按各自已交付层级记录，未声明全产品闭环。

## 2026-09-12 · GrowthOS managed release restoration

- 只读发现current选择器仍指向20260823 demo及local标签；恢复已发布541bcc63基线的三项exact镜像，并把选择器改到managed release，不重建源码、不接空卷。恢复前用实际Flyway12.8.1校验代码逐项比对27个迁移checksum，全部匹配；fresh备份可读且0600，基础设施镜像及既有凭据保持。
- 三项产品容器healthy，JWKS三端点200且public-only；Tenant/Platform首页200，3002/3003/18081只绑定loopback。MySQL改用已发布release中正确权限的配置，旧world-writable警告消失；27/27迁移无变化。
- Backend的identity/Budget/Execution JWKS、workspace budget和quote authentication恢复ok；aggregate仍503，阻断推进至平台Temporal proof和matching Worker。没有把历史基线恢复冒充最新GrowthOS候选、serviceJWT/producer/consumer、UAT或Pilot完成。精确来源、备份/校验摘要及镜像见[恢复记录](../evidence/growthos-managed-runtime-restoration-20260912.md)。

## 2026-09-12 · Browser proc-exit race successor and exact-image adoption

- #517 在同步 #498 后以 exact head `0a7d2259466c144291f1e6abede51360c02eb1ac` 完成 required CI 和独立 delta review，合入为 `b6be49020b28dccf2f67413667c396a893b9ce94`。修复将 Linux proc stat 的 ESRCH 识别为该 PID 已消失，仍扫描其他成员并保留 EACCES/EIO/活进程组的阻断。先前 headless/timeout 变更及重启后的短暂成功并未消除该竞态。
- 从该 exact main 发布 `ghcr.io/mlhjyx/global-backend@sha256:175ae53c6500456f1121d006fd4add694231d15e20d26fbd77ef795d3f9f90d5`，先完成发布来源校验、服务器预拉取和离线 verifier，再于13:28 UTC采用。API、Worker、Relay回读匹配同一source/image/artifact/migration；没有queued/running BuildRun，没有手工业务数据更新、迁移或凭据改动。
- [持续运行观察](../evidence/browser-readiness-runtime-adoption-20260912.md) 已完成30分钟60次采样，observer exit0且PASS；browser持续`ok`不升级为整体ready。GrowthOS旧demo运行导致identity/Budget/Execution JWKS不可用，平台当前首先停在QUOTE_UNAVAILABLE，Worker仍STARTING。历史观察保留，不重写成新版本通过。
- GrowthOS0101/0102的codec与独立签名/JWKS完成本地patch重放和35项相关测试；实际Java签名与Backend互操作通过，Backend本地`a56665123572b9471dff2761fb87cb3eb6472c9a`增加持久golden vectors及111项capability回归，精确绑定见[本地验签记录](../evidence/platform-capability-java-local-20260912.md)。未把这些源码结果外推为service JWT交付、真实producer/consumer、hosted跨仓CI或UAT。

## 2026-09-12 · Browser readiness headless environment successor

- PR #513 `fix(runtime): pass headless mode to browser readiness probe` 已通过完整 hosted CI 并合入，merge commit 为 `479d51f0dd474df31f0547923cc072064b897a03`。修复在受控浏览器子进程环境中显式传递 `CHROME_HEADLESS=1`，保留批准的 Chromium executable、隔离临时目录、网络禁用参数和 fail-closed 错误语义；聚焦 runtime 测试 58/58 通过。
- 从该 exact main 发布并验证新的 immutable OCI：`ghcr.io/mlhjyx/global-backend@sha256:137f881da04ac2d22258dd909c674798613335745226d22dd2cc9a03c965a783`，artifact `sha256:fe8e6fb41438012b502a791b7b3a9eda32bb4af078a5593dbf2e1c20fd5d6070`，manifest `sha256:0111e7a4016fa052788abd1604d9d0365202b3c554279cb5b0df791e61b2389f`，SBOM `sha256:5fe6a6215565126612b2476fcfe27c77618a9fb1f768d213529dc85fa3d882ff`，并完成 registry provenance attestation。
- API 与 Worker 已通过受控 drain-and-swap 运行该同一 digest，`/health/build` 返回 attested、image/artifact/migration identity 一致；Chromium browser readiness 现为 `ok`。`/health/ready` 仍为 503，原因仍是 `PLATFORM_AUTOMATION_ACQ_SWEEP_TEMPORAL_PROOF_UNAVAILABLE` 与 `MATCHING_WORKER_NOT_READY`，不把浏览器修复外推为平台或产品就绪。
- 首次运行中 readback 曾捕获一次 browser probe 清理失败并按 singleton 语义保持 fail-closed；未修改数据或绕过门，执行同 digest 的受控 API/Worker 重启后 browser 恢复，连续 5 次 `/health/ready` readback 均为 browser=`ok`，残留 probe 目录已清理。该事实说明当前恢复依赖受控重启，不能宣称已有自动自愈或 RuntimeEvidence。
- 当前未执行真实付费模型调用；客户 Billing/Credits 继续 `DEFERRED / NOT_IMPLEMENTED`，`cap_microusd` 仍只是平台内部执行安全包络。旧 PR #479 已关闭为 provenance，干净重放候选 #515 的 GrowthOS capability producer、capability JWKS/service token、真实 Temporal reader、revocation delivery 和跨仓 hosted contract 仍保持 HOLD。


## 2026-09-06 · GitHub queue currentness closeout

- 22:09 +08:00 只读复核 root/remote main `17b637d7e2a333cc4c76f04c7798b42f74f2fb37` 及该提交成功的 build/contracts/security/governance/CodeQL/advisory checks；#455 平台 Temporal 基础设施、#456 执行规则与 #457 决策卡修复均已合入，不再列为待合入候选。
- GrowthOS 本地 authority 已前进到 clean `51d7420373e31ba5c2a696513d8d6b5e77ed3fe0`；其当前接纳仍需独立证据。API/Worker metadata 仍为 `674ff12d…` / `sha256:b70175a0…`，6 条 RuntimeEvidence 全部 historical；本次没有重新验证 readiness 或用户旅程。
- 承接既有 #451 文档修订，保留原历史条目和冻结证据。GitHub 队列收口授权不扩大为部署、保留迁移、Provider/模型/付费或 Pilot 授权。

## 2026-09-06 · Global source merge readback and currentness correction

- #452 Browser 默认生命周期接线、#453 ACK 状态回读、#454 DeletionCompleted v1 兼容修复依次合入，最终 merge 为 `63b4af94b662d7e2b6a40823a1872daf0fc9b993`。三项 PR 必需 CI 与该主线 CI 全部成功；最终源码树匹配本地组合，134 项相关测试、4 项一次性 PG/RLS、构建与 OpenAPI 一致性通过。
- 后续另一任务合入 #457，主线前进到 `8eefba1cff15f2bbe4154451cac958a072803ab5`。2026-09-06 21:17 +08:00 回读时，其安全、治理、依赖、CodeQL 成功，CI 仍在运行；不能挪用前一提交的全绿描述。
- 同次 Docker metadata 显示 API/Worker 仍运行旧 `674ff12d…`/image `b70175a…`，不是新修复的运行验收。治理报告 0 current / 6 historical RuntimeEvidence；没有新部署、保留数据迁移、缓存清理、Provider/模型调用或 UAT。
- Program C 同文件 C1 合同在独立工作区提交 `4b116f10…`，三项剩余 wire/privacy/digest finding 已复审关闭；这是本地文档，不是 main 中的 C1 实现。GrowthOS 当前 writer 仍须完成明确文件交接。
- 此次文档候选撤销针对旧日期/SHA/临时状态的硬编码文字断言，保留稳定 ownership、历史计划合同及真实机器 RuntimeEvidence/Release/权限/晋级测试；architecture 与 evidence 索引改为引用唯一 current 页面，不复制动态计数。旧观察和原始 evidence 不改写。

## 2026-09-04 · Global dynamic currentness successor

- 18:58 +08:00 source/worktree 与 18:32 runtime readback 固定 repository source `0679a0bc510a980f65ebd33eb88b3215a97c20ba` 和 development runtime source `674ff12d4d768ce5599fc07b565fe21da37dc5fe` 为分离身份；后者落后 main 4 commits。服务/探针健康不等于 current main 已部署，3001 与 legacy 8080 wildcard 风险仍开放。
- 全局 G5 拆为 `G5-Site=AMBER / TIME_LIMITED` 与 `G5-Acquisition=RED / NOT_READY`：6 条 RuntimeEvidence 中 current 2 / historical 4，current 2 仅属 Site 且到期 `2026-09-05T03:49:25.000Z`；Acquisition evidence 为空，platform readiness 报 `PLATFORM_BUDGET_AUTHORITY_PLATFORM_ACQUISITION_MISSING`。
- Program B accepted source slices #427/#431/#432 已不可变进入 main，必须与 active Task0L 分开；后者 authoritative implementation review 仍为 `C3 / H3` 且 coverage <80%。Program C durable consumer/Opportunity/commit-before-ACK 尚未实现。current-main Supply Chain Canary run `33855198691` 因 advisory baseline stale 失败，不能称 main CI 全绿。
- 本 successor 只更新 currentness 合同和导航；不改写 RuntimeEvidence/Release Bundle，不执行 push、PR、merge、retained migration、部署、listener 调整、provider/model dispatch、UAT 或 Pilot。

## 2026-09-04 · Platform writer terminal reconciliation and fresh zero-model evidence

- 追加 platform-writer development successor evidence。fresh deterministic smoke 在同一 exact runtime 上完成且 model calls 为 0；历史 Spend 保持 `UNKNOWN/unknown`、reservation/conservative charge 均为 `800000`。
- request-bound reconciliation attempts 1–5 为 `UNRESOLVED`，attempt 6 已 `EXPIRED`；该终态不产生 durable output、ACK、精确费用、redispatch 或第二次物理调用，也不构成 generative success、UAT、Pilot 或 GA。Platform acquisition authority 仍 missing，customer Billing/Credits 继续 `DEFERRED / NOT_IMPLEMENTED`。

## 2026-09-02 · Platform writer API composition and exact-runtime successor

- PR #443 修复 API Nest composition 漏装配：专用 `execution_budget_platform_writer` client 只来自唯一 deployment env，缺失/空白保持 fail-closed，owner/app URL 行为级负例禁止 fallback；API/Worker 复用同一工厂，API lifecycle 负责断连。完整 CI、CodeQL、安全与独立 review 通过。
- exact main `674ff12d…` 发布为 `sha256:b70175a0…`，GitHub environment approval、registry attestation、非 root/entrypoint 与离线 image verifier 通过；API/Worker/Relay drain-and-swap 后共同绑定 artifact `sha256:f34128f5…`，127 migrations、READY、restart 0、mixed digest 0。
- Platform capability 从 `WRITER_UNAVAILABLE` 变为 `PLATFORM_ACQUISITION_MISSING`，证明专用 writer/principal 可用但外部 Control Plane 仍未摄入 `platform.acquisition`、`platform.intent_watch`、`platform.sanctions`。没有 seed 假 authority；该缺口不阻塞 Site Builder workspace Grant。
- 新 digest 上以 `DETERMINISTIC_ONLY=1` 运行 GrowthOS Session→Access Token→Technical Quote→Budget Grant→Intake→READY Release，BuildRun `034e4175…` 成功且模型调用为 0。历史 UNKNOWN Spend 在三次只读 reconciliation 后仍无 Gateway consume log；完整 reservation 与不重发语义保持。
- 新增追加式 successor RuntimeEvidence、readback 与 development CANDIDATE；旧 evidence 不改写，Pilot/GA、成功 generative output、公开发布和客户 Billing/Credits 均未因此成立。

## 2026-09-02 · Production Parity development capability cutover and UNKNOWN settlement correction

- GrowthOS authority `541bcc63…` 的三个独立 RS256 signing domains、短期 Backend Access Token、零费用 Technical Budget Quote 与自动 Site Build Budget Grant 已装配到 Tenant Web；客户没有余额、充值、模型次数或固定金额门，technical cap 只作为平台执行安全包络。商业 Billing/Credits 继续 `DEFERRED / NOT_IMPLEMENTED`。
- Backend PR #440/#441 合入后发布并部署 `main@da2f7aeb…` 的 exact OCI `sha256:66e2dbf8…`。API、Worker、Outbox Relay 三个 fresh lease 共用同一 image/artifact/migration；127 migrations、readiness、GrowthOS 三个 JWKS 与无 mixed queue digest 均已读回。
- 同路径确定性 Intake BuildRun `84aa659f…` 成功并产生 READY Release。获授权的一次真实模型 refurbish BuildRun `81dcfe5a…` 没有 durable output/ACK；修复后的持久事实为 `UNKNOWN/unknown`、完整 reservation 保守扣减、paid-call kill switch 关闭，request-bound reconciliation attempt 1 为 `UNRESOLVED/log_unavailable`。只有一次物理模型调用，没有自动重发。
- 新增 development RuntimeEvidence、脱敏 readback 与 `CANDIDATE` Release Bundle；它们明确不授权 Pilot/GA，不证明模型质量或公开发布。`platform_budget_authority` writer 仍不可用，但 Site Builder 使用的 workspace budget authority ready。

## 2026-09-01 · MinIO PERSONAL_DATA exact-version cleanup policy correction

- Production Parity retained-development bootstrap 首次真实 provision dedicated artifact bucket 时，bucket、versioning、SSE-S3、lifecycle、runtime policy 和 personal-read policy 均成功，但 MinIO 对 cleanup policy 返回：`s3:ExistingObjectTag/artifact-privacy` 不支持 `s3:DeleteObjectVersion`。bootstrap 按设计失败关闭，没有创建 cleanup user，也没有启动 Backend runtime。
- 根因是 S3 授权模型本身不允许基于 existing-object tag 授权 DELETE，而不是 development/production 配置差异。修复保持一个产品路径：final key 由受控 privacy class + digest 派生到三个互斥物理 prefix；runtime 的 Put/PutTag 权限逐 prefix 绑定唯一 privacy tag，cleanup IAM 只允许 `final/personal-data/*` 的 exact-version read/tag/delete，无 list/write/tag mutation/bucket管理。adapter 在同一 exact `VersionId` 上读取 tag，并只在 tag set 唯一等于 `artifact-privacy=PERSONAL_DATA` 时删除。缺 tag、非个人 tag、歧义 tag、版本不一致或读取失败均在 delete 前关闭；模糊 404 只有在 bucket location 仍可读时才作为 ABSENT，NoSuchBucket/endpoint 404 保持重试失败。
- 新增 forward-only `20260901060000_generic_operation_artifact_privacy_prefix`：任一 object/manifest/pending cleanup 非空即要求显式迁移；空库才把 object 主键扩成 `(sha256, privacy_class)`，并替换两张表 CHECK、manifest assertion、append/cleanup object lookup。一次性 PostgreSQL 从零应用 125 migrations；同一 digest 的三种 privacy object 可并存，新 prefix 通过、旧 prefix 拒绝、函数 readback 更新。S3 bootstrap 在首个 provision mutation 前独立执行 version-aware predecessor-prefix scan；root bucket inventory 或 version listing 任一失败均稳定 `STORAGE_PREFLIGHT_UNAVAILABLE` 且零 mutation，真实 MinIO 非零 version 拒绝、清零后接受，覆盖“DB 空但 promote 后 orphan version 存在”的失败窗。
- RED 覆盖证明旧 adapter 会跳过 tag gate；GREEN 后 artifact+budget focused 336 PASS / 9 conditional skip、deployment contract 9/9、API build 和完整 API 429 files / 6,396 tests PASS（4 files / 42 tests conditional skip）。修复版 bootstrap 在同一 retained MinIO 上完成三类最小权限 user/policy attach并返回 `OBJECT_STORAGE_PROVISIONED`；真实 cleanup-principal spec 3/3 证明 personal exact-version 删除、confidential direct-delete deny、cross-prefix/tag 写拒绝、无 list/tag mutation、旧版本删除不产生新 marker 与 missing-bucket fail closed。测试在任何 client/stage/promote 前进入外层 `try/finally`，按阶段登记 staging/final key 与 exact VersionId；从全 bucket 0 开始并在 finally version-aware 清除 final/staging versions 与 delete markers，结束仍为 0。这仍不等于 Backend API/Worker readiness、真实 BuildRun 或 Pilot/GA；必须发布新的 exact-main OCI，当前中间镜像不得部署。

## 2026-08-24 · Production Parity PERSONAL_DATA cleanup runtime readback

- [PR #413](https://github.com/mlhjyx/global-backend/pull/413) 在 required CI、Supply Chain、CodeQL 与全部 inline review thread 收口后，以普通 merge commit `866ede78` 合入 main；未使用 admin bypass。main freshness 以 `BASELINE_SOURCE_LOCK_MISMATCH` HOLD，证明旧 36-advisory baseline 不能描述新 lock。后继 baseline refresh 从 exact main 重建 10 条 advisory / 10 条 canonical exposure，并逐项继承剩余 Site Renderer/Astro 的 owner、due date 与 validity；不把已解决项保留为例外，也不延后剩余债务。

- 生产依赖安全收口提交 `7a7bea11` 完成 NestJS 10→11 / Express 4→5 与 `fast-xml-parser` 4→5 的协调迁移；未通过 override 强压不兼容主版本。新增 loopback HTTP 测试捕获并修复 Express 5 wildcard 参数从字符串变为数组的真实语义变化，同时保留 nested query 的 extended parser 合同。API 385 files / 5755 tests PASS（3/39 skipped），本地受信 base→candidate graph-delta 为 `COMPARABLE_AUDIT_PASS`，36 条 production advisory 降至 10 条、26 条 resolved，全部逾期 NestJS/Express/XML 公告消失。该记录不替代 PR #413 Hosted CI、合并或部署 readback；Copy fixed-source 继续为 `STALE_HOLD / NOT_AUTHORIZED / BLOCKED`。

- `codex/production-parity` 的 exact clean HEAD `50c23d8de738ba7bdac9b9b2ff85630bab8473a1` 收口了 PERSONAL_DATA artifact cleanup 的物理 runtime wiring：内部 exact S3 VersionId、tombstone/audit commit fence、shared-digest advisory fence、durable cleanup command、Outbox→Temporal retry/backoff 与独立 cleanup principal。ToolBroker 的 `GENERIC_OPERATION_ARTIFACT_SUBJECT_BINDING_HOLD` 仍保持，未新增 producer 旁路。
- 用户授权的 disposable PostgreSQL 16 验证使用本机已有 `pgvector/pgvector:pg16`、内部临时网络与 tmpfs 数据目录；全新数据库应用 98 个迁移，真实 `app_user` 通过受控函数完成 inspect/enqueue/claim/complete/replay，验证 exact VersionId、FORCE RLS、直表权限拒绝、跨 workspace deny 与 shared subject binding fence。临时容器和网络已清理；该记录不触碰 retained `global-postgres`。
- 运行验证先后捕获并修复两个迁移缺陷：PL/pgSQL `audit` 局部变量与 SQL alias 歧义、PostgreSQL 不支持 `{1,1024}` 重复上限。修复提交为 `da7b92c0`、`bb5a9d03`，并新增 migration regression tests；cleanup activity 的异常 cause 保留修复为 `50c23d8d`。
- 最新 source checks：API 384 files / 5752 tests（3/39 skipped）、API build PASS、lint 0 errors/16 既有 warnings、governance 118/118、`docs:verify` 0 errors/1 既有 table warning、ContractGraph 10917 nodes / 25049 edges / 0 errors。MinIO/S3 policy attach 与 exact-version delete、Temporal/Worker/Relay 目标环境 admission、OCI 发布/部署、主线合并、RuntimeEvidence 与真实模型调用仍为 UNKNOWN/未执行。
- 后续门修复：`f41c12a5` 恢复 sanctions workflow 的 destructured activity graph binding，并让 Temporal 测试 proxy 在 reset 时保留 memoized spies；`65eabae9` 修正文档注释。`fb5e2e21` 将 OCI Dockerfile 与 SBOM/manifest contract pin 从已撤出的 Chromium `151.0.7922.137-1~deb12u1` 更新到当前可得的锁定版本 `151.0.7922.173-1~deb12u1`。新 PR CI 的 governance/contracts/renderer/gitleaks/CodeQL canary 结果已回读，production advisory delta 仍因既有 overdue advisories fail；OCI 完整 readback尚在运行。
- CodeQL 安全收口提交 `a648706a`：Helmet 恢复 CSP；catalog 与 image pipeline/child 使用 `O_NOFOLLOW` 句柄并校验 dev/ino/size；managed image child path 改为生产相邻制品、测试显式 DI；slug 去除交替锚定正则；opaque provider token 保留 v2 SHA-256 fingerprint 合同并添加有理由的 CodeQL 语义抑制。该提交的本地 API 384/5752 与 focused 39/39 通过，新的 CodeQL/CI readback 尚待推送。
- `05b8b73d` 补齐 child/runner 输入输出文件句柄的 before/opened/after `dev/ino/size` 复读校验，并把 slug suffix 改为 rejection sampling、前缀清理改为线性字符扫描。该提交尚未完成新的 CodeQL/CI readback；此前 `ac9a3143` 的 CodeQL 仍报告 6 个 high，不能用本地测试替代远端安全门。
- `41843111` 将 catalog、child input、runner output 的读取顺序进一步改为先 `open(O_NOFOLLOW)` 再句柄校验/读取，消除 CodeQL 的 check-before-open 模式；保留 opaque token v2 SHA-256 fingerprint 合同和有理由的 in-source suppression。新 CodeQL readback尚待该提交推送。
- `ae2d9a0e` 将已退出产品 composition 的 legacy attestation verifier credential check 改为 work-factor PBKDF2；正常产品 Budget Grant/模型路径不读取该 verifier。新一轮 CodeQL 尚待推送 readback，旧 `161bdd68` CodeQL 仍只剩该 legacy weak-hash alert。
- `40c13f1c` 删除产品源码中的 fast credential fingerprint helper，legacy verifier 继续使用 PBKDF2，测试改用固定脱敏 digest。目标是让 CodeQL 只看到 work-factor legacy sink；新一轮远端安全 readback尚待执行。

## 2026-08-22 · 通用操作 Artifact 耐久重放 Task 8 记录（pre-cutover / no runtime claim）

- 新增 [通用操作 Artifact 耐久重放实现记录](../implementation-records/generic-operation-artifact-replay.md)，固定 Task 1–7 在 `codex/production-parity` 的 `a06eb7f4f29d8b9dd0ed47f52a1d86d60a13379b` 审查基线：closed small reference、digest-derived immutable key、七个 additive artifact migrations、expected facts、`RESULT_UNKNOWN` recovery、bounded materializers，以及 deployment-owned MinIO lifecycle/IAM/readiness contract。
- 本次聚焦 artifact/ToolBroker suite 为 232 passed / 6 skipped（artifact statements 86.95%、branches 82.89%），schema validate、API build、governance（118/118）和 docs verifier 通过；ContractGraph clean scan/status 绑定 `a06eb7f4…`（10,407 nodes / 23,838 edges），但仅为 static impact，未评估 RuntimeEvidence。
- 在 `9aab31ff0239165ef373ed9eb17adf6c0e630b5e`，legacy ToolRegistry fixtures 已显式声明匹配当前合同的 `durableResultStrategy`，先前 `public-web-wire-suppression` 1 个与 `paid-execution-gates` 3 个 fixture mismatch 因而关闭。完整 API suite 现为 **349 files / 5,375 tests / 10 skipped / exit 0**；这只是本地 deterministic suite，不推导 MinIO、OCI、部署或 RuntimeEvidence。
- 当前 worktree 没有 fresh disposable PostgreSQL/MinIO receipt；为不写入其他 worktree 保留的 `global-postgres`/`global-minio`，real RLS 和 Task 7 six-scenario MinIO contract 继续为 `RESULT_UNKNOWN`，不伪造 PASS。
- 仍是 additive/pre-cutover：没有 Domain ACK/cutover、Authority admission/Control Plane transport、retained migration、OCI/deployment/readback、production RuntimeEvidence、Release Bundle、merge 或用户可用性声明。Copy receipt 保持 `STALE_HOLD / NOT_AUTHORIZED / BLOCKED`，不 rebaseline 或授权 dispatch。

## 2026-08-21 · Execution Budget Authority additive foundation

- Tasks 1–7 在 `c96b5d4f04ca8d93ad23b4b7b690e88bd2449f42` 后完成共享 Authority claim/JWKS verifier、Workspace Grant 同事务 consume+authorized-open、Platform signed command/schema/ingestion、FORCE RLS authority/revocation/account binding，以及独立 capability health snapshots；实现收口于 `bea4d7392344cd44cbfbc5379a7d620f418122fc`。现有产品 caller、API/Worker admission 与 legacy cap path 未切换，probe 只观察、不 admission。
- 外部 Control Plane signer/JWKS、Workspace producer、Platform inbound transport、部署 writer LOGIN/credential/connection 均为 `EXTERNAL_OWNED/PARTIAL`。本批次没有 retained migration、服务重启、真实 JWKS/provider/model/paid call、部署、RuntimeEvidence 或用户可用性声明；产品 cutover 仍须按独立计划与授权执行。
- Authority 新 export 令 active Copy v22 source bundle 多出 `packages/contracts/src/index.ts` 漂移。旧 binding/evidence 未改写；机器 successor 固定 11-path fingerprint `fadc301c5944d06e1a97dd77c022b3d5d6b79ce9fe52758329f22fa6e69984a9`，继续为 `STALE_HOLD / NOT_AUTHORIZED / BLOCKED`。partial/extra/predecessor path-set mutation 均拒绝，不 rebaseline Copy、不授权 dispatch。
- Fresh verification：Authority/Task 7 changed-scope coverage statements 88.30%、branches 87.71%；API 327 files / 4,836 tests；disposable PostgreSQL 16.14 从空库完成 84 migrations 与 RLS/ACL/concurrency 20/20，容器和匿名卷均销毁；Governance 115/115；ContractGraph 0 errors。完整 provenance、命令、外部交接与 deferred minors 见[实施记录](../implementation-records/execution-budget-authority-contract.md)。
- Fix Round 1 更正 coverage denominator：完整 include 为 `execution-budget/**/*.ts`、managed dependency readiness、runtime readiness、health controller/schema、Site Build request guard 与 `budget-store.ts`，并执行原十个 specs 加 `budget-store.spec.ts`；11 files / 252 tests PASS，statements 88.76% (632/712)、branches 88.21% (479/543)、functions 88.10% (163/185)、lines 91.19% (611/670)。同时把 [Copy fixed-source CURRENT 治理页](../implementation-records/copy-fixed-source-impact-governance.md)更新到 active v22、多 narrow exact scopes 和当前 Authority 11-path `STALE_HOLD / NOT_AUTHORIZED / BLOCKED` 机器真值；successor 不等于 CURRENT、rebaseline 或 dispatch 授权。
- Final-review fix wave 以 `0ba38497…` RED / `98a7d600…` GREEN 收口 6 个 Important：authority-bound 账户使用 `cap_cents=0` 且 legacy cents lifecycle 全面 fence；Platform ingest/open/revoke 在 repository readback 外由同一 PostgreSQL helper 重做 exact LOGIN/group attestation；新增窄 append-only revoke 与共享 campaign/60 秒 freshness 计算；DB 强制 schedule subject equality；verified time 改为 immutable NumericDate seconds。writer-only microusd reserve/settle/status/close、外部 transport、产品/API/Worker cutover 仍为 blocker，不宣称完整 Platform lifecycle。验证为 focused 225/225、coverage 12 files / 283 tests（statements 89.63%、branches 87.79%）、Full API 327 files / 4,865 tests、fresh PG16 28/28、84 migrations up-to-date、pre-Task3 upgrade 与 fresh schema 无差异；无 retained migration、真实 JWKS/provider/model/paid call、部署或 runtime claim。Copy bound paths 未新增，existing 11-path successor 继续 `STALE_HOLD / NOT_AUTHORIZED / BLOCKED`。
- Correction gate 在 `51f61391…` → `c29e5742…` 修复剩余整秒 NumericDate 边界和 readiness 后台 rejection containment：SQL 只把比较时钟归整到秒，verifier/ingest/open/freshness 对 `-61/-60/0/+60/+61` 使用同一容差矩阵；Platform freshness 显式处理 `invalid` 并生成固定 purpose-derived code；bootstrap/interval refresh 以有界 catch 保留 fail-closed snapshot。独立 scoped review PASS。全新一次性 PG16 的完整 Authority RLS/ACL/concurrency 为 29/29、84 migrations up-to-date；fresh deploy 与 old-migrations-plus-Authority upgrade schema diff 为 `No difference detected.`。Copy readback 无指纹变化，仍为 `STALE_HOLD / NOT_AUTHORIZED / BLOCKED`；没有 retained migration、RuntimeEvidence、真实 JWKS/provider/model/paid call、部署、重启或 product cutover。

## 2026-08-10 · 获客 Suppression/DataRights source 治理

- #375 已以 merge commit `5b588353fba6cdbda3a7e0f5f171a3e2fabbc786` 合入 roles→scopes，并在该 main commit 上通过 CI、Governance、Security、Supply Chain 与 CodeQL push canary；Supply Chain 仍是带 36 项生产依赖遗留风险的 ratchet pass，不是漏洞清零。
- 当前独立变更集取消 suppression 裸 DELETE：`suppression_record` 保留事实、未知原因 fail-closed 为 LEGAL、只允许 PREFERENCE→LEGAL；类型化 canonicalizer 拒绝无效禁联值，并在新写入、旧值读取、发现匹配、即时公司分块更新和所有动作门共享规范键，避免“201 成功但永不命中”。fit/enrich/signal/watch/contact/guess 六个自动 backlog 阶段每家出网前直接复核原始 suppression；长网络后的联系人/猜测写入、邮箱验证回写、Lead accept 和 suppression 创建共享 workspace 事务 advisory lock 并在提交前复读。被禁邮箱联系人从 `LeadQualifiedPackage` 排除，过滤后零可达则 accept fail-closed。释放和身份纠正的 `suppression_decision` 分别保留 requested command 与 outcome，同 requestId 的不同原始 reason 返回幂等冲突；DB 固定合法语义组合，普通 API 不执行真实 release。OpenAPI 现显式列出 400/404/409 统一错误 envelope 与 UUID path；审计/PII 列表使用 cursor page envelope 且每页最多 100。
- DataRights DENY 从“throw 导致日志回滚”改为先在租户事务提交 `policy_decision_log`、再在事务外返回 409；在 DENY 前不执行 Lead CAS、不建 LeadDecision、不发 LeadQualified。隔离无卷 PostgreSQL 空库完成全部 82 migrations，并验证 app_user 禁止删除 suppression、禁止更新/删除 decision、禁止 LEGAL 降级与跨 workspace 关联；测试容器已删除。该证据只属于 source/migration 验证，不代表已部署或真实 pilot。

## 2026-08-10 · Copy fixed-source 影响治理

- 新增 [Copy source eligibility receipt](../evidence/site-builder/copy-runtime-eligibility.json) 和 required-build verifier。活跃 v15 binding 的路径、文件 SHA、artifact ID、82-file bundle digest、当前 source fingerprint 与 drift paths 都必须精确匹配。
- 只有零漂移可执行 v15 双 fixed-source rebuild。与 Copy 无关的 Prisma schema 漂移必须显式降级为 `STALE_HOLD`，且 verifier/runner/model runtime/lockfile 等其他路径不允许进入例外；receipt 永远不能授权 dispatch 或 pilot。
- 该治理避免未授权的 Site Builder 评测冻结获客数据库演进；CI impact verifier 以描述符锚定、同句柄稳定读取和总量上限证明当前 source 状态。历史 dispatch verifier 的中间目录/并发读取与 ledger/claim 前置时序仍是明确 NO-GO，必须随下一次 Copy fixed-source rebase 关闭，不能由本 receipt 冒充已解决。完整设计见[实施记录](../implementation-records/copy-fixed-source-impact-governance.md)。

## 2026-08-09 · Copy Sonnet recovery v14 create-only preparation

- #356 与 #359 已以 merge commit 进入 `origin/main@2557b991e62ff171aeec60abff33de2ad8f2859f`。v14 [manifest](../evidence/site-builder/m1-g-copy-sonnet-recovery-manifest-v14.json) 以该主线为 fixed source；[runtime binding](../evidence/site-builder/m1-g-copy-sonnet-recovery-runtime-binding-v14.json) 固定 canonical path 与后续身份绑定提交 `3da93486163404e3943711c6689a55c9a9e2c119`、82-file source digest `cbec88ad…`、53-file compiled tree `ce806d78…` 与 artifact digest `4f9fdf06…`。
- admission 现在要求 campaign、global authorization、child authorization 与 reservation 全部使用各自的 v14 namespace；即使重算 manifest/global/child/reservation digest，v11/v12/v13 身份仍会在 ledger/client 前拒绝。同代 v14 的重复消费继续由 durable ledger/marker 阻止。
- recovery execution 与 child slot 均版本化为 v14；runner 的 Git-reviewed evidence acceptance 复用 recovery-aware execution plan，不再把合法 v14 receipt 误当成旧 pilot ID。fake gateway 覆盖 1 wire known settlement、完成、PR-merge acceptance，全程零真实模型调用。
- v13 后续私有 operator run 以 2 known-settlement wires、1 repair、0 completion 停止并冻结；它不是 tracked capability/质量 evidence。v14 明确禁止复用 Terra/Sol v11 及停止的 v12/v13 authorization、campaign 或 wire。
- v14 artifact 继续是 create-only、`NOT_AUTHORIZED`、`dispatchCapable=false`、0 network/model wire、0 cost；本批次不包含凭据、真实调用、36/72、晋级或 route adoption。

## 2026-08-09 · Copy Sonnet recovery v13 create-only preparation（#356）

- [实施/TDD 记录](../implementation-records/copy-sonnet-recovery-v13-create-only-tdd.md)、[v13 manifest](../evidence/site-builder/m1-g-copy-sonnet-recovery-manifest-v13.json) 与 [post-sync runtime binding](../evidence/site-builder/m1-g-copy-sonnet-recovery-runtime-binding-v13.json) 固定 #355 后的唯一 Sonnet Messages/medium recovery：1 execution、最多 2 wires、最多 1 次 closed repair；Terra/Sol v11 成功 wire 及停止的 v12 wire/authorization 均不可复用。
- 主线同步后的 binding 固定 source commit `874a8cc2aa637c35f8c78302006ffb370913fcb7`、82-file source digest `139c8661…`、53-file compiled tree `a7ac0ca8…` 与 artifact digest `caa42cbf…`。它仍为 create-only、`NOT_AUTHORIZED`、`dispatchCapable=false`、0 network/model wire、0 cost；#356 后续已合并，真实私有 operator run 的 stopped 诊断由上方 v14 条目承接，不能回写该 artifact。
- 本交付不包含 capability evidence、36/72 质量矩阵、模型晋级或生产 route adoption；这些门继续独立决策。

## 2026-08-08 · Governance trust-boundary hardening

- `nontechnical decision card integrity` 取代会误导为 freshness/授权的 context 名。Draft 可非阻断展示 `CURRENT_UNVERIFIED`；非 Draft 中完整的 `PASS / RECOMMEND_MERGE / MERGE` 作者声明在没有可信外部 provenance 时必须阻断，用户授权仍固定为 `NOT_AUTHORIZED`。
- Release Bundle 新增显式 `external_provenance`。当前没有独立外部 readback verifier，所以 machine/reviewer/authorization/merge refs 都只是 documentary，任何 `PILOT/GA` 均以 `RELEASE_EXTERNAL_PROVENANCE_UNVERIFIED` fail closed；伪造 `VERIFIED` 或 URL 另报 unsupported，不能晋级。
- 治理验证器扫描全部 GitHub workflow 的外部 `uses:`，只接受从官方 tag 只读解析的完整 commit SHA 与版本注释；CI、Security、Governance 和 Decision Card 四个 workflow 已全部 pin。CODEOWNERS 最终规则块覆盖政策、schema、verifier、runtime evidence 与 release 输入/输出，删除或后置覆盖会使 mutation test 失败。

## 2026-08-07 · Governance foundation、current 入口瘦身与证据晋级门

- `AGENTS.md` 只保留稳定 authority、产品边界、Ubuntu/Compose/Temporal 约束、worktree ownership、外部动作、TDD/安全、模型费用与 evidence/release 规则；`docs/status/current.md` 只保留远端主线 SHA、在途主题、blocker、最新 runtime fact 和下一产品决策。迁移前的完整日期化文字保留在 Git 对象 `35145699db63fc8aef2350a0ca331fef9724f617`，没有删除或重写原始实施 provenance。
- 新增机器 `provider-registry/v1`，逐项绑定代码 seed 的 key、SourceClass、默认 enablement、purpose、taxonomy、license、个人数据等级、调用门、测试与 evidence anchor，并生成单一人类页。研究型 `discovery-sources.md` 不再承担 provider 当前状态真值。
- 新增 `runtime-evidence/v1`、`delivery-traceability/v1` 与 `release-bundle/v1` schema、验证器、生成器和模板。到期 RuntimeEvidence 只能成为 historical；Capability→Object→operationId→code→test→Scenario 链若声明 `PILOT`/`GA`，必须同时有 fresh PASS evidence 与真实 Release Bundle。
- Release Bundle 将机器 check、独立 reviewer、产品负责人签署授权和真实 merge method provenance 分开，PR 正文声明不能升级任一门。当前 fresh RuntimeEvidence 和真实 Release Bundle 均为零，因此获客恢复链保持 `INTERNAL_ONLY / NOT_AUTHORIZED`。
- 仓库新增可执行的 governance required context 与 required-context 清单；OpenAPI 手写总数从权威架构页删除并加防回归检查。GitHub ruleset/branch protection 仍是外部配置，仓内声明本身不证明已生效。
- 历史模型与 Site Builder 证据统一由 [evidence 索引](../evidence/README.md)导航；索引不改变 artifact 的历史分类，也不复制模型评测或运行结论。

## 2026-07-22 · Site Builder DI-0 净室设计合同与静态 Catalog 基础（#164）

- `@global/contracts` 新增并导出 DesignSourceManifest、DesignObservation、DesignRule、DesignDNA、TemplateFamily/Blueprint、DesignBrief、DesignEvaluation 与 DesignCatalog；每个非可信对象都有运行时 fail-closed validator，目录与 Family 使用确定性 digest。
- 来源合同区分平台原创、许可归档、仅视觉研究与书面授权路径；授权、训练、保留、未来生效时间、外部贡献稳定身份和至少五个独立贡献组均在合同层拒绝违规输入。Tier B 视觉研究不得保存原始文案、素材、DOM、代码、精确坐标或进入训练/运行时 RAG。
- API 只提供递归冻结的空静态 Catalog 和 approved-family-only resolver；当前没有真实 Family、Blueprint、StylePreset、DemoVisualPack、SiteSpec 1.1 或 Renderer/assembly 消费。DesignEvaluation 只落合同，运行时生产仍归 M1-f。本交付不代表 M1-e、设计系统或生产部署完成。
- CI build/test、contracts drift/lint/breaking 与 gitleaks 全绿后合并；下一主线为 M1-e-A 26 型封闭组件与变体，实验模板只能按批准合同选择性提取。

## 2026-07-18 · MODEL-1 BrandProfile 首个逐任务晋级

- 真实 new-api 同形 6×2 评测固定 prompt/schema/evaluator 与协议：Terra/Responses、Sonnet/Messages 均 12/12 accepted、0 hard failure；当时 DeepSeek Pro/Chat 为 10/12。候选/基线报告与价格快照写入 evidence id `model1-brand-profile-20260718-v1`，故 owner 批准 Terra 主、Sonnet 回退。**2026-07-19 fast-follow 已 supersede 此 active evidence**：v20 final-code candidate 24/24、完整 legacy route baseline 12/12；旧 v1 只保留为历史裁决输入，不再作为当前 baseline 真值。
- 生产 provider 复用已验证的 model→transport 显式映射；BrandProfile `promotedRoute` 有 provider/schema/截断/超时回退及 EvidenceRef v2 任务硬门，失败 usage 不丢。`SITE_BUILDER_MODEL_ROLLBACK_BRAND_PROFILE=true` 可回冻结 DeepSeek Pro→GLM，原紧急 model/fallback override 优先级不变，route policy/trace 记录实际快照与来源。
- 仅 BrandProfile 代码路由晋级；其余 6 个文本 task、图片和视频均未继承。GPT Image 2 单次 `/images/generations` 真探不等于 MediaGateway、edit/mask 或生产消费者上线；本记录也不代表生产部署、真实租户 canary、locale/视觉覆盖或 R4-B-min 持久成本真值完成。

## 2026-07-17 · Site Builder R3-B2（局部 SiteSpec 消费与单调 Build 进度）

- `scope=page|section` 与 `options.pages` 现在冻结请求时的 active `baseVersionId` 并做确定性局部合并：只替换命中的 page/block 及其引用文案键，未选择页面、全站主题、assets 与其余 CopyBundle 保持不变；发布时以 active pointer CAS 防止覆盖并发人工编辑。新执行先渲染到 run-scoped staging，再移入不直接服务的 immutable 本地版本目录；数据库提交后以单次原子 symlink rename 切换 `.active/<slug>`，因此 CAS/事务失败不泄露候选且成功切换无目录缺口。Site 级 advisory lock 覆盖最终数据库复核与 pointer rename；旧 Activity retry 若发现更新 build 已接管，只丢弃自己的 pending link，不会回写旧预览。提交后进程崩溃由 Temporal Activity retry 根据 durable artifactKey 重建 pending pointer；生产对象存储 Release、跨节点恢复与回收仍归 R1-min。缺目标 404、重复目标/脏 active spec 422。`stylePreset` 属全站副作用，禁止与局部请求组合。非 `en` 仍 422，真实多语种 CopyBundle/Renderer 路径归 M1-d，不以英文复制冒充翻译。
- 新增 RLS/FORCE RLS 的 `SiteBuildStep` 一等真值表；Temporal patch 保护旧历史命令序列，新执行按 Activity/图片批次增量落 attempt/status/phase/progress。BuildRun phase/progress 只前进，旧 attempt 迟到不可覆盖，begin replay 不重写 `startedAt`，成功/失败/取消均终态化未完成步骤；`SiteBuildRun.steps` 继续作为有界公共读模型，`costSummary` 保持 null 归 R4-B-min。
- 验证：157 files / 1628 tests 全绿、API build、lint 0 error；独立空库 50 migrations；真 PostgreSQL `app_user`/FORCE RLS 验证跨租户不可见与 attempt fencing；隔离 Temporal namespace/worker 验证 page 局部构建、immutable version→active symlink 提升、KB Activity 中取消补偿，以及 renderer 忽略取消并迟到完成时的版本 fencing/产物清理；另以注入的持续 pointer rename 故障验证 durable publication base 的 Site/run/version 回滚，并以旧 finalize retry/更新 active version 的并发单测验证旧 pointer 不会复活。临时 namespace/数据库/预览均清理。仅代表 Ubuntu 开发环境，不代表生产部署。

## 2026-07-17 · Site Builder R3-B1（Build 请求合同、持久幂等与 Temporal ACK）

- **Breaking correction（需 PR 标签 `breaking-change-approved`）**：Build API 改用有界 SiteSpec 字符串标识符、严格 options 与共享 Renderer preset 目录；机器契约只声明当前真实执行的整站/stylePreset/en，并收紧 `Idempotency-Key`。此前会被静默忽略却返回 201 的 page/section/pages/非 en 请求，现分别 fail-closed 为 `422 BUILD_SCOPE_UNAVAILABLE/BUILD_OPTION_UNAVAILABLE`。消费者必须停止发送未实现字段/非法 key，并从本版 OpenAPI 重新生成客户端。
- `Idempotency-Key` 统一为 1–128 位安全字符，按 workspace+Build 操作持久 `requestHash`；siteId 进入请求指纹而非账本分区，同 key 换 Site/换参数均 409。跨 Site 同 key 并发先取 key 锁再取 site 锁，避免 P2002 泄漏或重复副作用。
- Temporal 使用确定性 workflowId、`REJECT_DUPLICATE + USE_EXISTING` 与 describe 恢复；只有 workflowId+firstExecutionRunId 双 ID 持久化后才返回 201。ACK 不明保留原 queued run，同 key 或无 key 的完全相同规范化请求都收敛同一执行链，不误标 failed、不另起 run；正式客户端仍必须带 key。
- 取消改为等待 Temporal 执行链关闭及不可取消补偿完成后才释放 DB active 单飞门；取消未确认/未关闭返回 `502 BUILD_CANCEL_UNAVAILABLE` 并保持 active，避免新旧 workflow 并行。取消与失败补偿分终态，旧 run 只有 CAS 赢得 active ownership 才可回写 Site 状态；若补偿因 DB 故障耗尽重试，后续同 buildId 取消会在确认执行链已关闭后以同站锁+CAS redrive 最小终态事务，不永久卡 active。
- Ubuntu 开发环境以真 PostgreSQL/app_user/FORCE RLS + 真 Temporal 验证双 ID 对账、同请求重放、异请求 409、跨 Site 同 key 并发恰一胜、取消与夹具清零；仅代表开发验证，不代表生产部署。R3-B2 继续真实 scope/options 与单调 step/progress/replay，costSummary 仍归 R4-B-min。

## 2026-07-17 · Site Builder R3-A（BuildRun 数据库背书）

- `site_build_run` 改以 `(site_id,workspace_id)` 复合外键绑定 Site，父 workspace 更新为 `NO ACTION`、禁止隐式搬迁 run；validated CHECK 固定 `queued/running/succeeded/failed/cancelled`，部分唯一索引保证每个 Site 最多一个 active run。
- 新增 nullable `temporal_workflow_id`；独立数据迁移只为已知 `demo_v0/refurbish` kind 生成确定性 workflow ID，未知 kind 保持 NULL，交由其 owner 显式处理。
- schema 迁移以 5 秒 lock timeout / 60 秒 statement timeout 取得表锁并 fail-closed 预检孤儿/跨 workspace provenance、非法状态和重复 active；不自动修归属、不改状态、不任选 run 取消。
- Ubuntu 开发环境验证：隔离空库 49 migrations 全量 deploy；三类脏旧库均阻止升级；`global_dev` 真 owner/app_user/FORCE RLS、双连接单飞、复合 FK/CHECK/父归属更新负例与 nullable ACK 前语义全绿，夹具已清理。仅为开发验证，不代表生产部署。
- 评审后 timeout 加固改变了尚未提交但已在开发库试跑的 060/061 字节；没有静默改 `_prisma_migrations` checksum，而是先做 0600 dump，再由最终 49 migrations 重建候选库、恢复除迁移账本外的数据。60 张业务表逐表 count+内容 hash 与旧库完全一致、49/49 checksum 与 schema diff 全绿后原子切换；旧库 `global_dev_pre_r3_checksum_20260717` 与 `/global/backups/global_dev_pre_r3_checksum_20260717.dump` 保留回退，不涉及生产。

## 2026-07-17 · Site Builder M1-c（纯 Sharp 确定性图片管线）

- API 直接 exact pin `sharp@0.35.0`，pipeline identity 同时包含 libvips；输入按 20 MiB/40 MP/4 channels/单页严格解码，自动方向与 sRGB，输出默认剥离 EXIF/GPS/XMP。模糊/曝光/噪点记录为版本化 warning，不以未校准阈值主观拒绝可解码图片。
- kind→role 与 explicit focal policy 版本化；只生成源裁切可承受的 320/640/960/1440/1920 档，绝不放大。每档 AVIF+WebP+JPEG/PNG fallback；共享 recipe 保留 MF0-A 旧 API/hash 行为，并以显式 V2 纳入 encoder/alpha/background/kernel/withoutEnlargement 等全部字节影响参数。inspection 与编码均在 cache=false、concurrency=1 且可超时终止的子进程运行；父协议、路径、输出字节和全 worker 并发有硬门，Ubuntu 编译子进程另加 `prlimit`，但不冒充生产容器/cgroup/独立 UID/禁网隔离。
- 首个真实 Variant writer 先核验 ready-set，完整重放零编码；ready 账本缺对象时 fail-closed。否则在首个对象写前持久预占完整 recipe set 的 `processing` owner。对象先写带一日 lifecycle tag 的 producer-token 隔离 attempt key，只有重新锁定 Asset、校验 token 并取得 canonical key fence 后才能在 15 秒有界窗口内 promote，copy 去除 TTL tag；attempt key 进入 durable metadata/cleanup plan。响应丢失按对象真值收敛，失败只 CAS 自己的 owner；重试前以 8 路有界 IO 对账并压缩 attempt，settled cleanup 重放只重删冻结 attempt，cleanup IO 接 cancellation+110 秒 deadline。生产 lifecycle 默认 validate-only、缺失阻止启动，仅单一部署 owner 可管理。单 Asset 最多 120 行；新 cleanup 的 canonical+Variant+attempt 总对象≤128，历史无 attempt payload 兼容 128 Variant+canonical。
- refurbish P2 正式调用图片活动：逐图失败隔离，步骤记录 done/degraded 与数量，取消穿透；既有 `hasPerson` 只保留不臆测，全部 `aiEdited=false`。Temporal 以 patch marker 兼容在途历史。
- refurbish 首个 Activity 一次物化≤512 个排序 Asset ID 的不可变 workset，后续每 Activity 最多两张；超限在 Sharp 前降级，旧 cursor history 仅作 replay。
- Ubuntu 开发环境真 PG/app_user FORCE RLS + MinIO 验证 30 项断言：同 asset 双 producer 同 key 只物化 30 行、对象/DB checksum 对账、EXIF/GPS/XMP 清零、sRGB、原图不变、重放 ID/hash 不变、PUT response loss 收敛、首个对象写前完整 owner、中断只落 attempt key、接管、批间 INSERT 隔离与既有成员 UPDATE 不漏、坏图隔离、A/B/unset RLS 与 fixture/object 清零。仅为开发验证，不代表生产部署。
- 明确未做：migration、MediaJob/AssetUsage、rembg、生成图、视频、Readdy/设计 Agent、公开 process/select API、SiteSpec variantId 与 Renderer `<picture>`；最后两项归 M1-e 消费者交付。

## 2026-07-17 · Site Builder MF0-B（引用守卫与 canonical/Variant 安全回收）

- Profile 三个正式 Asset 引用面与当前 `Site.activeVersionId` SiteVersion 进入同一 fail-closed scanner；SiteSpec 1.0.0 manifest UUID/kind/hash 与 ready Asset 对账，开放 props 按媒体字段语义有界扫描，缺 manifest/畸形/未知/超预算拒绝。Profile/active 指针/Variant/DELETE 共用 Asset 行锁，Variant trigger 作 DB backstop；DELETE 命中返回稳定 `409 ASSET_IN_USE` usages。
- canonical producer 按 key advisory xact lock 串行，事务内拒绝任一 active/unsettled owner后 copy+fenced 激活；关闭同 hash 多 tombstone 与 `copy→旧 cleanup→finalize` 误删窗口。DELETE 同事务只写 tombstone、cleanup ownership 与严格 schema v2 frozen plan；Temporal 两轮 Variant 叶→根/canonical 最后 Delete+HEAD，再重验 provenance、删 Variant 行并 durable settle。settle 响应丢失和旧事件重放均不会触碰后来 replacement。
- copy 成功但数据库 finalize/commit 失败时，producer 会重取同 key 锁，仅在无 owner 时 Delete+HEAD 补偿；补偿失败持久标记 retryable Asset 并阻止 DELETE，避免留下不可追踪 canonical 孤儿。
- 历史 schema v1 parked 对账默认 dry-run、单实例 advisory lock、稳定游标与逐项 poison 隔离；eligible 生成带 `causationId` 的 v2 successor，不篡改旧事件。050000 保持已应用字节不变；051000 显式 quarantine 迁移前 unbound tombstone、禁止新写伪造 legacy 标记，并将 lifecycle CHECK 收为 validated。
- Ubuntu 开发环境验证：46 migrations up-to-date、schema diff=0、lifecycle validated；真 PG RLS/双连接验证 Profile/activeVersion/Variant/delete 顺序与 props-only gate；真 PG 历史对账六分类 dry/apply/rerun；真 MinIO+Temporal canonical+多层 Variant 清理、settle、同 hash replacement 全绿。仅为开发环境，不代表生产部署。Sharp writer、MediaJob/AssetUsage、rembg、生成式图片与视频均未加入。

## 2026-07-17 · Site Builder MF0-A（AssetVariant 数据地基）

- 新增 additive `asset_variant`：workspace/site/Asset 直接 scope，父 Asset 与 source Variant 复合 FK 锁 provenance；单输出 `(asset_id,recipe_hash)` 幂等、canonical object key/hash/正尺寸/状态 payload CHECK、显式 app_user CRUD、ENABLE+FORCE RLS。
- `@global/contracts` 新增 recipe 与 `DerivedImageManifest` 共享类型；recipe hash 覆盖 pipeline/source/role/format/尺寸/crop/focal/quality，纯 projector 只从 ready Variant 确定性物化旧 `derivedKeys` 视图。未接 Sharp writer、未伪造历史 backfill、未预建 MediaJob/AssetUsage。
- TDD 与 Ubuntu 开发环境真 PostgreSQL 验证：app_user 非 super/non-BYPASSRLS，A/B/unset 隔离，跨 workspace/site/Asset provenance、ready+checksummed source 门、MIME→规范扩展名精确绑定的 Variant 专属对象键、不可改写行身份/来源/ready 账本、锁内 `row_security=off` 的脏升级 fail-closed 预检和 CHECK/trigger 负例，并发同 recipe 恰一胜；非 BYPASSRLS 扫描会直接失败而非假报 0；verifier 用数据库 advisory lock 串行，并在启动时只清理带专用 marker 的中断残留；现库增量迁移、临时空库 44 migrations 与 Prisma schema diff=0，fixture 清零。这里只代表开发环境，不代表生产部署。
- MF0-B 仍须完成 SiteSpec+Profile 引用扫描、409、删除/写侧共享并发门，以及 canonical+Variant 严格异步回收与历史 parked 对账；在此之前 canonical 继续 parked，不宣称整个 MF-0 完成。

## 2026-07-17 · Site Builder R2-A2（KB 正确性状态机）

- KB 改为单素材持久状态机：due queued/过期 processing 以 Asset attempt+UUID token+lease CAS 认领；外部 IO 间续租，所有回写 fenced。文档/chunks 与 Asset ready 同事务提交，结果丢失重跑 replace 同一文档，旧 worker 复活不能 zombie write。
- migration 以 020000 单事务/表锁完成 reconciliation + constraints 原子门，021000 仅作已在共享开发库执行过旧迁移名的 compatibility marker，022000 再让旧开发库形态通过正常 deploy 收敛到同一结构。除 duplicate/orphan/零块/不完整历史外，Site→Asset/KbDocument、document→Asset、chunk→document 均闭合复合租户 provenance；Site/workspace 不一致的子行无法安全跨租户改写时迁移直接中止，要求显式 quarantine/audit，绝不硬删 canonical Asset 或绕过 R2-A4/MF-0 cleanup 账本。开发库应用前预检该类行数为 0。
- Docling、embedding 与 KB 存储边界改 typed error；瞬时故障回 `queued+retryAt`，真损坏文档才 `failed_terminal`。commit workflow 透传 assetId；新增 5 分钟 recovery Schedule、有界扫描、结构化告警和 `redrive-site-builder-kb.mts`。
- 验证：专项 TDD、空库 37 migrations、从 34 migrations 构造旧 020000/021000 实际形态再只执行 022000 的升级、零块/healthy+processing|failed/重复/跨 workspace chunk/跨 Site 租户/terminal 保留等样本，以及真 PostgreSQL/app_user RLS/MinIO/Docling/BGE-M3、双 worker/过期接管/zombie fence、真损坏 PDF、recovery/redrive、unique/FK 与删除级联全部通过；fixture、对象与旧 M1-a verifier 残留均清零。当前仅为 Ubuntu 开发环境验证，不代表生产部署；生产迁移仍须独立变更审批与备份/回滚窗口。

## 2026-07-17 · Site Builder R2-A1（Asset 正确性状态机）

- Asset 增加 `processing_attempt`、UUID `lease_token`、`lease_until`、`retry_at` 与 `deleted_at`；active `object_key` 改为部分唯一索引，并以 validated CHECK 锁住状态/lease/tombstone 形状。
- commit 入口先 CAS 认领，所有完成/失败回写按 attempt+token fencing；canonical copy content-addressed 幂等，DB 真值先于 staging 删除，瞬时错误保留 staging 转 `failed_retryable`，唯一竞态显式转 `duplicate`。
- DELETE 从硬删改为 tombstone，KB 检索面同事务移除；cleanup intent 与状态变化同事务写 Outbox。R2-A4 前命令刻意 parked，MF-0 引用扫描器前 canonical 不自动删除。
- TDD 覆盖并发 loser、过期 lease 接管/zombie write、copy 失败重试、P2002、清理失败与 tombstone；开发环境真 PostgreSQL/app_user RLS/MinIO/presigned PUT 全绿，34 个 migration 在临时空库全量 deploy、索引与约束复验通过，verifier 无残留。

## 2026-07-17 · Site Builder R1-safety ②（抓取出口隔离）

- 移除开发 Compose 的 `CRAWL4AI_ALLOW_INTERNAL_URLS`；Crawl4AI 固定到 0.9.1 不可变 digest，保留 global-unicast seed guard 与浏览器 pinning proxy，并只在系统解析结果全部为 `198.18.0.0/15` fake-IP 时经固定 Cloudflare DoH 窄回退。
- API 新增统一 guarded HTTP：Crawl、robots 与 `http.get` 均在每一跳校验 global-unicast、将连接钉扎到已校验 IP、跨域剥离凭证并执行 redirect/超时/响应大小上限；不再保留 check-then-fetch 的 DNS-rebinding 窗口。
- 单测覆盖特殊地址、fake/private 混合答案、无二次 DNS、redirect 与大小上限；真机探针覆盖公网 `/md`+`/crawl`，并确认 private/loopback/metadata/IPv4-mapped/redirect-to-metadata 均被拒绝。R1-safety 两个安全小 PR 至此完成，下一主路为拆分后的 R2-A。

## 2026-07-17 · Site Builder R1-safety ①（构建隔离）

- 两条 Astro 构建路径共用随机 0700 临时目录与 0600 SiteSpec，成功/异常均由 `finally` 删除，消除失败/超时后的租户内容残留。
- Renderer 改为固定 Node/Astro 入口和 7 变量 env allowlist，不经 shell/pnpm/PATH、不再展开 `process.env`；数据库、对象存储、模型网关、代理和 `NODE_OPTIONS` 均不出域。
- 新增单测锁住权限/清理/错误保持/allowlist，并以真 Astro fixture 验证三页产物与子路径资产；R1-safety ② Crawl/robots egress/SSRF 仍是下一项，未把 per-run staging/原子预览冒充已完成。

## 2026-07-16 · Site Builder R0 contract closeout（#126）

- intake 成功合同收口为 `{siteId,buildId,status:"generating_demo"}`，移除旧响应 `mode`；`hasWebsite/websiteUrl` 仅作品牌理解背景。
- 复用通用 `idempotency_key` 账本并新增 nullable SHA-256 `request_hash`：同 workspace/endpoint/key 同请求重放首次结果，异请求 fail-closed 409；历史其他 endpoint 的 NULL 行保持兼容；格式约束先以 `NOT VALID` 落地，再由独立迁移事务验证，避免把建列锁持有到全表扫描结束。
- Temporal 以确定性 workflowId、`REJECT_DUPLICATE + USE_EXISTING`、execution-chain head 与 DB CAS 持久化收敛启动 ACK 不确定窗口；终态缺 ACK 只 describe 修复，不重新 start；start 已成功但 ACK 写库失败时保留 Site/run，绝不补偿删除仍在运行的 workflow 锚点。
- code-first OpenAPI、生成类型、消费者迁移说明、稳定 400/409/502 错误码同步；验证包含单测、真实 PostgreSQL 并发/RLS/迁移约束与真实 Temporal probe。

# 后端路线图 · 能力一：AI 获客主线

> 范围锁定：**企业理解 → ICP → 客户发现 → 验证评分 → Lead**。
> 市场研究（PRD 7.3）与触达/Campaign 延后为下一能力。数据源第一版走 sandbox。

## 目标

跑通「客户输入官网/产品 → 系统理解企业 → 生成 ICP → 多源发现目标客户 → 验证补全评分 → 产出分好组的可跟进 Lead」的后端闭环，产出可交给 Campaign（触达）的合格 Lead。

对应 PRD：旅程 5.2 / 5.4 / 5.5 / 5.6；功能域 7.2 / 7.4 / 7.5；架构第 11 部分。

## 阶段与交付物

| 阶段            | 交付物                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | PRD 依据                 | 状态            |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | --------------- |
| **P0 地基**     | ✅ Nx monorepo · ✅ NestJS `api` + Swagger(`/api/docs`, code-first) · ✅ 本地 PG+Redis · ✅ Prisma 多租户 + RLS（隔离已验证）· ✅ 事件 Outbox 表 · ✅ api↔db(app_user 连) · ✅ 鉴权 seam + AuthGuard + `whoami` · ✅ `workspace` 精简为租户锚点 + JIT provision · ✅ Model Gateway（app→**单一中转站(new-api)端点** + 薄契约 + task 选 model 名 + stub fallback；模型在中转站 UI 统一管理）· ✅ Outbox relay（owner 扫描跨租户）+ Temporal 编排（dev server）· ⬜ Policy stub                                                                                                                                                                                                                                                                                                                                                                  | 11.5 · ADR-001/002/009   | 🚧 收尾中       |
| **P1 企业理解** | ✅ 数据模型 `company_profile`/`offering`/`knowledge_source`/`claim`/`evidence`/`citation` + RLS · ✅ `POST/GET /companies`（code-first、租户隔离验证、创建写 `CompanyProfileCreated` Outbox）· ✅ Temporal 理解工作流端到端（relay→workflow→活动→ACTIVE + 写 Claim(NEEDS_REVIEW)/Source，活动 stub）· ✅ 抽取走**真模型**（DeepSeek V4 经 new-api 中转站，实测抽出 ISO/CE/MOQ/交期/市场等真实 Claim）· ✅ Claim 审核端点 + 人工 Gate（approve/reject 状态机 + ClaimApproved 事件 + 乐观锁 + 409 非法转移）· ✅ 抓官网走 **Crawl4AI**（真实抓取 + 自带 SSRF egress 防护；实测抓 python.org 抽出真实 Claim）· ✅ **字段级 Evidence**：每条 Claim 存 来源URL+官网原文片段+置信度，可溯源（事实 vs 推断）· ✅ **按任务选模型**（抽取=deepseek-v4-flash，ICP=deepseek-v4-pro）· ⬜ Docling（文档上传路径）· ⬜ 知识冲突/术语表                      | 7.2 · 5.2 · KNW-001..011 | 🚧 深化中       |
| **P2 ICP**      | ✅ 数据模型 `icp_definition`/`persona`/`buying_committee_role` + RLS · ✅ AI 生成 ICP（`icp.design` Task，DeepSeek 从已确认 Claim 生成 目标属性/痛点/触发信号/排除/买家委员会）· ✅ `POST /companies/:id/icps`、`GET /icps`、`activate`（→ACTIVE + ICPActivated 事件，未回测标 HYPOTHESIS）· ⬜ 样例回测(LED-004) · ⬜ QualificationRule · ⬜ 按 ICP 生成多源查询计划(LED-005，接客户发现)                                                                                                                                                                                                                                                                                                                                                                                                                                                     | 7.5 · 5.4 · LED-001..005 | 🚧 骨架完成     |
| **P3 客户发现** | ✅ `ProviderAdapter` 契约（七类，ADR-017 raw 不穿透领域层）· ✅ **真实公开数据挖掘**（PublicWebDiscoveryProvider：SearXNG 元搜索→噪声过滤→robots 闸门→Crawl4AI 抓官网→gemini-2.5-flash 判站抽取→provenance 指纹）· ✅ **Source Registry**（source_policy，SUSPENDED 域名爬前跳过）· ✅ Temporal discoveryWorkflow（READY 计划→逐源→归一→**ICP 资格门**→PARTIAL 容错）· ✅ `raw_source_record`（带采集留痕）→`canonical_company`/`canonical_contact` · ✅ 确定性身份解析（domain_exact > name_country，identity_link 留痕）· ✅ 字段级 `field_evidence` · ✅ **ICP 资格门**（discovery.qualify_fit，gemini-2.5-pro，四门：材质/角色/工艺/商业模式）· ✅ 联系人按需发现 + 邮箱验证 + Suppression · ✅ **真实评测通过**（19 家真公司，真实性 3 项满分，资格门拦竞品/品类不符）· ⬜ 真源合同接入 · ⬜ 规范词表归一（中英属性值映射，真源前必须做） | 7.4 · 5.5 · DAT-001..017 | ✅ 真实数据闭环 |
| **P4 验证评分** | ✅ 六维评分（确定性：规则引擎 Fit + 委员会覆盖 Role + 信号代理 Intent + 完整度 DataQuality + 可达 Reachability + Engagement=0 待触达）· ✅ `lead` + 四队列 + 分数明细（逐规则评估可审计）· ✅ 人工裁决 accept/reject + `lead_decision` 留痕 · ✅ LeadQualified 事件（Campaign 入口）· ✅ 重评不覆盖人工终态 · ⬜ 真实意向信号源 · ⬜ LLM 辅助评分层（LED-007 组合评分）                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 7.5 · 5.6 · LED-006..009 | 🚧 主链完成     |
| **P5 收口**     | ✅ OpenAPI 导出（38 端点，`packages/contracts/openapi/openapi.json`）+ `INTEGRATION.md` 前端接入说明 · ✅ LeadQualified 出口事件（Campaign 入口）· ✅ 单元测试基线（vitest 24 用例：规则引擎/评分/身份解析/选页/联系方式抽取，`pnpm test`）· ⬜ API 集成测试 + RLS 回归入 CI · ⬜ 事件对外发布通道（现仅 outbox 内部消费）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | 11.10/11.11 · 14.1       | 🚧              |

### 补充完成（差距盘点驱动的收口，2026-07-06）

- **P1 深化**：多页抓取（关键子页确定性选择）· Offering 结构化抽取（幂等 upsert + 溯源）· 公开联系方式/社媒（正则确定性，Buyer Trust 原料）· 画像回填（industry/summary）· 手工 Claim 录入 · APPROVED→REVOKED 撤销 + validUntil→EXPIRED 扫描 · 知识冲突检测（Jaccard 启发式 + 人工裁决）· **REVIEW Gate**（零审批不得 ACTIVE，审批≥3 自动激活或显式 confirm）
- **AI 基建**：ai_trace + usage_ledger 全调用记账 · 结构化输出 ajv 校验 + 修复重试 · stub 仅 DEV · 模型调用超时 · persistClaims 幂等（ingestKey）
- **横切**：统一错误模型全局过滤器 · Idempotency-Key（POST /companies）· 我方侧 URL/SSRF 守卫 · outbox producer 字段

### 多源发现 + 工具编排 + 接口管理（2026-07-06 续）

- **真实多源发现**：官网(SearXNG+Crawl4AI+Gemini) + **Wikidata SPARQL**(结构化，实测 20 家真实公司端到端) + **OpenStreetMap Overpass**(地理，多实例 fallback)；executeQuery **fan-out** 到 source_class 全部 ENABLED 适配器；source_hint 收窄子源。设计蓝图见 [discovery-sources.md](../backend/discovery-sources.md)。
- **✅ GLEIF 富集**（[discovery-sources.md](../backend/discovery-sources.md#gleif-富集落地要点本轮)）：`CompanyEnrichmentAdapter` 新契约 + `enrichRun` 活动（fit 门后，只富集 match 公司）；对已归一公司补 **LEI + 法人形式(ELF) + 实体·登记状态 + 直接·最终母公司**；核心名召回 + 拼写全称归一 + 置信门槛 0.72 + 歧义边距 0.1（绝不贴错身份）；429/5xx 退避重试。实测 Audi→Volkswagen AG、BMW Bank→BMW AG 母子关系落地。
- **✅ Wikidata 富集**（直连 REST，与 GLEIF 互补并跑）：`WikidataEnrichmentProvider` 走 wbsearchentities+wbgetentities，补 **行业/产品/员工数/成立年/母子/LEI/ISIN/上市交易所/总部/官网**；复用共享 name-match（精确命中凭搜索知名度排名消歧、模糊命中需边距）。enrichRun 改为**多源命名空间合并**（`attributes.gleif.*` / `attributes.wikidata.*`，逐源 field_evidence，按源幂等）。实测 SAP(32 万员工/LEI/交易所)、Siemens、Bosch、Bystronic→母公司 Conzzeta。
- **✅ 名录/列表发现**（**已端到端实测**）：`DirectoryDiscoveryProvider` + `discovery.extract_list`（一页多公司）。一次真实运行从 3 个静态目录（metalstamper/mrforum/thefabricator）抽出 **151 家真实公司**（带官网+地址），并正确拒绝非名录页（单会员/单供应商详情页判 not-a-directory）。剩余短板：地域精度——查 Germany 会召回美国目录，需下游 fit/地域过滤收敛。
- **✅ 展会参展商 API 模板**（**已端到端实测**，解决 JS-SPA 短板）：`TradeFairDiscoveryProvider` + `trade-fairs.ts` 逐站/逐平台模板。逆向大展会 SPA 的托管搜索（EuroBLECH/RX=Algolia），**直接打 public API** 拿结构化参展商名录。实测 EuroBLECH 2026 一次拉 **398 家 / 5 秒**（带官网 324 / **公开邮箱 322 / 电话 320** / 招聘信号 55）。`scripts/discover-fair-algolia.mjs` 用 crawl4ai 网络抓取自动提取展会配置（加新展会/换届一条命令）。维护：apiKey/eventEditionId 按届刷新。
- **✅ SearXNG 出网绕行**：本环境对消费级搜索引擎做 SNI 过滤，切到放行侧引擎（Yandex/Marginalia/Mojeek）恢复搜索（0→14 结果），解冻 public-web 发现。
- **工具/Broker 层**（[discovery-architecture.md](../research/discovery-architecture.md)）：Tool 契约 + Registry + **ToolBroker**（allowedTools 白名单/预算 reserve-settle/限流/source_policy/幂等/trace 统一闸门）；AiTaskContract 加 allowedTools 等边界字段。MCP=传输非授权，第一步不做。
- **✅ 规范词表归一**（[vocab-taxonomy.md](../backend/vocab-taxonomy.md)）：canonical_taxonomy + term_alias 表；250 国 ISO3166 + 1910 多语言别名 + ISIC 行业；TaxonomyResolver 确定性 + LLM 冷路径沉淀。实测中文「半导体/德国」→ wikidata 挖到 18 家德国公司。**欠账已还**。
- **✅ 统一接口门户**（[api-management.md](../research/api-management.md)）：自托管 Scalar `/api/portal`（前端一个入口浏览+调试全部端点）；OpenAPI 单一事实源 `--export-openapi`；结论：单端点是伪需求、不用 Apifox（出海数据合规）。
- **✅ 前端护栏**：helmet + CORS 白名单 + 按 workspace 限流。
- **✅ 生产鉴权**：JwksTokenVerifier（jose，验签 iss/aud/exp）；生产禁 dev stub。**待 SaaS 平台给 JWKS 契约激活**。

### 采集监控层 + v3.0 买家智能（2026-07-07）

- **✅ 采集监控层（源无关，平台级）**：`monitored_source`/`source_entity`/`source_fetch`/`source_entity_change` 4 表 + `AcquisitionService.acquire`（抓取→**清洗**（域名/电话/邮箱分级）→落库→**增量 diff**（ADDED/UPDATED/REMOVED，连续缺席阈值防误杀）) + **Temporal Schedule 定时 sweep**（`acquisitionSweepWorkflow`，源自带 cadence，`nextFetchAt` 到期自动增量）。展会只是第一个源：`trade_fair`(RX/Algolia，**实测 INTERPHEX 美国 602 家/12 国**，证明不锁德国/行业) + `mapyourshow`(MYS 无鉴权 JSON，实测 321)。源→`canonical_company` 租户投影（RLS+去重+🔴合规隔离）。
- **✅ v3.0 P0 信号富集（零付费，[buyer-intelligence-v3.md](../research/buyer-intelligence-v3.md)）**：直接兑现 P4「⬜ 真实意向信号源」。signal 源写 `attributes.*` 喂六维 Intent/Reachability：`digital_footprint`（官网 HTML/DNS→技术栈/在投广告像素/服务市场 hreflang/邮件商 MX/JSON-LD 事实，实测 TRUMPF 30 国/Xometry 社媒句柄）+ `structured_harvest`（sitemap→careers→招聘信号，采购岗=买家团队扩张）。走 enrichRun 命名空间+field_evidence+幂等。
- **✅ v3.0 P0 自建邮箱验证 `smtp_self`（#3）**：MX + SMTP RCPT 握手 + catch-all 检测 + SSRF 护栏；Gmail/M365/catch-all/端口不可达 → **RISKY**（不谎报 VALID），写 `contact_point` 验证生命周期。
- **✅ v3.0 P0 网站变更 = intent 引擎 `web_watch`（#4，`apps/api/src/intent/`）**：**复用 `source_entity_change` diff**——逐页抓意图承载页（产品/招聘/供应商招募·RFQ/新闻）→ 抽结构化信号 → `signalHash` 只覆盖信号字段（cosmetic 抖动不触发）→ 前后快照 diff 出 delta → 每条 = intent 事件（`SOURCING_OPENED`/`HIRING_UP`/`NEW_PRODUCTS`/`NEWS_POSTED`/`PAGE_CHANGED` + 强度）。真实站多不发 Product/Article JSON-LD → 产品/新闻靠**主内容锚点链接**（去 nav/footer）；**实测** TRUMPF supplier→`supplier_program`、Flex→3 招募词、products→主内容 7 品类、newsroom→8 新闻指纹。独立 `intentSweepWorkflow`+Schedule（registry 正向过滤，不碰通用采集 sweep）；DAT-011 SUSPENDED + robots + crawl4ai SSRF 守；🔴 新闻只存**指纹哈希**（不落标题/人名），保留期清理；租户 `IntentProjectionService` 按 `companyIdentity` dedupeKey 投影 `attributes.intent.*`。**✅ 已接进六维 Intent 维**（`lead/scoring.ts`：真实 intent 事件按新近度衰减(半衰期 60d)取最强 + 关键词代理兜底，`intent=max(realIntent,keywordIntent)`；代理排除 intent 命名空间防双重计数；`scoreLead` 加 `opts.nowMs` 可测；权重/阈值不变，仅在有真实信号时上移）。**✅ 从 ICP 短名单自动 `registerWatch`**（`discovery.activities.registerWatchesForRun` 接在 `discoveryWorkflow` 信号富集后：本 run fit=match+域名公司自动建 web_watch → intentSweep 持续盯，best-effort）。**dev 整条链路实测**（`verify-intent-loop.mts`，真库+真 crawl）：TRUMPF supplier 真实 diff→`SOURCING_OPENED`→投影→Intent 维 0→1、总分 0.39→0.54。**下一步**：六维加法→乘法门（需 backtest 校准阈值）。
- **⬜ v3.0 续（P1）**：自有 ATS JSON 逆向（Greenhouse/Lever/Workday CXS 招聘）· 海关提单（ImportYeti 免费+FOIA 基线+HS 反查逆向）· 招投标（TED v3/SAM.gov）· 认证注册库（openFDA/FCC/EUDAMED）· 专利 inventor（USPTO/EPO）。设计+免费访问+对抗核验见 [buyer-intelligence-v3.md](../research/buyer-intelligence-v3.md)。

### 管线通脉：存量对账 + 队列门修复 + loop 收口（2026-07-08）

> 背景（全库体检结论）：架构跑在数据前面——982/1040 家公司卡在 `fitVerdict=null`（投影公司从不属于任何 run，够不到前向取件的资格门）；4 个 signal provider 只靠 relay 启动静默 seed；`recommended` 队列被 fit 单维覆盖（11 家推荐里 9-10 家零联系人）；`DecisionMakerProvider` 从未注册；intent 事件无人投影。本次不建新能力，只让已建好的在存量上真跑。

- **✅ 存量对账管线 `backlogSweepWorkflow`**（`temporal/backlog.activities/workflow.ts`，Schedule 24h + 手动 `scripts/run-backlog-sweep.mts`）：资格门（`fit-judge.ts` 共享四门核心）→ GLEIF/Wikidata 快事实 → 信号富集（TTL 感知）→ web_watch 注册 → 联系人发现 → `scoreCandidates` 重评分。`id>cursor` 分页防活锁（单 sweep 每行至多一次，跨 sweep 自然重试）；批量+轮次双上限有界；网络一律事务外；DAT-011/SUPPRESSED 全程守。跨租户目标经 ownerDb 只读扫描（「受信系统扫描器」，同 relay 先例）。
- **✅ 队列门修复**：`scoreLead` 接 `authoritativeFit`（LLM 资格门）**只覆盖 Fit 维**；队列走六维总分阈值 + **Reachability 硬底**（match 但零联系方式 → needs_review 并注明先做联系人发现）；EXCLUSION 永远优先。`scoreCandidates` 每批独立事务（千余家单事务会撞 Prisma 5s 超时）。
- **✅ `decision_maker` 复活**：`ContactDiscoveryAdapter` 包装注册为联系人发现**首选**（Impressum/管理层页具名决策人+买家角色，此前是死代码、实际走 public_web 正则只挖 info@）；`contact-persist.ts` 共享持久化（🔴具名人 `person.profile` 证据 + `personal_data` 标记，无 outreach 授权）；`discoverContacts` 服务改「短事务①→网络→短事务②」。
- **✅ 启动自愈**：worker 启动幂等 seed（失败大声，双保险 relay）+ **三个 Schedule 自动 ensure**（acq/intent/backlog——dev Temporal 重置即丢 Schedule 的根治）；relay 合并 QualifyRequested AlreadyStarted。
- **✅ loop 双收口**：`intentSweepWorkflow` 尾部 `projectIntentAllWorkspaces`（事件自动流到 `attributes.intent.*` → Intent 维）；`finalizeRun` 自动发 `QualifyRequested`（发现完成 → 评分自动刷新）。
- **✅ 数据完整性**：fit-judge 拒绝 stub 兜底判定（实测抓到 2 家被网关 fallback 的罐头 null 假判定并重置）。
- **✅ dev 实测（真库真 crawl·无 sandbox）**：有界样本 `run-backlog-sweep --fit-batch=10 --max-fit-rounds=1` 等，首轮冷样本 **6 阶段全产出**——资格门 10 判/1 match、快事实 10 尝试、信号 4 抓/3 命中、web_watch 注册 4、联系人 5 尝试/1 具名、`scored` 1040 全量重评；重跑呈**正确幂等**（TTL 新鲜/已注册/已建联系人的行跳过，不重复烧网关/抓取）。
- **✅ 对抗式复审收口（5 维·14 agent·逐条核验 → 6 findings）**：已修 3 手术刀——① 队列门 Reachability 硬底此前**只在 authoritative 分支生效**，`fitVerdict=null` 存量（982/1040 家）走规则引擎老路径时零联系方式仍能进 recommended（实算 total 0.57≥0.55），抽 `canRecommend` 对两条推荐分支统一生效 + 补 2 测试（RED→GREEN）；② DAT-011 `registerWatchesBacklog` 唯独没调 `suspendedDomains()` → 补 SUSPENDED 守（🔴 注册期 sitemap 探测对 kill-switch 域名越线）；③ 6 阶段静默 catch→`log.warn`（持续性故障不再吞成绿色空转）。

### TED 招投标 provider（P1 中标发现 + P2 ICP→CPV + P3 招标 intent，2026-07-09）

> 获客三缺环「需求证据/时机/对的人」的欧盟官方源。TED（Tenders Electronic Daily）= 欧盟采购官方公报，**零鉴权 REST**、绿事实 CC BY 4.0。归 `public_intelligence` 类，**复用 discovery→fit→enrich→score 全管线，无需新 SourceClass**。规格 [ted-provider-spec.md](../implementation-records/ted-provider-spec.md)（活 API 实测 + 对抗核验，含 §8 审查修正 8 点）。

- **✅ P1 中标发现**：`adapters/ted-api.ts`（`POST /v3/notices/search` expert query 构造 / ITERATION 滚动分页 / `winner-name` 多语言 eng 优先解包 / 缺键当 null / winner-* 按位对齐 / URL 身份安全归属）+ `discovery/providers/ted.provider.ts`（中标公告 → 每中标方一条 `ProviderCompanyRecord`，`winner-name` + 国别税号主解析键；`executeQuery` fan-out，无 CPV → fail-safe 空）。**实测**：泵(CPV 42120000)+德国 近 60 天真拉 12 家（BBA Pumpen/KAESER 等，真税号）→ 真落 canonical 过 fit 门。
- **✅ P2 ICP→CPV 映射（多租户不硬编码）**：`discovery/icp-to-cpv.ts` `resolveIcpToCpv`（industry `crosswalk.cpv` 锚定确定性 + product LLM 精修**限子树** + country 覆盖门非 EU/EEA/UK → `icp_fit_warning` 绝不静默丢）+ **§8.2** 暴露 taxonomy `crosswalks`（`resolveCpvForProduct` 枚举限子树前缀·去尾零覆盖子码）+ **§8.7** planner 路由 TED（`generateQueryPlan` **确定性注入** TED 查询，LLM 绝不臆造 CPV）+ CPV 子树种子（手工核验，非全 9450 树）。**实测**：ICP「pumps+德国」→ cpv 42120000+DEU → 注入 TED 查询 → 真拉 29 家闭环；US → 覆盖门 warning。
- **🔴 合规**（spec §3）：绿事实带 **CC BY 4.0** 署名（发现证据 `field_evidence.license` 修，非硬编码 `'licensed'`）· `winner-email`/具名联系点**不入绿库** · `source_policy(api.ted.europa.eu, personalData=true)` **用途门**（含个人数据源直连前 fail-closed，非「ToolBroker 可选」）· 国别税号身份**按 alpha-2 国别限定**（防跨境同号误并）· 国别 ISO-3→alpha-2 归一（防跨源 dedupe 裂键）。
- **质量闭环**：TDD（252 单测）+ 真库真 API 端到端（无 sandbox，`verify-ted-discovery.mts`/`verify-icp-to-cpv.mts`）+ **2 轮对抗复审工作流**（P1 修 1 HIGH 跨境同号误并 · P2 修 3 findings：CPV 子树前缀去尾零/缓存子树作用域/行业词双路采集）。PR #30/#31 自审自合。
- **✅ P3 招标 → TENDER_PUBLISHED intent（招标=买方需求，动 Intent 维）**：`adapters/ted-api.ts` `searchContractNotices`（`cn-standard`，`CONTRACT_FIELDS` 只取绿字段 buyer/CPV/截止/发布日，**绝不 winner/buyer-email**；抽共享 `fetchNoticesRaw` 分页，award 路径不变）+ `intent/ted-intent-projection.service.ts` `projectTenders`（买方身份 name+alpha-2 归并取最新发布日 → upsert canonical(有则更新/无则建线索) → append `attributes.intent.events[{type:'TENDER_PUBLISHED', at:<发布日 ISO>, strength 0.9}]` → 动六维 Intent 维，复用 `mergeIntent`，**新 event type 无需改评分**）。**§8.6** 发布日 `tedDateToIso` 归一（缺 T 补全 + Date.parse 校验；非法/缺失则跳过，绝不 NaN 静默 0 分）。🔴 **§8.8** 直连前过 `source_policy` 门（SUSPENDED/用途不含 intent\|discovery → fail-closed，与 P1 同一 DAT-011 kill-switch）· **幂等**（`sameIntent` canonical **键序无关**比较——开放招标每 sweep 复现不 bump version/不堆 evidence/不虚报指标）· **无国别招标跳过**（防跨国同名误并）· 新建买方写 `identity` 署名证据（CC BY 4.0 provenance）。**实测**（真库真 API 无 sandbox，`verify-ted-intent.mts` 五段全绿）：泵+德国近 90 天 **24 条开放招标 → 18 家买方 canonical**（skip 全 0）；同参再跑幂等（`companiesTouched=0`、evidence 36→36）；样本 Intent **0→0.8657**、总分 **0.1425→0.2724**；SUSPENDED→零落地。**3 轮对抗复审**（本轮 4 维·16 agent → 9 findings 收敛 5 处真缺陷全修；幂等修复被实测反抓 **jsonb 键序** bug）。TDD 261 测（+2 tedDateToIso）。PR #33 自审自合。
- **✅ P5 招标 intent 投影上 Temporal Schedule**（见下「外部源 intent sweep」——TED 招标 + openFDA 清关共用 `externalIntentSweepWorkflow`，ACTIVE ICP → CPV/FDA 码 → 投影，生产周期真跑）。
- **⬜ 下一步**：P4 招标 SAM.gov Sources Sought（早数月意图）。

### openFDA 认证注册库 provider（P1 器械注册发现 + P2 ICP→FDA 产品码 + P3 510(k) intent，2026-07-09）

> 获客第二个官方免费源。openFDA（`api.fda.gov`）= 美国 FDA 官方开放数据 API，**零鉴权、CC0 公共领域**。`device/registrationlisting` = 「正在合规卖进美国」的规管品类活跃公司名单（「注册人=合规卖家」）。与 TED 同构，归 `public_intelligence` 类、**复用全管线无需新 SourceClass**。规格 [openfda-provider-spec.md](../implementation-records/openfda-provider-spec.md)。

- **✅ P1 器械注册发现**：`adapters/openfda-api.ts`（`GET /device/registrationlisting.json` search 构造 / 有界样本分页 skip≤25000 / `openfda` 谐调块缺块当 null / 判 `error.NOT_FOUND` 空 / 429 退避 / 分类事实取**匹配 ICP 搜索码**的产品块）+ `discovery/providers/openfda.provider.ts`（establishment → `ProviderCompanyRecord`，`name+iso_country_code` 主解析键、FDA 注册号→`fda-reg` **全局唯一 scheme**（非国别税号）、externalId 无注册号退 name:country 防跨国同名互撞；无 product code → fail-safe 空）。**§8.1** 美国进口商=`initial_importer_flag:Y`（**非** establishment_type:Importer）。fit 门设备信号经 `attributes.products`=device_name 送达。
- **🔴 合规**（spec §3，**与 TED 关键差异**）：绿事实 **CC0**（可商用、**署名非义务**，`license='CC0-1.0'`，非 TED 强制 CC BY）· `us_agent`/`owner_operator`/`contact` **具名个人绝不入绿库**（CC0≠GDPR 依据）· **「注册≠核准」文案红线**（`attributes.fda.disclaimer`，绝不称 FDA 认证）· `source_policy(api.fda.gov, personalData=true)` **§8.8 用途门** fail-closed · MAUDE/FAERS 患者数据不摄入 · 捕获的 `owner_operator_number` 是非个人 firm id。
- **质量闭环**：TDD（289 单测，+28）+ 真库真 API 端到端（无 sandbox，`verify-openfda-discovery.mts` 四段全绿：LLZ 放射影像美国进口商 27 家 → canonical 27 + CC0 证据 108 → 无具名个人 → §8.8 SUSPENDED 零落地）+ **对抗复审工作流**（4 维·10 agent → 4 findings 全修：匹配产品分类/跨国 externalId/fit 门设备信号/firm 归并留键）。PR #34 自审自合。⚠️ Tier 3 fit 门 LLM 判别受阻于**网关 Gemini 额度耗尽(429)**（环境/计费，波及全部 fit 门，已建 task 跟进），openFDA 数据已正确进入门。
- **✅ P2 ICP→FDA 产品码映射（多租户不硬编码）**：`taxonomy-resolver.ts` 加 `resolveFdaProductCode`（产品词精修，枚举**限 panel 子树** `parentCode ∈ panelCodes`——FDA 3 字母码不透明无前缀层级、靠显式 panel 父维；缓存命中复验落当前子树；**复用 parentCode 列零 migration**）+ `listFdaProductCodes`（panel 宽网）；`discovery/icp-to-fda.ts` `resolveIcpToFda`（industry `crosswalk.fdaPanels` 锚定 + product LLM 精修限子树 + panel 宽网回退 + 直锚码**并集**）+ `buildFdaQuery`；`icp.service.ts` `generateQueryPlan` 链式 `injectFdaQuery`。**国家维与 TED 相反**：FDA=全美市场无覆盖门，租户选**贸易侧**（进口渠道 `initial_importer_flag:Y` / 同类制造商 `establishment_type`；未识别侧默认进口 + warn）。种子 curated（同 CPV 子树哲学）：6 panel + 6 放射 product code（码/名/class/regulation 手工核验自 `/device/classification`）+ ISIC 医疗器械节点 '325' crosswalks.fdaPanels（**只列已种子 panel**，不 over-claim）。**实测**（真库真 API，`verify-icp-to-fda.mts` 三段全绿，**确定性 allowLlm=false 即通**、不依赖模型）：ICP「放射影像器械+进口商」→ panel RA → 码子树 → 闭环真拉 25 家在美注册进口商（Philips Ultrasound/Carestream/Xoran…）。TDD 302 测 + 对抗复审（3 维·11 agent → 6 findings 全修：wikidata QID 错锚[Q12140 药品→Q6554101 器械]/panel 过度声明/贸易侧兜底/直锚码并集/标签截断）。PR #36。基于 #35（Gemini→deepseek 改路由）rebase。
- **✅ P3 510(k) → `FDA_CLEARANCE` intent 投影（动分，镜像 TED intent 投影）**：`adapters/openfda-api.ts` 加 `search510kClearances`（`GET /device/510k.json`，**顶层** `product_code`/`country_code` + `decision_date:[FROM TO TO]` 有界分页）+ `build510kSearch` + `map510k`（只取绿事实：法人 applicant/清关码/器械名/顶层 `openfda` 块，🔴 绝不取 `contact`/地址自然人）+ `fdaDateToIso`（§8.6/gotcha#5：`YYYY-MM-DD`/紧凑 `YYYYMMDD`/ISO datetime → `'YYYY-MM-DD'`，非法→undefined，防 `scoring.ts` `Date.parse` NaN 静默 0 分）+ `isClearedDecision`（§8.6/gotcha#6：**只对正向清关投**——`SE*` 家族 + `SN/ST/PT/SI` + `DENG`；NSE/被拒/撤回排除，绝不给被拒公司误加分；allowlist=fail toward 不投影）。`intent/openfda-intent-projection.service.ts` `projectClearances`：**具名申请人清关=新品/上市时机**，按 name+alpha-2 归并取最新决定日 → upsert canonical(有则更新/无则建线索) → `attributes.intent.events[{type:'FDA_CLEARANCE', at:<决定日 ISO>, strength 0.85}]` → 动六维 Intent 维（复用 `mergeIntent`，新 event type **无需改评分**——`scoring.ts` 逐事件泛读）。§8.8 用途门 fail-closed；**§6 高精度个体户边界**（`isLikelyIndividualApplicant` 只判人称头衔/"Surname, Given" 逗号格式，**绝不按「几个大写词」形状误伤真公司**——"GE Precision Healthcare"/"Karl Storz Endoscopy" 都是 3 词却是公司；风险有界=从不落 contact/邮箱、applicant 为公开备案主体名）；幂等（`sameIntent`）。**合规（与 TED 关键差异）**：CC0 **署名非义务**（`field_evidence.license='CC0-1.0'`，非 TED 强制 CC BY）+「注册/清关≠核准」`attributes.fda.disclaimer` 恒置。**DRY**：`sameIntent`/`canonicalize` 上移 `intent-projection.service.ts` 供 TED/openFDA 共享；`mergeIntent` 排序比较器改一致（相等 `at` 返 0 保序，V8 稳定；修共享幂等基石的潜在不一致比较器）。**实测**（真库真 API 无 sandbox，`verify-openfda-510k-intent.mts` 五段全绿）：ICP「AI 放射影像诊断软件 product code QAS」近 1 年 16 条清关（Qure.Ai/Aidoc/Ischemaview/A2z Radiology Ai… IN/TW/US/CA/ES/IL）→ **11 家去重 canonical + 11 FDA_CLEARANCE**（"Ischemaview"+"Ischemaview, Inc." 正确并到最新决定日）、disclaimer/CC0-1.0/无 PII、同参再跑幂等（evidence 22→22）、Intent 维 0→0.0252 总分 0.1425→0.1463、§8.8 SUSPENDED 零落地。TDD 339 测（+37：510k 映射/日期/清关码 + `isLikelyIndividualApplicant` + 共享幂等基石单测）+ 对抗复审（3 维·7 agent → 4 findings 全经核验，2 条真机制加固：比较器一致性 + 共享幂等基石单测）。PR #37。
- **✅ 510k intent 投影上 Temporal Schedule**（见下「外部源 intent sweep」）。
- **⬜ 下一步**：P4 `attributes.fda.*` 富集（分类事实/清关历史）· monitoring sweep（定时扫新注册/清关 `created_date`/`decision_date` 增量）· FDA 分类扩 `foiclass.zip` 全表种子（resolver/宽网机制已就位，扩种子即生效）。

### 外部源 intent sweep 上 Temporal Schedule（P5 · loop 收口，2026-07-09）

> 让已落地的两 P3 intent 投影（TED 招标 `TENDER_PUBLISHED` + openFDA 510k 清关 `FDA_CLEARANCE`）**在生产周期真跑**——此前只在 verify 脚本里活，生产永不触发、Intent 维永远拿不到外部信号。核心原则「已建的东西在生产真跑优先于建新能力」。

- **✅ `externalIntentSweepWorkflow` + 第 4 个 Schedule**（`temporal/external-intent.{activities,workflow}.ts` + `ensure-schedules.ts`，默认 6h、overlap=SKIP、env `EXTERNAL_INTENT_SWEEP_EVERY` 可调，worker 启动幂等自愈）：`listExternalIntentTargets`（ownerDb 只读枚举**全部** ACTIVE ICP——无静默截断防旧 ICP 饿死，稳定序 id asc；+ data_provider `ted`/`openfda` ENABLED kill-switch）→ 逐 ICP `projectExternalIntentForIcp`：ICP `companyAttributes`/`targetMarkets` → **确定性**（`allowLlm:false`，调度不臆造码/可复现/零 LLM 成本）解析 CPV（`resolveIcpToCpv`）+ FDA 产品码（`resolveIcpToFda`）→ `projectTenders` + `projectClearances`。各 provider 独立 enabled 门 + 单 provider/单 ICP 失败 fail-safe 不阻断其余；投影写全走 `withWorkspace`（RLS 安全，跨租户枚举走「受信系统扫描器」先例）；§8.8 source_policy 门由两 projection service 各自把守。worker 抽出**共享** `TaxonomyResolver` 一实例（discovery + external-intent 复用）。
- **实测**（真库真 API 无 sandbox，`verify-external-intent-sweep.mts` 四段全绿，活动级）：seed 两 ACTIVE ICP → 枚举命中 + provider ENABLED；pumps+EU → CPV 1 码 → **68 招标 → 54 买方 canonical → 54 TENDER_PUBLISHED**；radiology+US → 6 FDA 码 → **82 清关 → 70 公司 → 70 FDA_CLEARANCE**；`ted` DISABLED → `tedEnabled=false` 跳过。build 绿 · 340 单测绿 · 对抗复审（3 维·7 agent → 1 finding 经核验后加固：ACTIVE ICP 枚举去静默截断防饿死）。PR #38。
- **⬜ 下一步**：超大规模（ACTIVE ICP 数千+）再上 `lastSweptAt` 水位列做增量轮转（当前全量枚举，dozens 级绰绰有余）。

### 已知欠账（按优先级）

- 🟠 **存量下游跨-sweep 游标饿死（fast-follow，复审 #1/#2 HIGH）**：`enrichBacklog/enrichSignalsBacklog/registerWatchesBacklog/discoverContactsBacklog` 每 sweep 游标复位为 null（Schedule 全新 workflow、无跨-sweep 持久化）+ 扫描集按 `fitVerdict='match'` 不随处理收缩（处理只改 attributes/version，不脱离过滤集；联系人集靠结果依赖的 `contacts:{none:{}}`，空结果常态 → 永久留前排）→ 每轮重扫 id 最前固定 N 家（预算 signals/watch 各 36），**预算位次后的 match 公司在信号/监控/联系人上永久饿死**（某租户 match>36 即触发），Intent/Reachability 恒 0、永不满足 recommended——**本管线立论 bug 在下游复现**。根治：加 schema 水位列 `lastEnrichedAt/lastSignalAt/lastWatchAt/contactDiscoveryAttemptedAt`，WHERE 过滤「已处理且 TTL 新鲜」使扫描集随处理收缩、游标真吞噬存量（仅调大预算治标不治本）。

1. **鉴权契约对接**：JwksTokenVerifier 已就绪，但需 SaaS 平台的 JWKS 端点 + claim 约定书面确认才能激活（联调前提）。
2. **多源 P0 补源**：VDMA 协会名录 / Hannover Messe·EuroBLECH 展会名录（需逐站抓取模板）。~~GLEIF LEI 富集~~ ✅ 已落地。
3. 异步长任务前端交付：SSE 进度流 + 领域事件出口（现仅裸轮询）。
4. 契约防漂移进 CI：openapi-typescript 生成前端类型 + oasdiff 破坏性变更检查。
5. Docling 文档上传路径；OPA / Langfuse / Golden Set；brand_profile / glossary。
6. 海关贸易公司级数据（付费 reseller，留契约插槽）；product/HS 维归一。

## 关键数据模型（本能力落地的主要表）

所有业务表带 `workspace_id` + PostgreSQL RLS（ADR-001）。

- **企业理解**：`company_profile` · `offering` · `brand_profile` · `knowledge_source` · `claim` · `evidence` · `citation` · `knowledge_conflict` · `glossary`
- **ICP**：`icp_definition` · `persona` · `buying_committee_role` · `qualification_rule`
- **Data Hub**：`data_provider` · `provider_contract` · `dataset_license` · `source_policy` · `raw_source_record` · `canonical_company` · `canonical_contact` · `field_evidence` · `identity_link` · `data_quality_issue` · `data_cost_ledger` · `suppression_record`
- **Lead**：`account` · `contact` · `lead` · `signal` · `lead_score` · `lead_decision` · `lead_cohort`
- **公共/基础设施**：`organization` · `workspace` · `membership` · `outbox_event` · `ai_trace` · `usage_ledger` · `audit_log`

## 状态机（PRD 11.9）

- **Claim**：INGESTED → EXTRACTED → NEEDS_REVIEW → APPROVED → EXPIRED/REVOKED
- **ICP**：DRAFT → HYPOTHESIS → VALIDATING → ACTIVE → SUPERSEDED → ARCHIVED
- **Lead**：DISCOVERED → ENRICHING → REVIEW → QUALIFIED/REJECTED/SUPPRESSED → CONTACTED → CONVERTED

## 贯穿约束（每个阶段都要守）

1. **多租户**：Shared Schema + `workspace_id` + RLS，领域 API 不感知物理隔离（ADR-001）。
2. **AI 分层**：AI 只理解/研究/生成/建议；状态/权限/预算/执行/审计由确定性系统兜底（无「超级 Agent」）。
3. **对外动作前置校验链**：数据权利 → Suppression → Policy → RBAC/ABAC → Campaign Scope → Approval → ExecutionAuthorization。
4. **字段级 Evidence**：Canonical 字段不只存「最终值」，保存来源/时间/置信度/许可/允许动作（7.4.9）。
5. **契约先行**：数据模型 + OpenAPI/AsyncAPI 先定，Provider JSON 禁穿透领域层（ADR-017）。
6. **幂等**：所有外部副作用用稳定 idempotency_key；业务更新用乐观锁/version（11.16）。

## 接口文档（后期交付，code-first）

**不为前端并行开发做协调/mock；后端做好后再出一份接口文档告诉前端如何接入**，不等前端（见 [[api-contract-approach]]）。做法：

1. REST 采用 **code-first**——用 `@nestjs/swagger` 从实现自动生成 OpenAPI，开发期 `/api/docs` 可看可试；后期**导出 OpenAPI + 简短接入说明**作为交付物。
2. 事件用 AsyncAPI/JSON Schema（`packages/contracts/events/`，按 11.10/11.11），随实现补。
3. `packages/contracts` 保留：事件 schema、通用约定(README)、以及最终导出的 OpenAPI；spectral/redoc 用来 lint 与渲染导出的 doc。

统一约定（错误模型 11.15、游标分页、uuid、UTC 时间、金额币种、幂等键、乐观锁）见 `packages/contracts/README.md`。

**鉴权边界**：身份/登录由**外部 SaaS 平台**拥有，我方只校验其签发的 bearer token 并解出 workspace/角色（做成可插拔守卫，本地 dev 校验器）。契约安全方案 `bearerAuth` 不变。

**文档工具链就绪**（早期用手写 `/health`+`/companies` 验证过 lint/mock/gen 全链路；REST 契约后续改由 Nest 自动生成，手写 openapi.yaml 仅作过渡参考）：

- `pnpm contracts:lint` / `contracts:docs` — spectral 校验 + Redoc 渲染（用于最终导出的 doc）
- `contracts:mock` / `contracts:gen` — Prism mock / TS 类型（备用，非当前优先）

## 待定决策

- **数据层 ORM**：✅ 已定 **Prisma**。RLS 用「非超级用户 app_user 连接 + 每事务 `set_config('app.current_workspace_id')` + `current_workspace_id()` 策略函数」，迁移 `20260706_rls_and_app_role` 已落地并验证隔离。
- **首个真实数据源**：Provider 合同 Validation Required；先 sandbox，合同确认后接第一个真实 TradeData/B2B 源。

### 收口① CandidateAssessment：fit 判定迁到 ICP×公司维（2026-07-10，PR #43）

> release-plan 六收口第一项。修 as-built 缺口 #1（真 bug）：fit_verdict/fit_reasons 原挂 canonical_company（公司级），同 workspace 两个 ACTIVE ICP 时后判 ICP 判不了（qualifyFit 只判 null）且评分读到前判 ICP 的判定（污染）。

- **迁移**：Lead(+fitVerdict/fitReasons/`[ws,icp,fitVerdict]` 索引/FK→canonical onDelete:Cascade)；canonical 删两列、4 水位索引去 fit 前缀；migration 有意不 backfill（生产未上，sweep 按 ICP 重判）。共享 `upsertLeadFit`（run 增量 + backlog 存量两路统一）；初始 queue 按 verdict 映射（mismatch→rejected）。
- **过滤语义**：discovery 下游=本 run ICP 的 match（`leads.some(icpId,match)`）；backlog 下游=任一 ICP match（公司级去重）；四水位列留 canonical（公司级，多 ICP 共享）。scoreCandidates 的 authoritativeFit 改读本 ICP Lead。
- **对抗复审 2 findings 已修**：ENRICHED 死值（真正富集成功处写回，updateMany+SUPPRESSED 守护）；空分 Lead 置顶（排序 nulls last）。迁移/RLS/并发维 5 疑点全核验安全。
- **实测**：build 零错 · 343 vitest（回归 spec RED→GREEN）· 真库真 RLS `verify-candidate-assessment-fit.mts` 全绿（app_user 硬 guard；两 ICP 独立/幂等/迁移生效/水位保留）。

### 收口③ LeadQualifiedPackage 真实交付：Outbox 假发布根治（2026-07-10，PR #46）

> release-plan 六收口第三项（P0）。修 as-built 缺口 #3：relay 对无 handler 的 8 种事件（含 LeadQualified）也标 publishedAt——假发布、静默丢失，平台核心交付物事实上发不出去。

- **事件注册表三分支**（`relay/event-registry.ts` 穷举 11 种产地）：3 内部命令→Temporal（补 AlreadyStarted 幂等，`startWorkflowIdempotent` 三处共用）；8 集成事件→`outbox_delivery` 账本单事务原子路由（skipDuplicates 幂等，publishedAt 语义=已路由进交付层）；未注册→`parkedAt` 停靠+大声报错（不假发布、不毒化 2s 轮询）。
- **双 sink**：`saas` 拉模式=`GET /events`（游标=**交付账本行 id**，构造性消除「低 id 晚发布被游标越过→永久漏交付」；任意重放 at-least-once）+ `POST /events/ack`（幂等、锁死 pull sink——webhook 的 ACKED 只能由 relay 2xx 写）；`webhook` 推模式=URL+SECRET 且 https 才启用、HMAC-SHA256 签名（验签契约 `contracts/events/WEBHOOK.md`）、指数退避封顶 1h、10 次 DEAD（DLQ）、成功/失败双路径 CAS。
- **LeadQualified 快照 v1**（decide(accept) 事务当刻不可变副本，契约 `lead-qualified.v1.schema.json` + ajv Consumer Test）：六维分（demand_proof 收口⑤前恒 null）+ icp_version + company_ref（LEI/FDA 标识符）+ 🔴 contact_refs 只带 ref+职务元数据绝不嵌人名/邮箱（additionalProperties:false 契约兜死）；含具名 refs 事件 privacyClassification=RESTRICTED。
- **decide 幂等+CAS**：同状态重复裁决短路（双击不产生第二条 LeadQualified）；version 乐观锁并发 409。值域护栏：权重 @Min(0)+快照/scoring clamp01。expireDueClaims 两步包事务（ClaimExpired 现为对外事件，不可丢）。
- **对抗复审**（3 维 18 agent 逐条核验）：15 findings→确认 13（2 对重复=11 独立）**全修**，杀 2 误报。记档不阻塞：游标 volume 侧信道→后续不透明游标；LeadQualificationRevoked 撤销事件；internal command attempts 上限停靠。
- **实测**：build 零错 · 435 vitest（RED→GREEN 有据）· 真库真 RLS `verify-outbox-delivery.mts` 24 断言全绿（app_user 非 superuser 硬 guard；路由/幂等/停靠/账本游标翻页不漏不重/跨租户 RLS/端到端 decide→快照→拉取→ajv 契约校验→无 PII/重复 decide 幂等）。
- **部署注意**：relay 单写者约束（多副本前需 advisory lock）；存量已假发布旧事件不回补（thin payload 无快照可补）。

### 选项 B · P0.4 决策人邮箱猜测接入主链（2026-07-10，PR #49，设计 [decision-maker-p0.4-mainchain-wiring-design.md](decision-maker-p0.4-mainchain-wiring-design.md)）

> 承接 P0.3（PR #42/#45）：已落地但**无生产调用方**的 `guessEmailsForCompany` 接进主链，让 fit=match+域名+缺邮箱的具名决策人**自动补全邮箱**。混合姿态（会话拍板）。service 方法零改动，两条路复用其底层纯件。

- **组件 A 按需端点**：`POST /canonical-companies/:id/guess-emails`（`GuessEmailsDto` 镜像 VerifyContactPointDto + maxContacts/maxProbe 护栏）→ 透传 `guessEmailsForCompany`。调用方（SaaS 前端代客户）带 LIA = per-tenant 干净合法性来源。
- **组件 B 存量 sweep 阶段⑤b**：新活动 `guessEmailsBacklog`（镜像 discoverContactsBacklog：短事务①载入→事务外 SMTP→短事务②落库→水位 stamp-all）。🔴 **双闸合规门·默认关**：全局 kill-switch `email_guess` provider（seed **DISABLED**）ENABLED **且** `config.lawfulBasis` 有合法记录才自动探测；**自动路径永不 allowPersonalWithoutBasis**（红线，单测+实测证伪）。RISKY 猜测无 outreach、suppression 不落、personal_data+lawful_basis 留痕（走未改动的 persistGuessedEmail）。
- **组件 C 水位列**：迁移加 `canonical_company.email_guess_attempted_at`（加性可空 + 索引，镜像 4 同族列）；`backlog.eligibility` 加该水位（30d TTL 防重锤 MX）+ `requireEmaillessContact` 谓词。
- 🔴 **诚实交底**：B 路径 `config.lawfulBasis` 是 **interim 全局**（ENABLED 时对所有租户套同一条），仅适用当前单客户/dev；per-tenant LIA 采集归收口⑥ DataRightsService+SaaS。默认 DISABLED 即为此设计。
- **对抗复审**（4 维·逐条对抗核验）：无 HIGH/CRITICAL；修 2 MEDIUM（自动路径 per-company SMTP 扇出无上界→大团队公司超时→水位不 stamp→重锤 MX；service/backlog 目标构建逐字重复漂移）——抽共享纯件 `buildGuessTargets`（RISKY 排除 + per-company cap 25）供两路共用一并根治 + 补 no_verifier 测试 + 清死字段。
- **实测**：build 零错 · **464 vitest** · 真库真 SMTP 真 RLS `verify-email-guess-backlog.mts` 全绿（app_user 非 superuser 硬 guard；双闸全开→真扫→真 SMTP 诚实降级 RISKY 不谎报 VALID→落库+水位 stamp；幂等 scanned=0 不重锤；两红线可证伪 DISABLED/无 LIA→skip）。
- **遗留**（后续独立 track）：待办 2 跨源身份解析（name-match 合并多源同一人）；待办 3 P1 身份源（专利/注册处/商标）。

## 2026-07-10 · 收口④ OpenAPI 单一真值 + 统一信封（PR #48，缺口#4 已修）

- **统一响应信封定稿**（PRD 11.12/11.15 + contracts README 既有约定落地）：2xx 一律 `{data}`；分页 `{data, page:{next_cursor, has_more}}`（协议键 snake_case、资源字段 camelCase）；错误 `{error}`；`/health*` 探针例外。8 控制器 38 业务操作全套 + `@ApiEnvelope/@ApiPageEnvelope/@ApiListEnvelope`（与运行时 `common/envelope.ts` 同源），响应 schema 覆盖 23 缺失→0。
- **双源消失**：删旧 3-path `openapi.yaml`；contracts lint/bundle/docs/mock/gen 5 脚本切 code-first 导出的 `openapi.json`（40 paths）；README 重写 code-first；`src/generated/api.ts` 从 JSON 重生成。顺手修 17 处 DTO 契约错型（`string|null` 联合被 swagger 推断成 object）+ create 202/201 错位。
- **CI contracts job 三道门**：`--export-openapi`（无需 DB/Temporal，假 DATABASE_URL 实测可跑）→ drift（`git status --porcelain`，抓修改+untracked+删除态）→ spectral lint → oasdiff breaking（PR base 对比；`breaking-change-approved` label 放行——本 PR 即首例，v1 无消费方是定稿零成本窗口；`review:'false'` 关掉 action 默认把私有契约上传 oasdiff.com 的外发）。
- **对抗复审**（3 维 find + 逐条对抗核验，14 agent）：11 findings → 10 确认全修 + 1 误报杀掉。HIGH×2：6 端点 13 个可选 @Query 被推断 required:true（prism mock 实测合法首页请求 422）→ 显式 @ApiQuery；Idempotency-Key 大小写不合并成双 header 矛盾参数 → 改小写合并。MEDIUM×4：事件 envelope schema 与 envelope.schema.json 双源漂移（补 10 required+枚举+3 条一致性单测）；恒在可空字段错标可缺失（@ApiProperty+nullable 正确建模）；22 处裸 `{type:'object'}` 致 codegen `Record<string,never>` 字段访问全编译错（补 additionalProperties:true）。LOW×4：drift 门 untracked 盲区、oasdiff 隐私外发、class-validator 约束进契约、INTEGRATION.md 旧示例。
- **实测**（真实数据无 sandbox）：461 vitest 全绿（TDD RED→GREEN）· `verify-envelope.mts` 真 API+真 dev 库 18 断言全绿（1040 家 canonical 真数据游标续拉不重复、真事件 snake_case envelope、404/400 错误模型、真响应逐个过 openapi.json ajv 校验）· 契约复检（query required 清零/单 idempotency header/events 10 required+enum/裸 object 清零）· CI contracts job 首跑即绿（ubuntu 重导出与提交契约逐字节一致=跨平台确定性）。
- **记档不阻塞**：Lead/CanonicalCompany 等松散 object 的结构化 DTO 待收口⑤/实体解析定型后收紧；信封扩展字段（Evidence/Quality/Rights/Freshness/Cost/Partial）随收口⑤⑥补。

## 2026-07-11 · 收口② ExecutionContext + Broker 真收口（PR #51，缺口#2 已修——R0 四刀全部完成）

- **主链全经 Broker**：新增 8 个 L0 工具（`crawl4ai.render`/`http.get`/`wikidata.entity`/`gleif.fetch`/`ted.search`/`openfda.search`/`tradefair.algolia`/`mapyourshow.fetch`，`tools/source-tools.ts`）+ 既有 5 件套，收编 22 处直连出网——发现/富集/intent/采集/理解五条链全部 `broker.invoke`（业务层直连 grep 清零）。登记例外四类注明：robots.txt 抓取（合规原语）、DNS 解析（SSRF 护栏原语）、模型网关内部 HTTP（网关层自治）、outbox relay webhook（交付账本治理）。
- **source_policy fail-closed 分层**：`ComplianceMeta.sourcePolicy = required|advisory|none`——required（受治理数据源，policyDomain 固定治理域）未登记/无 reader/提不出域一律拒；advisory（标的公司站点）登记即强制、未登记放行（robots/SSRF/DAT-011 兜底，不杀发现引擎）。删 ted/openfda 四处手写 §8.8 镜像（「无 reader fail-open」缺陷）收敛 Broker 单点；用途门按**本次调用用途**判（`ToolContext.purpose: string|string[]`，any-of ∩ 工具声明集——TED E2E 负向测试抓到交集弱化回归后补）；seed 补 6 治理域行（algolia.net ToS 灰红源如实标 REVIEWED_RESTRICTED=显性风险登记点，SUSPENDED 即全链停抓）。
- **预算真开账 + LLM 网关门**：discovery run 逐活动幂等 `open(runId, RUN_BUDGET_CENTS)`/finalize 强制 close；backlog sweep fit/contact 阶段账（BudgetLedger open/close 引用计数防并发误删 + settle 迟到句柄钳 0）；**RouterModelGateway reserve-then-settle**——`maxCostCents` 从纯声明变真闸，settle 按 token 折算实际成本（`LLM_CENTS_PER_MTOK` 保守混合价；复审 HIGH：原按上限记账令 $20 run 实为 ~100 次调用硬顶）、预算拒绝落 trace、fit 截断显性化（`stats.fitSkippedForBudget` + run 转 PARTIAL 绝不假 DONE；backlog 该页收手下轮重判）、stub fallback 零成本入账。
- **allowedTools 填实 + 灭伪 workspace**：extract_company/extract_list/find_decision_makers/extract_claims 填真实工具 id，provider 经 broker 调用绑 taskContractId（白名单真实生效）；`ExecutionContext {workspaceId, runId?, correlationId?}` 贯穿 adapter 契约（discoverCompanies/enrichCompany/discoverContacts 增 ctx），`'discovery'`×3 + `'taxonomy'`×3 伪值清零（taxonomy 无租户时跳过 LLM 冷路径）——ai_trace/usage_ledger 按真租户/run 归账。
- **实测**（真库真源无 sandbox）：`verify-broker-closure.mts` 15/15 断言（未登记拒/无 reader 拒/SUSPENDED 真库翻转 Broker 真拦/预算双门真拦截/**ai_trace 真写入** + 伪 workspace 负向对照 22P02 静默 0 行/TED 真拉 5 中标/SSRF 真拦云元数据 IP）· `verify-ted-discovery.mts` 端到端全绿（raw 13→canonical 13→CC BY 证据→真 LLM fit 四门）· 494 vitest（+33 新测）· 15 个 verify 脚本同步新契约。
- **对抗复审**（3 维 find + 14 agent 逐条对抗核验）：11 findings 确认全修（HIGH×2：预算按上限记账静默截断假 DONE、http.get redirect:'follow' SSRF 绕过→改 manual 逐跳护栏≤3 跳；MEDIUM×4：intent 用途门缺口、directory 名录页 60k→40k 上下文劣化（工具加 maxChars）、http.get 丢浏览器兼容 UA、sweep 预算生命周期注释与事实不符；LOW×3）+ 3 误报核验杀掉（含 algolia seed APPROVED——显性登记优于 main 零门现状）。
- **记档不阻塞**：整轮 sweep 硬上界需持久化账本（收口⑤/R2 预算基建）；DNS-rebinding TOCTOU 连接层 IP pinning（收口⑥安全加固）；Broker ToolTrace 落库（现 console，成本/合规决策审计表后续）；幂等闸门仍为 trace 元数据（无结果缓存）。

### 选项 B · 待办 2 跨源决策人身份解析（2026-07-11，PR #54，设计 [decision-maker-cross-source-identity-design.md](decision-maker-cross-source-identity-design.md)）

> 承接 P0.4（#49）+ 设计定稿（#53）：落库前加 `resolvePersonIdentity` 解析前置——先问「本公司是否已有同一人」，有则并入、无则新建——修 P0.4 令其更活的决策人重复 bug（email/无-email 桥 + 人名变体），并建成待办 3（专利/注册处/商标）复用缝。

- **新 `person-name.ts`**：从 `email-permutation.ts` **搬迁**人名归一（去称谓/贵族前缀/"Surname, Given" 语序/NFC/德语去音标），email-permutation 改 import + re-export，**行为逐字不变**（69 email 测全绿）。
- **新 `person-identity.ts` `resolvePersonIdentity`**：同 companyId 内 4-Tier（externalId / 邮箱精确 / 归一名精确 / 高置信模糊）。🔴 **绝不错并**：仅同公司 + fuzzy 严阈值 **0.9 + margin 0.1** + **邮箱冲突守卫**（同公司同名不同邮箱→判不同人、不并）；方向宁欠并不错并。
- **改 `contact-persist.ts`**：命中并入（title/seniority 补空不覆盖 + `identity.merge` snake_case 证据）、无则原 `contactIdentity` 键新建；`created`/`merged` 分计。**无 schema 迁移**（键形不变、matchRule 走 field_evidence、Tier0 留 TODO 供待办 3）。
- **对抗复审**（单 reviewer 逐条对抗核验）：抓 **1 HIGH（🔴 错并）**——Tier 3 原误借**公司名匹配器** `normForMatch` 剥法人后缀（co/sa/oy/as…），姓氏恰为这些真实姓氏时（"Marco Sa"/"Erik Oy"/挪威姓 "…As"）→ 剥成只剩名 → 错并两人；**已修**：Tier 3 改用人名归一 token Jaccard、不碰公司匹配器 + 锁死回归测。2 LOW（`created` 含并入、证据 camelCase→snake_case）一并修；邮箱守卫/欠并方向/重构等价/事务纪律逐条核验安全。
- **实测**：build 零错 · **521 vitest**（+3 错并回归）· 真库真 RLS `verify-cross-source-identity.mts` 三场景全绿（①一人无邮箱→带邮箱同名→并一条 ②同公司同名不同邮箱→两条不并🔴 ③"Dr. Johann Schmidt"→"Johann Schmidt"→并）。
- **遗留**：待办 3 P1 身份源（专利 inventor/注册处董事/商标申请人）——本期已建 `externalIds→Tier 0` 缝、留 TODO 空跑通。

## 2026-07-11 · 收口⑤ 一等 Signal + ingest-once（PR #56 代码 + 本 PR 文档）

**缺口#5 根治**：intent 从「JSON 投影非一等事实 + 外部源按 ICP×workspace 重复直拉」反转为两层模型。

- **平台层**：`source_signal` 一等信号表（无 RLS 零个人数据：payload 白名单显式构造 + FDA 个体户摄取层即拒 + 对抗单测锁；subject 身份键与租户 dedupeKey 同规范化；双时间轴 occurred/observed=backtest 基础；license 行级；状态机 ACTIVE→EXPIRED|REVOKED + 类型 TTL 招标 90d/清关 365d）+ `signal_ingest` ingest-once 账本。**时间窗拍板：6h UTC 对齐桶**（env `SIGNAL_INGEST_WINDOW_MS`），拉取键=(provider, 规范化查询指纹, windowKey)——跨 workspace 同参 ICP 天然共享一次拉取。
- **SignalIngestService**：经 Broker（PLATFORM_WORKSPACE + purpose=['intent','discovery']）+ `sweep:external-intent` 预算开账 + BudgetExceeded 透传；ERROR 条件记账绝不覆盖并发 OK 行（TOCTOU 护栏）；**撤即脱敏** revoke + revokeBySubjectKey/ByProvider（Art.17 路径）。**两级撤停语义拍板**：source_policy SUSPENDED=停采不停用（只拦出网），「采集被判违规」类事件用 revokeByProvider 处置存量。
- **投影反转**：TED/openFDA intent 投影只读 source_signal（fetch 拆层、构造去 broker）；FDA 码过滤下推 jsonb；扫描窗/上限截断显性告警 + subjectsTruncated 可观测。sweep 四段化（枚举→确定性解析→指纹去重拉取一次→逐 ICP 投影），expireStale 状态机先行。
- **可复算**：IntentRecomputeService（surfaces=与增量投影同过滤面——对抗复审 HIGH：防跨 CPV/跨 ICP 注入与抖动循环，不动点回归锁）；mergeIntent 去重键 epoch 归一（对抗复审 HIGH：存量旧格式 at 与新 UTC ISO 同刻去重，生产 sweep 一次重写自然收敛，无需 backfill）。web_watch 按 ADR-006 留租户轨（事实账本=source_entity_change，复算地平线=保留期）。
- **demand_proof 维切分拍板**：需求证据=TENDER_PUBLISHED+SOURCING_OPENED（FDA_CLEARANCE 属上市时机留 Intent 维）；evidence 判据强制（ADR-010）；观测维**不进总分**（乘法门待 R2 backtest ≥50 QGO 标签）；快照 v1 契约预留槽位 → **零破坏填充**（snapshot_version 保持 1，不开 v2 文件防混流；qualification_rule_version→additive-6dim-v2）。
- **实测**（真库真 API 无 sandbox，四脚本全绿）：verify-signal-first 38 断言（验收①②③各有专属断言：24 条真招标一次拉取双租户各投 18 家零出网 / EXPIRED-REVOKED 剔除+脱敏 / 复算重建 unchanged）；三旧脚本适配两层架构（真跑抓到并修 openFDA 投影 taxonomy 键大小写 bug）。547/547 vitest（+53 新测 TDD）+ build + eslint 零告警。
- **对抗复审**：3 维 21 agent 逐 finding 独立核验——14 缺陷确认全修/记档（2 HIGH 根治+回归锁）、2 误报驳回。
- **记档不阻塞**：ingest PENDING 抢锁根治 · TED CPV 前缀列+GIN 下推 · 投影上限游标化（缺口#8 同类）· license 值 SPDX 统一（随收口⑥ 权利词表）。

### 选项 B · 待办 3 首个身份源 UK Companies House（2026-07-11，PR #58，设计 [decision-maker-p1-companies-house-design.md](decision-maker-p1-companies-house-design.md)）

> 承接待办 2（#54）**兑现 `resolvePersonIdentity` 的 Tier 0 externalId 缝**：对 fit=match 英国公司 → CH 官方注册处取现任董事 → 高置信对齐公司 → `externalId(uk-ch-officer)` 走 Tier 0 精确并/新建；**同董事若也在 Impressum 出现→自动并成一条**（兑现待办 2 跨源合并）。

- 新 `adapters/companies-house.ts`（Basic auth CH client，经 ToolBroker 出网）+ `providers/companies-house.provider.ts`（`ContactDiscoveryAdapter`）；扩 `ProviderContactRecord.externalIds/license` + `contact-persist` 写 `external_id` 点/传 resolve；联系人发现改 **fan-out 全部 enabled adapter**（CH 与 decision_maker 并跑经缝合并，逐 adapter fail-safe）；seed `companies_house` data_provider（无 key 天然 no-op）+ source_policy。**无 schema 迁移**。
- 🔴 合规：**GB country 门**（非英不搜）+ 公司对齐 `pickBestByName` 0.9·margin（绝不挂错公司）+ **数据最小化**（只 name+role+officer_id，不摄 DOB/国籍/职业/住址）+ **§8.8 source_policy 用途门 fail-closed** + 董事 personalData + **OGL-UK-3.0** 署名穿透 field_evidence。
- **对抗复审**（PoC 单测在分支上实测复现）：抓 **2 HIGH 全修**——① Tier 0 缺反向守卫致同公司同名不同 officer_id 董事误并（加 `hasExternalIdConflict` 对称 email 守卫，Tier 2/3 拦冲突）；② GB 门 `.uk` 域名当辖区可绕过（`.uk` 2014 全球开放），改 country 优先（非英一律拒、`.uk` 仅缺国别弱兜底）+ 1 MED（fan-out 静默 catch 补 warn）。已核验安全：数据最小化/§8.8 门/公司对齐 margin/key 不泄漏/自足性（committed schema 构建通过，不依赖并发 storage-compliance WIP）。
- **实测**：build 0 · **610 vitest**（含错并回归）· 真库真 CH API `verify-companies-house.mts` 四段全绿（AstraZeneca 真拉 12 董事·对齐 1.00·Tier 0 二次幂等 merged=12·跨源与 Impressum 并一条·§8.8 去用途→拒→零联系人·无 DOB/国籍入库）。
- **遗留**：待办 3 后续源（专利 inventor USPTO/EPO、商标 EUIPO/WIPO；CH 扩德/法）——fan-out + Tier 0 缝已跑通，后续源同法接入。

## 2026-07-11 · 收口⑥ 存储合规 PR-B 删除编排（GDPR Art.17，六项工程收口最后一项完成）

设计见 [../implementation-records/storage-compliance-spec.md §8](../implementation-records/storage-compliance-spec.md)。承 PR-A #60（存储合规地基），本 PR 落地 DSR 删除编排，**满足收口⑥ 验收① DSR 全链演练 + ②「删除编排先于任何发送上线」时序门前置**——**六项工程收口至此全部完成**。

- **schema**：`deletion_request`（状态机 RECEIVED→FROZEN→ERASING→COMPLETED\|FAILED，租户 RLS，`stats` 持久化擦除计数）+ `deletion_receipt`（租户 RLS + **append-only** REVOKE UPDATE,DELETE + **FK onDelete RESTRICT** 防级联删绕过 + `REVOKE DELETE ON deletion_request`）+ 「同主体至多一条在途」**部分唯一索引**。
- **纯核**（+12 单测）：`deletion.types/state`(状态机)/`plan`(禁联项)/`snapshot`(最小化事件 payload)。
- **Temporal 三段编排 + 四活动（CAS 幂等）**：`freezeSubject`（定位擦除面 pre-deletion 快照 + 写 suppression_record 对外动作第一道闸 + **company 即标 SUPPRESSED**）→ `eraseSubject`（硬删 canonical_contact 级联 contact_point + 显式删 field_evidence(contact) + **擦除时刻重查 company 联系人捕漏网** + 受影响 ACTIVE ICP 发 QualifyRequested 重评分 + 同 tx 持久化 stats）→ `completeDeletion`（写回执 append-only + DeletionCompleted 事件同 tx + **取持久化 stats 写忠实回执、拒绝为未擦除请求伪造回执、CAS 收尾**）。
- **`DeletionService`**：受理 → **事务性 outbox 发 DeletionRequested** → relay dispatch 起 deletionWorkflow（Temporal 暂挂靠 relay 重试起，「受理即必然执行」）；`createRequest` catch P2002 → 复用在途请求（并发去重）。**`DeletionController`** `POST/GET /deletion-requests`（authN + RLS 隔离，**无 RolesGuard**=授权归 SaaS，R1 加固）。
- **outbox 注册** DeletionRequested(internal)+DeletionCompleted(integration) + 契约 `deletion-completed.v1.schema.json`。
- 🔴 **合规红线**：located 进 Temporal 历史 **PII-free**（只 uuid+计数，禁联邮箱仅 freeze 内部落库不外泄）；`source_signal` 是**平台共享零-PII 绿库** → 租户 DSR **不撤**（避免跨租户误删），signalsRevoked 恒 0；回执/事件**内容最小化**只计数 + 行 id 引用；receipt DB 层 append-only + FK RESTRICT 双护 GDPR Art.5(2) 问责证据。
- **质量**：TDD **682 单测**（12 新纯核）+ **真库 DSR 全链演练 31 断言全绿**（contact/company 主体 + 幂等 + 无 PII 残留 + RLS 隔离 + 并发去重 + 部分失败忠实回执 + append-only 护证 + 擦除完整性）+ **对抗复审（5 维·16 agent·逐条 adversarial 核验）6 findings（11 raised）去重 4 根因全修**：F1 部分失败伪造 0 回执（stats 持久化 + 拒伪造 + CAS）、F2 append-only 被级联删绕过（FK RESTRICT + REVOKE DELETE）、F3 createRequest 并发竞态重复请求（部分唯一索引 + P2002 复用）、F4 company freeze→erase 窗口漏网新联系人（freeze 即 SUPPRESSED + 擦除时刻重查）；驳回 HIGH「verify 不真跑 Temporal」（测试覆盖 gap 非可触发缺陷）。openapi 无 drift。
- **下一步**：R1 发送侧上线时联合校验「删除编排先于发送」时序门；细粒度 RolesGuard、consent_record(Art.21)、retention sweep 随 R1；`verify-deletion-orchestration.mts` 后续可补 Temporal 端到端（现活动级）。

## 2026-07-11 · 收口⑤ fast-follow：外部源 intent 投影 live 重读 DataProvider kill-switch（Codex #56 P1）

Codex 复审 #56（收口⑤ 一等 Signal）提 **P1 TOCTOU**：`temporal/external-intent.activities.ts` 的 `projectExternalIntentForIcp` 只认 sweep 头部 `listExternalIntentTargets` **捕获的** `tedEnabled/openfdaEnabled` 标志。摄取活动 `ingestExternalSignals` 已逐指纹 `liveEnabled` 重读 `data_provider`，但投影此前只受**捕获门**——若 provider 在捕获之后被 ops 置 DISABLED（`DataProvider.status`=Kill Switch 执行点），投影仍会把缓存 `source_signal` 投进本租户 canonical **造新线索**，绕过摄取侧的 live kill-switch（原 verify Tier 5 只喂 `tedEnabled=false` 走 trivial 分支，从未覆盖「捕获=true 但 live=DISABLED」的真缺口）。

- **修**：`projectExternalIntentForIcp` 投影前 `liveEnabled()` 重读 `data_provider`，`tedOn = 捕获标志 && live.ted`（openfda 同），对齐摄取侧逐单元重读纪律——provider 中途下线本轮即不投影。kill-switch 自此是**非破坏性「停一切新活动（含新线索）不脱敏存量」**闸，填补 SUSPENDED（太软·仍投）与 `revokeByProvider`（太硬·脱敏存量）之间的空档。
- **刻意不做**：**不**在投影加 `source_policy` SUSPENDED 门。SUSPENDED=**停采不停用**（egress-only，见 [../architecture/current.md](../architecture/current.md) §5 两级撤停语义）——停「用」存量信号的正解是 `revokeByProvider`（翻 REVOKED，投影已按 `status='ACTIVE'` 剔除）。在投影加 SUSPENDED 门会违背该设计。Codex 建议「re-check live provider state」被采纳（=DataProvider kill-switch）；「skip cached signals while suspended」按两级语义驳回并说明。
- **实测**：build 0 · **673 vitest**（新增 `external-intent.activities.spec.ts` 3 测：捕获 true+live DISABLED→跳过该 provider / 双 ENABLED→均投 / 双 DISABLED→全跳）· 真库真 TED/openFDA `verify-external-intent-sweep.mts` 全绿（Tier 5 加 **TOCTOU 断言**：喂过时 `tedEnabled=true` + `data_provider` DISABLED → 投影 live 重读 kill-switch，TED 仍跳过；Tier 4 正路 64 信号→50 买方 canonical 不受影响）。**无 schema 迁移**。

## 2026-07-11 · 待办 2 create 层收尾：createContact 尊重 resolve 拒并（#54-D/#54-E / Codex #62-2/#62-3）

> Codex 复审（PR #62 P2 + 重开 #54 P1）暴露待办 2 遗留缺陷：`resolvePersonIdentity` 的合并守卫被 `persistDiscoveredContacts`→`createContact` 的 `contactIdentity` **键控 upsert 旁路**——resolve 明确「拒并」（同名歧义 / RISKY 猜测邮箱）返 null 后，create 层仍按键相同的旧行 upsert，把新记录并回错行，令拒并形同虚设。**先合入 #62（resolve 层拒并的另一半，含 Tier 1 RISKY 跳过 + Tier 2 唯一才并 + external_id 不算可达），再补 create 层**（本 PR）——两半齐落才真正闭合误并。

- **`resolvePersonIdentity` 返富结果 `{hit, ambiguous}`**（`person-identity.ts`；`resolveAmongCandidates` 保留为薄封装、签名与其 ~25 单测不变）：`ambiguous`=因**同名歧义**拒并（Tier 2 ≥2 合格同名候选 / Tier 3 高分但 margin 不足），**与 DB 当前占位无关**（只看候选语义）——这是幂等的关键（见下）。
- **`createContact` 拒并键**（`identity.ts` 新纯件 `declinedContactIdentity` + `contact-persist.ts` 守卫）：resolve 返 null 时，若 `ambiguous || 明文键（盲值）与既有**不同**联系人碰撞`（`findUnique` 探测，同 tx 读己写），改用**不碰撞确定性拒并键**新建独立行——`dx:` 命名空间与明文 `e:`/`c:` 互斥、按 `companyKey` 隔离；判别符优先级 **externalId `dx:x:<ck>:<scheme:value>` > 可信 email `dx:e:<ck>:<归一名>:<email>` > 人名 `dx:c:<ck>:<归一名>`**。可信 email=明文键 `e:<email>` 未被占用（非 catch-all/RISKY 共享地址），占用则退回人名。拒并键盲化落库（复用 #65 `blindContactKey`，去 PII 明文）。
- 🔴 **绝不错并**：同名不同 externalId（HIGH-1）/ 同址不同名（catch-all，#54-E）/ **同名不同 VALID 邮箱**（名+邮箱双判别符）三类全分开。**同源再跑幂等**：`ambiguous` DB-state 无关 + 拒并键确定性 → 二次跑落回同一行、不生重复（纯碰撞探测会在「歧义但来件明文键恰空」翻键生第三/四行，故 `ambiguous` 信号必需）；正常合并/新建路径行为逐字不变（EPO/CH verify 二次跑 created=0 不破）。
- **质量**：TDD **725 vitest**（新增 `declinedContactIdentity` 单测 + `createContact` 歧义/RISKY/误并回归 + `resolvePersonIdentity` `ambiguous` 信号）· build 0 · 真库真 RLS 真盲化 `verify-contact-decline-honor.mts` **三场景全绿**（① RISKY 同址不同名新建+二次跑幂等 ② 歧义无邮箱新建独立行+二次跑不生第 4 行 ③ 同名不同邮箱各自成行+二次跑幂等）。**对抗复审 3 维（误并 / 幂等 / 集成完整性，逐条 adversarial + 修后再攻）**：误并维抓 **1 HIGH**（`dx:c` 只按名致同名不同 VALID 邮箱塌键=净新误并）→ 补 email 判别符 → 再攻确认闭合 + 补**名+邮箱双判别符**闭合「不同名共用 catch-all」残余（LOW）；幂等维 5 场景全幂等；集成维 6 类（ripple/blinding/regression/completeness/tx/test）全净。**无 schema 迁移**。#62 的 2 条 Codex 线程已回复「create 层于本 PR 修」并 resolve。

## 2026-07-11 · 收口⑤ fast-follow²：外部源 intent 投影 kill-switch 单次重读优化（承 #64）

承 #64（Codex #56 P1，投影每 ICP `liveEnabled()` 重读 DataProvider kill-switch）。#64 的 per-ICP 重读正确但每 ICP 一次 owner-DB 读；本 PR 把它降到**每 sweep 一次**，同时**不丢活动自守与任何既有保证**（保严格性优化，非「移守卫出活动去信任调用方」的降级式改法）。

- **workflow 单次读 + thread**：`externalIntentSweepWorkflow` 摄取后调**一次** `liveProviderState()`（新活动=`liveEnabled()` 薄封装），把 `LiveProviderState` 快照 thread 给逐 ICP `projectExternalIntentForIcp`。取「投影阶段开始前一刻」的 live 态——覆盖 #64 关掉的**主窗口**（sweep 头部捕获→摄取全程分钟级 egress→投影开始），残留仅投影循环自身（零出网、下轮自愈）。
- **投影活动保留自守（防御纵深）**：`projectExternalIntentForIcp` 新增可选 `live?: LiveProviderState`，`const live = args.live ?? await liveEnabled()`——**注入优先**（省读），**缺省自读兜底**（直连调用者=测试/verify/未来调用不被信任，#64 的 TOCTOU 断言与单测零改动仍绿）。仍逐 ICP AND 各自捕获标志（捕获=false 者无论 live 都不投）。workflow 单次读失败 fail-safe→undefined→投影自读兜底（一次读故障不放大成整轮不投）。
- **刻意仍不做**：`source_policy` SUSPENDED 门不入投影（停采不停用，见 §4/#64）。
- **实测**：build 0 · **759 vitest**（新增注入快照 4 测：注入门控且零自读 / 注入优先 / 捕获标志不被绕过 / 缺省自读兜底）· 真库真 TED/openFDA `verify-external-intent-sweep.mts` 全绿（Tier 5 加：`liveProviderState` 单次重读 + 「data_provider ENABLED 但注入 live.ted=false → 投影用注入快照跳过 TED」证明非自读）。**无 schema 迁移**。

## 待办 3 第二源 · 专利发明人 BigQuery Google Patents（替代被封 EPO OPS）

- **背景**：EPO OPS（PR #61）账号被网关封停、PatentsView 卡 ID.me 美国身份墙 → 专利发明人源改走 **BigQuery Google Patents Public Data**（`patents-public-data.patents.publications`，IFI CLAIMS 谐调）：仅需 Google 账号，**无审批/无身份墙/无封号风险**，1TB/月查询免费。
- **DRY 源无关移植**：provider（`bigquery-patents.provider.ts`）几乎原样移植自 #61 `epo-ops.provider.ts`——那套护栏源无关，只换 L0 数据客户端（EPO OPS REST → BigQuery）。保留：applicant 高置信对齐（0.9·margin 0.1）+ 归一名去重候选 + **只取独家申请人专利**（防合著误挂）+ 国别门 + 近 5 年·cap 25 + **归一名并（非 Tier 0，无 externalIds）**。
- **L0 adapter**（`adapters/bigquery-patents.ts`）：`assigneeLikeAnchor` 宽预筛锚（provider 再精确对齐）+ `buildQuery` 只 SELECT 2 列 + **`maximumBytesBilled` 成本硬顶**（默认 200GB，超顶即 fail-closed，护免费额度）+ `normalizeRow` 🔴 **数据最小化**（inventor 只留 name，丢 country_code）+ 无 SA key/project → 天然 no-op 返空。
- **合规**：`google_patents.search` = required 工具（personalData=true，policyDomain `bigquery.googleapis.com`，§8.8 用途门 fail-closed）+ CC-BY-4.0 署名写 `field_evidence.license`（⚠️ ENABLE 前核实确切 attribution 文案）+ SA key 文件 gitignored（`.env.example` 记 `GOOGLE_PATENTS_SA_JSON`/`_PROJECT`/`_MAX_GB`）。
- **⚠️ 规模警示**：publications 表无 assignee 分区 → 每查全表扫描（约数十 GB/查）→ 适合有界样本/周期 sweep，不适合高频实时逐公司；生产规模 fast-follow = 物化「assignee→inventor」小表。
- **seed DISABLED**：`google_patents` data_provider 种 DISABLED（真库真测待 GCP key），`bigquery.googleapis.com` source_policy APPROVED（供 verify 过 §8.8 门）。verify 脚本直 new Provider 跑，DISABLED 不挡真测；生产 fan-out 不路由（无静默错采）。
- **质量**：build 0 · eslint 0 · **909 vitest**（新增 33：adapter `assigneeLikeAnchor`/`normalizeRow` 数据最小化/成本护栏 env+默认路径/无 creds fail-safe + provider 全护栏移植测）。**无 schema 迁移**（新增依赖 `@google-cloud/bigquery`）。EPO 代码 PR #61 留档 DISABLED。
- **✅ 真库真 BigQuery 四段 verify 全绿**（2026-07-14，用户 GCP key，无 sandbox）：A 真 API Siemens(DE)→**25 名真实发明人**六护栏全绿；B 落库 25 + person.profile CC-BY-4.0 署名/personal_data、无 external_id 点、二次幂等（created=0/merged=25 Tier 2 归一名）；C 跨源并 match_rule=name_exact；D §8.8 用途门 DENIED 零发明人。对抗复审 APPROVE（0 CRITICAL/HIGH，1 MEDIUM「MAX_GB=0 静默默认」+ 2 LOW 均已收）。
- **⚠️ seed 仍 DISABLED（刻意）**：verify 证明源可用，但 publications 无 assignee 分区 = 每查全表扫（数十 GB）→ 生产逐公司 fan-out 会快速吃光 1TB/月免费额度。**生产启用 = 物化「assignee→inventor」小表 fast-follow**（scale-safe），非直接翻 ENABLED 全量 fan-out。


## 2026-09-20 · Production audit baseline refresh for Windows migration

2026-09-20 锁文件更新后的重审绑定 `6213baf2715f0680f05024bee0994e8593403433`：官方 registry 的 production audit 覆盖 845 个依赖，所有严重度计数均为零。旧绑定对当前锁文件返回 `BASELINE_SOURCE_LOCK_MISMATCH`；刷新来源提交、锁文件摘要和采集时间后，同一份审计返回 `FRESH`。原失效时间、零例外策略和 verifier 保持不变；后续锁文件变更仍须重新审计，不能复用本次通过结论。

同日 main 合入配对 S3 依赖更新后，再以干净提交 `1aaa1a779bbf716f301e5f08c7f3d0ad37eeaacc` 对官方 registry 重审，仍为零公告；刷新当前绑定并保留原到期时间。同一审计在旧绑定下失败，在新绑定下返回 `FRESH`。

同日 main 合入AI SDK 依赖更新后，再以干净提交 `03e8ada02010052bf4220e1063d2c5c987bf1f8a` 对官方 registry 重审，仍为零公告；刷新当前绑定并保留原到期时间。同一审计在旧绑定下失败，在新绑定下返回 `FRESH`。

原始审计和新鲜度回执保存在[冻结证据](../evidence/security/20260920-baseline-refresh.json)。本记录不证明镜像已发布、运行部署完成或当前主线永远满足基线。


2026-09-20 工具链候选重审：源码 `728fbf8eaab86f24182cffe1cccdfb5fbaa7e16c`、锁文件 `sha256:3fa4365cd8f83ba44680fa94e1f3c336a5c94eb055065a0b1eae38ab97333787`，官方production audit共872依赖、零公告；同一审计在旧绑定下HOLD，刷新来源和采集时点后FRESH。原有效期不变，前后回执见[工具链重审证据](../evidence/security/20260920-tooling-baseline-refresh.json)。
