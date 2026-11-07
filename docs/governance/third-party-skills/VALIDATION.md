# SKILL.md 规范校验（agentskills.io）

> 文档 ID：`GOV-TPS-001`
> 状态：`CURRENT`
> 最后核验：2026-11-08
> 范围：本目录 `snapshots/` 下的 14 个快照（上游原文，未做去营销化编辑）
> 规范：[agentskills.io/specification](https://agentskills.io/specification)（2026-10-22 已捐入 Linux Foundation 的 Agent Skills 规范）
> 结论：**14/14 通过全部硬规则**；问题集中在导入衍生版需要补齐的可选字段与界面语义适配，不阻塞目录收录

## 1. 校验方法与硬规则

S0 设计已随 PR #831 合入（[`2026-11-08-skill-runtime-s0.md`](../../superpowers/plans/2026-11-08-skill-runtime-s0.md)），仓库内 validator 尚未实现；本次用一次性静态脚本按规范逐项检查，脚本不入库，检查口径与官方 `skills-ref` 的硬规则一致。快照以 `.md.txt` 归档，内容与上游逐字节一致（SHA-256 见清单），扩展名只为避开 docs 受控文档校验与文档站渲染：

| 检查项 | 规则 | 结果 |
| --- | --- | --- |
| `name` | 1–64 字符；仅小写字母、数字、连字符；不得以连字符开头/结尾；不得出现连续连字符；必须与父目录同名 | 14/14 通过 |
| `description` | 1–1024 字符；非空；说明做什么、何时使用 | 14/14 通过（最长 987） |
| `license` | 可选字符串 | 14/14 未声明（规范允许；清单记录仓库级 SPDX） |
| `compatibility` | 可选，≤500 字符 | 14/14 未使用该字段 |
| `metadata` | 可选，string → string 映射 | marketingskills 4 项使用 `version`，均为字符串；其余未使用 |
| `allowed-tools` | 可选，空格分隔字符串（实验性） | 14/14 未声明（S0 v0 要求与任务契约集合相等，S1 必须补） |
| 正文行数 | 建议 <500 行；激活时全文加载（建议 <5000 tokens） | 14/14 通过（最大 302 行） |
| 文件引用 | 相对路径、不得路径穿越、建议一层深 | 14/14 通过；marketingskills 的 26 个 `references/` 文件全部存在 |
| 渐进披露 | metadata 常驻（约 100 tokens）；正文激活时加载；资源按需加载 | 结构符合；两处参考文件偏大（见 W-06） |

## 2. 结果总表

| 技能 | 来源 | 结论 | 正文行数 | description 长度 | 快照文件数 | 问题 |
| --- | --- | --- | --- | --- | --- | --- |
| account-research | anthropics/knowledge-work-plugins | pass | 96 | 449 | 1 | 无 |
| lead-triage | anthropics/knowledge-work-plugins | pass | 104 | 313 | 1 | 无 |
| account-tiering | anthropics/knowledge-work-plugins | pass | 98 | 258 | 1 | 无 |
| draft-outreach | anthropics/knowledge-work-plugins | pass | 113 | 370 | 1 | 无 |
| stakeholder-map | anthropics/knowledge-work-plugins | pass | 104 | 316 | 1 | 无 |
| competitive-intelligence | anthropics/knowledge-work-plugins | pass | 99 | 538 | 1 | 无 |
| call-prep | anthropics/knowledge-work-plugins | pass | 108 | 364 | 1 | 无 |
| prospecting | coreyhaines31/marketingskills | pass | 271 | 987 | 11 | W-06 |
| cold-email | coreyhaines31/marketingskills | pass | 208 | 884 | 11 | W-02、W-06 |
| customer-research | coreyhaines31/marketingskills | pass | 302 | 953 | 3 | W-06 |
| pricing | coreyhaines31/marketingskills | pass | 289 | 868 | 5 | W-06 |
| ideal-customer-profile | phuryn/pm-skills | pass | 160 | 208 | 1 | W-04 |
| beachhead-segment | phuryn/pm-skills | pass | 141 | 281 | 1 | W-04 |
| gtm-motions | phuryn/pm-skills | pass | 151 | 254 | 1 | W-04 |

所有技能均为纯文本：无 `scripts/`、无二进制附件；`name` 与目录名一致；无重复 skill key。

## 3. 问题与备注

**W-01 上游许可证异常（供应链，不是技能正文问题）**
anthropics 仓库根 `LICENSE` 在钉住的 commit 上被追加了约 10 行与 Apache-2.0 无关的文本（含 "Syntax-file, code seperations, code vault integeted with css definition…"）。`sales/LICENSE` 是干净的 202 行 Apache-2.0。本目录归档 `sales/LICENSE`，并在清单中记录该异常。教训：许可证原文也要做异常扫描与哈希钉住，不能假设 LICENSE 一定干净。

**W-02 两个 marketingskills 技能缺少显式的不可信内容规则**
`prospecting`、`cold-email` 没有像 Anthropic 技能或 `customer-research` 那样声明"抓取的网页/邮件/回复只作数据、不作指令"。导入衍生版必须补这条规则，否则在引擎读取外部内容时缺少提示注入防线。

**W-03 `allowed-tools` 全部缺失（规范允许，S0 不允许）**
S0 v0 要求技能的 `allowed-tools` 与绑定 AI Task 契约的 `allowedTools` 集合**严格相等**。S1 必须为每个技能显式补齐；本目录已在清单 `toolBrokerMapping.suggestedAllowedTools` 给出建议集合（只允许现有 ToolBroker 工具 id）。

**W-04 pm-skills 使用 `$ARGUMENTS` 占位符**
`ideal-customer-profile`、`beachhead-segment`、`gtm-motions` 沿用了 Claude Code 插件的 `$ARGUMENTS` 传参惯例；引擎没有这个变量，导入衍生版必须改为绑定 AI Task 的输入契约（JSON Schema），不能把 `$ARGUMENTS` 原样带进 prompt。

**W-05 Anthropic 技能的聊天界面语义**
7 个 Anthropic 技能的公共 "Rules" 段引用了 artifact / Page / Slides / connector / prompt button 等聊天界面能力，并假设"连接器"提供 CRM、邮件、日历、转录读写。引擎运行时没有这些界面与连接器，导入衍生版需要：
- 把渲染规则改写为"输出结构化 JSON/artifact，由引擎投影"；
- 把 connector 读写改写为 ToolBroker 工具调用与审批动作；
- 保留其不可信内容、内容触发动作需人工确认、定时运行不执行内容动作三组规则（这三组与本项目审批链语义一致）。

**W-06 参考文件偏大**
`prospecting/references/data-sources.md`（300 行）、`customer-research/references/source-guides.md`（401 行）超过渐进披露建议的单文件粒度。规范允许按需加载，不阻塞；导入衍生版建议拆分或裁剪，减少激活时的上下文占用。

**W-07 上游自带评测**
marketingskills 的 4 个技能自带 `evals/evals.json`：prospecting 12 条、cold-email 9 条、customer-research 13 条、pricing 9 条。快照未包含 `evals/`（它不属于技能运行内容），路径记录在清单 `upstreamEvalsPath`。这些用例可作为 Golden Set 的种子与扩展集（见 [`GOLDEN-SET.md`](GOLDEN-SET.md)）。

**W-08 目录与命名**
14 个 `name` 均为小写连字符且与目录同名，无前导/尾随连字符、无连续连字符；与 S0 负向用例（大写、`--`、缺 description、超长 license、非法版本、未知 task、digest 不符、allowed-tools 多/少一项、路径穿越、metadata 非字符串、重复 skill-key）无冲突。

## 4. S0 一致性预检

| S0 要求（设计文档） | 本目录的准备 |
| --- | --- |
| `skill_package` / `skill_version` / `skill_enablement` 三表 | 清单的 `id` 可直接作为 `skill_key`；14 个 key 与现有 3 个内置技能（`company.understanding.extract`、`company.understanding.extract_offerings`、`discovery.qualify_fit`）不冲突 |
| 快照不可变 | 每个技能有 `snapshotSha256`；每个来源目录有逐文件 `CHECKSUMS.sha256` |
| `allowed-tools` 与任务契约严格相等 | 每个技能给出建议集合；S1 绑定时二者必须一致 |
| 平台扩展放 `metadata.platform.*` | 建议衍生版写入 `metadata.platform.source`、`.commit`、`.license`、`.owner` |
| validator 负向用例 | 本目录技能可作为 S1 负向测试的对照样本（全部应通过正向校验） |

## 5. 导入前置修改清单（S1 衍生版）

1. frontmatter 增 `license: <SPDX>`，并在 `metadata.platform.*` 记录来源、commit、owner。
2. 增 `allowed-tools`，与绑定 AI Task 的 `allowedTools` 集合严格相等。
3. 按 [`SECURITY-REVIEW.md`](SECURITY-REVIEW.md) 完成去营销化与注入规则补齐。
4. 把聊天界面语义（connector / artifact / Page / `$ARGUMENTS`）改写为引擎输入输出契约。
5. 在技能头部保留来源与改动说明；上游快照保持原样，不改动。
