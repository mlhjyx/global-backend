# 获客挖掘 vNext：去平台预算帽、实体级深度与可复验的覆盖率

> 生命周期：`APPROVED`
> 依据：产品负责人 2026-11-10 决定——「预算不是平台决定的：客户充值费用，就应该查询所有能查询的，按实际花费扣除」；「要的是更深入的版本，而不是一个更大的版本」；并对四问研究（专家实践 / 原始素材 / 方法工具 / 第三方证伪）逐条「同意，实施」。

## 1. 问题与方向

现状：挖掘的产出被**平台侧产品上限**（`MAX_DISCOVERY_PROVIDER_RECORDS=25`、`DISCOVERY_RUN_POOL_CAP=500`、`DISCOVERY_STRUCTURED_SOURCE_RUN_CAP=100`、工具环轮数/搜索数等）钳制；这些上限与客户付费意愿无关。方向改为：

1. **计费模型**：删除平台产品上限；唯一收紧条件是**客户余额/预付授权**。执行前经现有 quote/grant 以余额准入，执行中**逐次调用按实际花费结算扣减**（既有 execution budget 账本已是逐次结算，本改造是去掉包络里的人为上限、把授权上限锚定到余额）。
2. **深度模型**：不做「同样的东西更大」，做「对每个 ICP 更深」——实体级消歧、原始源下沉、可复验的覆盖率与精确率、源边际产出会计、主动学习、可触达性一世量。

## 2. 总目标（可复验验收）

- **精度**：golden set（≥100 家人工确认的 ICP 命中/未命中）上 precision@10 报告；
- **覆盖率**：双源捕获-再捕获（Chapman 估计）给出每个「地区×品类」召回区间；与官方注册计数对比覆盖；
- **深度**：每条公司记录可追溯到法人实体（LEI/VAT/HRB/SIREN 至少一键）与≥1 条可复验证据（快照哈希+持久回执）；
- **产出会计**：每源每美元「新增合格公司」、每合格线索成本、可发信率/电话可通率入 metrics；
- **对账**：调用用量 ↔ 结算 ↔ 客户余额三方一致（账单页与 API 可查）；
- **证伪**：与付费数据商（Apollo/Hunter/PDL）同 ICP 抽样对账报告；第三方可凭快照与回执重放任一记录。

## 3. 工作流分解

### W1 去帽 + 余额闸（执行与计费模型）
- 去帽清单：`MAX_DISCOVERY_PROVIDER_RECORDS`、`DISCOVERY_RUN_POOL_CAP`、`DISCOVERY_STRUCTURED_SOURCE_RUN_CAP`/`DISCOVERY_TRIAL_*`、`MODEL_WEB_SEARCH_MAX_ROUNDS/TOOL_CALLS`、`QUICK_SCAN_POOL_LIMIT`、按查询的 `sourceQueryBudgets` 上限。全部改为「余额准入 + 限流/合规」语义；安全上限保留为**远高于余额可支付范围**的防爆界（防失控，不是产品帽）。
- quote/grant：授权上限 = min(估算包络, 客户可用余额)；余额耗尽 = 唯一执行停止条件（§27 既有审计）。
- 结算：沿用逐次 settle；新增「本次 run 成本」汇总端点与 metrics。
- 回退开关：`DISCOVERY_UNCAPPED=off` 恢复旧包络。
- 验收：一次「全源全量」run 在不触碰任何产品帽的情况下按余额结算停止；账单三方对账一致。

### W2 实体级消歧与公司图谱
- 新表：`legal_entity`（LEI/VAT/HRB/SIREN/CH number/名字/地址/状态/来源证据）、`company_legal_link`（canonical_company ↔ legal_entity，含置信度与判定来源）、父子/集团边。
- 匹配：确定性键优先（LEI/VAT/注册号，VIES 校验 VAT）；无键时 Fellegi–Sunter 概率匹配（blocking on 国家+名字归一+域名；字段权重表），阈值双档（auto/link-review）。
- 合并策略：不自动合并两个已存在 canonical 公司，只产出 link 候选进人工复核；法人级去重（同名异地、子公司）。
- 验收：golden 实体对（同一法人的多源记录、同名异法人反例）上 F1 报告；每 ICP 产出「法人级」计数。

### W3 评估学与产出会计
- golden set 工具：标注队列 + 版本化快照（`evaluation_set`/`evaluation_label`）；precision@k 报告端点。
- 捕获-再捕获：任选两条相互独立源的重叠计数 → Chapman 估计与置信区间（`coverage_estimate`）。
- 边际产出账本：`source_yield_ledger`（run/源/查询/花费/新增合格），季度砍源报表。
- 对账：`billing_reconciliation` 视图（tool/model 用量 ↔ 结算 ↔ 余额）。
- 验收：上述四类报告可直接从 API/metrics 取数并在文档留证。

### W4 原始源下沉（P0 → P1）
- P0：OpenCorporates（按国家批量拉注册实体）、Companies House、INSEE SIRENE、Handelsregister/Unternehmensregister（德，经 OpenCorporates 或官方接口）、GLEIF 全量 LEI 增量、VIES 校验；展会参展商原始目录（Hannover Messe/IFAT/Messe Frankfurt exhibitor list）；本地语言词表（德/法/意/西）接入查询计划。
- P1：TED/SAM 中标库反推买家、Europages/Kompass/WLW（先过 ToS 矩阵）、认证库（CE NANDO/ISO）、破产公告（负名单）。
- **合规矩阵**：`source_compliance_matrix`（源/许可/robots/ToS/个人数据/保留期/责任人），未登记不许上线（工具 broker 引用它做准入）。
- 验收：P0 每个源有装载器 + 合规登记 + 边际产出初始数据；本地语言查询计划对德/法市场各出一次真实 run。

### W5 主动学习循环
- 复核/审批数据 → 源权重与 fit 阈值的重校准任务（离线批处理 + 版本化阈值）；阈值变更走审批与回滚点。
- 验收：一轮「驳回样本 → 阈值更新 → 下一 run 命中率变化」的可复现实验报告。

### W6 可触达性一等指标 + 纵向监测接入
- 可发信率/可通率进入 metrics 与源评估；信号栈（changedetection/RSSHub→company_signal）接入「时机排序」评分。
- 验收：run 报告含可触达率；信号触发的公司排序实验报告。

## 4. 数据模型增量（迁移）

`legal_entity`、`company_legal_link`、`source_compliance_matrix`、`source_yield_ledger`、`evaluation_set/evaluation_label`、`coverage_estimate`；均带 workspace RLS（平台级表除外：compliance matrix 为平台表）。迁移时间戳由实施会话按 READY/GO 协议申领。

## 5. 与既有资产的裁决

- 保留：证据包/佐证门、判定与复核、durable 回执/血缘、metrics、信号栈、`model_web_search`（两段式，DeepSeek 执行器为深度检索执行面）。
- 废止：以「调大产品上限」为目的的改动（如 `MAX_DISCOVERY_PROVIDER_RECORDS 25→50` 取消）；env 里临时调高的帽子由 W1 取代。
- 文档：本计划入 `docs/superpowers/plans/`；实施证据入 `docs/evidence/`。

## 6. 里程碑

1. M1：W1 + W3（去帽/余额闸 + 评估学基线）——先立「数说得清」。
2. M2：W2 实体图谱 + W4 P0 前两源。
3. M3：W4 其余 + W5；W6 并行小步。

每个工作流独立 PR、独立 worktree；跨会话共享夹具（execution-authority policy 计数、task-registry 精确集合、Copy 指纹、迁移时间戳）按 READY/GO 串行放行（见记忆 `parallel-session-pr-coordination`）。
