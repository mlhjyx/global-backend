# Golden discovery set（ch01 §3.2 / PR-07/08 脚手架）

> 状态：`DRAFT`（2026-11-09）。本目录当前只含**抽样与登记脚手架**：模板 manifest、schema、合成样例池与采样器。真实抽样尚未执行，也未产生任何人工标注——标注由产品负责人安排（ch01 PR-08）。

金标集不是「挑一批好数据」，而是一套可重复运行的真值裁判：给 precision/recall 绝对基线、做模型/供应商变更的回归门、校准 judge 与验证器。v1 目标：**500 账户 + 500 联系人**（联系人按 STRICT/PLUS 两个通道集各 500 抽样登记），三层结构：

| 层 | 规模 | 用途 |
| --- | --- | --- |
| anchor | 100/集 | 固定锚点，任何变更在这层不得下降 |
| rolling | 300/集 | 代表当前流量分布，每月替换 10–20% |
| challenge | 100/集 | 已知困难样本与历史失败复盘 |

## 1. 目录

```text
evals/golden-discovery/
  README.md                       # 本文件：流程、口径、PII 规则
  schema/golden-manifest.schema.json   # 抽样登记 manifest 的 JSON Schema
  v1/manifest.template.json       # v1 抽样配置模板（三个数据集×500 条配额）
```

采样器与导出模板在代码侧：

```text
scripts/metrics/golden-sampling.mjs          # 确定性分层采样（seed 固定）
scripts/metrics/sql/golden-pool-accounts.sql # 账户候选池只读导出（元数据）
scripts/metrics/sql/golden-pool-contacts.sql # 联系人候选池只读导出（盲化 ref）
scripts/metrics/fixtures/golden-pool.*.csv   # 合成样例池（演示/测试用，非真实数据）
```

## 2. 端到端流程

1. **导出候选池（只读）**：用 `scripts/metrics/sql/golden-pool-*.sql` 在只读会话里导出 `ref,layer,stratum` CSV。账户 ref = `canonical_company.id`；联系人 ref = `canonical_contact.dedupe_key`（HMAC 盲化键，不是明文邮箱/电话）。**禁止**把 `contact_point.value` 写进池或样本。
2. **抽样**：

   ```bash
   node scripts/metrics/golden-sampling.mjs \
     --manifest evals/golden-discovery/v1/manifest.template.json \
     --dataset accounts --pool accounts-pool.csv --out accounts-sample.csv --report accounts-report.json
   ```

   同一 pool + 同一 seed 必然得到同一批样本与同一 `refsSha256`；欠采样层（池不足）会写进报告，不自动回填。把样本与报告归档到受控证据位置（含 PII 的原文不进 git）。
3. **登记**：把 `refsSha256`、stratum 分布、pool 快照哈希写回 manifest 的 `refsSha256`（实际执行时复制模板为 `manifest.json`）。
4. **标注**：按 ch01 §3.2.3 的 rubric 双人独立标注；≥100 条双标、Cohen's κ ≥0.6 才发布该字段；分歧进裁决。标注产物只有标签与 `contactRef`，没有明文 PII。
5. **跑批与门限**：`golden_eval_run` + 门限（G1 绝对门 precision≥0.80/recall≥0.75、G2 相对门 >2pp 下降判红、G3 字段门、G5 变异门）——runner 属 PR-07 后续，本脚手架只定义数据与登记。

## 3. 分层与配额

- 分层键：`country × industry(2位) × employee_band × source_class`；联系人再加 `seniority`、`channel`（email/phone/both）。
- 分配：层内按比例（最大余数法）+ 每层最少 5 条（池允许时）；稀有层（US、AT/CH、phone）过采样，汇总时按层权重还原。
- 排除：11 个非生产 workspace、`@example.test`/`@demo.cn`、DSR 擦除/SUPPRESSED 实体、重复实体（按 ref 去重）。
- 样本量依据（ch01 §3.2.2）：层内 precision 95% CI ±5pp 需 p=0.5 约 384 条、p=0.9 约 141 条；v1 关键层 150–200，其余 30–60。

## 4. PII 与安全

- 金标条目**不存个人邮箱/电话明文**：联系人用 `contactRef`（HMAC `dedupe_key`）与 `email_pattern_hash`；标注员通过受控工具查看脱敏证据。
- 调用外部标注服务只发最小必要字段；样本文件加密存放，不进 git。
- 目录内所有样例（`scripts/metrics/fixtures/`）都是合成数据（`co-0001` / `ct-0001`）。
- `contact_point.value` 是加密列：任何导出 SQL 都不得 select 它。

## 5. 版本化

- 数据集按 `v1/`、`v2/` 递增，不覆盖；manifest 记录 seed、pool 哈希、样本哈希与配额。
- 内容寻址：manifest 记录每个文件 SHA-256；同一数据集可在不同 baseline（prompt/model/verifier 版本）下重复跑批。
- 过期：`subjectAsOf` 超过 90 天的条目重取；公司关闭/域名易主超过 180 天移入 retired。

## 6. 与 2026-11-09 现状的距离（诚实窗口）

- 库内联系人邮箱 274 条、phone 30 条、VALID 0：`contacts_plus` 的 phone 层在 P1 电话验证补齐前无法达到 500，预期欠采样并在 baseline 披露。
- 账户池 2,423 家、match 403 家：`accounts` 500 条可以从池内抽满，但关键层（DE 工业）需要先补 industry 字段（当前仅 5.0% 有值）才能按 industry 分层——v1 先按 country×source_class×employee_band 分层并在报告标注 industry=UNKNOWN 占比。
