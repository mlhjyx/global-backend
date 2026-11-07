# 第三方技能导入目录（M1.5 试点准备）

> 文档 ID：`GOV-TPS-000`
> 状态：`CURRENT`
> 最后核验：2026-11-08
> 决策：D-MA-5（2026-11-08 产品负责人批准，出自 §0.7「外部技能导入从 S3 远期提升为 M1.5 试点 + S1 精选导入」）
> 进展：目录与合规材料完成，等待产品负责人挑选首批名单；本目录**不含运行时集成**
> 机器事实源：[`THIRD_PARTY_SKILLS.json`](THIRD_PARTY_SKILLS.json)

本目录回答五个问题：哪些外部技能可导入、许可证是什么、正文是否符合 SKILL.md 规范、安全与合规风险在哪、导入后如何验收。Skill Runtime（S0：validator、`skill_package`/`skill_version`/`skill_enablement` 三表）由另一条泳道负责，设计文档已随 PR #831 合入 [`2026-11-08-skill-runtime-s0.md`](../../superpowers/plans/2026-11-08-skill-runtime-s0.md)；本目录不依赖、也不修改它。

## 1. 边界

- **快照 ≠ 已导入**。`snapshots/` 是上游原文（已排除 `evals/` 与 `scripts/`，文件以 `.md.txt` 归档），只用于审计、哈希钉住和去营销化编辑的基线。真正进入运行时的是 S1 生成的衍生版，衍生版必须保留 SPDX、来源与改动说明。
- **不执行任何外部 `scripts/`**。v1 直接排除携带 `scripts/` 的技能；运行时不加载、不执行技能目录中的可执行文件。
- **`allowed-tools` 仅提示**。执行边界由绑定 AI Task 的 ToolBroker 白名单强制；S0 v0 要求技能声明的 `allowed-tools` 与任务契约的 `allowedTools` 集合严格相等。
- **发送、CRM 写、名单/数据对外导出一律走审批链**：ActionProposal → Policy → 审批 → ExecutionAuthorization → ToolBroker。
- **厂商技能必须去营销化**，登记 owner 与退出计划。当前 owner 一律为 `UNASSIGNED`，导入前必须由产品负责人指派。

## 2. 目录

| 路径 | 内容 |
| --- | --- |
| [`THIRD_PARTY_SKILLS.json`](THIRD_PARTY_SKILLS.json) | 机器清单：3 个来源、14 个技能；每项含 repo、commit、原路径、SPDX、author、许可证路径、快照路径与 SHA-256、校验结论、安全映射、建议批次、owner/退出计划 |
| [`THIRD_PARTY_SKILLS.schema.json`](THIRD_PARTY_SKILLS.schema.json) | 清单的 JSON Schema（draft 2020-12），供 S1 CI 校验 |
| [`licenses/`](licenses/) | 三个来源的许可证原文（Apache-2.0 / MIT / MIT）与 `CHECKSUMS.sha256` |
| `snapshots/<source>/<skill>/` | 上游 `SKILL.md` 与 `references/`，归档为 `.md.txt`（逐字节原文；避免 docs 校验把上游文本当受控文档，也避免第三方内容在文档站渲染）；每个来源目录下 `CHECKSUMS.sha256` 可逐文件校验 |
| [`VALIDATION.md`](VALIDATION.md) | 按 agentskills.io 规范的逐项校验结果、问题与 S0 一致性预检 |
| [`SECURITY-REVIEW.md`](SECURITY-REVIEW.md) | 提示注入面、外链/营销内容、个人数据、allowedTools 映射与审批链标注 |
| [`GOLDEN-SET.md`](GOLDEN-SET.md) | 每技能 5 条代表性输入与判定标准草案（共 70 条） |
| [`FIRST-BATCH.md`](FIRST-BATCH.md) | 三档导入建议与产品负责人选择表 |

## 3. 口径（D-MA-5）

| 主题 | 规则 |
| --- | --- |
| 许可三档硬门 | MIT / Apache-2.0 可导入并保留许可证与来源；AGPL-3.0 / GPL / BSL 仅借鉴模式、不复制正文；无许可证只能 clean-room 重写 |
| 钉版本 | 每个技能固定到 commit；快照与许可证均带 SHA-256，更新上游等于新增快照，不在原地改动 |
| 默认不执行 scripts | 技能目录中的 `scripts/` 不执行；v1 进一步排除所有携带 `scripts/` 的技能 |
| allowed-tools | 只是声明与提示，真正生效的是 ToolBroker 的任务级白名单 |
| 动作分级 | 读取与生成可自动；发送、CRM 写、对外导出必须审批；无人在场的定时运行不得执行内容触发的动作 |
| 厂商技能 | 去营销化审校（删除赞助商标记、集成推广表、作者付费通讯链接），标 owner 与退出计划 |

## 4. 来源与筛选结果

| 来源 | 钉住 commit | SPDX | 仓库技能总数 | 入选 | 结论 |
| --- | --- | --- | --- | --- | --- |
| [anthropics/knowledge-work-plugins](https://github.com/anthropics/knowledge-work-plugins) | `e050c2ec856373787143d7057663a6ebd1277df3`（2026-11-06） | Apache-2.0 | 252（sales 插件 36） | 7 | 正文零外链、无厂商推广、内置不可信内容规则；最佳来源 |
| [coreyhaines31/marketingskills](https://github.com/coreyhaines31/marketingskills) | `96798cf38736ecdba015a1d2b0521b0c8f8f41dd`（2026-11-06） | MIT | 53 | 4 | 内容与合规护栏质量高；带厂商集成表与赞助商标记，需去营销化 |
| [phuryn/pm-skills](https://github.com/phuryn/pm-skills) | `2a12295a7717569baa7be181b4cfebe3ca38a6bb`（2026-10-29） | MIT | 69（pm-go-to-market 6） | 3 | 策略框架扎实；带作者付费通讯链接，需去营销化 |
| [LeadMagic/gtm-skills](https://github.com/LeadMagic/gtm-skills) | `2b7ec0f9e7044f46e4c77b536f486303fd863e28`（2026-10-14） | MIT | 211 | 0 | 211/211 技能自带 `scripts/check-output.py`，按 v1 规则整源不导入；正文大量绑定厂商数据源 |
| [LaGrowthMachine/gtm-system](https://github.com/LaGrowthMachine/gtm-system) | `fb0155a78d28efa6c75be232e389817f14115210`（2026-10-07） | MIT | 13 | 0 | 与 La Growth Machine 数据/MCP 强绑定，5 个技能自带 `scripts/`；厂商 API 绑定 |

> 许可证异常：anthropics 仓库根 `LICENSE` 在钉住的 commit 上被追加了约 10 行与 Apache-2.0 无关的文本；`sales/LICENSE` 是干净的 202 行 Apache-2.0。本目录归档后者，并把它当作一次上游供应链异常记录在 [`SECURITY-REVIEW.md`](SECURITY-REVIEW.md) 与清单的 `license.note` 中。

## 5. 复核方法

```bash
git clone https://github.com/<repo>.git /tmp/<repo>
git -C /tmp/<repo> checkout <commit>          # commit 见 THIRD_PARTY_SKILLS.json
cd docs/governance/third-party-skills/snapshots/<source-id>
sha256sum -c CHECKSUMS.sha256                  # 快照逐文件校验
cd ../../licenses && sha256sum -c CHECKSUMS.sha256
```

把上游 `<originalPath>` 与快照逐字节比对即可确认快照未被改动。规范校验的复现方法见 [`VALIDATION.md`](VALIDATION.md)，安全扫描口径见 [`SECURITY-REVIEW.md`](SECURITY-REVIEW.md)。

## 6. 下一步

1. 产品负责人按 [`FIRST-BATCH.md`](FIRST-BATCH.md) 选择首批名单（catalog 共 14 个，S1 运行时首批建议 2 个，与计划步 8「精选导入 2 个外部技能」一致）。
2. 选定后进入 S1：生成去营销化衍生版、补 `allowed-tools`、接入 Golden Set CI、按租户启停。
3. 指派每项 owner；退出计划已写入清单：Golden Set 未通过，或登记起 180 天内未接入运行时/未被保留，则移出 catalog 并归档。

## 7. 变更规则

- 更新上游版本 = 新 commit + 新快照 + 重算 `CHECKSUMS.sha256` + 重跑校验；不得原地编辑快照。
- 衍生版的每一次改动都在 S1 PR 中说明（去营销化删除了什么、补了哪些规则），并在技能头部保留来源与改动说明。
- 新增来源或技能先改本目录的清单与审校文档，再进 S1 运行时；不要让运行时出现目录外的技能。
