# M2 里程碑验收证据汇编（2026-11-08）

> 用途：按协调计划 §0.2 步 9–14 的验收口径，逐项登记证据指针与状态。状态取值：✅ 已满足（附可复核证据）/ 🟡 部分（注明缺口）/ ⏳ 进行中（附件计划）。本文件随验收推进更新，最终版本以 M2 关闭时为准。

## 步 9 · M2.0 契约 / M2.1 审批 / M2.2 指标

- **M2.0 契约先行 ✅**：campaign/revision/approval/authorization 等六表与状态机、canonical plan_hash 已随 gain-saas `60a08b8` 部署（设计 `docs/technical/campaign-control-plane-m2-0.md`；实现 PR gain-saas #69/#71）。
- **M2.1 审批 UI 端到端（只审不执行）✅**：
  - 实施：backend #876（campaign.plan 技能/工作流/内部端点/预算 purpose）、gain-saas #75（job 表+端点+回调）、#80（审批 UI）、#81（E2E 脚本）。
  - 服务端 --live 终验：job SUCCEEDED、revision/plan_hash 一致、authorization ISSUED（TTL 30min）、campaign_decision_trace 4 行、audit_log 5 行、重复回调幂等、缺服务令牌 401。
  - live campaign 真实浏览器断言 10/10（影子横幅/已批准 v1/无待审批卡/Why 卡三层/默认视图无 plan_hash 与 UUID）：`docs/status/campaign-planner-e2e-2026-11-08.md` §4.1 + 截图 `docs/status/assets/campaign-planner-live-detail.png`（gain-saas #95）。
  - 「只审不执行」结构证明：`campaign-execution-wiring.absence.spec.ts` 钉住授权模型无任何执行消费方（#95 §4.2）。
- **M2.2 有界重规划与指标 🟡（设计范围已全部落地，余联合验收）**：
  - 契约/查询/页签：maxReplans∈{0,1,2}（gain-saas #84）、四指标查询层（#86）、成本形状修正（#96）、运营台「战役指标」页签（#97）。
  - 重规划循环：backend #884（有界循环+NEEDS_HUMAN+job 成本上限）、gain-saas #90（NEEDS_HUMAN/replanHistory/轨迹）与 #99（拒绝→自动重生成→仍拒→NEEDS_HUMAN，迁移 `20261108180000_campaign_plan_job_replan_of`）。
  - Golden：backend #877（briefs×6 + `campaign:golden` 跑批器，replay 6/6、变异退出码、baseline diff）。
  - 已完成的 SaaS 侧真机验证：合成 job→NEEDS_HUMAN（两轮 replanHistory）→落表与两条 `campaign.replan` 轨迹→指标口径查询返回 2 轮；重复回写幂等、异态 409。
  - 余：golden `--live` 首跑基线与 E2E-M2.2 联合验收（金丝雀 harness=quote+Grant 链，等后端/前端两班车完成）。

## 步 9b · 多 agent 编排 v0 ✅（证据四件套齐）

- 实施：backend #870/#878/#879/#880（注册表/决策轨迹表、`source.route` 侦察员、`fit.judge` 资格判定、租户轨迹端点）。
- 真实并行寻源证据（2026-11-08 真机，`DISCOVERY_RUN2_QUICK_SCAN=on`）：
  - `agent_decision_trace`：fit.judge 67 批（单轮 400 家判定、含 verdict 分布与被否候选）、source.route 24 条；跨 run 交叉（b960dda9/d0adabec/78dd56fe/aae4a06a）。
  - 用量归属按 run 账户分模型拆净（德工业 ≈$2.19；quickScan 19 次 qualify_fit/$0.20）。
  - 负向线上对照 1/2/4/5/6：AGENT_DISABLED nonRetryable 13ms、app_user 对轨迹表 UPDATE/DELETE 拒绝、同键重放零重复、停用误伤窗口如实记录；租户端点 200/404/400。
- 前端过程页 ✅：gain-saas #98「寻源过程」人话时间线（选源/判定/重试徽标/依据链接+技术详情折叠），Playwright 断言无 UUID/引擎标识；顺带修复 i18n 键含点导致线上裸显示引擎标识的红线漏洞。
- 观察项（不阻塞）：400 家规模 quickScan 触发 `BUDGET_OPERATION_REPLAY_UNAVAILABLE`——根因=artifact 持久化失败泄漏裸 RESERVED（`markUnknownOnAmbiguousWrite` 谓词过窄）+ 空对象并发风暴；修复 PR 在整改线进行（全 ArtifactStorageError→RESULT_UNKNOWN、日志补码、瞬态/真不符区分）。

## 步 10 · Lead→QGO→SAO→Outcome 回写 ✅（E2E-M2.10 全链真实数据）

- 实施：10-1 候选批次事件与只读视图（#871）、10-2 QGO/SAO/outcome 域（gain-saas #73）、10-2b 运营候选批次表（#83）、10-3 web 提升商机/商机页/结果登记（#78）。
- 全链证据（run 78dd56fe，quickScan on）：wikidata 22 raw（429 未致命）＋public_web/ted 24；候选批次 scored 100（recommended 6/needs_review 45/rejected 44/sanctions_hold 5）与 scored 2；SaaS event_inbox 收 CandidateBatchCompleted×5、DiscoveryRunCompleted×5、LeadQualified×2；真实线索 Festool→接受 QUALIFIED→QGO 5708b948（OPEN，含证据）→accept CONVERTED+SAO 2dfde1d2→Outcome MEETING_BOOKED/MANUAL；qgo/sao/outcome 各 2 行；负向 400 QGO_EVIDENCE_REQUIRED 三层文案。证据为明示 E2E 测试空间。

## 步 11 · 小批量真实发送闭环 ⏳（唯一用户输入阻塞）

- 合规基座已合：gain-saas #79（consent/unsubscribe）、backend #883（DNC 与全局抑制）；迁移 `20261108180000_outreach_compliance`（更名后）待下一班车。
- **硬前置未到**：D1② 发送域名与 DNS 管理访问（产品负责人提供中）。域名到位前 11-5 真发验收（3–5 收件人含 DE 负向 + SPF/DKIM/DMARC 实检）无法执行；步 13 的 L2 发送门与步 12 的 12-3 正式联调同依赖。

## 步 12 · 归因与台账一致 🟡

- 12-1/12-2 ✅：两视图+对账服务+ops「战役归因」页签（gain-saas #82，真库 3 例含造差变红）；联调预演 #89（真实 Campaign/QGO 服务+真库整链 e2e 2/2）。
- D-12-e 发车前对账：2026-11-08 两次发车均执行并留痕（`_archive/backend-runtime-switch-e6e579d4-xin-20261108/README.md`）；对账当场抓出引擎 meta 键错位假绿（campaign.plan 用量在 `meta.task`+`runId` 内嵌 campaignId），修复 gain-saas #94+#96（真红可见：E2E 夹具差异 −10,000µUSD 精确暴露）与文档 backend #886。
- 12-3 正式联调 ⏳（需步 11 发送→回复数据）。

## 步 13 · 审批门全绿 / 越权拒绝 🟡

- 13-1 ✅：S2 技能包（outreach.sequence_draft / engage.reply_classify）+ Golden Set + 两份真实评测回执（backend #881；证据 `docs/evidence/2026-11-08-step13-s2-skills-golden-set.md`，负向 1/2/4/5 具名覆盖）。
- 13-2/13-3（草稿存储/审批界面、逐封发送 L2 门）⏳：随步 11 通道落地；负向 3/6/7 与 L2 审批门届时补齐。

## 步 14 · P6 前端主链路 ✅

- 14-1 导航壳+glossary+零术语机检（gain-saas #77/#85）、14-2「商机与触达」三 tab 内嵌（#91）、14-3 Playwright 主链路 11 用例 + CI e2e job（#93，runner 连续首跑即绿）。触达/禁联增删两条用例按设计 fixme 挂起，随步 11 后启用。
- 零术语红线：机检 CI 门（`pnpm lint:terms`）+ Playwright 文本扫描双保险，现行绿。

## 全局项

- **发车记录（2026-11-08）**：backend `86d623ee→e6e579d4`（M2 train，四迁移）；gain-saas 到 `1da9b6d`（二班车，needs_human 迁移）；backend 收尾班车（DNC/9b/skills/golden）因迁移排序缺陷被前提门安全拦截，修复 PR #890 先后发布。
- **测试/构建**：两仓 main CI 全绿；runtime-image-verifier + capability 探针 4 路 ok + readiness 扁平对比一致。
- **文档**：七份 M2 设计 APPROVED 并入 main；本汇编 + 各线证据文档（campaign-planner e2e、step13 golden、归因对账记录、步2 逐源启用 #889）齐备。
- **未闭环阻塞（截至本文件）**：① D1② 发送域名（用户输入，阻塞步 11/12-3/13-2/13-3）；② M2.2 golden 首跑与 E2E-M2.2（等收尾/前端班车）；③ 观察项：400 家快扫预算 replay 缺陷修复（整改线）。
