# 当前状态与下一决策

> 文档 ID：`DOC-STATUS-001`
> 生命周期：`CURRENT`
> 状态：`CURRENT`
> 当前事实来源：[产品范围](../product-scope.md)、[当前架构](../architecture/current.md)、[ADR registry](../adr/registry.md)、[发布路线](../status/release-plan.md)、[冲突与开放决策登记](../governance/conflict-register.md)，以及本页逐项注明的 Git/GitHub 回读与 xin `global_dev` 只读查询
> 最后核验：2026-11-04T01:40Z（`origin/main@8b142f53`、运行镜像以 `local-config/global/runtime.compose.env` 的 `GLOBAL_BACKEND_IMAGE` 为准（核验时 `sha256:e2cfa8cc…`）、`global_dev` 只读计数；本页是人工核验的读数，不是 RuntimeEvidence；计数快照会漂移，引用前先重跑只读查询）
> 写法：按 PRD 4.0 L2 §5 的四问填写——做了什么（四态：未做 / 可运行 / 已验证 / 已验收）、证据、谁验收、怎么回退。四态口径（PRD 4.0 L0 §9.3「4.0 新锁定」的 `D-029`，与待拍板项 `PRD4-D<n>` 不是同一编号序列）尚未逐条拍板，本页先按它组织。2026-09-20 核验的旧版正文见文末[历史](#历史2026-09-20-核验)。

## 一页结论

当前 Release 是 **RL1 线索试点**：一个 ICP（德国 / DACH 工业泵进口商与分销商）、一个国家、一个品类，Managed 周报交付，目标是拿到第一个人工 QGO 判断并记下每条线索的成本。产品负责人 2026-10-10 批准按 PRD 4.0 开发（「同意，继续，需要闭环，按照 prd 中的需求进行开发实施」）。

**2026-11-04 复核：主链路已跑出首个 `DONE` 终态 run，Phase 1 已上线。本段是唯一计数快照（2026-11-04T01:40Z），之后引用请重跑只读查询，不在其他章节复制计数。** xin 上 `discovery_run` 39 行：`DONE` 1（首次非失败终态，2026-11-03 02:07 `5e7401f6`）、`PARTIAL` 13、`FAILED` 25；11-03 之后新增的 3 条 run 均以 FAILED 收尾。`lead` 6 212 行：recommended 63、needs_review 3 345、rejected 2 717、sanctions_hold 87；其中 21 条已被客户接受（QUALIFIED），DISCOVERED（未评分）138。具名个人数据：`canonical_contact` 129、`contact_point` 134、`company_contact_point` 280（联系人线 M1–M4 落地）。`outbox_delivery` 475 行 ACKED、49 行 PENDING（11-04 读数；消费者按 2 分钟一轮消费，PENDING 属在途，不构成交付结论）。`company_profile` 8 ACTIVE / 17 REVIEW / 28 ENRICHING / 35 DRAFT；`icp_definition` 50（ACTIVE 49、HYPOTHESIS 1）；gain-saas 侧 7 users / 10 workspace / 5 membership（2026-11-03 读数，未复验）。

**2026-11-02 Phase 1a 安全热修已上线**（运行镜像 `a428afab`→`a12503e6`→`36412147`，均为历史批次；当前以 `runtime.compose.env` 为准）：#737 intake 同事务消费执行授权并写 `CompanyProfileCreated` v2（缺授权显式 `understanding: not_started`）、JWKS 拉取有界（2s/64KiB）、`POST /site-builder/intake` 纳入技术报价；#736 拒答不再进入 rejected 队列（weak/unjudged，含事故原文单测）；#739 trade_fair 按展会注册表裁剪；#740 model 侧投影拒绝与联系人回执混合态修复；gain-saas #30 关闭 settlement-readback 开放代理、登录/注册限流落库；Postgres `pg_hba` 移除 127.0.0.1 trust 改 scram。**R4 平台权威已在 gain-saas**（2026-10-31 迁移完成、GrowthOS 当日退役），撤销投递链 2026-11-01 用真实 Grant 实测打通（含自动触发与受审计重开，见证据页）；4 个平台 schedule 仍全部 paused，unpause 是产品负责人的单独决定。

**2026-11-03 Phase 1 已上线并验收**（运行镜像 `36412147`，build `5a526747`，带迁移 `20261102170000_phase1_seller_sourcing_fields`；gain-saas #32/#33/#34 同批部署）：`POST /companies` 支持无官网建档与 `industry/targetMarkets/products/businessEmail`（products 落 `Offering(source=onboarding)`），无官网不发理解事件、不消费 Grant；gain-saas 注册后强制三步引导向导（中英双语）、`GET /api/workspace/context`、BFF `ONBOARDING_INCOMPLETE` 门禁、注册页「创建账号」口径与邀请码按配置显隐、头部工作空间切换器。端到端验收（有官网/无官网/门禁/重复提交）通过，记录在 `_archive/backend-runtime-switch-5a526747-xin-20261102/README.md`。

**2026-11-08 AI 底座 S0（M1 并行泳道，非客户可见）**：技能运行时 v0 随本批 PR 进入 main——SKILL.md 包规范 v0 与校验器、`skill_package`/`skill_version`/`skill_enablement`/`skill_resolution_snapshot` 四表（FORCE RLS；版本与快照 append-only）、三个存量技能（`company.understanding.extract` / `company.understanding.extract_offerings` / `discovery.qualify_fit`）经直通 adapter 执行、ops 启停（引擎 API）。执行输入与预算逐字节不变；**已于 2026-11-07 发车**（镜像 `1982a551` / 源码 `99845741`，带迁移硬窗口）：四表入库、readiness 与基线一致，E2E Part 1 全绿，Part 2/3 证据由主会话回填发车归档。S1-1/S1-2（Pack schema/内容目录/冲突裁决/Golden Set 骨架；Pack 七表/策略解析快照/skill-kind/pack seed）已入 main，S1-3/S1-4 待做。设计：`docs/superpowers/plans/2026-11-08-skill-runtime-s0.md`；模块文档：`docs/modules/ai-foundation/`。

仍未达成：首个 `DONE` run 出现在 11-03，但**试点交付节奏**与**邮箱/电话覆盖**仍未达成（最近一次常规 run 的联系人阶段 0 邮箱/0 电话，社交源 blocked/circuit；`email_guess` 2026-11-02 已按 D3 重开，等下一轮带 match 的 run 验证）。逐项见下表。

## 1. RL1 主链：做了什么、证据、谁验收、怎么回退

| 项 | 做了什么（四态） | 证据 | 谁验收 | 怎么回退 |
| --- | --- | --- | --- | --- |
| 发现 run（ICP → 查询计划 → run） | **可运行，部分验证**：当前计数见「一页结论」的 2026-11-04 快照（单一来源）；首个非失败终态 run 为 2026-11-03 02:07 `5e7401f6`；此前最近一次常规 run 2026-11-02（`3ad22469`）21/21 条查询、28 家公司、fit 4/4/20/1、零拒答。历史失败逐项见 §2 | `discovery_run` 只读查询（status、`stats`）；[联系人线设计稿 §十一](../superpowers/plans/2026-10-31-contact-discovery.md) | 产品负责人（RL1 内部验收） | 运行镜像按 digest 钉在 `local-config/global/runtime.compose.env`，每次换镜像的前后 digest 与验收记录在 `/global/_archive/backend-runtime-switch-*`；带迁移的窗口先 `pg_dump`，另有每日 `db-backup` |
| 评分与制裁第五门 | **已验证（有真实数据）**：`lead` 与队列计数见「一页结论」的 2026-11-04 快照（单一来源），其中 21 条已被客户接受（QUALIFIED）；`sanctions_screening_result` 28 行、三个制裁源 ENABLED | `lead`（status、queue、total_score）、`sanctions_screening_result`、`sanctions_source` 只读计数 | 产品负责人 | 评分是确定性重算、可重跑，不改源数据，规则版本写进快照 |
| 可达性与联系人（BI-14 / 联系人线 M1–M4） | **已验证（链路）；质量待验证**：`company_contact` ENABLED，`company_contact_point` 268 行公司级路径；联系人线 M1–M4 已上线（#703/#707/#709/#717/#728/#733/#734 + gain-saas #26/#27/#28），run 内联系人阶段覆盖全部 match 公司、$2 子预算封顶；当前 4 家 match 产出 38 个决策人、0 邮箱/0 电话（社交源 blocked 3 / circuit open 9）。`canonical_contact` 80、`contact_point` 61；`email_guess` 2026-11-02 按 D3 重开（双闸：lawfulBasis interim LIA + smtp_self），待验证 | `data_provider`、`canonical_contact`、`contact_point`、`company_contact_point` 只读查询；run `3ad22469` stats | 产品负责人 | `company_contact` / `email_guess` 置回 DISABLED |
| 交付最后一跳（`LeadQualified` → 事件 ACK） | **已验证**：`outbox_delivery` 468 行 `ACKED`（sink=saas），无 PENDING；事件由 gain-saas 消费者按 2 分钟一轮消费；GrowthOS 不再是消费方 | `outbox_delivery` 按 sink/status 计数 | 产品负责人 | 不涉及数据回退（事件只读交付） |
| 卖方自助入驻（understanding + 注册引导） | **可运行，部分验证**：`company_profile` 6 ACTIVE、13 REVIEW、28 ENRICHING、30 DRAFT；#722/#730 之后失败可见、可按 attempt 换新 Grant 重试，live 实测闭环（[证据](../evidence/README.md)）；#737 修复 intake 创建档案后不发 `CompanyProfileCreated` 的断链；**Phase 1（#743 + gain-saas #32）**：`POST /companies` 支持无官网建档与六项引导事实（`targetMarkets`/`businessEmail` 落库、products→`Offering(source=onboarding)`），gain-saas 注册后强制三步向导、BFF 门禁 409 `ONBOARDING_INCOMPLETE`，端到端验收通过 | `company_profile`/`offering` 只读查询；`_archive/backend-runtime-switch-5a526747-xin-20261102/README.md` | 产品负责人 | 修复随镜像回退（列保留无害） |
| 交付包 v1.1、周报 CSV、反馈端点、Golden Set（BI-19–BI-24） | **部分完成**：周报 CSV（#650，BI-22；#729 增加决策人列）与反馈端点（BI-23）已上线并在真实数据上导出；LeadPackage v1.1（#681）已上线；Golden Set 仍未做 | 仓内 `/reports/weekly` 与 `/reports/weekly/feedback` 已注册；Golden Set 不在仓内 | 产品负责人；design partner（商机，PRD4-D8 未定人选） | — |

运行时：xin 的 API / Worker / platform Worker 的运行镜像以 `local-config/global/runtime.compose.env` 的 `GLOBAL_BACKEND_IMAGE` 为准（2026-11-04 核验：`sha256:e2cfa8cc…`），本页不复写 digest；历史切换归档见 `_archive/backend-runtime-switch-*`。`origin/main` 已到 `8b142f53`（#762，seller-documents 上传中继）。获客模型：抽取档 `gemini-3.8-flash`、推理档 `gpt-5.6-sol`，任务级覆盖 `taxonomy.normalize→deepseek-flash`、`discovery.qualify_fit→gemini-3.8-flash`（2026-11-02 因 `gpt-5.6-sol` 内容拒答切换，护栏 #736 已同版上线）。

身份分工（2026-11-02 核实）：产品登录/身份与 **R4 平台权威**都在 **gain-saas**——`AUTH_ISSUER`/`AUTH_JWKS_URI` = `https://127.0.0.1:18446`；机器 token / capability / Temporal 运行时 JWKS 指向 gain-saas mTLS 端点 `https://172.20.0.1:18447/…`；GrowthOS 九容器已于 2026-10-31 退役（卷保留作回退）。`CAPABILITY_MACHINE_ISSUER`/`TEMPORAL_MACHINE_ISSUER`/`PLATFORM_TECHNICAL_QUOTE_AUTH_ISSUER` 的字符串仍写作 `…:18444/…` 是**故意**的：引擎逐字节比对 `iss`，gain-saas 按同一字符串签发。

## 2. 历史验收 run 记录（2026-10-08 → 10-13，11 次全部 FAILED）

> 下表是当时的失败归因，保留作证据；**当前计数以「一页结论」的 2026-11-04 快照为准**，本表不复写计数。

| 卖方 | run | 启动（UTC） | 倒在 | 直接原因 | 修复 |
| --- | --- | --- | --- | --- | --- |
| #14 | `e182794c` | 10-08 19:28 | 查询 | 所有模型输出失败都被判成控制错误 | #610 |
| #15 | `e269a2ba` | 10-09 07:27 | 查询 | `searxng.search` 输出不符合持久契约 | #611 |
| #16 | `733fbf03` | 10-09 09:42 | 查询 | 21 条公开网页记录全被 Raw 源治理拒收；Grant 约 6 分钟过期；公司官网无源策略 | #615、#617、#618 |
| #20 | `322866ef` | 10-11 19:02 | 查询（7/14） | 一次抽取输出被截断，整份血缘作废 | #638 |
| #21 | `5740150c` | 10-12 10:55 | 查询（11/16） | 一次 SSE 流中断 | #639 |
| #22 | `6f2d0871` | 10-12 17:21 | fit（51 家） | 一个活动判 51 家，超过 15 分钟时限 | #640 |
| #23 | `c3878e54` | 10-12 22:47 | 信号（86 家） | `http-get/v1` 产物没能存下，重试撞同一操作 | #641（跳过并计数）；根因见 #28 |
| #25 | `57529327` | 10-13 08:22 | 查询（5/16） | 抽取流里带上游错误事件，重试撞同一操作 | #642 |
| #26 | `3e78eb4e` | 10-13 11:36 | 查询（1/16） | 词表归一遇上游 503，同一个词的操作键被 16 条查询共用 | #645（未上线） |
| #27 | `5abe5584` | 10-13 12:25 | 物化（9/10 条查询完成） | 失败的查询没有回执，物化准入扣住 run | #643 |
| #28 | `3afe9c46` | 10-13 15:43 | 信号（44 家） | 连续两家 `http-get/v1` 产物被判 `GENERIC_OPERATION_ARTIFACT_INVALID`：careers 探测的空产物撞上 `crawl4ai-fetch/v1` 存过的同字节空对象 | #644（未上线） |

前三行是 10-08/09 旧镜像上的试跑，10-09 经产品负责人授权清理时统一记 FAILED（`/global/_archive/discovery-run-cleanup-xin-20261009/`）；10-11 起的八行是正式验收。另有两次没有开出 run：卖方 #19 的 ICP 调用被上游换成 Flash、身份闸门拒收（D14 之前）；卖方 #24 的查询计划被上游内容过滤，API 报裸 500（#646 在途改为 502 `MODEL_UPSTREAM_UNUSABLE`），同一 ICP 重试报 409 `EXECUTION_BUDGET_GRANT_REUSED`。验收期间上游（OpenOx）失败率：10-13 截至 12:55 UTC 约 3.9%（206 次中 8 次），10-11 至 10-12 约 0.35%（867 次中 3 次）。

失败后的完整重试（PRD4-D13 根治）已并入 2026-11-02 拍板的「任务对象 + 重试」工作流（rerun = 新 run/新 Grant，引擎 `POST /query-plans/:planId/rerun`）；在此之前，同一计划、同一主体的 Grant 只能用一次，失败就换卖方。2026-11-02 已新增一条现实约束的缓解：理解流程重试按 attemptId 换新 Grant（#730）。

## 3. 生效的决定（2026-10-10 起）

PRD 4.0 待拍板项 D1–D19 的全量状态见[冲突与开放决策登记](../governance/conflict-register.md)；已生效的承重决定登记在 [ADR registry](../adr/registry.md) 的 `PRD4-` 一节。为避免与 Site Builder 线的 D9/D13 混淆，本页一律写 `PRD4-D<n>`。

| 决定 | 当前事实 | 怎么回退 |
| --- | --- | --- |
| PRD4-D2 冻结 R4（2026-10-10，**2026-10-31 重开并当日完成迁移**） | 冻结期间不追加 R4 投入、4 个平台 schedule 保持 paused、每次换镜像仍续 7 天绑定。**2026-10-31 产品负责人重开**：唯一目的是把平台权威从 GrowthOS 迁到 gain-saas——当日完成，GrowthOS 九容器退役（卷保留）。撤销投递链现状：gain-saas 签发 → 后端接收（RS256 JWS）→ fence 提交 → ACK 验签已用真实 committed Grant 实测通过（[证据](../evidence/2026-11-01-platform-admission-v2-and-revocation-fence.md)）；自动触发已接线并在 dev 开启，绑定撤销 → 自动请求 → 真实 Grant → fence → ACK → 受审计重开全链实测（[live 证据](../evidence/2026-11-01-platform-revocation-autotrigger-live.md)），`BLOCKED_PENDING_BACKEND_4A4` 不再成立 | 重开只恢复「迁移」这一项投入；平台运行准入的写入者授权缺口（L4-G23）已于 2026-11-01 随准入 v2 上线闭合；恢复平台 schedule（unpause）仍是产品负责人的单独决定 |
| PRD4-D3 客户写入准入与 platform Worker 就绪解耦（2026-10-10） | #627 已合并，2026-10-11 上线：客户写入按客户依赖集合判定，platform Worker 恰为 `PLATFORM_WORKER_NOT_READY` 时不再关闭客户写入；`/health/ready` 的整体口径不变 | 换回 #627 之前的镜像 |
| PRD4-D9 制裁名单与职能邮箱（2026-10-10，部分拍板） | 制裁名单走运营刷新（#629，不经平台 schedule），三个源 ENABLED（OFAC SDN、OFAC Consolidated、EU FSF，约 1.2 万条实体）；职能邮箱按 BI-14 做公司级（#630；`company_contact` 现已 ENABLED 并在 run 内产出公司级路径）。LIA 时机未定（D6 页面待排期） | `sanctions_source` 置 DISABLED |
| PRD4-D14 模型供应（2026-10-11） | #633：11 个获客任务照旧请求 pro 档，上游换成 Flash 档时也接受，trace 与账本如实记为 Flash；建站等其他任务仍只认 pro。xin 已打开 `MODEL_IDENTITY_SUBSTITUTES`。官方备用上游未接 | 关掉 `MODEL_IDENTITY_SUBSTITUTES` |
| PRD4-D16 个人数据路径保持现状（2026-10-11） | `decision_maker`、`companies_house`、`inpi_rne`、`smtp_self` 保持 ENABLED，展会 Algolia 来源保留，产品负责人风险自担；验收 run 存下个人数据不再停止，改为如实计数并注明来源。个人数据三张表已有真实行：`canonical_contact` 80、`contact_point` 61、`company_contact_point` 268 | 把相应 `data_provider` 置 DISABLED |
| 联系人线 D1–D8（2026-10-31 / 11-01 拍板） | M1–M4 已上线（run 内接线、社媒三层降级、邮箱补全双闸、gain-saas 决策人卡片）；M5 Golden Set 未开始；`email_guess` 2026-11-02 按 D3 重开、待验证。权威设计稿[§十一](../superpowers/plans/2026-10-31-contact-discovery.md) 是这条线唯一总文档 | 置回对应 provider DISABLED |
| 2026-11-02 操作决定 | ① trade_fair 零结果根因=注册表只覆盖钣金展会；拍板「planner 按注册表裁剪」（PR #739，Docker 会话执行）；② `email_guess` 重开（D3 已于 11-01 批准）；③「已执行方案可重跑」立项，并入发布线的任务/重试工作流（Phase 4）；④ new-api 的 gemini 上游 5 并发是寻源慢的根因，待产品负责人提供新密钥/渠道后扩容；⑤ natfrp 穿透保持现状（产品负责人决定，不限制不关闭） | ①②置回开关；③不移交则忽略 |

## 4. 在途工作（2026-11-03 GitHub 回读）

无在途 PR（2026-11-03 03:35Z 回读为 0）。近期已合并：#735（模块文档）、#736（拒答护栏）、#737（Phase 1a 热修）、#738（联系人线状态）、#739（trade_fair 裁剪）、#740（fail-closed 残留）、#743（Phase 1 卖家事实字段）、#744/#745（联系人同名排除与 attemptId 客户端透传）。

历史任务卡（A 快速通道、B `gctl switch-backend`、D 查询活动无回执、E 卖方入驻 HOLD）均已合并或随演进取代；#597 已于 2026-10 合并（ICP 重试仅在未触达上游时允许）。

## 5. 下一步与需要的决定

按分阶段验收推进（2026-11-02 产品负责人批准）：

1. **Phase 0 已完成**：本页 11-02 基线、`docs/modules/*` 与实现矩阵（#735）、`docs/status/release-plan.md` 承接迁移与历史文档定位（#741）。
2. **Phase 1 已上线并验收（2026-11-03）**：租户/工作空间合同、注册引导向导与门禁、引擎卖家事实字段（#743 + gain-saas #32/#33/#34，带迁移发布）。
3. **Phase 2 进行中**：卖家资料库 MVP（seller_document/seller_document_chunk、独立 bucket、presign/commit、Docling→分块→BGE-M3→pgvector 检索、前端资料库 tab）；**Phase 2b** 寻源性能改造与 Phase 2 并行（首批线索 ≤10 分钟、25 家 ≤30 分钟）。
4. Phase 4「任务对象 + 重试」已立项（含 retry-account 放宽设计评估），排在 Phase 2 之后。

需要产品负责人拍板的：M5 Golden Set 取样口径（20 家名单）；D6 per-tenant LIA 采集页排期；D8 开源融合顺序（theHarvester/social-analyzer、JobSpy、Trafilatura、Common Crawl、跨进程熔断）；`google_patents` 启用条件（等 patent cache 刷新恢复 + BQ 实测）；平台 4 个 schedule 是否恢复运行；`secrets-backup` 交互执行与异地副本；new-api gemini 渠道扩容（换密钥/加渠道）；PRD4-D1（Site Builder 正式冻结）、PRD4-D4/D19（文档各有两案）、PRD4-D12（流程瘦身，晋级门死锁）、PRD4-D8（design partner 人选）等既有待拍板项不变。

## 6. 不变的边界与工程门

- 源码合入、单测或 CI 通过不等于运行采用；xin 的运行观察不是 RuntimeEvidence，也不产生可信 Release Bundle。
- Billing/Credits 保持 `DEFERRED / NOT_IMPLEMENTED`；`cap_microusd` 是一次执行的技术安全上界，不是客户余额。正常产品请求的费用权威是 SaaS 签发的 Budget Grant，与开发者 ad-hoc 调用授权保持分离。
- 当前非运行时模型候选合同仍为 `site-builder-model-candidate-baseline/2026-08-07-v3`，详见[生成页](../site-builder/model-candidate-baseline.md)；它不等于 active route、质量证明或真实 dispatch 授权。
- 发送仍未开放：RL1 不做任何发送，触达属于 RL4。
- `PILOT`/`GA` 晋级门目前不可达：AGENTS §7 要求可信外部 readback，而仓内原有的 approval/readback 回读器已由 #566 移除，`scripts/governance-delivery-contracts.mjs` 对任何晋级状态恒阻断。这是已知死锁，是否改为产品负责人签字待 PRD4-D12 拍板。

工程门 G0–G7 的定义见[发布路线](../status/release-plan.md)。自 2026-09-20 核验以来没有任何一道门晋级，下表的裁决不变，所缺证据按当前事实改写：

| Gate | 当前裁决 | 所缺证据 |
| --- | --- | --- |
| G0 — Truth & Ownership | PARTIAL | 权威文档已回写到 2026-11 决定；PRD 4.0 仍只在私有目录（PRD4-D10 未拍板），不是仓内权威 |
| G1 — Product/UX/Contract | PARTIAL | 周报 CSV 与反馈端点已有机器合同（#650/#729）；交付包 v1.1 合同、可达性口径写入产品范围仍待补 |
| G2 — Source/TDD/Security | PARTIAL / MERGED_FIXES_VERIFIED | 每个修复 PR 自带 TDD 与必需检查；不推广到未改动的模块 |
| G3 — Integration/Data | PARTIAL / PRODUCT_E2E_PARTIAL | 13 次 PARTIAL + 首次 `DONE` run（11-03）；真实评分与 ACK 计数见「一页结论」；`DONE` 之外的 run 仍以 PARTIAL/FAILED 收尾 |
| G4 — Release Candidate | DEVELOPMENT_CANDIDATE_ONLY | xin 运行的是按 digest 钉住、带构建证明的开发镜像；没有可信外部 provenance readback |
| G5-Site — Runtime Observed | HISTORICAL_ONLY | Site 线未推进（PRD4-D1 未拍板）；历史观察不可晋级 |
| G5-Acquisition — Runtime Observed | NOT_VERIFIED | 有首次 `DONE` run，但没有当前 RuntimeEvidence（普通 run 观察不构成 RuntimeEvidence PASS） |
| G6 — UAT Accepted | NOT_RUN | RL1 退出指标：推荐队列计数见「一页结论」（目标 ≥15 已达），`DONE` run 与 design partner 回填仍未达成 |
| G7 — Pilot/GA Authorized | NOT_AUTHORIZED | 晋级门当前不可达（见上一条死锁）；也没有产品授权 |

相同动作、目标和范围的有效授权继续沿用。源码 / PR 合入不自动授权生产部署、保留数据库迁移、凭据与端口修改、付费调用或 Pilot/GA。

## 历史（2026-09-20 核验）

2026-09-20 核验的旧版正文——源码与候选、Program A/B/C 所有权、阶段门的原裁决与所缺证据、运行与发布证据、PR / 分支 / worktree 处置，以及其后不刷新核验的 §4.1 宿主迁移、§4.2 R4 平台命名空间授权缺口、§4.3 远端分支清理、§4.4 客户写入准入解耦与旧「下一顺序」——已原文移至[归档](../archive/status/current-20260920.md)，不代表当前状态。其中 R4 的推进项已由 PRD4-D2 冻结取代（该冻结又于 2026-10-31 重开并完成迁移）；#538 与 #515 已于 2026-10-06 关闭。

下面这条历史事实仍需在本页可见：

历史费用记录保持 UNKNOWN/unknown：attempts 1–5 为 UNRESOLVED，attempt 6 为 EXPIRED，reservation/conservative charge 均为 `800000`；EXPIRED 不产生有效输出或精确费用，继续不重发。完整脱敏字段见 [2026-09-04 platform-writer successor runtime readback](../evidence/site-builder/production-parity-platform-writer-runtime-readback-20260904.json)；20260901 predecessor 保持 historical provenance。GrowthOS 2026-09-01 historical provenance 也不能代替当前 authority source。源码修复、disposable 测试或当前文档不能改写历史物理调用和 ACK 事实。
