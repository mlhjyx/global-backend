# Golden discovery rubric v1（标注手册）

> 文档 ID：`GOLDEN-RUBRIC-001`
> 版本：`v1.0`（2026-11-09）
> 生命周期：`DRAFT`
> 状态：`DRAFT`
> 依据：ch01 §3.2.3（字段级 rubric）与附录 C；本手册是标注与裁决的唯一操作口径，变更须升版本并重跑 κ。

## 0. 通用规则（先读）

1. **证据优先**：每个判定必须附 ≥1 个可访问 URL 或截图哈希；无证据的判定默认 `unknown`，不得凭印象。
2. **保守原则**：证据不足选 `unknown`，不得猜 yes。`unknown` 不是失败，是诚实。
3. **独立标注**：标注员 A/B 互不可见；只看 rubric 与证据页；不得参考模型输出（避免确认偏差）。
4. **PII**：标注界面只显示脱敏字段（公司名可显示；人名/邮箱/电话用 `contactRef` 与哈希）；不得把明文邮箱/电话写入任何标注文件或提交信息。
5. **边界案例**：难以判定的写入 challenge 层，附「为什么难」一句话；每条不超 3 分钟，超时即标 `unknown` 并记 challenge。
6. **一致性门槛**：逐字段 Cohen's κ ≥ 0.6 才允许发布该字段金标；κ<0.6 先修 rubric/培训/缩字段，不得用多数投票硬凑。

## 1. 公司级字段（account）

| 字段 | 取值 | 判定规则 |
| --- | --- | --- |
| `is_company` | yes / no / ambiguous | 官网只卖自家产品/服务且能对应注册实体 → yes；纯内容/媒体/招聘聚合/品牌落地页 → no；只有社交主页或目录页 → ambiguous。 |
| `in_icp` | match / weak / mismatch / unknown | 按该条目附带的 `icp_definition` 逐条规则判定并记录命中的规则 ID；命中 EXCLUSION 即 mismatch；规则不明 → unknown。 |
| `country` | ISO-2 / unknown | 以注册地或主要运营地为准；两者冲突时取运营地并在 notes 记录。 |
| `industry` | NACE 2 位 / unknown | 以官网产品/服务为主，目录分类为辅；冲突时官网优先并记录。 |
| `employee_band` | 1-10 / 11-50 / 51-200 / 201-500 / 501-1000 / 1001-5000 / 5000+ / unknown | 优先注册信息/年报；其次 LinkedIn 区间；冲突取较保守区间并记 unknown 说明。 |
| `domain_correct` | yes / no / not_applicable | 首页/Impressum 上的公司名与法定名一致 → yes；仅品牌名相似需第二证据；域名不属于该公司 → no。 |
| `is_competitor` | yes / no | 与卖方同业/竞品 → yes（命中即从线索池排除）。 |
| `evidence_url` | URL | 支撑判断的证据页（≥1 条）；paywall/登录页不算。 |

## 2. 联系人级字段（contact）

| 字段 | 取值 | 判定规则 |
| --- | --- | --- |
| `person_exists` | yes / no / ambiguous | 公司官网团队页/LinkedIn/新闻 ≥1 个独立来源证实该人在该公司 → yes；只有爬取名 → ambiguous。 |
| `is_decision_maker` | yes / no / unknown | title/seniority 命中目标 persona 且公司规模匹配 → yes；小公司 founder 可算，大公司不算；title 缺失 → unknown。 |
| `email_status_truth` | valid / invalid / catch_all / unknown | valid 需 ≥2 条独立证据（验证器 A valid + 验证器 B valid/not-catch-all，或一次真实发送无退信）；catch_all 需 MX/验证器明确 accept-all；invalid 需 SMTP 5xx 或 bounce；证据不足 → unknown。 |
| `email_is_personal` | yes / no | 具名个人邮箱 → yes；info@/sales@ 等职能邮箱 → no。 |
| `phone_status_truth` | valid / invalid / unknown | Twilio Lookup 线型 + 人工抽呼接通 → valid；空号/错号 → invalid；未拨测 → unknown。 |
| `source_correct` | yes / no | 来源标注与实际一致（如标 impressum 但实际来自猜测）→ no。 |
| `lawful_basis_ok` | yes / no | 国家路由与来源允许该用途（DE/IT email 需 opt-in；FR 需三条件；职能邮箱与个人邮箱分级不同）→ no 即阻断。 |

## 3. 标注流程与裁决

1. 抽样：`scripts/metrics/golden-sampling.mjs`（固定 seed、分层配额、欠采样如实报告）；样本与 manifest 哈希登记。
2. 双标：A/B 独立标注同一批（L1 全双标；L2 60% 双标 + 40% 单标 + 10% 复核）。
3. 计算逐字段 raw agreement 与 Cohen's κ（多人有序/多类用 weighted κ 或 Krippendorff's α）。
4. 分歧进裁决：第三人（或数据工程 owner）裁决；2-1 记弱共识；无法裁决标 ambiguous。
5. 产物写 `golden-label/v1`（含 `adjudicated_value`、`adjudicator`、`reason`、`at`）；标注批次写 `golden-run/v1`（标注人、日期、样本哈希、κ、分歧率、耗时）。
6. 纪律：judge 一致率与每位标注者分别比较，不把人+judge 混进同一个 α。

## 4. 与机器字典的关系

- 本手册判定的字段直接对应指标 `T1-005 fit_precision_golden`、`T1-006 fit_recall_golden`、`G-004 judge_human_agreement`、`G-005 annotation_kappa`（见 `docs/metrics/dictionary/`）。
- 金标结果用于校准 `email_status_truth → T2-002/003/004` 与 VRIC 的 `email_valid_precision ≥0.95` 降级条件（字典 §1.3）。
