# judge 校准报告（合成 fixture）

> ⚠️ SYNTHETIC FIXTURE —— 合成样例，仅证明报告可复算；真实校准须等 J13 标注集。
> 生成命令：`judge-calibration.mts --fixture`；同输入同输出（bootstrap 种子 20261109）。

## 混淆矩阵（n=300，阳性=目标客户 FIT）

| | 判 FIT | 判非 FIT（含 UNKNOWN） |
| --- | --- | --- |
| 金标 FIT | 180 | 20 |
| 金标 NOT_FIT | 12 | 88 |

## 指标（均带 Wilson 95% CI）

| 指标 | 值 | 95% CI | n |
| --- | --- | --- | --- |
| TPR（recall） | 90.0% | [85.1%, 93.4%] | 200 |
| TNR（specificity） | 88.0% | [80.2%, 93.0%] | 100 |
| PPV（precision） | 93.8% | [89.4%, 96.4%] | 192 |
| NPV | 81.5% | [73.1%, 87.7%] | 108 |
| FNR | 10.0% | [6.6%, 14.9%] | 200 |
| Cohen's κ | 0.7647 | [68.4%, 84.1%]（bootstrap B=1000） | 300 |

## Rogan–Gladen 校正

- 观测 FIT 率：64.0%
- 校正后真实匹配率 π̂：66.7%
- 校正后 PPV：93.8%

## 复算

```bash
pnpm --filter @global/api exec tsx scripts/judgment/judge-calibration.mts --fixture
```
