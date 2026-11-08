# GainOS 周报 2026-W45

> 模板：`report-template/v1`；数据日期 2026-11-08；口径：指标字典 v1.3（docs/metrics/metric-dictionary.md）；生成：`scripts/metrics/report.mjs`
> 纪律：所有数字由 metric-observation 快照生成，禁止手写；未接线指标显示为「未接线/不可测」，不得用 0 或估计值冒充。

## 1. 北极星

- VRIC_1000_STRICT = 0.0（95% CI [0.0, 9.4]；分子 0 / 账户 403；metric v1）
- VRIC_1000_PLUS = 0.0（分子 0 / 账户 403；PLUS 为引擎侧上界，见字典 §1.3.1）

## 2. 覆盖

- 召回率 company_recall_vs_frame：未测（frame 抽样依赖 PR-11/12 帧接入）
- fit precision/recall（金标口径）：未接线（金标集待标注，见 evals/golden-discovery/）

## 3. 可触达

- email 覆盖率（match 账户，任意状态） = 18.1%（95% CI [14.7%, 22.2%]；73/403；metric v1）
- email VALID 率（已尝试验证）：不可测（NO_ADJUDICATED_VERDICTS：0 条邮箱级验证裁决；0 VALID 不是测得率）
- catch-all 率：不可测（NO_ADJUDICATED_VERDICTS：catch-all 判定从未发生）
- UNKNOWN 率：不可测（NO_ADJUDICATED_VERDICTS：UNKNOWN 无从谈起（无裁决））
- phone 覆盖率 = 1.0%（95% CI [0.4%, 2.5%]；4/403；metric v1）
- contacts / match 账户 = 0.93（95% CI [0.81, 1.07]；375/403；metric v1）
- T2-009：不可测（EMPTY_DENOMINATOR：VALID 联系点为 0）
- email 覆盖率按国家（Top 4，按账户数）：UNKNOWN 11.3%（195） / DE 24.9%（173） / AT 35.7%（14） / CH 14.3%（7）

## 4. 质量门

- 金标 gates（G1–G6）：未接线（golden_eval_run 待 PR-07/08）
- PSI 漂移：未接线（PR-09）
- 失败分类 Top5：未接线（P3 失败分类学）
- event backlog / metric freshness：未接线（measurement API，PR-03/04）

## 5. 源

- 源接受率最好：wikidata 95.7% / public_web 91.2% / openfda 45.5%
- 源接受率最差：directory 26.2% / ted 26.3% / openfda 45.5%
- 拒收原因 Top3：PROVIDER_PAYLOAD_SCHEMA_INVALID 65.7%（2408） / SOURCE_POLICY_MISSING 23.7%（868） / PROCESSING_KEY_DRIFT 10.6%（387）

## 6. 风险与下期动作

- （人工填写：本周阻塞、下期动作、需要产品负责人决策的事项）

---

口径与变更流程见 `docs/metrics/metric-dictionary.md`；报告节奏见 `docs/metrics/reporting.md`。
