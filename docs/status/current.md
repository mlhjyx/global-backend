# 当前状态与下一决策

> 文档 ID：`DOC-STATUS-001`
> 生命周期：`CURRENT`
> 状态：`CURRENT`
> 当前事实来源：[产品范围](../product-scope.md)、[当前架构](../architecture/current.md)、[ADR registry](../adr/registry.md)、[发布路线](../roadmap/release-plan.md)、[冲突与开放决策登记](../governance/conflict-register.md)，以及本页逐项注明的 Git/GitHub 回读与 xin `global_dev` 只读查询
> 最后核验：2026-10-14T10:05Z（`origin/main@33339fb4`、GitHub PR 列表、xin 运行容器的镜像 revision 与 `global_dev` 只读计数；本页是人工核验的读数，不是 RuntimeEvidence）
> 写法：按 PRD 4.0 L2 §5 的四问填写——做了什么（四态：未做 / 可运行 / 已验证 / 已验收）、证据、谁验收、怎么回退。四态口径（PRD 4.0 L0 §9.3「4.0 新锁定」的 `D-029`，与待拍板项 `PRD4-D<n>` 不是同一编号序列）尚未逐条拍板，本页先按它组织。2026-09-20 核验的旧版正文见文末[历史](#历史2026-09-20-核验)。

## 一页结论

当前 Release 是 **RL1 线索试点**：一个 ICP（德国 / DACH 工业泵进口商与分销商）、一个国家、一个品类，Managed 周报交付，目标是拿到第一个人工 QGO 判断并记下每条线索的成本。产品负责人 2026-10-10 批准按 PRD 4.0 开发（「同意，继续，需要闭环，按照 prd 中的需求进行开发实施」）。

**RL1 还没有达成任何一条产出类退出指标。** xin 上 `discovery_run` 全部 11 行都是 `FAILED`，没有一行 `COMPLETED` 或 `PARTIAL`（截至 2026-10-14 08:33 UTC；本次 10:05 UTC 复核没有新 run）。八条退出指标里，真实产出、精度、可达、证据、成本、商机六条没有数据可填；合规可以计数（个人数据三张表 0 行，制裁门从未执行所以命中为 0）；节奏为 0（还没有发出过一份周报）。

阻塞 RL1 的不止「run 跑不完」：评分从未在验收数据上跑过，可达性结构上为 0，交付最后一跳（GrowthOS ACK）从未走通，卖方自助入驻自 08-24 起不可运行。逐项见下表。

## 1. RL1 主链：做了什么、证据、谁验收、怎么回退

| 项 | 做了什么（四态） | 证据 | 谁验收 | 怎么回退 |
| --- | --- | --- | --- | --- |
| 发现 run（ICP → 查询计划 → run） | **可运行，未验证**：11 次全部 FAILED，最远走到信号阶段（卖方 #23、#28）；10-11 起每次失败都由一个 PR 修了倒下的那一处（#638–#645，见 §2），#644、#645 尚未上线 | `discovery_run` 只读查询（status、`stats.failure`）；RL1 执行计划 §15 | 产品负责人（RL1 内部验收） | 运行镜像按 digest 钉在 `local-config/global/runtime.compose.env`，每次换镜像的前后 digest 与验收记录在 `/global/_archive/backend-runtime-switch-*`；带迁移的窗口先 `pg_dump`，另有每日 `db-backup` |
| 评分与制裁第五门 | **未验证**：从未在验收数据上执行。179 条 lead 的 `total_score` 全部为 NULL，队列只是 fit 阶段按判定预置的值；`sanctions_screening_result` 0 行。原因：`finalizeRun` 只在 run 不是 FAILED 时发 `QualifyRequested`，而 run 全部 FAILED。修复 #648 在途 | `lead`、`sanctions_screening_result`、`outbox_event` 只读计数 | 产品负责人 | 评分是确定性重算、可重跑，不改源数据，规则版本写进快照；#648 随镜像回退 |
| 可达性（BI-14 公司级联系路径） | **可运行（开关关闭），未验证**：#630（PR-1，只存联系页 / Impressum / 表单等链接）已合并，`company_contact` 为 DISABLED，`company_contact_point` 0 行；评分侧（可达性按公司级联系路径计分、评分规则 v3）在 #649，未合并。在它上线前 recommended 结构上为 0（当前 179 条 lead：62 条 needs_review、117 条 rejected、0 条 recommended） | `data_provider`、`company_contact_point` 只读查询；#630、#649 | 产品负责人 | `company_contact` 置回 DISABLED；#649 随镜像回退 |
| 交付最后一跳（`LeadQualified` → GrowthOS ACK） | **未验证**：`outbox_delivery` 154 行全部是 `sink=saas`、`PENDING`（2026-09-01 至 2026-10-13），GrowthOS 从未 ACK 过任何事件；xin 没有配置 webhook sink，只能由 GrowthOS 调 `POST /events/ack`；GrowthOS 前台只拉前 50 条、只给前 3 条 ACK 按钮 | `outbox_delivery` 只读计数；评审稿 2026-10-13 §1.5 | 产品负责人；GrowthOS 侧消费需走 `growthos-dev` 补丁线 | 不涉及数据回退（事件只读交付） |
| 卖方自助入驻（understanding 官网抓取） | **不可运行**：自 2026-08-24（#413）起，ToolBroker 的 artifactPrecheck 对 understanding 的 `crawl4ai-fetch/v1` 抓取一律 HOLD，`company_profile` 28 行 ENRICHING、9 行 DRAFT、历史上 0 行 ACTIVE；工作流没有失败终态，同一公司不可重跑。验收靠手工 `POST /companies/:id/claims` 再审批绕过。已派任务卡 E（扩主体种类 + 失败终态 + 重跑入口） | `company_profile` 按 status 分组；评审稿 2026-10-13 §1.1 | 产品负责人 | 修复随镜像回退。修复前不影响验收 run 产出 lead，但 pilot 客户经 GrowthOS 自助入驻会 100% 失败且不报错 |
| 交付包 v1.1、周报 CSV、反馈端点、Golden Set（BI-19–BI-24） | **未做**（RL1 执行计划 §15 第 5–9 项）。交付闭环设计已批准：[`2026-10-10-lead-delivery-loop-design.md`](../superpowers/plans/2026-10-10-lead-delivery-loop-design.md) | 仓内无 `/reports` 路径、无反馈端点；Golden Set 不在仓内 | 产品负责人；design partner（商机，PRD4-D8 未定人选） | — |

运行时：xin 的 API / Worker / platform Worker 运行 `9b94ee53`（#643，镜像 `sha256:72b8504c…`，2026-10-13 窗口 7 上线，无迁移）。#644、#645 已于 2026-10-14 合并，**尚未上线**。

## 2. 验收 run 记录（11 次，全部 FAILED）

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
| PRD4-D2 冻结 R4（2026-10-10） | 不在 R4 准入上继续投入；4 个平台 schedule 在 RL1 期间继续 paused；平台工作流迁进 customer worker 另出设计（未做）。每次换镜像仍要续 R4 部署绑定与准入回执（7 天）。R4 撤销投递链仍未打通（Backend 没有调用 GrowthOS HMAC 签发端点的客户端，`BLOCKED_PENDING_BACKEND_4A4`）：platform Worker 绿灯只代表「事实可观察」，不代表「撤销能真正送达」 | 冻结只是停止投入，没有删代码；恢复平台 schedule 是产品负责人的单独决定，且先要做平台写入者授权（L4-G23） |
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
| 不变的 | 开关为空时 API、relay、worker 行为逐字不变；其余 workspace、擦除与建站命令、整体 readiness、客户写入准入、`/health/build`、租约与准入代码都不变；pilot/production 启动即拒绝车道变量 | 车道 worker 是 unattested 源码进程，车道时段的任何观察都不能作为 RuntimeEvidence PASS 或进入 Release Bundle；R4 撤销投递链仍未打通 |
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
| G3 — Integration/Data | PARTIAL / PRODUCT_E2E_NOT_RUN | 没有一次发现 run 跑完；评分、制裁门与 GrowthOS ACK 从未在验收数据上执行 |
| G4 — Release Candidate | DEVELOPMENT_CANDIDATE_ONLY | xin 运行的是按 digest 钉住、带构建证明的开发镜像；没有可信外部 provenance readback |
| G5-Site — Runtime Observed | HISTORICAL_ONLY | Site 线未推进（PRD4-D1 未拍板）；历史观察不可晋级 |
| G5-Acquisition — Runtime Observed | NOT_VERIFIED | 11 次 run 全部 FAILED；没有当前 RuntimeEvidence |
| G6 — UAT Accepted | NOT_RUN | RL1 退出指标（≥3 个跑完的 run、≥15 条 recommended、design partner 回填）都没有数据 |
| G7 — Pilot/GA Authorized | NOT_AUTHORIZED | 晋级门当前不可达（见上一条死锁）；也没有产品授权 |

相同动作、目标和范围的有效授权继续沿用。源码 / PR 合入不自动授权生产部署、保留数据库迁移、凭据与端口修改、付费调用或 Pilot/GA。

## 历史（2026-09-20 核验）

2026-09-20 核验的旧版正文——源码与候选、Program A/B/C 所有权、阶段门的原裁决与所缺证据、运行与发布证据、PR / 分支 / worktree 处置，以及其后不刷新核验的 §4.1 宿主迁移、§4.2 R4 平台命名空间授权缺口、§4.3 远端分支清理、§4.4 客户写入准入解耦与旧「下一顺序」——已原文移至[归档](../archive/status/current-20260920.md)，不代表当前状态。其中 R4 的推进项已由 PRD4-D2 冻结取代；#538 与 #515 已于 2026-10-06 关闭。

下面这条历史事实仍需在本页可见：

历史费用记录保持 UNKNOWN/unknown：attempts 1–5 为 UNRESOLVED，attempt 6 为 EXPIRED，reservation/conservative charge 均为 `800000`；EXPIRED 不产生有效输出或精确费用，继续不重发。完整脱敏字段见 [2026-09-04 platform-writer successor runtime readback](../evidence/site-builder/production-parity-platform-writer-runtime-readback-20260904.json)；20260901 predecessor 保持 historical provenance。GrowthOS 2026-09-01 historical provenance 也不能代替当前 authority source。源码修复、disposable 测试或当前文档不能改写历史物理调用和 ACK 事实。
