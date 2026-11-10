# 双仓工程治理冲刺（2026-11-11）

本记录是一次集中工程治理的实际执行结果：基线审计（G0）、权威与冲突治理（G1）、文档治理（G2/G3）、PR 与 CI 效率（G4/G5）、Agent 协作规则（G6）、治理机制盘点（G7）、运行与安全审计（G8）、发布与验收缺口（G9）。它记录改动、检查结果与未完成项；**不是 RuntimeEvidence，不升级任何产品、运行或发布状态**。

## 0. 结论摘要

- 后端 `docs/` 从会话开始的 411 份 Markdown 降到 **280 份**（净 -131）：并行会话先新增 1 份（#1002），本冲刺消费 119 份 changelog 片段、直接删除 15 份零引用且已交付/被取代的计划与 TDD 记录、新增 1 个片段与 1 份本报告；证据、Release、ADR、机器合同零删除。
- 交付 6 个后端 PR（#1003–#1007、#1014）+ 本报告 PR，5 个 SaaS PR（#154/#155/#156/#157/#159）：入口纠偏、文档删除、changelog 汇编、PR 规则统一、contracts 文档快通道、main push 并发组修复；SaaS 文档入口重建、CI 路径分流 + 密钥扫描 + 引擎合同确定性固定、门户链接修复。
- 修复的真实缺陷：#776 声称已实现但从未落地的 contracts 短路、SaaS 合同漂移检查 `continue-on-error` 长期失效、SaaS 无密钥扫描、`outreach-experiments` 约 1.2% 随机盐假红、SaaS status 页的 nohup 指令与 systemd 现实冲突、后端入口残留 GrowthOS 恢复步骤。
- 未解决的高优先级项：PILOT/GA 外部 provenance 死锁（等 PRD4-D12）、PRD 4.0 权威不在仓内（PRD4-D10）、SaaS `main` 无 GitHub 分支保护、引擎 outbox 事件 payload 无机器兼容校验、依赖漏洞基线 2026-11-14 到期。

## 1. 基线与现场保护

| 项 | 值 |
| --- | --- |
| 执行日 | 2026-11-11（UTC 深夜） |
| 后端基线 | `ef3cc1b5`（会话开始）→ `235d0f41`（#1002 由并行会话合入） |
| SaaS 基线 | `c4f9c90`（#153） |
| 后端 ruleset | `protect-main` active：5 项必需检查、0 个强制 Approving Review、admin role always-bypass、strict 关闭、squash/merge/rebase 允许 |
| SaaS ruleset | **无**：`/rulesets` 返回空，`branches/main/protection` 404 |
| 开放 PR（开始时） | 后端 #1002（获客 W4，另一会话；会话中已合并）；SaaS 0 |
| 并行会话 | 5 个（1 个 busy：vNext W4 源下沉）；改动限定在文档/CI 面，未触碰他人 worktree 与未提交改动（SaaS 根 `apps/server/src/config/configuration.ts` 保持原样） |

未执行：`git reset --hard`、`git clean`、force-push（我的分支仅在 PR 内 `--force-with-lease` 修正自审措辞）、历史重写、ruleset/仓库设置变更、部署、真实数据操作。

### 1.1 双仓数据所有权核对（G1）

| 对象 | 唯一 SoR | 依据 | 备注 |
| --- | --- | --- | --- |
| Identity / User / Workspace / Membership | gain-saas | ADR-011（身份 SoR 在 SaaS）；gain-saas `docs/technical/adr/0001` | 引擎只验签 JWKS token、消费 workspace/user/role claims |
| CompanyProfile / Offering / Claim / Evidence / ICP / Discovery / Buyer / Contact | backend | product-scope §4、ADR-001/006/007 | 引擎拥有采集、身份、证据、可达性与资格输入 |
| Lead / LeadQualifiedPackage / Outbox / ACK | backend 产出，SaaS 消费 | ADR-001/025、ADR-009 | 交付止于不可变包 + 集成事件；Program C 持有服务端 receipt |
| Campaign / QGO / SAO / Opportunity / Outcome / Conversation | gain-saas | ADR-001、ADR-025、gain-saas ADR-0001 | PRD4-D4 仍登记「QGO 宿主三处相反」，ADR-001 为现行裁决 |
| Budget Grant 签发 / 消费 | SaaS 签发，引擎验签与原子消费 | ADR-024、PRD4-D2 | 平台 Grant 同路径（gain-saas 18446） |
| Suppression / Privacy / Deletion（存储侧） | backend | ADR-010 | SaaS 侧 DSR 级联删除仍未完成（status 页登记） |

结论：未发现两仓同时维护相互冲突的主状态；唯一活的三方矛盾是 PRD4-D4（QGO 宿主），已由 ADR-001 裁决并登记待 PRD 4.0 同步。

## 2. 文档治理（G2/G3）

### 2.1 库存方法

用一次性脚本（不入库）对 `docs/**/*.md` 建立 CSV：路径、标题、文档 ID、生命周期、最后提交、文档入站引用、机器引用（CI/scripts/registry/代码，含无 `.md` 的 slug 形式）。`git ls-tree` 默认会给非 ASCII 路径加引号（`docs/templates/前端技术方案模板.md` 因此被脚本漏计 1 份）；按 `find`/`docs:verify` 口径，会话开始为 **411** 份。

### 2.2 处置结果

| 处置 | 数量 | 说明 |
| --- | --- | --- |
| DELETE（汇编消费） | 119 | `docs/roadmap/changelog.d/` 全部片段，经 `changelog-assemble.mjs` 汇编进 `changelog.md`（PR #1003，dry-run 无告警，docs:verify PASS） |
| DELETE（计划/记录） | 15 | 11 份已交付或显式被取代的 superpowers 计划 + 4 份 CLOSED 且零引用的实施记录（PR #1004，逐文件依据与最后提交 SHA 见 PR 正文） |
| MERGE | 0 | 本轮以删除与承接为主；`docs/README.md` 增加代码地图入口 |
| ARCHIVE | 0 | 无新增归档：删除的 15 份由 Git 历史承担 provenance（规则已在 `documentation-rules.md` §5 写明） |
| HOLD | 保留项 | `docs/frontend/` 19 份（Gate 2–8 批准的目标规范，与 gain-saas 现实的关系需产品决定）；`docs/site-builder/`（冻结线，PRD4-D1 未拍板）；`cost-dimension-settlement`、`contact-point-four-state`（被代码/迁移引用）；`platform-worker-drain-gate`、`channel-crawl-fetch-artifact-scope`（验证未完）；`global-review-remediation`（DRAFT 待产品负责人评审） |
| KEEP（保护） | 全部 | `docs/evidence/` 50 → 保留（零引用也不删）、`docs/releases/` 3、ADR、机器合同、governance registry |

**文档计数**（`find docs -name '*.md'`，与 `docs:verify` 一致）：会话开始 `ef3cc1b5` = **411** → `235d0f41`（#1002）= **412** → 汇编后 `2597471e` = **293** → 删除后 `acb47861` = **278** → PR #1007 新增片段 = **279** → 本报告 = **280**。各分支 `docs:verify` 逐一 PASS（0 errors）。

### 2.3 入口与规则整改

- 后端（PR #1005）：`AGENTS.md` 恢复顺序去掉已退役的 GrowthOS；`docs/README.md` 修正「SaaS 前端仓库未确定」的错误陈述（正式前端在 gain-saas）、按 M2 收官更新进度、新增代码地图导航、把「与 Codex 协作」改为「与 AI 代理协作（Claude Code 主）」。
- SaaS（PR #154）：README 从「模块 01–04」改为完整文档入口表；`AGENTS.md` 只留工程执行规则，12 条 UI 设计准则原样移入 `docs/engineering/ui-design-guidelines.md`；新增 `docs/README.md` 导航；`status/current.md` 校对运行方式（四个 systemd 单元）、移除公开仓库中的演示账号密码、按 backend 证据更正 R4 撤销状态与 4 条过时「下一步」项。
- 工作区（不入库）：`local-config/RUNBOOK.md` §8 恢复顺序同步去掉 GrowthOS。

## 3. PR 与 CI（G4/G5）

### 3.1 近 120 个 PR 审计（只读统计）

| 指标 | 后端 | SaaS |
| --- | --- | --- |
| 已合并 | 115 / 120 | 117 / 120 |
| 纯文档 PR | 11（9.6%），p50 合并 0.1h | 6（5%），p50 <0.1h |
| 代码 PR | 104，p50 0.5h / p90 3.7h | 111，p50 0.1h / p90 1.5h |
| 变更文件 p50 | 9 | — |
| 变更行数 p50 | 676 | — |
| 单日峰值 | 11-08 | 11-08：57 个 PR（M2 冲刺） |

**粒度发现**：后端 11 个文档 PR 中 9 个 ≤2 文件，且集中在同一天——正是 `development-process.md` §2B-1 规定应「同主题攒批」的形态。规则已存在（2026-11-04 起），本轮把它升级为四类变更分类（PR #1006），执行层无需新规则。CI 首轮失败率与重试次数的逐 PR 统计未做（需要逐 PR check-runs 取样）——标记 NOT_RUN。

### 3.2 CI 运行时长（近期运行，只读）

| 工作流 | 样本 | p50 | p90 |
| --- | --- | --- | --- |
| 后端 CI | 30 | 16 min | 19 min |
| 后端 Governance | 29 | 2 min | 2 min |
| 后端 Security | 29 | <1 min | <1 min |
| SaaS CI | 100 | 2 min | 3 min |

### 3.3 实际改动

- **后端 contracts 快通道（PR #1007）**：#776 的 changelog 声称 contracts job 已按 `run_code` 短路，实测从未落地。现按 build-test 同一模式接入：默认运行、仅显式 docs-only 跳过、fail-closed 首步、结构测试锁定。纯文档 PR 的 contracts job 从 **63–88 秒**（#1003–#1006 实测）降到 **21 秒**（本报告 PR 实测）。
- **SaaS CI 分流 + 密钥扫描 + 合同固定（PR #155）**：`classify` job（docs-only 判定，fail-safe）+ 门控 build/e2e + 新增 gitleaks job + 引擎合同离线 pin（`engine-contract.lock.json` + `verify-pin.mjs` + `gen:types` diff + oasdiff breaking）。
  - **真实前后对比**（同一个纯文档 PR 类别）：治理前文档 PR 跑 build-test 1m30s + e2e 2m23s（#154 实测）；治理后文档 PR（#156）`classify` 5s + `secret scan` 12s + build-test 快通道 11s，`e2e` 显式 skipped。
- **SaaS 状态页记录（PR #156）**：记录本次 CI/文档治理并作为快通道的真实旁证。
- **自查发现并修复的并发缺陷（PR #157）**：新 CI 的并发组最初对 main push 共用 `ref`，连续合并时 GitHub 顶掉排队 run——实测 #154 的合并 run 被 cancelled。改为 push 用 commit SHA 分组（与 backend 既有教训一致）。修复后实测：`450576c2`(#157)、`44a10a69`(#158)、`066ca207`(#159) 三笔连续 main push 的 CI 全部 success、无一被取消；修复前的 `8f4cb54a`(#154 合并) 是被取消的对照。
- **规则统一（PR #1006）**：`development-process.md` §2B 改为 T0–T3 四类变更分类（T0 不由目录决定）；worktree 生命周期冲突（「合入即删」vs「默认保留需逐次授权」）统一为「满足清理门 1–5 即删，只删本任务自己的」。
- **测试可靠性（含于 PR #155）**：`outreach-experiments.service.spec.ts` 的账户级 holdout 断言改为本次分配的 `otherRef`，消除约 1.2% 随机盐假红（本 PR 首轮 CI 实测复现）。

### 3.4 重复检查发现（未改，登记）

`pnpm docs:verify` 内含 `pnpm governance:verify`，因此每个 PR 的 `build · typecheck · test` 与 `governance · traceability · release` 两个 job 各跑一次 governance 校验。属 SIMPLIFY 候选；`docs:verify` 是 Copy fixed-source 绑定的根命令，拆分须单独 PR 并重签指纹。

### 3.5 零上下文导航验收（G6）

用无上下文只读子代理按任务书 §6.4 的六问做入口验收。

- **基线轮**（工作树现场：backend `235d0f41`、gain-saas 根 checkout `c4f9c90`，即两仓治理 PR 合并前）：六问全部找到权威答案，共打开 17 份文档（Q1 5、Q2 6、Q3 6、Q4 6、Q5 8、Q6 6），无需额外平行导航层。
- 顺带发现的真实问题：SaaS 当时缺 `docs/README.md`（PR #154 已补）；`gain-saas/docs/technical/phase-1-01-04.md` §6.1 的内嵌模型网关描述已过时；PRD4-D4（QGO 宿主三处相反）与 PRD4-D16（PRD 文本与既有决定冲突）被正确识别为登记在 conflict-register 的开放冲突；`PILOT/GA` 死锁被正确识别。
- **验收轮**（合并后的 `origin/main` 快照）：同一六问 + 5 项治理变更核对（T0–T3 单一表、T0 不由目录决定、worktree 生命周期、引擎合同 pin 与事件缺口、systemd 运行方式、代码地图与 SaaS 前端归属）全部可定位；11 个检查项共 36 次文件读取（每项 1–7 份），仍无平行导航层。
- 复测抓到 3 处残留不一致并已修复：`CONTRIBUTING.md` 仍保留旧的「琐碎/小改/实质」三级分类；`docs/CODEX-NAVIGATION-GUIDE.md` §5.4 仍要求删除 worktree「explicit authorization」；SaaS `docs/README.md` 链接了不存在的 `superpowers/plans/` 并把片段机制误写为「汇编方式同 backend 仓」。前两处随本报告 PR 修复，第三处在 gain-saas #159 修复。

### 3.6 PR 清单

| PR | 仓 | 范围 | 检查 | 状态 |
| --- | --- | --- | --- | --- |
| #1003 | backend | changelog 119 片段汇编 | 5 项必需检查全绿 | MERGED `2597471e` |
| #1004 | backend | 删除 15 份零引用文件 + 文档删除规则 | 5 项全绿 | MERGED `17d26882` |
| #1005 | backend | 入口纠偏（GrowthOS、SaaS 前端归属、代码地图） | 5 项全绿 | MERGED `c7bd3b53` |
| #1006 | backend | T0–T3 分类 + worktree 生命周期统一 | 5 项全绿 | MERGED `acb47861` |
| #1007 | backend | contracts 检查接入 docs-only 快通道 | 6 项全绿（build 46m38s，含 Go race/DB/视觉/OCI） | MERGED `90c22e81` |
| #154 | saas | 文档入口重建 + 状态页纠偏 | build-test + e2e 绿 | MERGED `8f4cb54` |
| #155 | saas | CI 分流 + gitleaks + 合同 pin | 4 job 绿 | MERGED `f0f65359` |
| #156 | saas | 状态页记录（快通道实测） | classify+secret 绿、e2e skipped | MERGED `59a61f8` |
| #157 | saas | main push 并发组修复 | 4 job 绿 | MERGED `450576c2` |
| #1014 | backend | main push 的 governance/security 并发组 | 5 项必需检查全绿 | MERGED `af26b006` |
| #159 | saas | 修复门户悬空链接与不实描述 | 快通道：classify 5s / secret 10s / fast-path 11s / e2e skipped | MERGED `066ca207` |
| #1015 | backend | 本治理报告 + 2 处规则残留修复 | 见本 PR checks（docs-only 快通道） | 本 PR |

## 4. 风险台账（S0–S3）

| ID | 级别 | 风险 | 证据 | 状态 |
| --- | --- | --- | --- | --- |
| R1 | S1 | SaaS `main` 无 GitHub 分支保护 / ruleset | `gh api` 空数组；branch protection 404 | 未修复（ruleset 变更须产品负责人单独授权）；现流程仍走 PR |
| R2 | S1 | PILOT/GA 晋级死锁：无可信外部 provenance readback，verifier 恒阻断 | AGENTS §7、conflict-register PRD4-D12 | 未修复（等拍板）；本轮未伪造任何晋级证据 |
| R3 | S1 | PRD 4.0 批准全文不在可访问仓库（私有目录） | status/current、PRD4-D10 | 登记 `MISSING_AUTHORITY`；未用模型猜测补齐 |
| R4 | S1 | 引擎 outbox 事件 payload 兼容性只有部分机器校验：引擎侧 3/10 事件（LeadQualified / DeletionCompleted / SiteBuildCostSummaryUpdated）有 ajv consumer test，其余 7 个走通用信封；SaaS 消费端不校验引擎事件 schema | 导航验收子代理 2026-11-11 核查（architecture/current §6–7、ADR-009）；gain-saas engine-client README 缺口节 | 已登记；升级合同时人工核对 |
| R5 | S1 | `product-scope.md` 七轴状态表与 M2 实际交付不一致（文档权威漂移） | 表内 Opportunity/Growth Execution 仍为旧基态 | 未修复；需逐轴证据回写（HOLD） |
| R6 | S2 | 依赖漏洞基线 2026-11-14 到期，过期后 main 的 freshness canary 变红 | evidence/security/20261101-baseline-renewal.json | 未修复；需在到期前重绑（P0 backlog） |
| R7 | S2 | 工作区漂移：35 组已合并 worktree 未删；2 个未推送分支 | `gctl doctor` | 未清理（他人/并行会话现场；本会话自己的 5 个 PR 合并后即删） |
| R8 | S2 | `docs/frontend/` 19 份目标规范与 gain-saas 现实的关系未裁决 | docs/README §1.1 | HOLD；需产品决定归档/删除/保留 |
| R9 | S2 | 7 个 manual RLS 套件未接回 CI（既有 G5 卡） | 先前 G5 跟进记录 | 未修复 |
| R10 | S2 | R4 撤销自动触发在 dev `.env` 仍为 `true/true`（测试临时值） | `.env` 只读核验 | 未改（运行配置；按 status 页说明在测试结束后回退） |
| R11 | S2 | SaaS GitHub Actions 仍用 moving tag（`@v4` 等），后端已全部 pin SHA | `ci.yml` | 已部分缓解（新增的 gitleaks/oasdiff 均 pin SHA）；存量待后续 |
| R12 | S3 | `/global` 顶层白名单外：`.pnpm-store`、`.zcode` | `gctl doctor` | 未动（第三方/工具目录；报告用户） |
| R13 | S3 | 14 份零引用 evidence 未进索引（保留但不可导航） | 库存 CSV | 未改（evidence 保护优先） |
| R14 | S2 | 并行会话在 `/global/backend` **根 checkout** 直接修改 3 个获客源文件（违反「根只跟 main」）；根 checkout 因此无法受控同步到新 main，本会话的 `governance-main-worktree-sync apply` 已主动停止 | `git status`（会话中现场观察）；`gctl doctor` | 未动他人改动；根同步 HOLD，待该会话提交/清理后由其 owner 执行 |
| R15 | S2 | `gain-saas/docs/technical/phase-1-01-04.md` §6.1 仍把「内嵌模型网关」写成设计，与 2026-11-03「保持 new-api」决定冲突 | 导航验收子代理核查 | 未改（T1 设计文档，需按决定回写；已进 backlog） |

## 5. 治理机制盘点（G7）

| 机制 | 判定 | 理由 |
| --- | --- | --- |
| `required-contexts.json` + `governance-verify` + CI 拓扑结构测试 | RETAIN | 防「required check 假绿」的核心；本轮还用它安全扩展了 contracts 快通道 |
| `docs:verify`（结构/链接/ID/生命周期） | RETAIN | 零依赖、秒级、拦住文档漂移 |
| changelog 片段 + 汇编器 | RETAIN | 消除多 PR 同文件冲突；119 片段一次汇编验证有效 |
| delivery-traceability + provider registry | RETAIN | 机器真值（34 providers / 11 chains / 168 operations），漂移即失败 |
| environment-parity-policy | RETAIN | 单一产品运行路径的机器执行；当前 24 条登记差异 |
| Copy fixed-source 指纹 + 变异测试 | RETAIN / COMBINE 候选 | 保护受控文件，但重签窗口与 docs:verify 组合命令耦合，拆分需单独立项 |
| RuntimeEvidence / Release Bundle | HOLD | 机制本身必要，但外部 provenance 死锁使晋级不可达；等 PRD4-D12 |
| Skill Runtime（`skill_package`/`skill_version`/`skill_enablement`/解析快照、SKILL.md 校验器、Golden Set CI 层） | RETAIN | 对应 G6.4「AI 产品能力治理」：版本、启停、解析快照与评测门已是机器机制，不需要新制度 |
| 决策卡 / merge-judge | 已退役（2026-09-21） | 无新增 |
| 人工审批步骤 | RETAIN（最小化） | 仅剩 release/部署与 ruleset 变更需用户授权 |

## 6. 运行与安全审计（G8）

- gain-saas 四个 systemd 单元（db/web/worker/jwks-tls）实测 `enabled + active`；4020 监听者属 systemd 进程。文档中的 nohup 指令已移除（PR #154）。
- R4 部署绑定：`gain-saas/deploy/r4/deployment-binding.json` 的 `validUntil` = **2026-11-17T17:04:52Z**（7 天窗口），到期前需随下一次换镜像续期（`gctl switch-backend` 自动）。
- 数据库备份 / 异地副本：**NOT_VERIFIED**（备份目录 root-only，xin 身份无法核验；doctor 未报异常）。用户既有的「等有真实客户数据再做异地副本」决定不变。
- 数据质量：仓库已有 2026-11-09 的三份只读基线——漏斗（2,423 家公司 → fit=match 403 → match 有邮箱 73 / 有电话 4 → 邮箱 VALID 0）、[源记分卡](2026-11-09-source-scorecard.md)（directory 73.8% 被拒/隔离等）与 [RISKY 联系点盘点](2026-11-09-risky-inventory.md)（274 条 RISKY、VALID 0）。本轮**未重跑**这些查询（NOT_RUN），引用前必须重跑；旧快照不代表当前成果。
- 依赖：生产审计零 advisory 的基线有效期至 2026-11-14；含开发依赖的 6 条 advisory 在生产图之外。

## 7. 验证状态

| 项 | 状态 |
| --- | --- |
| `docs:verify`（各 PR） | VERIFIED（PASS，0 errors） |
| `governance-verify` / workflow constants / CI 拓扑测试 | VERIFIED（本地进行，passed / 13 of 13） |
| 后端必需检查（#1003–#1007） | VERIFIED（GitHub checks 全绿，见 PR） |
| SaaS CI（#154/#155/#156） | VERIFIED：#154 build-test+e2e 绿；#155 四个 job 绿；#156 为 docs-only 快通道实测（classify 5s、secret scan 12s、fast-path 11s、e2e skipped） |
| 文档快通道时长（后端 contracts） | VERIFIED：本报告 PR 为纯文档，contracts job **21 秒**通过（旧行为 63–88 秒：完整 install + Prisma generate + contracts/API build + OpenAPI 导出 + drift/spectral） |
| SaaS docs-only 快通道 | VERIFIED（#156 实测：classify 5s、secret scan 12s、fast-path 11s、e2e skipped） |
| main push 并发组修复效果 | VERIFIED（#157 合并后连续三笔 main push 各有独立 run，无一被取消） |
| 运行验证 / 部署 | NOT_RUN（本轮不做部署） |
| 真实数据质量指标 | NOT_RUN（无新 run；不重写旧快照） |
| 数据库备份可读性 | NOT_VERIFIED（需 root） |
| 事件 schema 兼容门 | NOT_IMPLEMENTED（缺口已登记） |

## 8. 未完成与下一阶段 Backlog

**P0**
1. 依赖漏洞基线在 2026-11-14 前续期（backend；否则 main canary 变红）——#1009。
2. PRD4-D12 拍板：Release 外部 provenance 死锁的替代机制（产品负责人；三个候选：可信 readback verifier / 产品负责人签字 / 保留死锁）——#1010。

**P1**
3. SaaS `main` 分支保护（需产品负责人授权 ruleset；建议等价于后端五项语义）——gain-saas #160。
4. 引擎 outbox 事件 schema 兼容门（SaaS CI 对固定事件 schema 做生产者/消费者兼容检查）——#1011。
5. `docs/frontend/` 19 份目标规范的处置决定 + `product-scope.md` 七轴状态表按 M2 交付逐轴回写 + SaaS 技术方案 §6.1 回写——#1012。

**P2**
6. `docs:verify` 与 `governance:verify` 的重复运行去重（需重签 Copy 指纹）；35 组已合并 worktree、2 个未推送分支与 `/global` 顶层条目的归属清理——#1013。
7. SaaS Actions 存量 moving tag 全部 pin SHA（不在本轮 Issue 内，随下次 CI 变更处理）。

## 9. 持续治理（复用现有机制，不新增 bot）

- 每次 PR：`classify` → 适用检查 → 独立自审 → 必需检查全绿 → squash 合并；micro 文档改动攒批。
- 每班发版列车：changelog 汇编（`changelog-assemble.mjs`）+ RuntimeEvidence/Release Bundle 核对（D12 拍板后）。
- 每周（复用 `gctl doctor` + 供应链 canary）：未推送提交、已合并 worktree、依赖基线到期、失败 CI。
- 每月：文档生命周期（零引用清单）、provider/源质量记分卡（`scripts/metrics/source-scorecard.mjs`）、恢复能力演练。
