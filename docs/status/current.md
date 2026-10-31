# 当前状态与下一决策

> 文档 ID：`DOC-STATUS-001`
> 生命周期：`CURRENT`
> 状态：`CURRENT`
> 当前事实来源：[产品范围](../product-scope.md)、[当前架构](../architecture/current.md)、[ADR registry](../adr/registry.md)、[发布路线](../roadmap/release-plan.md)、[冲突与开放决策登记](../governance/conflict-register.md)，以及本页逐项注明的 Git/GitHub 回读与 xin `global_dev` 只读查询
> 最后核验：2026-10-30T19:45Z（`origin/main@1ce1b7ba`、xin 运行镜像 `sha256:4a76e2c3…`（build `348fa0cb`）、`global_dev` 只读计数；本页是人工核验的读数，不是 RuntimeEvidence）
> 写法：按 PRD 4.0 L2 §5 的四问填写——做了什么（四态：未做 / 可运行 / 已验证 / 已验收）、证据、谁验收、怎么回退。四态口径（PRD 4.0 L0 §9.3「4.0 新锁定」的 `D-029`，与待拍板项 `PRD4-D<n>` 不是同一编号序列）尚未逐条拍板，本页先按它组织。2026-09-20 核验的旧版正文见文末[历史](#历史2026-09-20-核验)。

## 一页结论

当前 Release 是 **RL1 线索试点**：一个 ICP（德国 / DACH 工业泵进口商与分销商）、一个国家、一个品类，Managed 周报交付，目标是拿到第一个人工 QGO 判断并记下每条线索的成本。产品负责人 2026-10-10 批准按 PRD 4.0 开发（「同意，继续，需要闭环，按照 prd 中的需求进行开发实施」）。

**2026-10-30 复核：主链路已经跑出产出，但离退出指标仍有距离。** xin 上 `discovery_run` 25 行：`PARTIAL` 8、`FAILED` 17、`COMPLETED` 0（最近一次 2026-10-30 18:12Z `e54604d0` 为 PARTIAL，7 条查询、79.8 分钟、产出 5 条 recommended）。`lead` 3 629 行且 `total_score` **全部非空**：recommended 23、needs_review 2 073、rejected 1 503、sanctions_hold 30；其中 21 条已被客户接受（QUALIFIED）。`outbox_delivery` 321 行 **全部 ACKED**、无 PENDING（gain-saas 事件消费者按 2 分钟一轮）——交付最后一跳由 **gain-saas** 走通。`company_profile` 2 ACTIVE / 28 ENRICHING / 29 DRAFT / 1 REVIEW；个人数据：`canonical_contact` 与 `contact_point` 仍 0 行，`company_contact_point` 136 行（公司级联系路径，VALID/UNVERIFIED）。

仍未达成：**没有一次 `COMPLETED` run**；具名个人数据（决策人/个人邮箱）仍为 0 行；周报 CSV 已能按 ICP 真实导出（2026-W44 已在 4 个 ICP 上导出 1/3/5/7 行），但试点客户的交付节奏尚未开始。评分、制裁门与交付 ACK 这三项 2026-10-14 时「从未执行」的判断**已过时**——它们现在都有真实数据。逐项见下表。

## 1. RL1 主链：做了什么、证据、谁验收、怎么回退

| 项 | 做了什么（四态） | 证据 | 谁验收 | 怎么回退 |
| --- | --- | --- | --- | --- |
| 发现 run（ICP → 查询计划 → run） | **可运行，部分验证**：25 次 run，`PARTIAL` 8、`FAILED` 17、`COMPLETED` 0；最近一次 2026-10-30 18:12Z（`e54604d0`，7 条查询、79.8 分钟、5 条 recommended）为 PARTIAL。历史失败逐项见 §2 | `discovery_run` 只读查询（status、`stats`） | 产品负责人（RL1 内部验收） | 运行镜像按 digest 钉在 `local-config/global/runtime.compose.env`，每次换镜像的前后 digest 与验收记录在 `/global/_archive/backend-runtime-switch-*`；带迁移的窗口先 `pg_dump`，另有每日 `db-backup` |
| 评分与制裁第五门 | **已验证（有真实数据）**：`lead` 3 629 行，`total_score` NULL 为 **0**；队列 recommended 23 / needs_review 2 073 / rejected 1 503 / sanctions_hold 30，其中 21 条已被客户接受（QUALIFIED）；`sanctions_screening_result` 18 行 | `lead`（status、queue、total_score）、`sanctions_screening_result` 只读计数 | 产品负责人 | 评分是确定性重算、可重跑，不改源数据，规则版本写进快照 |
| 可达性（BI-14 公司级联系路径） | **可运行**：`company_contact` 已 ENABLED，`company_contact_point` 已有 136 行公司级路径（contact_page/contact_form/impressum_page，UNVERIFIED）。**具名联系人仍是缺口**：`decision_maker`、`companies_house`、`inpi_rne`、`smtp_self` 四个 provider 均为 ENABLED，但发现 run 不调用联系人发现——`POST /canonical-companies/:id/discover-contacts`、`/guess-emails`、`/contact-points/:id/verify` 只能按需调用；`email_guess` provider 仍 DISABLED；gain-saas 前端与 BFF 未暴露这三个端点，所以客户点不到入口。`canonical_contact`、`contact_point` 因此仍 0 行 | `data_provider`、`company_contact_point` 只读查询 | 产品负责人 | `company_contact` 置回 DISABLED |
| 交付最后一跳（`LeadQualified` → 事件 ACK） | **已验证**：`outbox_delivery` 321 行 `ACKED`（sink=saas；其中 LeadQualified 16 行全 ACK），增益事件由 gain-saas 事件消费者每 2 分钟消费；GrowthOS 不再是消费方 | `outbox_delivery` 按 sink/status 计数 | 产品负责人 | 不涉及数据回退（事件只读交付） |
| 卖方自助入驻（understanding 官网抓取） | **部分恢复但未闭环**：`company_profile` 2 ACTIVE、1 REVIEW、29 DRAFT、28 ENRICHING——#654 之后抓取能过产物门，但抽取阶段仍频繁失败，档案停在 DRAFT/ENRICHING；验收主要靠手工 claims 路径 | `company_profile` 按 status 分组 | 产品负责人 | 修复随镜像回退 |
| 交付包 v1.1、周报 CSV、反馈端点、Golden Set（BI-19–BI-24） | **部分完成**：周报 CSV（#650，BI-22）与反馈端点（BI-23）已上线并在真实数据上导出；LeadPackage v1.1（#681）已上线；Golden Set 仍未做 | 仓内 `/reports/weekly` 与 `/reports/weekly/feedback` 已注册；Golden Set 不在仓内 | 产品负责人；design partner（商机，PRD4-D8 未定人选） | — |

运行时：xin 的 API / Worker / platform Worker 运行 **`348fa0cb`**（#699，镜像 `sha256:4a76e2c3…`，2026-10-30 晚间切换，含 #697 DoH 可配置、#698 状态回读与 #699 开发信读取端点）。`origin/main` 已到 `1ce1b7ba`（#700，纯文档，未进镜像亦无需补发）。获客模型：抽取档 `gemini-3.8-flash`、推理档 `gpt-6.1-terra`，任务级覆盖 `taxonomy.normalize→deepseek-flash`、`discovery.qualify_fit→gemini-4-argon-high`。

身份分工（2026-10-30 核实）：产品登录/身份由 **gain-saas** 签发（`AUTH_ISSUER` / `AUTH_JWKS_URI` = `https://127.0.0.1:18446`）；**R4 平台权威仍在 GrowthOS**（`CAPABILITY_MACHINE_JWKS_URI`、`PLATFORM_CAPABILITY_JWKS_URI`、`TEMPORAL_MACHINE_JWKS_URI`、`PLATFORM_TECHNICAL_QUOTE_AUTH_ISSUER` 均指向 `https://127.0.0.1:18444`，`PLATFORM_CAPABILITY_GROWTHOS_SHA=6bbfa1cc…`）。GrowthOS 侧容器与 `frontend/growthos-source`、`frontend/growthos-work` 仍在服役。

## 2. 历史验收 run 记录（2026-10-08 → 10-13，11 次全部 FAILED）

> 下表是当时的失败归因，保留作证据；**当前计数以 §1 为准**（25 次：8 PARTIAL / 17 FAILED / 0 COMPLETED）。

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

失败后的完整重试（D13 根治，涉及受保护的网关与 broker）产品负责人 2026-10-13 定为验收通过后再做；在此之前，同一计划、同一主体的 Grant 只能用一次，失败就换卖方。

## 3. 生效的决定（2026-10-10 起）

PRD 4.0 待拍板项 D1–D19 的全量状态见[冲突与开放决策登记](../governance/conflict-register.md)；已生效的承重决定登记在 [ADR registry](../adr/registry.md) 的 `PRD4-` 一节。为避免与 Site Builder 线的 D9/D13 混淆，本页一律写 `PRD4-D<n>`。

| 决定 | 当前事实 | 怎么回退 |
| --- | --- | --- |
| PRD4-D2 冻结 R4（2026-10-10，**2026-10-31 重开**） | 冻结期间不追加 R4 投入、4 个平台 schedule 保持 paused、每次换镜像仍续 7 天绑定。**2026-10-31 产品负责人重开**：R4 恢复投入，唯一目的是把平台权威从 GrowthOS 迁到 gain-saas（机器 token、capability、撤销与恢复通道），迁完退役 GrowthOS；schedule 是否恢复运行另议。撤销投递链现状（2026-11-01）：gain-saas 签发 → 后端接收（RS256 JWS，不是 HMAC）→ fence 提交 → ACK 验签已用真实 committed Grant 实测通过（[证据](../evidence/2026-11-01-platform-admission-v2-and-revocation-fence.md)）；政策停用 → 撤销的自动触发尚未接线，`BLOCKED_PENDING_BACKEND_4A4` 不再成立 | 重开只恢复「迁移」这一项投入；平台运行准入的写入者授权缺口（L4-G23）已于 2026-11-01 随准入 v2 上线闭合，恢复平台 schedule（unpause）仍是产品负责人的单独决定 |
| PRD4-D3 客户写入准入与 platform Worker 就绪解耦（2026-10-10） | #627 已合并，2026-10-11 上线：客户写入按客户依赖集合判定，platform Worker 恰为 `PLATFORM_WORKER_NOT_READY` 时不再关闭客户写入；`/health/ready` 的整体口径不变 | 换回 #627 之前的镜像 |
| PRD4-D9 制裁名单与职能邮箱（2026-10-10，部分拍板） | 制裁名单走运营刷新（#629，不经平台 schedule），2026-10-11 打开三个源（OFAC SDN、OFAC Consolidated、EU FSF，`sanctions_source` 均 ENABLED，约 1.2 万条实体）；职能邮箱按 BI-14 做公司级（#630，开关 DISABLED）。LIA 时机未定 | `sanctions_source` 置 DISABLED |
| PRD4-D14 模型供应（2026-10-11） | #633：11 个获客任务照旧请求 pro 档，上游换成 Flash 档时也接受，trace 与账本如实记为 Flash；建站等其他任务仍只认 pro。xin 已打开 `MODEL_IDENTITY_SUBSTITUTES`。官方备用上游未接 | 关掉 `MODEL_IDENTITY_SUBSTITUTES` |
| PRD4-D16 个人数据路径保持现状（2026-10-11） | `decision_maker`、`companies_house`、`inpi_rne`、`smtp_self` 保持 ENABLED，展会 Algolia 来源保留，产品负责人风险自担（注：xin 上 `trade_fair` provider 实际为 DISABLED，发现 run 按 `data_provider.status` 门不会调用它）；验收 run 存下个人数据不再停止，改为如实计数并注明来源；不新写抽邮箱、电话的自动化。当前个人数据三张表（`canonical_contact`、`contact_point`、`company_contact_point`）均 0 行 | 把相应 `data_provider` 置 DISABLED |

## 4. 在途工作（2026-10-14 10:05 UTC GitHub 回读）

| PR | 内容 | 状态 |
| --- | --- | --- |
| #646 | ICP / 查询计划遇已结算但不可用的模型回答时报 502 `MODEL_UPSTREAM_UNUSABLE`，不再是裸 500（任务卡 C） | OPEN |
| #647 | 复用的产物对象在最晚一份清单到期前保持存活，并为擦除记录每个对象版本（#644 的邻接缺陷） | OPEN |
| #648 | FAILED 但已判过 fit 的发现 run 也请求评分；GET /leads 区分「预置队列」与「已评分」 | OPEN |
| #649 | 评分规则 v3：可达性取公司级联系路径与个人口径的较大值，闲置的 Role 权重归零并入 Fit / Reachability，权威 Fit 存在时镜像排除规则只记录不排除，并为现有公司补读联系路径（产品负责人已按方案 A 授权） | OPEN |
| #597 | ICP 请求在之前没有尝试到达上游时才允许重试 | OPEN、draft、`CONFLICTING`；建议关闭或改题，避免被当作在途工作 |

> 本表回读之后、#651 合入之前又开出两项，当时未列入：#650（周报 CSV 端点，BI-22；10-14 10:52 UTC 开出）与 #652（确定失败、尚无输出时释放 reservation，同一 key 可再预留；PRD4-D13；10-14 12:11 UTC 开出）。此后 #647 于 2026-10-14、#646 / #648 / #649 / #650 / #652 于 2026-10-15 合并，#597 仍为 draft；本节不刷新 `最后核验` 时间戳，现场状态以 GitHub 为准。

#644（产物按字节判等）与 #645（词表归一按查询归键、无源读取时不调模型、调用丢失时回退内置词表）已合并、待下一个维护窗口上线。另有任务卡 A（开发快速通道）、B（`gctl switch-backend` 一条命令换镜像）、D（查询活动普通错误无回执）、E（卖方入驻 HOLD）已派出，以各自 PR 为准。

### 4.1 开发快速通道（#656，2026-10-14 合并）

> 2026-10-15 随 #651 并入 main 时从旧结构的 §4.5 原样搬入：只记录这一项改动（#656，已合并、未上线），**不刷新**本页 `最后核验` 时间戳，也不改动上面各节的裁决。

开发者改了获客的 worker 侧代码后，此前每次都要发布并切换后端镜像才能在本机验证。本项让 development 里一个测试 workspace 的入驻理解、发现 run 与资格判定跑在源码 customer worker 上；设计与复核调整见 [落地设计](../superpowers/plans/2026-10-14-dev-fast-lane.md)，运维步骤见 [开发快速通道](../backend/dev-fast-lane.md)。

| 项 | 当前事实 | 不得外推 |
| --- | --- | --- |
| 改变的 | 开关置位时，受证 API 的 relay 把该 workspace 的三条获客命令投到开发用 Temporal 的专属队列（带执行超时），源码 worker 只 poll 该队列；`/health/ready` 多一个恒为 `not_proven` 的 `capabilities.dev_fast_lane` | 运行镜像何时采用另行记录，采用前行为不变；尚无本机运行观察，不是 RuntimeEvidence |
| 不变的 | 开关为空时 API、relay、worker 行为逐字不变；其余 workspace、擦除与建站命令、整体 readiness、客户写入准入、`/health/build`、租约与准入代码都不变；pilot/production 启动即拒绝车道变量 | 车道 worker 是 unattested 源码进程，车道时段的任何观察都不能作为 RuntimeEvidence PASS 或进入 Release Bundle；R4 撤销投递链 2026-11-01 已用真实 Grant 实测打通（见证据页），自动触发未接线 |
| 代价 | 车道只覆盖三个 workflow 的 workflow 体与活动体，workflow 输入、outbox payload、事件注册表与 API 内的同步获客操作仍是镜像代码；开关、迭代、关闭都要先排空在途 run（路由在投递时决定）；换镜像前要关车道 | 首次落地仍需发布并切换一次含本改动的镜像 |

## 5. 下一步与需要的决定

不碰受保护文件、可以先做的：#648、#649 合并并上线后，对两条验收 ICP 各调一次 `POST /icps/:icpId/qualify`，让现有 179 条 lead 拿到真实评分（不必等 run 全绿）；翻开 `company_contact` 并对现有公司补联系路径；交付包 v1.1 与周报 CSV 先出第一份；走通一次 GrowthOS 对真实 `LeadQualified` 的 accept → `GET /events` → ack。验收 run 的稳定性（#644、#645 上线后再跑）与「评分 → 接受 → CSV」可以并行验收。

需要产品负责人拍板的：PRD4-D8（design partner 人选与数据使用授权，卡「商机」与「节奏」）；PRD4-D15（成本口径与每个 run 的上限，卡「成本」）；PRD4-D12（流程瘦身，AGENTS §7 的晋级门在它之前是死锁，见 §6）；PRD4-D1（Site Builder 正式冻结）；PRD4-D4 与 PRD4-D19（文档里各有两案相反）；D13 是否拆成账户层（不碰受保护文件）与操作层（受保护，验收后）两步。

## 6. 不变的边界与工程门

- 源码合入、单测或 CI 通过不等于运行采用；xin 的运行观察不是 RuntimeEvidence，也不产生可信 Release Bundle。
- Billing/Credits 保持 `DEFERRED / NOT_IMPLEMENTED`；`cap_microusd` 是一次执行的技术安全上界，不是客户余额。正常产品请求的费用权威是 SaaS 签发的 Budget Grant，与开发者 ad-hoc 调用授权保持分离。
- 当前非运行时模型候选合同仍为 `site-builder-model-candidate-baseline/2026-08-07-v3`，详见[生成页](../site-builder/model-candidate-baseline.md)；它不等于 active route、质量证明或真实 dispatch 授权。
- 发送仍未开放：RL1 不做任何发送，触达属于 RL4。
- `PILOT`/`GA` 晋级门目前不可达：AGENTS §7 要求可信外部 readback，而仓内原有的 approval/readback 回读器已由 #566 移除，`scripts/governance-delivery-contracts.mjs` 对任何晋级状态恒阻断。这是已知死锁，是否改为产品负责人签字待 PRD4-D12 拍板。

工程门 G0–G7 的定义见[发布路线](../roadmap/release-plan.md)。自 2026-09-20 核验以来没有任何一道门晋级，下表的裁决不变，所缺证据按当前事实改写：

| Gate | 当前裁决 | 所缺证据 |
| --- | --- | --- |
| G0 — Truth & Ownership | PARTIAL | 权威文档已回写到 2026-10 决定；PRD 4.0 仍只在私有目录（PRD4-D10 未拍板），不是仓内权威 |
| G1 — Product/UX/Contract | PARTIAL | 交付包 v1.1、反馈端点的机器合同未做（周报 CSV 已有端点与 OpenAPI，#650，2026-10-15 合并、未上线）；可达性口径改为公司级联系路径尚未写入产品范围 |
| G2 — Source/TDD/Security | PARTIAL / MERGED_FIXES_VERIFIED | 每个修复 PR 自带 TDD 与必需检查；不推广到未改动的模块 |
| G3 — Integration/Data | PARTIAL / PRODUCT_E2E_PARTIAL | 已有 7 次 PARTIAL run、3 369 条真实评分、309 条 ACK；仍没有一次 `COMPLETED` run |
| G4 — Release Candidate | DEVELOPMENT_CANDIDATE_ONLY | xin 运行的是按 digest 钉住、带构建证明的开发镜像；没有可信外部 provenance readback |
| G5-Site — Runtime Observed | HISTORICAL_ONLY | Site 线未推进（PRD4-D1 未拍板）；历史观察不可晋级 |
| G5-Acquisition — Runtime Observed | NOT_VERIFIED | 有 7 次 PARTIAL run，但没有 `COMPLETED`，也没有当前 RuntimeEvidence（PARTIAL 不构成 RuntimeEvidence PASS） |
| G6 — UAT Accepted | NOT_RUN | RL1 退出指标：recommended 18 / 目标 ≥15 已达，跑完的 run 与 design partner 回填仍未达成 |
| G7 — Pilot/GA Authorized | NOT_AUTHORIZED | 晋级门当前不可达（见上一条死锁）；也没有产品授权 |

相同动作、目标和范围的有效授权继续沿用。源码 / PR 合入不自动授权生产部署、保留数据库迁移、凭据与端口修改、付费调用或 Pilot/GA。

## 历史（2026-09-20 核验）

2026-09-20 核验的旧版正文——源码与候选、Program A/B/C 所有权、阶段门的原裁决与所缺证据、运行与发布证据、PR / 分支 / worktree 处置，以及其后不刷新核验的 §4.1 宿主迁移、§4.2 R4 平台命名空间授权缺口、§4.3 远端分支清理、§4.4 客户写入准入解耦与旧「下一顺序」——已原文移至[归档](../archive/status/current-20260920.md)，不代表当前状态。其中 R4 的推进项已由 PRD4-D2 冻结取代；#538 与 #515 已于 2026-10-06 关闭。

下面这条历史事实仍需在本页可见：

历史费用记录保持 UNKNOWN/unknown：attempts 1–5 为 UNRESOLVED，attempt 6 为 EXPIRED，reservation/conservative charge 均为 `800000`；EXPIRED 不产生有效输出或精确费用，继续不重发。完整脱敏字段见 [2026-09-04 platform-writer successor runtime readback](../evidence/site-builder/production-parity-platform-writer-runtime-readback-20260904.json)；20260901 predecessor 保持 historical provenance。GrowthOS 2026-09-01 historical provenance 也不能代替当前 authority source。源码修复、disposable 测试或当前文档不能改写历史物理调用和 ACK 事实。
