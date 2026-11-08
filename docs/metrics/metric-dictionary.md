# GainOS 指标字典 v1

> 文档 ID：`METRICS-DICTIONARY-001`
> 版本：`v1.2`（2026-11-09；v1.0/v1.1 同日发布，changelog 见 §8）
> 生命周期：`DRAFT`（人工权威版；机器可读版见 `docs/metrics/dictionary/` + `scripts/metrics/metrics-lint.mjs`）
> 状态：`DRAFT`
> 依据：《GainOS 深化计划 v3.0》第 1 章 §3.1（指标树、VRIC 口径、RR1/RR3、分层、窗口、置信区间）与 §3.1.5 指标主表
> 外部基准：逐条标注 URL；未能当日核实的数字标「待核」（沿用 ch01 §7.4）

本字典是 GainOS 全部效果指标的**唯一口径来源**。任何周报、看板、对外汇报引用的指标必须能在这里找到唯一 ID、版本、分子、分母、排除项、观察窗口与分层方式；口径变更必须升版本并记录 changelog（§8）。实现代码、SQL、看板必须引用 `指标 ID + 版本`，禁止裸字符串。

本版为**只读基线版**：定义与现状读数均来自对 `global_dev` 的只读查询（2026-11-08 审计 + 2026-11-09 复核），不改变任何主链行为。

---

## 0. 阅读顺序与角色

| 角色 | 先读 |
| --- | --- |
| 要报数/写周报的人 | §1 通用规则（含 §1.8 报告格式） |
| 要实现指标查询的人 | §2 数据来源映射 → §3 指标全集 |
| 要改口径的人 | §7 版本与变更流程 → §8 changelog |
| 要对照行业基准的人 | 各指标行的「目标/基准」列（含 URL） |

Owner 均为责任角色而非个人：`data-eng`（数据工程）、`backend`（引擎后端）、`gtm-ops`（运营）、`product`（产品负责人）。

---

## 1. 通用规则（所有指标默认继承）

### 1.1 作用域与去重

- **workspace 作用域**：所有租户口径指标必须显式带 `workspace_id`；跨租户聚合仅在平台级指标（frame、CR、源记分卡）中使用，且对外展示时去掉 `workspace_id` 维度。
- **公司级去重**：一律按 `canonical_company.id` 去重——同一公司多条 lead（多 ICP）只算 1 个账户，除非指标显式声明按 lead 计。
- **人级去重**：按 `canonical_contact.dedupe_key` 去重；同一人多条邮箱只算 1 人。
- **测试租户识别**：当前库内 12 个 workspace 中仅 `c3584cf9-1a6b-4e7e-9b0c-c1bdcc8258e5`（主租户）为真实业务租户，其余为 E2E/验收/夹具租户。任何面向业务的读数必须**同时**报全库值与主租户值；测试租户的数据不得计入「真实租户」结论（2026-11-08 审计：23 条 QUALIFIED 全部落在测试 workspace）。

### 1.2 邮箱四态（一切「可触达」指标的前提）

`contact_point.status` 的取值语义（本字典强制）：

| 状态 | 含义 | 能否进入可触达分子 |
| --- | --- | --- |
| `VALID` | 经邮箱级验证（SMTP RCPT / 双验证器 / 运营确认）且非 catch-all | ✅ 仅当同时满足 §1.3 其余条件 |
| `RISKY` | 未验证的猜测地址、catch-all、或验证结论不确定 | ❌ |
| `UNVERIFIED` | 从未尝试验证 | ❌（只计入「有邮箱」覆盖率的分母/分子，不计入 VALID 率分子） |
| `INVALID` | 硬退信或验证器判死 | ❌ |

**「有邮箱」≠「可用邮箱」**：`email_coverage_rate` 统计「存在任一 email 类型联系点（不论状态）」；`email_valid_rate` 只统计「已尝试验证（VALID/INVALID/CATCH_ALL/UNKNOWN 四态已裁决）」中的 VALID。两者分母不同，禁止混用（2026-11-08 审计发现同一「邮箱覆盖率」在代码/文档/汇报中存在三种口径）。

**明确不进入任何可触达分子**（ch01 §1.4）：`pattern_guess` 且无二次验证的地址、`CATCH-ALL-RISKY`、`UNKNOWN`、`UNVERIFIED`、`INVALID`、职能邮箱（`email_type ∈ {role, generic_sales, procurement, finance, support}`）、无姓名/无角色的匿名邮箱、已 bounce/退订/投诉/DNC 的人、仅 LinkedIn URL 未验证的「联系点」。

### 1.3 VRIC 精确口径（T0 北极星）

**名称**：Verified Reachable ICP Contacts per 1,000 ICP accounts（每 1,000 个 ICP 账户的已验证可触达决策人）。

```text
VRIC_1000(icp, asOf) = 1000 × |V(icp, asOf)| / |A(icp, asOf)|

A（ICP 账户集合）：
  - canonical_company 属于该 workspace；
  - 该 ICP 的 lead 存在 fit_verdict = 'match'（Lead.fitVerdict）；
  - lead.status 不在 REJECTED（并排除 suppression/制裁 hold 的 lead）；
  - 按 canonical_company_id 去重；
  - 仅统计公司 status ∈ ('NEW','ENRICHED')（SUPPRESSED 不计）。

V（已验证可触达决策人集合），逐条满足：
  1) 人属于 A 中某账户（canonical_contact.company_id ∈ A）；
  2) 决策人角色：seniority ∈ {c_level, vp, director, manager} 且
     department 命中该 ICP 的 Persona/BuyingCommitteeRole 目标，或 title 命中词表；
     title/seniority 缺失时不计入（宁可漏，不可错）；
  3) 至少一条通道已验证：
     email（STRICT）：status='VALID' AND catch_all='not_catch_all'
       AND verification_method ∈ {'smtp_rcpt','provider_reported','operator'}
       AND verified_at ≥ asOf − 180 天；
     phone（PLUS）：status='VALID' AND line_type ∈ {'mobile','landline'}
       AND verified_at ≥ asOf − 90 天（phone 的 VALID 需每季度 50–100 通人工抽呼校准）；
  4) 未被 suppression：不在 workspace suppression / OutreachGlobalSuppression；
     consent 台账最新状态 ≠ OPT_OUT；
  5) 有合法依据：contact_point.legal_basis 非空；DE/IT 的 email 触达需要 consent=OPT_IN（P4 执行层校验）；
  6) 人级去重：按 canonical_contact.dedupe_key。
```

**两口径**：

- `VRIC_1000_STRICT`（T0-001）：只认 email VALID；用于对外承诺与销售口径。
- `VRIC_1000_PLUS`（T0-002）：email VALID 或 phone VALID；用于内部运营与电话渠道市场。
- 两口径在看板并列展示；对外只引用 STRICT，且必须带 95% CI、样本量、验证器版本与数据日期。

**反作弊约束**：每次对外报 VRIC 必须同时报「账户数、分子数、CI、验证器版本、金标 `email_valid_precision`、数据日期」，缺一项视为无效声明；`email_valid_precision < 0.95` 时对外口径降级为「估计值」，不得用于合同/SLA。

**当前基线（2026-11-09 只读复核）**：全库 match 账户 403、STRICT 分子 0 → `VRIC_1000_STRICT = 0`；主租户 match 账户 128、STRICT 分子 0。0 应读作「从未验证 + 写入缺溯源」，不是市场否定判决（ch01 §2.2）。

#### 1.3.1 VRIC_1000_PLUS 口径细则（内部运营口径）

`VRIC_1000_PLUS` 与 STRICT 共用账户集合 A 与人级去重（§1.3-6），差别只在「已验证通道」：

```text
人的通道判定（PLUS）：
  email_ok = status='VALID' AND catch_all='not_catch_all'
             AND verification_method ∈ {'smtp_rcpt','provider_reported','operator'}
             AND verified_at ≥ asOf − 180 天；
  phone_ok = type='phone' AND status='VALID'
             AND line_type ∈ {'mobile','landline'}          -- Twilio Lookup；schema 待 P1 加列
             AND verified_at ≥ asOf − 90 天
             AND 该国家/市场的季度人工抽呼校准已完成（50–100 通，connect_rate 与 wrong_number_rate 记录在案）；
  人计入 PLUS ⇔ (email_ok OR phone_ok)，同一人只计 1 次；同时有两条通道仍计 1 人。
```

强制规则：

- **通道拆分必须同时报告**：`VRIC_PLUS = email_only + phone_only + both`，其中 `phone_only` 是电话线市场价值的直接证据；只报总数视为口径不全。
- **PLUS 只用于内部运营与电话渠道评估**；对外承诺、合同与 SLA 只能引用 STRICT。
- **不可用条件**：`line_type` 为 `voip/unknown`、抽呼校准缺失、或号码来源为 `pattern_guess` 的，不计入 `phone_ok`。
- **引擎侧部分实现**：`scripts/metrics/funnel-baseline.mjs` 目前只能校验 `status/verified_at/seniority`——`line_type` 与抽呼校准在 SaaS/Twilio 侧，未接入前 PLUS 是**上界**，报告必须标「引擎侧」。
- **当前基线（2026-11-09）**：全库 phone VALID 0 条（30 条 phone 全部 UNVERIFIED，且全在 E2E 租户），`VRIC_1000_PLUS = 0`，通道拆分 0/0/0；PLUS 在 P1 电话验证补齐前无统计意义（n<30 规则）。

### 1.4 回复口径 RR1 / RR3（强制成对报告）

**术语**：`send_attempt`＝一次真实 SMTP 提交（`outreach_send` 一行；同一草稿重试 attempt+1）；`delivered`＝ESP webhook 或 SMTP 250 后无 DSN；`reply_human`＝收件人本人/同事的人工回复，排除自动回复（OOO、ticket、mailer-daemon）、退信 DSN、退订请求、内部测试、重复线程（同一 contact 同一序列只计首次）；`unknown_deliverability`＝发往 UNKNOWN/CATCH-ALL-RISKY 且未收到 DSN 的发送量。

```text
RR1 = |unique_human_replies| / |eligible_send_attempts|
  eligible_send_attempts = send_attempt
    − suppression/DNC 跳过（SKIPPED）
    − 内部/测试/种子地址
    − 同一 draft 的重复重试（attempt>1 只计 1 次）

RR3 = |unique_human_replies| / ( |delivered| + ê × |unknown_deliverability| )
  ê = 过去 90 天、同国家 × 同验证器 × 同 MX 类型分层的可送达率 = 1 − hard_bounce_rate(该分层)
```

**成对报告规则（硬性）**：任何回复率数字必须写成 `回复率：RR1 x%（分子/发送）；RR3 y%（分子/投递 + ê×未知）`。只报一个口径视为无效声明。RR1 对标 Belkins 0.45%（unique replies ÷ emails sent），RR3 对标 2–4.5% 平台口径；两者回答的问题不同（每封的端到端效率 vs 到达收件箱后的内容效率）。

**机器实现（唯一入口）**：`scripts/metrics/reply-rate.mjs`——按分层计数（sent/skipped/internal/duplicateRetries/delivered/unknown/replies + 分层 `eHat`）计算 RR1/RR3 并打印成对声明；`unknown>0` 而缺 `eHat` 时拒绝出数（RR3 不可算）。`--check <statement>` 校验任何人工写的回复率声明：缺 RR1 或 RR3、或只有裸百分比没有分数，判失败。周报/看板/导出必须调用它，禁止手写单口径。

**归因窗口**：回复归因 30 天；跨序列回复归因到最近一次发送；退订/投诉单独计数，不计入回复。

### 1.5 观察窗口与时间语义

- 时间戳统一 UTC；ISO 周按 `date_trunc('week', ts)`（周一起）。
- 三类窗口：`snapshot`（时点状态，按周固化，历史快照不重写）、`rolling`（过去 N 天事件聚合，默认 30 天，bounce 用 7 天）、`cohort`（按发送批次/月份跟踪，归因窗口 30/90 天）。
- 迟到事件：`occurred_at` 与 `received_at` 分开；聚合按 `occurred_at`，允许 72 小时迟到；超过 72 小时的更正走重算任务，不改历史快照。
- 时区陷阱：德国/法国本地周与 UTC 周不同；对外周报固定 `Europe/Berlin` 展示、UTC 计算，页脚注明。

### 1.6 分层维度（strata）

所有指标默认支持以下维度，实现上以 `stratum` JSONB 存储（避免宽表爆炸）；指标行里只写收窄/覆盖：

```text
country（ISO 3166-1 alpha-2，统一大写；「德国」等本地写法必须在入库/查询时归一为 DE——当前库内 DE 与「德国」并存，直接破坏分层）
industry（NACE Rev.2 2 位 / SIC 2 位；无值记 UNKNOWN，不丢弃）
employee_band（1-10 / 11-50 / 51-200 / 201-500 / 501-1000 / 1001-5000 / 5000+）
source_class（registry / directory / trade_fair / association / public_web / search / wikidata / paid_vendor / import）
provider_key（具体源：directory / public_web / wikidata / ted / openfda …）
channel（email / phone / linkedin / form）
verifier（zerobounce / millionverifier / emailable / smtp_probe / operator）
persona_role（c_level / vp / director / manager / unknown）
icp_id
workspace_id（仅内部；对外聚合去掉）
week（ISO week，UTC 周一起）
```

约定：分母 < 30 的 stratum 只展示点估计 + 「样本不足」标记；< 10 不展示。对外报告至少按 country × industry 两层切片；内部运营看板默认 country × source_class。`UNKNOWN` 必须显式展示，禁止默认丢弃。

### 1.7 置信区间、样本量与显著性

- **比例指标**用 Wilson score interval（z=1.96）。±5pp 精度需要：p=0.5 约 384 条，p=0.9 约 141 条。小样本（n<30）只报区间与原始计数，不做「达标/不达标」结论。分层汇总按账户数/实体数加权，禁止把各层比例简单平均。
- **连续指标**（成本、时长、N̂）用 bootstrap（1,000–10,000 次，按实体/账户重采样）给 95% CI；报告 median 与 IQR；N̂ 的 CI 必须用捕获历史重采样，不能对点估计套正态近似。
- **实验**：<500/arm 不做频率派显著性（改定性复盘/序贯）；500–2,000/arm 用 Bayesian/sequential；>2,000/arm 才用固定窗口频率派。多重比较用 Benjamini–Hochberg 控制 FDR（q=0.1）；主指标预注册。
- **漂移**：PSI 固定 10 个等频箱；0.1 关注、0.25 告警（经验阈值，需按样本量校准）。

### 1.8 报告格式（强制）

```text
指标：email_valid_rate v1
口径：30 天滚动；分母=已尝试验证邮箱；排除 role 邮箱出分子
结果：0%（0/274），Wilson 95% CI [0%, 1.4%]
分层：DE … / 主租户 …
数据日期：2026-11-09；验证器：smtp_probe（域名级，未做邮箱级 RCPT）
```

---

## 2. 数据来源映射（口径 ↔ 现有表）

| 指标族 | 现有可查表（2026-11-09 实证） | 尚缺（ch01 拟定新增） |
| --- | --- | --- |
| 账户/漏斗（T0/T1 部分、T2 覆盖率） | `canonical_company`、`lead`（status/queue/fit_verdict/icp_id）、`canonical_contact`、`contact_point`、`company_contact_channel`、`company_contact_point`、`company_channel_sighting` | — |
| 来源归因（T1 源指标） | `raw_source_record`（`provider_key`、`source_class`、`ingest_status`、`disposition_code`）、`identity_link`（company ↔ raw，当前每条公司恰 1 个 provider） | `frame_registry` / `frame_snapshot`（frame 族） |
| 判定质量（T1-005/006、G-004） | `lead.fit_verdict` / `fit_reasons`、`icp_backtest`、`run_shadow_diff`、`lead_decision`、`lead_outcome`、`icp_feedback` | `golden_*` 四表、金标数据集 |
| 验证（T2） | `contact_point.status/verified_at/verification_method/catch_all`、`tool_budget_operation`（`result_schema='smtp-probe-verdict/v1'`） | `contact_point_verification_event` |
| 运行与失败（G/诊断） | `discovery_run`、`discovery_company_job`、`run_event`、`tool_budget_operation`（成本） | `metric_observation` / rollup 表 |
| 触达/回复（T3/T4） | 不在本库；SaaS `outreach_send` / `outreach_reply` / `cost_ledger`（P4 前 DRAFT） | 同上 + `metric_rollup_*` |
| 召回（T1） | `docs/metrics/frames/frame-registry.v1.json`（19 法域登记，校验器 `scripts/metrics/frame-registry.mjs`）；`scripts/metrics/capture-recapture.mjs`（两源 Chapman + 三源 log-linear） | `frame_registry`/`frame_snapshot` 表 + `cr_estimate`（PR-10/11/13 后续） |
| 金标（T1-005/006、G-004/005） | `evals/golden-discovery/`（抽样 manifest 模板 + schema）+ `scripts/metrics/golden-sampling.mjs`（确定性分层抽样） | 真实样本、标注 rubric、`golden_*` 四表与 runner（PR-07/08） |

**计数漂移**：本字典引用的库内计数是 2026-11-08 / 11-09 单时点快照，会随运行漂移；引用前先重跑 `scripts/metrics/funnel-baseline.mjs` 与 `scripts/metrics/risky-inventory.mjs`（只读）。

---

## 3. 指标全集（v1，44 个）

> 列说明：**分子 / 分母**为口径表达式（表名指向现有表或 §2 拟定表）；**排除项**只写该指标特有部分（§1.2 的通用排除仍然生效）；**窗口**沿用 §1.5 词汇；**strata** 列只写对 §1.6 默认集的收窄/覆盖。所有指标 version=1，effectiveFrom=2026-11-09。

### 3.1 T0 北极星

| ID | 指标 | 单位 | 分子 | 分母 | 排除项 | 窗口 | strata | 状态 | 目标/基准 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| T0-001 | `vric_1000_strict` | count_per_1000 | 人级 VRIC（email VALID，§1.3） | ICP match 账户数 | §1.3 全部排除 | snapshot/周 | 默认 | ACTIVE（引擎侧） | ≥50（P1 首个内部目标）；当前 0 |
| T0-002 | `vric_1000_plus` | count_per_1000 | 人级 VRIC（email 或 phone VALID，§1.3/§1.3.1；输出 email_only/phone_only/both 通道拆分） | 同上 | 同上 | snapshot/周 | 默认+channel | ACTIVE（引擎侧；phone 的上界性质见 §1.3.1） | ≥80（内部）；当前 0（0/0/0） |

### 3.2 T1 覆盖与召回（市场分母）

| ID | 指标 | 单位 | 分子 | 分母 | 排除项 | 窗口 | strata | 状态 | 目标/基准 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| T1-001 | `universe_estimate_n` | count | CR 模型估计 N̂（Chapman/log-linear） | — | 见 §6 CR 规则 | 季度 | 默认 | DRAFT | 只报区间，无硬目标 |
| T1-002 | `company_recall_vs_frame` | ratio | frame 抽样中被我们发现的实体数 | frame 抽样实体数 | 已关闭/非 ICP 先剔除 | 月度 | 默认 | DRAFT | 首测基线；季度提升 ≥5pp |
| T1-003 | `company_recall_vs_estimate` | ratio | 我们发现的唯一实体数 | N̂（T1-001） | 同上 | 季度 | 默认 | DRAFT | 报告区间 |
| T1-004 | `domain_resolution_rate` | ratio | 有已验证域名的公司数（`canonical_company.domain` 非空且经 P2 校验） | 需解析域名的公司数（剔除无官网/仅线下） | 目录类源天然无域名，单列 | 月度 | 默认+provider_key | DRAFT（当前只能算「domain 非空」：全库 76.1%） | ≥70%（P2） |
| T1-005 | `fit_precision_golden` | ratio | 金标中模型判 match 且人工判 match | 金标中模型判 match | 抽样标注口径 | 月度 | 默认 | DRAFT | ≥90%（底线 80%） |
| T1-006 | `fit_recall_golden` | ratio | 金标中人工判 match 且模型判 match | 金标中人工判 match | 同上 | 月度 | 默认 | DRAFT | ≥85%（底线 75%） |
| T1-007 | `source_unique_contribution` | ratio | 仅该源贡献的实体数 | 该源实体数 | 重复/非 ICP | 月度 | provider_key | DRAFT | 低于 5% 降权 |
| T1-008 | `source_accept_rate` | ratio | ACCEPTED raw 记录（`raw_source_record.ingest_status`） | 总 raw 记录 | 按 provider 分层 | 日/周 | provider_key | ACTIVE（只读实现） | 目录 ≥90% |
| T1-009 | `rejection_reason_distribution` | distribution | 各 `disposition_code` 计数 | 带 `disposition_code` 的记录总数（含 REJECTED 与 QUARANTINED；2026-11-09：2,408 + 1,255 行中 3,663 行有码，含 868 SOURCE_POLICY_MISSING / 387 PROCESSING_KEY_DRIFT） | — | 周 | provider_key | ACTIVE（只读实现） | 无单一原因 >50% |
| T1-010 | `frame_freshness_days` | days | asOf − frame 最后更新 | — | — | 日 | frame_key | DRAFT | 核心 frame ≤35 天 |

### 3.3 T2 可触达（联系人）

| ID | 指标 | 单位 | 分子 | 分母 | 排除项 | 窗口 | strata | 状态 | 目标/基准 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| T2-001 | `email_coverage_rate` | ratio | 有 ≥1 邮箱（任意状态，`contact_point.type='email'`）的 match 账户 | match 账户 | 仅公司通道（`company_contact_channel`）不算「有联系人邮箱」 | 周 | 默认 | ACTIVE | 对标 80%+（Clay 瀑布 85–95%：https://www.clay.com/guides/waterfall-enrichment ）；当前 18.1%（73/403）、0 VALID |
| T2-002 | `email_valid_rate` | ratio | VALID 邮箱（且非 catch-all） | 已尝试验证邮箱（VALID/INVALID/CATCH_ALL/UNKNOWN 四态已裁决） | role 邮箱出分子留分母；同邮箱 7 天内重复验证按最新裁决去重；bounce 回写视为 INVALID 且优先于验证器 | 30 天滚动 | 默认+verifier | ACTIVE | ≥70%（对照 70–85%，BounceZero：https://bouncezero.io/b2b-contact-database-provider ）；当前 0/274 |
| T2-003 | `catch_all_rate` | ratio | CATCH-ALL-RISKY | 已尝试验证 | — | 30 天滚动 | 默认+verifier | ACTIVE | 10–30% 为常态；当前 0（全部未验证，非「没有 catch-all」） |
| T2-004 | `unknown_rate` | ratio | UNKNOWN | 已尝试验证 | — | 30 天滚动 | 默认+verifier | ACTIVE | 越低越好；当前不可测（0 条邮箱级裁决） |
| T2-005 | `phone_fill_rate` | ratio | 有 phone 联系点的 match 账户 | match 账户 | 公司总机不算（人级 phone 才计入） | 周 | 默认 | ACTIVE | ≥40%（对照 40–65%，Explorium：https://www.explorium.ai/blog/data-for-gtm/b2b-data-api-match-rate-benchmarks/ ）；当前 4/403=1.0% |
| T2-006 | `phone_connect_rate` | ratio | 人工抽呼接通 | 抽呼号码 | 空号/错号单列 | 季度 | 默认 | DRAFT | 报告 |
| T2-007 | `contact_role_coverage` | ratio | 有决策人角色（seniority ∈ c_level/vp/director/manager 或 title 命中）的 match 账户 | match 账户 | 角色未知不算 | 周 | 默认 | ACTIVE | ≥60% |
| T2-008 | `contacts_per_matched_account` | ratio | 联系人总数（去重） | match 账户 | 去重 | 周 | 默认 | ACTIVE | ≥2.0 |
| T2-009 | `verification_freshness_ratio` | ratio | 90/180 天内验证的已验证点 | 已验证点 | — | 周 | 默认+channel | ACTIVE | ≥90% |
| T2-010 | `cost_per_valid_contact` | usd | 富化+验证+人工成本（`tool_budget_operation` 实扣口径） | VALID 联系人数 | 含失败成本 | 月 | 默认 | DRAFT | 报告；目标 ≤$0.80 |

### 3.4 T3 互动（触达后；P4 前全部 DRAFT）

| ID | 指标 | 单位 | 分子 | 分母 | 排除项 | 窗口 | strata | 状态 | 目标/基准 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| T3-001 | `delivered_rate` | ratio | delivered（§1.4） | eligible_send_attempts | 见 §1.4 | 30 天滚动 | 默认 | DRAFT | ≥95% |
| T3-002 | `reply_rate_rr1` | ratio | unique human replies | eligible sends | 见 §1.4；成对报告 | 30 天滚动 | 默认 | DRAFT | 对照 0.45%（Belkins：https://belkins.io/blog/cold-email-response-rates ） |
| T3-003 | `reply_rate_rr3` | ratio | unique human replies | delivered + ê×unknown | 见 §1.4；成对报告 | 30 天滚动 | 默认 | DRAFT | 对照 2–4.5%（Smartlead：https://www.smartlead.ai/benchmarks/average-cold-email-reply-rate ） |
| T3-004 | `positive_reply_rate` | ratio | positive 回复（`OutreachReply.classification`，经金标校准） | 同 RR3 分母 | OOO/自动回复 | 30 天滚动 | 默认 | DRAFT | 报告 |
| T3-005 | `meeting_booked_rate` | ratio | 已预约会议（contact+日历事件 ID 去重） | 同 RR3 分母 | 重复会议 | 30 天滚动 | 默认 | DRAFT | 报告 |
| T3-006 | `meetings_per_1000_delivered` | count_per_1000 | held meetings | delivered/1000 | — | 月 | 默认 | DRAFT | 对照 3–10 |
| T3-007 | `reply_rate_per_contact` | ratio | unique human replies | 序列触达的联系人数 | 与 RR1/RR3 同回复定义 | 30 天滚动 | 默认 | DRAFT | 对照 Smartlead 中位 0.74%/联系人 |

### 3.5 T4 商业（P4 前全部 DRAFT）

| ID | 指标 | 单位 | 分子 | 分母 | 排除项 | 窗口 | strata | 状态 | 目标/基准 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| T4-001 | `meeting_held_rate` | ratio | held | booked | 取消/爽约单列 | 月 | 默认 | DRAFT | ≥60% |
| T4-002 | `opportunity_rate` | ratio | opportunity | held | 阶段须预先定义 | 月 | 默认 | DRAFT | 30–50% 锚点 |
| T4-003 | `pipeline_usd_per_1000_accounts` | usd_per_1000 | pipeline USD（去重） | ICP 账户/1000 | — | 季度 | 默认 | DRAFT | 报告 |
| T4-004 | `cost_per_meeting` | usd | 全载成本（工具+人力） | held meetings | — | 月 | 默认 | DRAFT | 邮件 $150–400（Bridge Group 2025：https://blog.bridgegroupinc.com/hubfs/resources/TBG%202025%20Sales%20Development%20Report.pdf ） |
| T4-005 | `cost_per_opportunity` | usd | 全载成本 | opportunities | — | 季度 | 默认 | DRAFT | 报告 |

### 3.6 Guardrail（红线）

| ID | 指标 | 单位 | 分子 | 分母 | 排除项/说明 | 窗口 | strata | 状态 | 阈值 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| G-001 | `bounce_rate_hard` | ratio | hard bounces | delivered+sent | 软退信连续 3 次按硬退 | 滚动 7 天 | 默认 | DRAFT（P4 接线） | <2% 目标；≥5% 停发 |
| G-002 | `spam_complaint_rate` | ratio | complaints | delivered | — | 滚动 7 天 | 默认 | DRAFT（P4 接线） | <0.1%；0.3% 硬线（SES：https://docs.aws.amazon.com/ses/latest/dg/faqs-enforcement.html ） |
| G-003 | `suppression_hit_rate` | ratio | 被 suppression 拦截的发送 | 命中 suppression 的名单 | — | 实时 | 默认 | DRAFT | 必须 100% |
| G-004 | `judge_human_agreement` | kappa | judge 与人工一致（Cohen's κ） | 人工标注样本 | 按任务分层；与每位标注者分别比较 | 月 | 默认+task | DRAFT | κ ≥0.6（目标 0.8） |
| G-005 | `annotation_kappa` | kappa | 双人一致 | 双标样本 | — | 每次标注 | 默认+field | DRAFT | ≥0.6 才发布金标 |
| G-006 | `psi_drift` | index | PSI（固定 10 等频箱） | — | 分箱固定 | 周 | 维度逐个 | DRAFT | >0.1 关注；>0.25 告警 |
| G-007 | `metric_freshness_hours` | hours | now − 最新 observation | — | — | 实时 | 默认 | DRAFT | ≤26h |
| G-008 | `event_backlog_seconds` | seconds | now − 最老未消费事件 | — | — | 实时 | 默认 | DRAFT | ≤900s |
| G-009 | `bounce_rate_total` | ratio | hard+soft bounces | delivered+sent | — | 滚动 7 天 | 默认 | DRAFT | 报告（辅助 G-001） |
| G-010 | `golden_gate_status` | status | 最近一次 `golden_eval_run.gates` 全绿=GREEN | — | 任一 gate 红即 RED | 每次跑批 | 金标集 | DRAFT | 红即阻断发布 |

**状态说明**：ACTIVE＝本版已有只读 SQL 实现或在现有表上可直接算；标「引擎侧」的指标只实现了本库可验部分（suppression/合法依据等 SaaS 侧条件见 §5）；DRAFT＝口径已定义但数据/采集未就位（P4 前 T3/T4 全部 DRAFT，P4 接线后转 ACTIVE）。

---

## 4. 现在就能算的基线读数（2026-11-09）

> 复算命令：`node scripts/metrics/funnel-baseline.mjs` 与 `node scripts/metrics/risky-inventory.mjs`（只读）。完整证据见 `docs/evidence/2026-11-09-funnel-baseline.md` 与 `docs/evidence/2026-11-09-risky-inventory.md`。

| 指标 | 全库 | 主租户 | 备注 |
| --- | --- | --- | --- |
| 公司数 | 2,423 | 787 | 12 个 workspace |
| 有域名 | 1,845（76.1%） | — | |
| lead fit=match 公司 | 403 | 128 | |
| match 公司有域名 | 302（74.9%） | — | 目录源 0 域名 |
| match 公司有邮箱（任意状态） | 73（18.1%） | 9 | T2-001 |
| match 公司有电话 | 4（1.0%） | 0 | T2-005 |
| 邮箱 VALID | 0 / 274 | 0 | T2-002 |
| QUALIFIED lead | 23（全部测试租户） | 0 | 真实租户 0 |
| `smtp-probe-verdict/v1` | 135 次，reachable=true 135、codes 空 131（4 次有码）、mailFromCode null 131 / 250 4 | — | 只测域名连通/MX，无一次邮箱级 RCPT |

---

## 5. 已知口径限制（必须随报告披露）

1. **VRIC 的 SaaS 侧条件本库不可验**：suppression/OPT_OUT、合法依据路由（DE/IT consent）在 gain-saas 库或执行层；引擎侧只能计算 §1.3 的 1–3/6 条。当前 VALID=0，两种口径结果一致（0）；接线后必须双库联合计算。
2. **国家字段未归一**：库内 `DE` 与「德国」并存（2026-11-09：DE 846、德国 72）；脚本内已做归一并单独报告未归一数量，但入库归一属 P2 数据治理。
3. **来源归因单一化**：`identity_link` 当前每公司恰 1 个 provider；多源同公司会退化为任意一条。source_unique_contribution 在 P2 帧矩阵接入前只作近似。
4. **「已尝试验证」分母当前极薄**：274 条邮箱中仅 24 条有 `verification_method='pattern_guess'`（非真实验证）、250 条从无验证记录；T2-002/003/004 当前读数不具统计意义（n<30 规则适用）。
5. **`contact_point.value` 是加密列**：本字典所有读数只用元数据列，不解密、不输出任何地址明文。
6. **测试租户污染**：全库指标必须与主租户并列报告；仅主租户读数可用于业务结论。
7. **计划文本与 schema 的枚举漂移（已按 schema 校正）**：ch01 §3.1.3 写 `verification_method ∈ {'smtp_rcpt','provider_verified','operator'}`，而 `packages/db/prisma/schema.prisma`（ContactPoint 注释）实际值是 `smtp_rcpt | pattern_guess | provider_reported | operator | import`；本字典采用 schema 实际值 `provider_reported`。`import` 是否视为「已验证」需在 P1 接线时明确（当前不自动计入）。

---

## 6. capture-recapture（T1-001/T1-003）口径补充

- 两源（Lincoln-Petersen/Chapman）仅作 sanity check，**不单独出结论**；`m11<5` 不报 N̂；`m11<25` 时 CV>20%，只报量级。
- 三源及以上用 log-linear（两两交互起步，G²/AIC/BIC 选型）或 LCMCR；缺失格（未被任何 frame 捕获）的拟合值即 N̂₀。
- 必须同时报告：每 frame 的 n、两两交集、模型选择、N̂、bootstrap 95% CI、CV、敏感性（去任一 frame 后 N̂ 变化）。
- **实现（v1.1 起）**：`scripts/metrics/capture-recapture.mjs`
  - 两 frame：确定性键匹配 + Chapman（`--a/--b`）。`m11<5` 不出 N̂；`m11<25` 只报量级。
  - 三 frame：`--frame A=a.csv --frame B=b.csv --frame C=c.csv` → 键簇捕获矩阵 → 8 个候选 log-linear 模型（独立/单交互×3/双交互×3/饱和）按 G²+2p（AIC）选型，饱和模型因 df=0 不可估而单列；参数化 bootstrap（默认 1,000 次，固定 seed）给 N̂ 的 95% CI；诊断门含两两交集 <5 阻断、<25 警告、模型间跨度 >30% 只报范围。
  - 局限：匹配仍是确定性键（无 Splink 概率匹配/人工复核）；k>3 与 LCMCR 未实现；bootstrap 未覆盖模型选择不确定性——报告必须携带这些限制。
- 单测：`scripts/metrics/capture-recapture.test.mjs`（合成数据已知 N 的回收测试、AIC 选型、门限、确定性 bootstrap）。

---

## 7. 版本与变更流程

1. 指标是一等公民：唯一 ID 不复用；删除指标用 `status: RETIRED`，不删行。
2. 任何口径变更（分子/分母/排除项/窗口/分层）必须升 `version` 并在 §8 changelog 记录 `breaking: true|false`；breaking 变更须附新旧口径 ≥30 天重叠对比。
3. 变更流程：提出 → 数据工程评审 → 产品例会确认 → 合入；紧急修复可先合入，48 小时内补评审记录。
4. 「为提升指标而放宽验证口径」一律按 breaking 变更处理并强制重跑金标；未走流程的口径修改视为缺陷。
5. **机器化（v1.2 起已落地，ch01 PR-01）**：`docs/metrics/dictionary/*.json`（`metric-definition/v1`，按 tier 分文件）+ `docs/metrics/schemas/metric-definition.v1.schema.json` + `docs/metrics/schemas/sources.v1.json`；校验器 `node scripts/metrics/metrics-lint.mjs`（未知字段拒绝、ID/名称唯一、tier 与 ID 前缀一致、来源必须登记、ACTIVE 只能引用 existing 源、分子/分母/窗口/分层/CI 词表、changelog 1..version 连续且末条等于 version、`exprStatus` 必填），并随 `scripts/governance-contracts.spec.mjs` 进 CI。选 JSON 而非 YAML 的原因：仓库无可直接引用的 YAML 依赖，引依赖会动锁文件与 Copy 绑定指纹；JSON 让 lint 保持零依赖。`exprStatus`：全部指标当前 `PENDING`（ch01 允许的显式标注）；与只读副本对账的 `EXPLAIN` 校验需要数据库（CI 不连库），通过后逐条升 `CHECKED`。
6. 本 markdown 与机器字典必须同步修改：口径变更同时改两处并升版本；`metrics:lint` 保证机器侧自洽，人工版负责解释与上下文。

---

## 8. changelog

| 版本 | 日期 | breaking | 说明 |
| --- | --- | --- | --- |
| v1.1 | 2026-11-09 | false | 新增 §1.3.1 VRIC PLUS 口径细则（phone VALID 四条件、通道拆分强制报告、引擎侧上界声明）；§1.4 增加 RR1/RR3 机器实现 `reply-rate.mjs` 与成对声明校验；§6 三源 log-linear 实现落地（8 模型 AIC 选型 + 参数化 bootstrap + 诊断门）；T0-002 增通道拆分。无 breaking。 |
| v1.2 | 2026-11-09 | false | 机器可读字典落地：`docs/metrics/dictionary/*.json`（44 指标）+ sources 登记 + `metrics-lint.mjs`（字段/来源/版本/changelog 校验）并接入 CI；§7-5 改为已落地说明（JSON 而非 YAML 的理由）。无 breaking。 |
| v1.0 | 2026-11-09 | — | 首次成文：T0–T4 + Guardrail 44 个指标；VRIC STRICT/PLUS 分离；RR1/RR3 成对报告；窗口/分层/CI 规则；基线读数（2026-11-08 审计 + 11-09 只读复核）。来源：ch01 §3.1 全文、§1.4 边界、§2 现状证据。 |

## 9. 外部基准来源（本版引用）

- Clay waterfall enrichment：https://www.clay.com/guides/waterfall-enrichment
- Explorium match-rate benchmarks：https://www.explorium.ai/blog/data-for-gtm/b2b-data-api-match-rate-benchmarks/
- BounceZero provider study：https://bouncezero.io/b2b-contact-database-provider
- AWS SES enforcement FAQ：https://docs.aws.amazon.com/ses/latest/dg/faqs-enforcement.html
- Belkins cold email response rates：https://belkins.io/blog/cold-email-response-rates
- Smartlead reply-rate benchmarks：https://www.smartlead.ai/benchmarks/average-cold-email-reply-rate
- Bridge Group 2025 SDR report：https://blog.bridgegroupinc.com/hubfs/resources/TBG%202025%20Sales%20Development%20Report.pdf
- Wilson score interval：https://en.wikipedia.org/wiki/Wilson_score_interval
- AAPOR response-rate overview（RR1/RR3 思想来源）：https://aapor.org/wp-content/uploads/2022/12/Response-Rates-Overview-508.pdf
- 计划正文：《GainOS 深化计划 v3.0》第 1 章（ch01）§1–§7，本地计划目录 `gainos-plan-chapters/01-measurement-and-ground-truth.md`
- 仓内配套：`docs/metrics/frame-registry.md`、`evals/golden-discovery/README.md`、`scripts/metrics/README.md`
