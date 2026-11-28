# 当前状态与下一决策

> 文档 ID：`DOC-STATUS-001`
> 生命周期：`CURRENT`
> 状态：`CURRENT`
> 当前事实来源：[产品范围](../product-scope.md)、[当前架构](../architecture/current.md)、[ADR registry](../adr/registry.md)、[发布路线](../status/release-plan.md)、[冲突与开放决策登记](../governance/conflict-register.md)，以及本页逐项注明的 Git/GitHub 回读与 xin `global_dev` 只读查询
> 最后核验：2026-11-28（以 `backend@a5ef77f64a240129c49cb14d187db40cdaae385e` 与 `gain-saas@ff45fa404701532785e41706dddfb9455701a50d` 核对源码、2026-11-28 CST 时点运行/CI 观测与受控证据基线；折叠区及 11-27 以前的历史计数与验收仍以原记录时间为准）。
> 写法：按 PRD 4.0 L2 §5 的四问填写——做了什么（四态：未做 / 可运行 / 已验证 / 已验收）、证据、谁验收、怎么回退。四态口径（PRD 4.0 L0 §9.3「4.0 新锁定」的 `D-029`，与待拍板项 `PRD4-D<n>` 不是同一编号序列）尚未逐条拍板，本页先按它组织。2026-09-20 核验的旧版正文见文末[历史](#历史2026-09-20-核验)。

## 一页结论

| 事项 | 核验结论 | 来源 |
| --- | --- | --- |
| 已合入源码 | 企业资料分片与后续解析、共享绿色事实域、个人数据加密 v2、流式寻源旁路与终态事件、平台授权轻量模式、建站按开关加载 | [changelog 片段](../roadmap/changelog.d/) · [实现状态](implementation-matrix.md) |
| 获客与渠道增量（截至 `a5ef77f6` / #1156） | 2026-11-27 起合入展会目录通用抽取、Wave 1 联系人证据与租约停轮询、英澳巴注册库导入、Google Places 源、寻源 v3 来源/联系人/实收回执（#1141）；2026-11-28 合入 L0.5 缺域补官网与 24h 缓存、平台监控自动纳管、API/Worker 容器健康检查、决策人邮箱双正验真漏斗、fit-v3 Prompt Caching、去帽每源查询预算修复与 ISO2 国家码规范化（#1152–#1156） | [去帽与国别修复](../roadmap/changelog.d/2026-11-28-query-plan-uncapped-budget-and-country-norm.md) · [缓存与健康检查](../roadmap/changelog.d/2026-11-28-prompt-cache-golden-eval-healthchecks.md) · [邮箱验真漏斗](../roadmap/changelog.d/2026-11-28-enrichment-valid-email-funnel.md) · [L0.5 与缓存](../roadmap/changelog.d/2026-11-28-l05-domain-resolution-and-24h-cache.md) · [L0.5 精度与监控](../roadmap/changelog.d/2026-11-28-l05-precision-and-platform-watch-handoff.md) |
| 主线 CI 与制品发布（2026-11-28 观测） | `backend@a5ef77f6`（#1156）合入后 main push CI 两项失败：`postgres semantics · permissions`（`Runtime lease principal PostgreSQL permissions` 步骤中 native Discovery v3 厂家证据计数期望 1、实际 0，见 [断言](../../apps/api/src/discovery/discovery-v3-operations.postgres.spec.ts)）与汇总检查；同 Git tree `87d57a00…` 在 PR #1156 合入前对应检查通过。同一提交的手动受保护容器镜像发布检查单独通过。**镜像发布与服务就绪不能关闭主线 CI 失败**，根因待隔离复验 | GitHub Actions 只读回读 [PR 对应检查](https://github.com/mlhjyx/global-backend/actions/runs/46064120174/job/140725299586)、[main 失败检查](https://github.com/mlhjyx/global-backend/actions/runs/46064949689/job/140727974608) 与 [main 汇总检查](https://github.com/mlhjyx/global-backend/actions/runs/46064949689/job/140729122386)；[待验证台账](pending-verification.md) `PV-004` |
| 验收覆盖 | 获客验收 F1–F12 接入实际源码的合成数据入口，F13–F15 保留设计自检。`a5ef77f6` + `ff45fa4` 候选组合尚未完成正常用户端到端验收；多租户、Temporal、SaaS 投影与正式试点仍需核验 | [验收口径](../roadmap/changelog.d/2026-11-27-e2e-precision-intel.md) · [待验证台账](pending-verification.md) `PV-006` |
| xin 运行观察（2026-11-28 CST 时点读回） | 04:58 CST 切换前为 `1085d5a2…`（镜像 `sha256:a06247b6…`）；05:05:30 CST 切换后及 05:33 CST 复核：API / Worker / platform Worker 三容器均 `running / healthy`，OCI revision `a5ef77f64a240129c49cb14d187db40cdaae385e`、镜像 `sha256:50b3ff38dd630f0672a3aba11d9e63b5f61bded8a91c6291cfc1b45403390b9a`、`/health/build` `attested`（artifact digest `sha256:5adacdd9…`、`migration_revision=20261127180000_google_places_discovery_provider`）、`/api/v1/health/ready` 返回 `200/ready`（05:20 与 05:33 均观测 16/16 硬组件 `ok`）。受管范围观测到 PostgreSQL Temporal 三组件运行，未见旧 SQLite Temporal 容器（旧历史排空与三方路由未单独取证）。仅代表观测时点，不等于实时状态或用户验收 | 2026-11-28 CST 镜像 OCI revision、`/health/build`、`/api/v1/health/ready` 与容器状态只读回读 |
| 跨仓交付与现役边界 | `gain-saas` 是现役 SaaS 前端和控制面。2026-11-28 Web 与 Worker 于 04:45:01 CST 启动，制品为 `gain-saas-ff45fa4-20261128`，05:33 CST 复核 readiness 为 `200/ok`。详细运行与开关读回见 SaaS 状态。SaaS 实现 Program C 入箱、投影及 ACK，持有现役 QGO/SAO/Outcome 和钱包源码。禁联有五条 SaaS 管理员 BFF 路由，Backend 的 `GET /suppressions` 校验 `compliance:manage` 且仅读取当前工作空间。隔离事件运营恢复、v3 切换所需的 API 绑定、SaaS 合同、`QUEUED` 终态投影和非模型成本聚合仍待处理。`SiteBuildCostSummaryUpdated` 的微美元字符串与 SaaS `budget.spentCents` 待对账 | [终态回传变更](../roadmap/changelog.d/2026-11-27-fix-discovery-bypass-lease-and-completed-event.md) · [gain-saas 当前状态](https://github.com/mlhjyx/gain-saas/blob/main/docs/status/current.md) · [gain-saas 现役产品说明](https://github.com/mlhjyx/gain-saas/blob/main/apps/web/PRODUCT.md) |
| 受控证据与追踪基线（2026-11-28） | 仓内 `docs/evidence/runtime/` 6 份 RuntimeEvidence（`valid_until` 均为 2026-09-02 或 09-05）均已过期自动降为 `HISTORICAL`；`docs/releases/` 3 份 Release Bundle 均为 `CANDIDATE` / `EXTERNAL_UNVERIFIED`；`docs/governance/delivery-traceability.json` 13 条追踪链全部为 `INTERNAL_ONLY` | [证据索引](../evidence/README.md) · [追踪登记](../governance/delivery-traceability.json) |
| 尚待核验 | `#1156` main push CI 失败根因、Discovery v3 成组切换前提、正常用户九条旅程验收、现网钱包/触达开关与商业规则、Temporal 历史排空、平台 `internal_db` 采用与个人数据访问审计保留候选边界 | [运行开关](../architecture/current.md#运行模式与开关) · [待验证台账](pending-verification.md) |

RL1 试点范围、G0–G7 定义和退出条件见 [发布路线](release-plan.md)。下面保留此前验收和决策记录，业务计数须按实际使用环境和口径重新核验。

<details>
<summary>历史交付记录与 2026-11-04 至 11-12 读数</summary>

当前 Release 是 **RL1 线索试点**：一个 ICP（德国 / DACH 工业泵进口商与分销商）、一个国家、一个品类，Managed 周报交付，目标是拿到第一个人工 QGO 判断并记下每条线索的成本。产品负责人 2026-10-10 批准按 PRD 4.0 开发（「同意，继续，需要闭环，按照 prd 中的需求进行开发实施」）。

**2026-11-04 复核：主链路已跑出首个 `DONE` 终态 run，Phase 1 已上线。本段是唯一计数快照（2026-11-04T01:40Z），之后引用请重跑只读查询，不在其他章节复制计数。** xin 上 `discovery_run` 39 行：`DONE` 1（首次非失败终态，2026-11-03 02:07 `5e7401f6`）、`PARTIAL` 13、`FAILED` 25；11-03 之后新增的 3 条 run 均以 FAILED 收尾。`lead` 6 212 行：recommended 63、needs_review 3 345、rejected 2 717、sanctions_hold 87；其中 21 条已被客户接受（QUALIFIED），DISCOVERED（未评分）138。具名个人数据：`canonical_contact` 129、`contact_point` 134、`company_contact_point` 280（联系人线 M1–M4 落地）。`outbox_delivery` 475 行 ACKED、49 行 PENDING（11-04 读数；消费者按 2 分钟一轮消费，PENDING 属在途，不构成交付结论）。`company_profile` 8 ACTIVE / 17 REVIEW / 28 ENRICHING / 35 DRAFT；`icp_definition` 50（ACTIVE 49、HYPOTHESIS 1）；gain-saas 侧 7 users / 10 workspace / 5 membership（2026-11-03 读数，未复验）。

**2026-11-02 Phase 1a 安全热修已上线**（运行镜像 `a428afab`→`a12503e6`→`36412147`，均为历史批次；当前以 `runtime.compose.env` 为准）：#737 intake 同事务消费执行授权并写 `CompanyProfileCreated` v2（缺授权显式 `understanding: not_started`）、JWKS 拉取有界（2s/64KiB）、`POST /site-builder/intake` 纳入技术报价；#736 拒答不再进入 rejected 队列（weak/unjudged，含事故原文单测）；#739 trade_fair 按展会注册表裁剪；#740 model 侧投影拒绝与联系人回执混合态修复；gain-saas #30 关闭 settlement-readback 开放代理、登录/注册限流落库；Postgres `pg_hba` 移除 127.0.0.1 trust 改 scram。**R4 平台权威已在 gain-saas**（2026-10-31 迁移完成、GrowthOS 当日退役），撤销投递链 2026-11-01 用真实 Grant 实测打通（含自动触发与受审计重开，见证据页）；4 个平台 schedule 仍全部 paused，unpause 是产品负责人的单独决定。

**2026-11-03 Phase 1 已上线并验收**（运行镜像 `36412147`，build `5a526747`，带迁移 `20261102170000_phase1_seller_sourcing_fields`；gain-saas #32/#33/#34 同批部署）：`POST /companies` 支持无官网建档与 `industry/targetMarkets/products/businessEmail`（products 落 `Offering(source=onboarding)`），无官网不发理解事件、不消费 Grant；gain-saas 注册后强制三步引导向导（中英双语）、`GET /api/workspace/context`、BFF `ONBOARDING_INCOMPLETE` 门禁、注册页「创建账号」口径与邀请码按配置显隐、头部工作空间切换器。端到端验收（有官网/无官网/门禁/重复提交）通过，记录在 `_archive/backend-runtime-switch-5a526747-xin-20261102/README.md`。

**2026-11-08 AI 底座 S0（M1 并行泳道，非客户可见）**：技能运行时 v0 随本批 PR 进入 main——SKILL.md 包规范 v0 与校验器、`skill_package`/`skill_version`/`skill_enablement`/`skill_resolution_snapshot` 四表（FORCE RLS；版本与快照 append-only）、三个存量技能（`company.understanding.extract` / `company.understanding.extract_offerings` / `discovery.qualify_fit`）经直通 adapter 执行、ops 启停（引擎 API）。执行输入与预算逐字节不变；**已于 2026-11-07 发车**（镜像 `1982a551` / 源码 `99845741`，带迁移硬窗口）：四表入库、readiness 与基线一致，E2E Part 1 全绿，Part 2/3 证据由主会话回填发车归档。S1-1/S1-2/S1-3（Pack schema/内容目录/冲突裁决/Golden Set 骨架；Pack 七表/策略解析快照/skill-kind/pack seed；Pack Studio/评测回执/发布门）与 S1-4（制裁筛查与 Incoterms 报价两个确定性服务技能、导入 A 档 2 个衍生技能、Golden Set CI 层）已全部入 main，**S1-2 起的表与 seed 待随下一次发车部署**。设计：`docs/superpowers/plans/2026-11-08-skill-runtime-s0.md`；模块文档：`docs/modules/ai-foundation/`。

**2026-11-08 M2（PRD 对齐）收官**：能力 2 Campaign 控制面（M2.0 契约、M2.1 只审不执行的影子审批 UI、M2.2 有界重规划与指标闭环）、能力 4 QGO/SAO/Opportunity/Outcome、能力 3 受控邮件触达（批次/草稿/L2 审批门/逐封发送门/审计包/DNC/退订/回复即停）、能力 5 归因对账、S2 触达技能与 L2 审批门、P6 前端主链路（Playwright 11 用例 + 移动端冒烟 + 视觉基线，零术语 lint 在 CI）、双 agent 编排 v0（源侦察/资格判定在真实市场并行寻源）全部上线并有部署态验收证据：`docs/evidence/2026-11-08-m2-acceptance.md`（汇编）、`2026-11-08-m2-2-acceptance.md`、`step13-l2-closure-20261108/`（基线 #899 + 修复后复跑 #900）、`outreach-11-x-gaps-20261108/`；SaaS 侧 PR 见 gain-saas #75/#78/#79/#80/#82/#89/#94/#104/#106/#107/#108/#111/#115/#116。**触达发送在生产默认关闭**（开关 + 回环白名单 + 逐封 L2 门）；真实域名 SPF/DKIM/DMARC 实检待产品负责人提供域名（D1②）。实现矩阵同日已回写。

仍未达成：首个 `DONE` run 出现在 11-03，但**试点交付节奏**与**邮箱/电话覆盖**仍未达成（最近一次常规 run 的联系人阶段 0 邮箱/0 电话，社交源 blocked/circuit；`email_guess` 2026-11-02 已按 D3 重开，等下一轮带 match 的 run 验证）。逐项见下表。

## 1. RL1 主链：做了什么、证据、谁验收、怎么回退

| 项 | 做了什么（四态） | 证据 | 谁验收 | 怎么回退 |
| --- | --- | --- | --- | --- |
| 发现 run（ICP → 查询计划 → run） | **可运行，部分验证**：当前计数见「一页结论」的 2026-11-04 快照（单一来源）；首个非失败终态 run 为 2026-11-03 02:07 `5e7401f6`；此前最近一次常规 run 2026-11-02（`3ad22469`）21/21 条查询、28 家公司、fit 4/4/20/1、零拒答。历史失败逐项见 §2 | `discovery_run` 只读查询（status、`stats`）；[联系人线设计稿 §十一](../superpowers/plans/2026-10-31-contact-discovery.md) | 产品负责人（RL1 内部验收） | 运行镜像按 digest 钉在 `local-config/global/runtime.compose.env`，每次换镜像的前后 digest 与验收记录在 `/global/_archive/backend-runtime-switch-*`；带迁移的窗口先 `pg_dump`，另有每日 `db-backup` |
| 评分与制裁第五门 | **已验证（有真实数据）**：`lead` 与队列计数见「一页结论」的 2026-11-04 快照（单一来源），其中 21 条已被客户接受（QUALIFIED）；`sanctions_screening_result` 28 行、三个制裁源 ENABLED | `lead`（status、queue、total_score）、`sanctions_screening_result`、`sanctions_source` 只读计数 | 产品负责人 | 评分是确定性重算、可重跑，不改源数据，规则版本写进快照 |
| 可达性与联系人（BI-14 / 联系人线 M1–M4） | **已验证（链路）；质量待验证**：`company_contact` ENABLED，`company_contact_point` 268 行公司级路径；联系人线 M1–M4 已上线（#703/#707/#709/#717/#728/#733/#734 + gain-saas #26/#27/#28），run 内联系人阶段覆盖全部 match 公司、$2 子预算封顶；当前 4 家 match 产出 38 个决策人、0 邮箱/0 电话（社交源 blocked 3 / circuit open 9）。`canonical_contact` 80、`contact_point` 61；`email_guess` 2026-11-02 按 D3 重开（双闸：lawfulBasis interim LIA + smtp_self），待验证 | `data_provider`、`canonical_contact`、`contact_point`、`company_contact_point` 只读查询；run `3ad22469` stats | 产品负责人 | `company_contact` / `email_guess` 置回 DISABLED |
| 交付最后一跳（`LeadQualified` → 事件 ACK） | **已验证**：`outbox_delivery` 468 行 `ACKED`（sink=saas），无 PENDING；事件由 gain-saas 消费者按 2 分钟一轮消费；GrowthOS 不再是消费方 | `outbox_delivery` 按 sink/status 计数 | 产品负责人 | 不涉及数据回退（事件只读交付） |
| 卖方自助入驻（understanding + 注册引导） | **可运行，部分验证**：`company_profile` 6 ACTIVE、13 REVIEW、28 ENRICHING、30 DRAFT；#722/#730 之后失败可见、可按 attempt 换新 Grant 重试，live 实测闭环（[证据](../evidence/README.md)）；#737 修复 intake 创建档案后不发 `CompanyProfileCreated` 的断链；**Phase 1（#743 + gain-saas #32）**：`POST /companies` 支持无官网建档与六项引导事实（`targetMarkets`/`businessEmail` 落库、products→`Offering(source=onboarding)`），gain-saas 注册后强制三步向导、BFF 门禁 409 `ONBOARDING_INCOMPLETE`，端到端验收通过 | `company_profile`/`offering` 只读查询；`_archive/backend-runtime-switch-5a526747-xin-20261102/README.md` | 产品负责人 | 修复随镜像回退（列保留无害） |
| 交付包 v1.1、周报 CSV、反馈端点、Golden Set（BI-19–BI-24） | **部分完成（引擎保留，SaaS 已取消）**：周报 CSV（#650，BI-22；#729 增加决策人列）与反馈端点（BI-23）曾在真实数据上导出；LeadPackage v1.1（#681）已上线；**SaaS 侧周报功能已于 2026-11-11 取消**（gain-saas `44a10a6`），引擎 `/reports/weekly` 与反馈端点保留但当前无消费者；Golden Set 仍未做 | 引擎端点仍注册；SaaS 路由已移除；Golden Set 不在仓内 | 产品负责人；design partner（商机，PRD4-D8 未定人选） | — |

运行时：xin 的 API / Worker / platform Worker 的运行镜像以 `local-config/global/runtime.compose.env` 的 `GLOBAL_BACKEND_IMAGE` 为准，本页不复写瞬时 digest 或主干 SHA；历史切换归档见 `_archive/backend-runtime-switch-*`。获客模型与任务级路由**一律以代码真值 `apps/api/src/model-gateway/task-registry.ts` 与 `apps/api/src/ai-tasks/judge-model-routing.ts` 为准**（注意：`judge-model-routing.ts` 已在启动阶段硬禁将 `discovery.qualify_fit` 路由至 `gemini-3.8-flash`，切勿按旧记录配置该覆盖，否则进程拒绝启动）。

身份分工（2026-11-02 核实）：产品登录/身份与 **R4 平台权威**都在 **gain-saas**——`AUTH_ISSUER`/`AUTH_JWKS_URI` = `https://127.0.0.1:18446`；机器 token / capability / Temporal 运行时 JWKS 指向 gain-saas mTLS 端点 `https://172.20.0.1:18447/…`；GrowthOS 九容器已于 2026-10-31 退役（卷保留作回退）。`CAPABILITY_MACHINE_ISSUER`/`TEMPORAL_MACHINE_ISSUER`/`PLATFORM_TECHNICAL_QUOTE_AUTH_ISSUER` 的字符串仍写作 `…:18444/…` 是**故意**的：引擎逐字节比对 `iss`，gain-saas 按同一字符串签发。

</details>

## 2. 历史验收 run 记录（2026-10-08 → 10-13，11 次全部 FAILED）

> 下表是当时的失败归因，保留作证据；**计数保留为「一页结论」的 2026-11-04 历史快照**，本表不复写计数。

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

| 决定 | 决议时的事实与后继 | 怎么回退 |
| --- | --- | --- |
| PRD4-D2 冻结 R4（2026-10-10，**2026-10-31 重开并当日完成迁移**） | 冻结期间不追加 R4 投入、4 个平台 schedule 保持 paused、每次换镜像仍续 7 天绑定。**2026-10-31 产品负责人重开**：唯一目的是把平台权威从 GrowthOS 迁到 gain-saas——当日完成，GrowthOS 九容器退役（卷保留）。撤销投递链现状：gain-saas 签发 → 后端接收（RS256 JWS）→ fence 提交 → ACK 验签已用真实 committed Grant 实测通过（[证据](../evidence/2026-11-01-platform-admission-v2-and-revocation-fence.md)）；自动触发曾在 dev 验证窗口开启，绑定撤销 → 自动请求 → 真实 Grant → fence → ACK → 受审计重开全链实测（[live 证据](../evidence/2026-11-01-platform-revocation-autotrigger-live.md)），`BLOCKED_PENDING_BACKEND_4A4` 不再成立 | 重开只恢复「迁移」这一项投入；平台运行准入的写入者授权缺口（L4-G23）已于 2026-11-01 随准入 v2 上线闭合；恢复平台 schedule（unpause）仍是产品负责人的单独决定 |
| PRD4-D3 客户写入准入与 platform Worker 就绪解耦（2026-10-10） | #627 已合并，2026-10-11 上线：客户写入按客户依赖集合判定，platform Worker 恰为 `PLATFORM_WORKER_NOT_READY` 时不再关闭客户写入；`/health/ready` 的整体口径不变 | 换回 #627 之前的镜像 |
| PRD4-D9 制裁名单与职能邮箱（2026-10-10，部分拍板） | 制裁名单走运营刷新（#629，不经平台 schedule），三个源 ENABLED（OFAC SDN、OFAC Consolidated、EU FSF，约 1.2 万条实体）；职能邮箱按 BI-14 做公司级（#630；`company_contact` 现已 ENABLED 并在 run 内产出公司级路径）。LIA 时机未定（D6 页面待排期） | `sanctions_source` 置 DISABLED |
| PRD4-D14 模型供应（2026-10-11） | #633：11 个获客任务照旧请求 pro 档，上游换成 Flash 档时也接受，trace 与账本如实记为 Flash；建站等其他任务仍只认 pro。xin 已打开 `MODEL_IDENTITY_SUBSTITUTES`。官方备用上游未接 | 关掉 `MODEL_IDENTITY_SUBSTITUTES` |
| PRD4-D16 个人数据路径保持现状（2026-10-11） | `decision_maker`、`companies_house`、`inpi_rne`、`smtp_self` 保持 ENABLED，展会 Algolia 来源保留，产品负责人风险自担；验收 run 存下个人数据不再停止，改为如实计数并注明来源。个人数据三张表已有真实行：`canonical_contact` 80、`contact_point` 61、`company_contact_point` 268 | 把相应 `data_provider` 置 DISABLED |
| OWNER-DECISION-2026-11-05 渠道记录 PII 明文延后（2026-11-05） | 渠道抓取记录 `source_channel_record` 的联系人字段明文存储（列注释 `PII_PENDING_ENCRYPTION`）；列级加密、Q25 访问审计、保留期与 Art.17 擦除按该决定延后。**后继**：2026-11-26 主线已合入渠道联系人列加密，当前实现见[数据平面](../architecture/current.md#3-数据平面与最小权限)；存量覆盖与 DSR 验证单独核对 | 无需回退（列不变）；启动加密时按迁移改造并补 DSR 覆盖 |
| 联系人线 D1–D8（2026-10-31 / 11-01 拍板） | M1–M4 已上线（run 内接线、社媒三层降级、邮箱补全双闸、gain-saas 决策人卡片）；M5 Golden Set 未开始；`email_guess` 2026-11-02 按 D3 重开、待验证。权威设计稿[§十一](../superpowers/plans/2026-10-31-contact-discovery.md) 是这条线唯一总文档 | 置回对应 provider DISABLED |
| 2026-11-02 操作决定 | ① trade_fair 零结果根因=注册表只覆盖钣金展会；拍板「planner 按注册表裁剪」（PR #739，Docker 会话执行）；② `email_guess` 重开（D3 已于 11-01 批准）；③「已执行方案可重跑」立项，并入发布线的任务/重试工作流（Phase 4）；④ new-api 的 gemini 上游 5 并发是寻源慢的根因，待产品负责人提供新密钥/渠道后扩容；⑤ natfrp 穿透保持现状（产品负责人决定，不限制不关闭） | ①②置回开关；③不移交则忽略 |

## 4. 在途工作（2026-11-03 GitHub 回读；2026-11-08 M2 收官的 PR 清单见证据页，本节未逐条刷新）

无在途 PR（2026-11-03 03:35Z 回读为 0）。近期已合并：#735（模块文档）、#736（拒答护栏）、#737（Phase 1a 热修）、#738（联系人线状态）、#739（trade_fair 裁剪）、#740（fail-closed 残留）、#743（Phase 1 卖家事实字段）、#744/#745（联系人同名排除与 attemptId 客户端透传）。

历史任务卡（A 快速通道、B `gctl switch-backend`、D 查询活动无回执、E 卖方入驻 HOLD）均已合并或随演进取代；#597 已于 2026-10 合并（ICP 重试仅在未触达上游时允许）。

## 5. 下一步与需要的决定

当前优先顺序（2026-11-28 核对）：① 查明 `a5ef77f6`（#1156）合入后 main push CI 失败根因及发布前实际证据门；② 在精准候选（`a5ef77f6` + `ff45fa4`）上推进正常用户九条旅程有界验收，并核对事件隔离恢复与 `SiteBuildCostSummaryUpdated` 金额形状；③ 涉及业务行为、权限、费用与发送的高风险事项（Discovery v3 成组切换与非模型成本覆盖、钱包启用与不明受理、触达外发与回复停发、成员写权限/匿名查重、运营 DB 写闸、访问审计保留候选、健康探针口径对齐）按独立规格与产品负责人单独裁决推进。每次环境切换分别记录迁移与回退证据，试点与正式发布走现行晋级门。

以下为 2026-11-02 的分阶段验收记录，近期实现见上方当前核验与[实现状态](implementation-matrix.md)。

1. **Phase 0 已完成**：本页 11-02 基线、`docs/modules/*` 与实现矩阵（#735）、`docs/status/release-plan.md` 承接迁移与历史文档定位（#741）。
2. **Phase 1 已上线并验收（2026-11-03）**：租户/工作空间合同、注册引导向导与门禁、引擎卖家事实字段（#743 + gain-saas #32/#33/#34，带迁移发布）。
3. **Phase 2 进行中**：卖家资料库 MVP（seller_document/seller_document_chunk、独立 bucket、presign/commit、Docling→分块→BGE-M3→pgvector 检索、前端资料库 tab）；**Phase 2b** 寻源性能改造与 Phase 2 并行（首批线索 ≤10 分钟、25 家 ≤30 分钟）。
4. Phase 4「任务对象 + 重试」已立项（含 retry-account 放宽设计评估），排在 Phase 2 之后。

需要产品负责人拍板的：M5 Golden Set 取样口径（20 家名单）；D6 per-tenant LIA 采集页排期；D8 开源融合顺序（theHarvester/social-analyzer、JobSpy、Trafilatura、Common Crawl、跨进程熔断）；`google_patents` 启用条件（等 patent cache 刷新恢复 + BQ 实测）；平台 4 个 schedule 是否恢复运行；`secrets-backup` 交互执行与异地副本；new-api gemini 渠道扩容（换密钥/加渠道）；PRD4-D1（Site Builder 正式冻结）、PRD4-D4/D19（文档各有两案，其中现役 QGO 源码已在 `gain-saas`）、PRD4-D8（design partner 人选）等既有待拍板项不变。（PRD4-D12 已于 2026-11-11 拍板，见下。）

## 6. 不变的边界与工程门

- 源码合入、单测或 CI 通过不等于运行采用；xin 的运行观察不是 RuntimeEvidence，也不产生可信 Release Bundle。
- 预付积分钱包的源码、商用账本、界面和验收归 `gain-saas`（代码默认 `WALLET_BILLING_ENABLED=false`，实际环境开关与商业收费待单独核验与批准）；引擎的技术预算与供应商成本记录见[运行模式与开关](../architecture/current.md#运行模式与开关)。开发者临时调用另依任务授权。
- 当前非运行时模型候选合同仍为 `site-builder-model-candidate-baseline/2026-08-07-v3`，详见[生成页](../site-builder/model-candidate-baseline.md)；它不等于 active route、质量证明或真实 dispatch 授权。
- SaaS 源码接入 SMTP 和发送 Worker。已有隔离库与 Mailpit 的历史测试。M2 真实域名外发 11-5 仍待验收，包含实际域名认证及经授权的发送验证。`OUTREACH_SEND_ENABLED` 和 `OUTREACH_SENDER_ENABLED` 的代码默认值均为 `false`，`CAMPAIGN_EXECUTION_SHADOW` 默认 `true`。现役运行开关未知，正式发送待产品负责人批准，RL1 试点的范围为零发送。[M2 步 11 记录](../evidence/2026-11-08-m2-acceptance.md) · [隔离测试索引](../evidence/README.md)
- `PILOT`/`GA` 晋级门：PRD4-D12 于 2026-11-11 拍板为**产品负责人 SSH 签名回执**（`external_provenance.status=OWNER_SIGNED`，verifier=`PRODUCT_OWNER_SSH_SIGNATURE`），回执绑定 bundle 摘要/commit/证据集/机器 check 结论/审查记录，验证器离线验签；`EXTERNAL_UNVERIFIED` 仍阻断、自证 `VERIFIED` 仍拒绝，RuntimeEvidence 与 Release Bundle 仍是晋级条件。首个真实 `PILOT` 仍需相应 PASS RuntimeEvidence 与产品负责人的签名授权。

工程门 G0–G7 的定义见[发布路线](../status/release-plan.md)。自 2026-09-20 核验以来没有任何一道门晋级，下表的裁决不变，所缺证据按当前事实改写：

| Gate | 当前裁决 | 所缺证据 |
| --- | --- | --- |
| G0 — Truth & Ownership | PARTIAL | 权威文档已回写到 2026-11 决定；PRD 4.0 仍只在私有目录（PRD4-D10 未拍板），不是仓内权威 |
| G1 — Product/UX/Contract | PARTIAL | 引擎周报 CSV 与反馈端点已有机器合同（#650/#729；SaaS 侧周报功能已于 2026-11-11 取消）；交付包 v1.1 合同、可达性口径写入产品范围与 v3 合同对齐仍待补 |
| G2 — Source/TDD/Security | PARTIAL / MERGED_FIXES_VERIFIED | 各修复 PR 自带 TDD 与必需检查，但不推广到未改动模块；`a5ef77f6`（#1156）合入后 main push CI 存在 `postgres semantics · permissions`（native Discovery v3 厂家证据断言）失败待查 |
| G3 — Integration/Data | PARTIAL / PRODUCT_E2E_PARTIAL | 历史 13 次 PARTIAL + 首次 `DONE` run（11-03）；`a5ef77f6` + `ff45fa4` 候选尚未补齐多租户/Temporal/SaaS 投影与隔离恢复集成验收 |
| G4 — Release Candidate | DEVELOPMENT_CANDIDATE_ONLY | 一页结论记录了该后端制品的采用。对应 main CI 尚有失败，成对候选的完整发布证明与已测试回退输入仍待取得 |
| G5-Site — Runtime Observed | HISTORICAL_ONLY | Site 线待 PRD4-D1 裁决，证据时效与追踪范围见[一页结论](#一页结论) |
| G5-Acquisition — Runtime Observed | NOT_VERIFIED | 无当前有效 RuntimeEvidence（本机时点观测与普通 run 不构成 RuntimeEvidence PASS） |
| G6 — UAT Accepted | NOT_RUN | 精确组合尚缺正常用户端到端验收。连续三轮通过、受控恢复和产品负责人验收按[待验证台账](pending-verification.md) `PV-006` 取证 |
| G7 — Pilot/GA Authorized | NOT_AUTHORIZED | 待取得当前 PASS RuntimeEvidence、有效 Release Bundle 与产品负责人 `OWNER_SIGNED` 签名回执。按 PRD4-D12 复验 |

相同动作、目标和范围的有效授权继续沿用。源码 / PR 合入不自动授权生产部署、保留数据库迁移、凭据与端口修改、付费调用或 Pilot/GA。

## 历史（2026-09-20 核验）

2026-09-20 核验的旧版正文——源码与候选、Program A/B/C 所有权、阶段门的原裁决与所缺证据、运行与发布证据、PR / 分支 / worktree 处置，以及其后不刷新核验的 §4.1 宿主迁移、§4.2 R4 平台命名空间授权缺口、§4.3 远端分支清理、§4.4 客户写入准入解耦与旧「下一顺序」——已原文移至[归档](../archive/status/current-20260920.md)，不代表当前状态。其中 R4 的推进项已由 PRD4-D2 冻结取代（该冻结又于 2026-10-31 重开并完成迁移）；#538 与 #515 已于 2026-10-06 关闭。

下面这条历史事实仍需在本页可见：

历史费用记录保持 UNKNOWN/unknown：attempts 1–5 为 UNRESOLVED，attempt 6 为 EXPIRED，reservation/conservative charge 均为 `800000`；EXPIRED 不产生有效输出或精确费用，继续不重发。完整脱敏字段见 [2026-09-04 platform-writer successor runtime readback](../evidence/site-builder/production-parity-platform-writer-runtime-readback-20260904.json)；20260901 predecessor 保持 historical provenance。GrowthOS 2026-09-01 historical provenance 也不能代替当前 authority source。源码修复、disposable 测试或当前文档不能改写历史物理调用和 ACK 事实。
