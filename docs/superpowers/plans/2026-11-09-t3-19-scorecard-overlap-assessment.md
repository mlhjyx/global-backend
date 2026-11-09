# T3-19 每源记分卡 vs ch01 PR-06 源记分卡：重叠评估与建议

> 生命周期：`DRAFT`
> 依据：P2 看板（ch03 第 3 章）要求先比对再动手——若与 P0 的 PR-06 源记分卡重叠 >50% 则转 T3-20；本文件是评估记录，结论供转呈。

## 1. 两边各是什么

| | ch01 PR-06（P0，已合） | ch03 T3-19（本卡） |
|---|---|---|
| 对象 | 租户 raw 管线里的**发现 provider**（public_web/directory/wikidata/ted/openfda…） | 注册库 **frame 源**（registry_frame：官方登记册/名录） |
| 数据面 | `raw_source_record` + `identity_link`/`canonical_company` 归因 | `registry_snapshot`/`registry_entity`/`registry_entity_change`（平台表） |
| 频率/形态 | 日任务（窗口 N 天），`source-scorecard-daily/v1` 行（contentHash 幂等），未来落 `source_scorecard_daily`（PR-03） | 月度，`source_scorecard_monthly`（ch03 §3.9.6），运营台「源健康」页下钻 |
| 实现 | `scripts/metrics/source-scorecard.mjs`（离线只读 psql，JSON+Markdown） | 尚未实现 |

## 2. 指标逐项比对（ch03 §3.18.1 的 8 指标）

| 指标 | PR-06 已有？ | registry 侧当前可算？ | 说明 |
|---|---|---|---|
| ingested（raw 行数） | ✅ | ✅（snapshot.rowCount / 本次装载行数） | 数据源不同，SQL 完全不同 |
| accepted / rejected | ✅（含拒收原因分布 + 词表漂移信号） | ✅（validRows / invalidRows + 行级 issue code） | 同上 |
| uniqueContribution | ✅（identity_link 归因的「仅此源见过」） | ❌ | 需要跨 frame 归并（Splink/T3-16）与投影（L2）落地后才能算 |
| domainResolutionRate | ❌（raw 管线无域名解析率口径） | ❌ | 域名解析流水线（T3-10～T3-13）尚未实现 |
| precisionSample | ❌（脚本注明金标未接） | ❌ | 人工标注（T3-20/T3-13）尚未开始 |
| costCents | ✅ | ✅（恒 0） | registry 零出网，指标无区分度 |
| marginalGain | ❌ | ❌ | 需要多 frame 交叠估计（Tier B/归并） |
| freshnessDays | ✅ | ✅（publishedAt/lastSeenAt） | 可算 |

小结：**9 项指标里 registry 侧当前只有 4 项真正可算**（ingested/accepted+rejected/cost=0/freshness），而它们恰恰是 PR-06 已实现得最完整的部分；三项差异化指标（unique/domain/precision/marginal）全部依赖尚未落地的能力。

## 3. 工程形态比对

- 输出形状（schemaVersion + 行 contentHash 幂等 + JSON/Markdown 双格式 + 拒收原因词表校验）——**高度相同**，若做 T3-19 等于把同一模式第二遍实现。
- SQL/数据面——**完全不同**（raw_source_record vs registry_*），代码零复用（除 `lib/psql.mjs` 这类通用件）。
- 产物家谱——ch01 已有 `source_scorecard_daily`（日）+ 未来 PR-03 物化；ch03 再立 `source_scorecard_monthly` 会形成**两套并行记分卡**，指标口径相互漂移的风险高。

综合判断：**能力/形态重叠 ≈60–70%（>50% 阈值），可复用代码 ≈0，可立即计算的差异化指标 = 0**。按看板规则转 T3-20。

## 4. 建议（T3-19 的后续归宿）

不要新建第二套记分卡子系统，T3-19 在依赖齐备后以「**扩展 ch01 记分卡家族**」的形态落地：

1. 在 `source_scorecard_daily` 之上加 registry 源行（provider=`registry_frame:<frameKey>`，指标取 snapshot/entity/change）；
2. 月度 rollup + `domain_resolution_rate`（等 T3-10～13）、`precision_sample`（等金标抽样）、`marginal_gain`（等 T3-16 归并与 Tier B）；
3. 运营台「源健康」页直接消费同一 JSON 形状（ch01 PR-02/03 的看板位）。

## 5. 本波转做什么

转 **T3-20 Tier A 审计导出骨架**：把「冻结 frame → 审计输入」这一段做成可运行、可测试的管线（registry 侧导出 + 与既有 `recall-audit.mjs` 打通），产物侧（run 产出池导出）明确挂起等执行面（local_query 血缘获批）——保证骨架落地即真实可用，不预造依赖未到的能力。
