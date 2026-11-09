# 双人标注工作流：工作表生成与导入预检（ch01 PR-08 工具）

> 文档 ID：`GOLDEN-ANNOTATION-001`
> 生命周期：`GUIDE`
> 生命周期依据：ch01 PR-08（人工标注本体）的前置工具；判定口径以 [rubric-v1.md](rubric-v1.md) 为准。
> 状态：`GUIDE`

J13 的人工标注不需要引擎：两名标注员各自拿一份空白工作表，按 rubric 独立填完后交回，导入时由
本工具做结构与一致性预检。工具完全离线，只读写本地 CSV/JSON，不连接数据库、不调用模型、不含明文 PII
（样本里只有 `ref`：公司 ID 或联系人盲化 `dedupe_key`）。

## 1. 生成工作表

输入是 `golden-sampling.mjs` 的采样输出（`ref,layer,stratum`）：

```bash
node scripts/metrics/annotation-worksheet.mjs \
  --sample accounts-sample.csv --dataset accounts \
  --out-dir ~/golden-annotation/v1 --seed <manifest.seed> --round 1
```

- 每个标注员一份工作表：`accounts.annotator-a.csv` / `accounts.annotator-b.csv`（另有同内容的
  `.json` 与 `accounts.worksheet-manifest.json`）。
- 行序由 `seed + dataset + annotator` 确定性打乱：同一份样本 + 同一 seed 永远生成同样的顺序，
  但 A/B 的顺序互相独立（避免按同一顺序抄答案）。
- 工作表列：`ref,layer,stratum` + 该数据集的全部标注字段（见 §3），值留空待填。
- 目标文件已存在时拒绝覆盖（`--force` 才覆盖）——填过的表不能被重跑冲掉。
- 生成后把样本/工作表放在受控的本地目录（含盲化 ref 也不入 git）。

## 2. 导入预检

```bash
node scripts/metrics/annotation-import.mjs \
  --dataset accounts --a accounts.annotator-a.csv --b accounts.annotator-b.csv \
  --report accounts-check.json --adjudication accounts-disagreements.csv
```

预检内容：

1. **结构**：必需列齐全、无未知列、`ref` 不重复、两表 ref 集合一致（缺一边记 `REF_UNPAIRED`）。
2. **词表**：枚举/格式字段的取值必须命中词表（`VALUE_INVALID` 即拼写错误，必须先修表）；
   空单元格只计数（`missing`），不阻断——标注可以分批导入。
3. **一致性**：逐字段 raw agreement 与 Cohen's κ；κ 用 `golden-run.mjs` 的同一实现。
4. **裁决队列**：所有分歧（含 ref/layer/stratum/字段/双方取值）写到 `--adjudication` CSV，
   供第三人裁决；自由文本字段（`evidence_url`/`notes`）不参与 κ 与分歧判定。

退出码：

| 退出码 | 含义 |
| --- | --- |
| `0` | 预检通过：结构 0 问题、逐字段 κ ≥ 0.6、双标数量 ≥ 100 |
| `1` | 结构性错误（缺列/重复 ref/ref 不成对/词表外取值），先修表再导入 |
| `2` | 质量门未过：某字段 κ < 0.6 或双标数量不足 100（rubric §0.6/§3.2 的发布门槛） |

单类别的字段（双方全填同一值）κ 无法定义，按 `PASS` 处理并在报告里标 `—`。

## 3. 字段与词表（与 rubric-v1.md §1–§2 对应）

| 数据集 | 字段 | 取值 |
| --- | --- | --- |
| accounts | `is_company` | yes / no / ambiguous |
| accounts | `in_icp` | match / weak / mismatch / unknown |
| accounts | `country` | ISO-2 大写 / unknown |
| accounts | `industry` | NACE 两位数字 / unknown |
| accounts | `employee_band` | 1-10 / 11-50 / 51-200 / 201-500 / 501-1000 / 1001-5000 / 5000+ / unknown |
| accounts | `domain_correct` | yes / no / not_applicable |
| accounts | `is_competitor` | yes / no |
| contacts | `person_exists` | yes / no / ambiguous |
| contacts | `is_decision_maker` | yes / no / unknown |
| contacts | `email_status_truth` | valid / invalid / catch_all / unknown |
| contacts | `email_is_personal` | yes / no |
| contacts | `phone_status_truth` | valid / invalid / unknown |
| contacts | `source_correct` | yes / no |
| contacts | `lawful_basis_ok` | yes / no |
| 两者 | `evidence_url` / `notes` | 自由文本（证据 URL 按 rubric 要求填写；不参与 κ） |

词表改动必须先改 rubric 并升版本，再同步 `scripts/metrics/annotation-worksheet.mjs` 的
`ANNOTATION_DATASETS`。

## 4. 与后续产物的关系

预检通过 + 分歧裁决完成后，按 `golden-label/v1`（`adjudicated: true` + `adjudicator` +
`adjudicatedValue` + `reason`）写入金标目录（`evals/golden-judgments/` 由 J11 线维护），
再由 `golden-run.mjs` 做 replay 评测与 G1/G2/G3 门。本工具不产出 `golden-label/v1`：裁决是人的决定，
脚本只做机械预检。

## 5. 测试

`scripts/metrics/annotation-tools.test.mjs` 覆盖：确定性打乱与 A/B 顺序独立、样本解析负例、
CSV 往返、κ 预检（完美一致 / 低 κ / 结构错误 / 缺失单元格 / 100 条门槛）、以及两个 CLI 的真实子进程
冒烟（生成 → 填表 → 导入 → 拒绝覆盖）。该测试随 governance-contracts 在 `docs:verify` 中执行。
