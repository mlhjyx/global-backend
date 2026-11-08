# M2 里程碑验收证据汇编（2026-11-08）

> 用途：按协调计划 §0.2 步 9–14 的验收口径，逐项登记证据指针与状态。状态取值：✅ 已满足（附可复核证据）/ 🟡 部分（注明缺口）/ ⏳ 进行中（附件计划）。本文件随验收推进更新，最终版本以 M2 关闭时为准。

## 步 9 · M2.0 契约 / M2.1 审批 / M2.2 指标

- **M2.0 契约先行 ✅**：campaign/revision/approval/authorization 等六表与状态机、canonical plan_hash 已随 gain-saas `60a08b8` 部署（设计 `docs/technical/campaign-control-plane-m2-0.md`；实现 PR gain-saas #69/#71）。
- **M2.1 审批 UI 端到端（只审不执行）✅**：
  - 实施：backend #876（campaign.plan 技能/工作流/内部端点/预算 purpose）、gain-saas #75（job 表+端点+回调）、#80（审批 UI）、#81（E2E 脚本）。
  - 服务端 --live 终验（2026-11-08，降档期标注）：job SUCCEEDED、revision/plan_hash 一致、authorization ISSUED（TTL 30min）、campaign_decision_trace 4 行、audit_log 5 行、重复回调幂等、缺服务令牌 401。
  - live campaign 真实浏览器断言 10/10（shadow 横幅文案/已批准 v1/无待审批卡/Why 卡三层/默认视图无 plan_hash 与 UUID）：证据 `docs/status/campaign-planner-e2e-2026-11-08.md` §4.1，截图 `docs/status/assets/campaign-planner-live-detail.png`（gain-saas #95）。
  - 「只审不执行」的结构证明：`campaign-execution-wiring.absence.spec.ts` 钉住授权模型无任何执行消费方（替换脚本内硬编码 shadow 字段，gain-saas #95 §4.2）。
- **M2.2 有界重规划与指标 🟡**：
  - 契约扩展 maxReplans∈{0,1,2}（gain-saas #84）、指标查询层（#86）、golden brief 资产（backend #877，合并中）。
  - 重规划循环（backend #884：NEEDS_HUMAN + 重规划轨迹；gain-saas 迁移 `20261108170000_campaign_plan_job_needs_human`）与四指标页签：实现已入 main，真机 golden 跑批待下一班车部署后执行。

## 步 9b · 多 agent 编排 v0

- **实施 ✅（四切片全并入 main）**：#870（agent 注册表/决策轨迹表/ops 启停）、#878（源侦察员 source.route）、#879（资格判定 role 化 fit.judge）、#880（租户决策轨迹端点）。负向 1/2/4/6 已过。
- **两 agent 真实并行寻源证据 ⏳**：golden mini-run（德吸塑/美电子合并 ICP `b2f73e40`、德工业 `b01190da`）在 2026-11-08 镜像 `e6e579d4` 上执行中；证据四件套=source.route/fit.judge 轨迹行、每 agent usage 归属对照、负向线上对照、租户 trace 端点返回样例。判别口径注明当日上游故障期降档/还原时点。
- **前端过程页 🟡**：14-2「商机与触达」三 tab 已内嵌真实页面（gain-saas #91）；决策轨迹页签展示待 9b 端点接入后由 P6 线补齐。

## 步 10 · Lead→QGO→SAO→Outcome 回写

- **实现 ✅**：10-1 候选批次事件与只读视图（#871）、10-2 QGO/SAO/outcome 域（gain-saas #73）、10-2b 运营归因页候选批次表（gain-saas #83）、10-3 web 提升商机/商机页/结果登记（gain-saas #78，已随 584fa40 部署）。
- **10-4 E2E-M2.10 ⏳**：模板→寻源→候选批次→提升→QGO→SAO→Outcome 联调执行中，证据待落（当日上游故障期已降档并还原）。

## 步 11 · 小批量真实发送闭环 ⏳（唯一用户输入阻塞）

- 合规基座已合：gain-saas #79（consent/unsubscribe 基座）、backend #883（DNC 与全局抑制）；`20261108160000_outreach_compliance` 迁移待下一班车。
- **硬前置未到**：D1② 发送域名与 DNS 管理访问（产品负责人提供中）。域名到位前 11-5 真发验收（3–5 收件人含 DE 负向 + SPF/DKIM/DMARC 实检）无法执行；步 13 的 L2 发送门与步 12 的 12-3 正式联调同依赖此。

## 步 12 · 归因与台账一致 🟡

- 12-1/12-2 ✅：两视图+对账服务+ops「战役归因」页签（gain-saas #82，真库 3 例含造差变红）；联调预演 #89（真实 Campaign/QGO 服务+真库整链 e2e 2/2）。
- D-12-e 发车前对账：2026-11-08 发车已执行并留痕 `_archive/backend-runtime-switch-e6e579d4-xin-20261108/README.md`；对账当场抓出引擎 meta 键错位假绿（campaign.plan 用量在 `meta.task`+`runId` 内嵌 campaignId），修复 gain-saas #94（真红可见：E2E 夹具差异 −10,000µUSD 精确暴露）与文档 backend #886。
- 12-3 正式联调 ⏳（需步 11 发送→回复数据）。

## 步 13 · 审批门全绿 / 越权拒绝 🟡

- 13-1 ✅：S2 技能包（outreach.sequence_draft / engage.reply_classify）+ Golden Set + 两份真实评测回执（backend #881；证据 `docs/evidence/2026-11-08-step13-s2-skills-golden-set.md`，负向 1/2/4/5 具名覆盖）。
- 13-2/13-3（草稿存储/审批界面、逐封发送 L2 门）⏳：随步 11 通道落地；负向 3/6/7 与 L2 审批门届时补齐。

## 步 14 · P6 前端主链路 ✅

- 14-1 导航壳+glossary+零术语机检（gain-saas #77/#85）、14-2「商机与触达」三 tab 内嵌（#91）、14-3 Playwright 主链路 11 用例 + CI e2e job（#93，GitHub runner 首跑即绿）。触达/禁联增删两条用例按设计 fixme 挂起，随步 11 后启用。
- 零术语红线：机检 CI 门（`pnpm lint:terms`）+ Playwright 文本扫描双保险，现行绿。

## 全局项

- **测试/构建**：两仓 main CI 全绿；backend 本日两次发车（86d623ee→e6e579d4）各验证 runtime-image-verifier + capability 探针 4 路 ok + readiness 扁平对比一致。
- **文档**：七份 M2 设计全部 APPROVED 并入 main；本汇编 + 各线证据文档（campaign-planner e2e、step13 golden、归因对账记录）齐备。
- **未闭环阻塞（截至本文件）**：① D1② 发送域名（用户输入，阻塞步 11/12-3/13-2/13-3）；② 9b mini-run 证据与 10-4 联调在飞；③ M2.2 golden 真跑待下一班车。
