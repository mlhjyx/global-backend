# 度量文档门户（docs/metrics）

> 文档 ID：`METRICS-PORTAL-001`
> 生命周期：`GUIDE`
> 生命周期依据：ch01（测量与真值）文档族的入口页；口径以指标字典为准。
> 状态：`GUIDE`

本目录是 GainOS 度量体系的文档入口。口径以[指标字典](metric-dictionary.md)为唯一来源；本页只是导航。

| 文档 | 作用 | 机器校验 |
| --- | --- | --- |
| [metric-dictionary.md](metric-dictionary.md) | 指标字典 v1.x：44 个指标的分子/分母/排除项/窗口/分层/CI、VRIC STRICT/PLUS、RR1+RR3 成对口径、版本与变更流程 | 人工权威版；机器版见下 |
| [dictionary/](dictionary/) | 机器可读字典（`metric-definition/v1` JSON，按 tier 分文件） | `node scripts/metrics/metrics-lint.mjs`（CI：governance-contracts import） |
| [schemas/metric-definition.v1.schema.json](schemas/metric-definition.v1.schema.json) | 单指标 JSON Schema | lint 内置等价校验 |
| [schemas/sources.v1.json](schemas/sources.v1.json) | 公式可引用的数据源登记（existing / planned / saas） | lint 的 `SOURCE_UNKNOWN` / `ACTIVE_SOURCE_NOT_EXISTING` |
| [frame-registry.md](frame-registry.md) + [frames/frame-registry.v1.json](frames/frame-registry.v1.json) | 19 法域 frame 矩阵（许可/获取/频率/规模/坑） | `node scripts/metrics/frame-registry.mjs`（CI 同链路） |
| [reporting.md](reporting.md) + [report-samples/](report-samples/) | 周/月报节奏与固定模板；报告由快照+脚本生成，未接线指标显式留白 | `scripts/metrics/report.mjs`（模板测试进 CI） |
| 证据 | 时点读数在 `docs/evidence/2026-11-09-*.md`（漏斗基线、RISKY 盘点） | 不可改写证据 |

## 常用命令

```bash
node scripts/metrics/metrics-lint.mjs          # 字典校验（0 问题才过）
node scripts/metrics/frame-registry.mjs        # frame registry 校验
node --test 'scripts/metrics/**/*.test.mjs'    # 全部单测（CI 经 governance-contracts import 运行）
```

## 变更流程

- 口径变更：改 `dictionary/*.json` 并升 `version` + changelog（lint 强制 1..N 连续且末条等于 version）；同步改 `metric-dictionary.md` 的对应行与 §8。
- 新增数据源：先在 `schemas/sources.v1.json` 登记（ACTIVE 指标只许引用 existing）。
- 新增/接入 frame：改 `frames/frame-registry.v1.json`（ACTIVE 必须有 license），跑校验器。
- 完整规则见[指标字典](metric-dictionary.md) §7 与 [frame registry](frame-registry.md) §5。
