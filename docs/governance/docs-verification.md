# 文档自动校验与例外治理

> 文档 ID：`GOV-FE-008`
> 层级：`L1 / Normative governance`
> 状态：`CURRENT`
> 评审状态：`APPROVED_AT_GATE_8`
> 事实 Owner：`OWN-DOC-GOV`
> 机器政策：[`docs-verification-policy/v1`](docs-verification-policy.json)
> 最后核验：2026-07-23
> 批准边界：产品负责人条件批准机器门与例外治理；独立人工、真实 Release 和全部 blocker 仍保留

本文定义文档如何进入持续集成、什么必须失败、什么只能告警，以及历史证据为什么不能为了“全绿”被无声重写。机器规则由 JSON 政策和 `scripts/verify-docs.mjs` 承重；本文解释其人类语义。

## 1. 运行方式

```bash
pnpm docs:verify
```

该命令不访问网络、不连接数据库、不生成产品代码，也不写入仓库。普通 CI 的安装步骤后运行同一命令；本地与 CI 不维护两套规则。

## 2. 检查面与失败语义

| 检查面 | 硬失败条件 | 不证明 |
|---|---|---|
| 结构 | 受控文档不是一个 H1、围栏不成对、缺结尾换行、受控表格列漂移 | 内容正确或用户可理解 |
| Document ID | 受控文档缺 ID、任意文档 ID 重复 | Registry 已登记或 Owner 已接受 |
| 状态 | 受控文档缺状态/生命周期、元数据未使用受控反引号格式、状态 token 不在政策词汇 | 产品或实现状态获得批准 |
| 链接 | 仓内目标或 Markdown heading anchor 不存在，或使用会跳到 GitHub host root 的 `/docs/...` 根相对路径 | 外部网页当前可用、链接内容可信 |
| Registry 引用 | Capability/Object/Page/Scenario/Fixture/Adoption/Owner ID 不在各自 Registry 的声明列 | 引用关系本身业务正确 |
| 历史 banner | 已登记的 Site 历史稿缺少冻结、dated 或 superseded 前言 | 可以删除、移动或覆盖历史证据 |
| Release Bundle | 未来 `docs/releases/` 中真实 bundle 缺必需元数据或章节 | 各证据真实通过或发布成功 |
| 敏感模式 | Markdown 出现高置信私钥、长 API key 或 AWS access key 模式 | 已完成完整 DLP/secret scan |

所有硬失败退出码为非零。输出中的计数是本次扫描范围，不是产品能力、测试通过数或发布证据。

## 3. 受控范围

受控范围包括：文档门户、治理 Registry、全局前端规范、设计规范、OSS 总账和仍保留的模板；五份权威页与指定活跃 Site Builder 专题页也在机器清单中，必须有单 H1、稳定 Document ID、`CURRENT` 生命周期和“当前事实来源”元数据。

机器政策明确区分三类文件：

- **权威当前页**：承载当下合同与阶段事实，改动能力时须按阶段回写清单人工复核；机器校验结构、链接、ID、生命周期和事实来源元数据。
- **历史 / provenance 页**：保留当时决策、实施记录与 handoff；机器要求显著历史 banner、结构和链接，不为消除 warning 改写正文。
- **不可改写 evidence**：证据原文只作路径、结构、链接和敏感模式校验；不以当前文档格式或日期要求重写。

研究、实施记录和其他历史输入仍参与链接、围栏、结尾换行、Document ID 唯一性和敏感模式扫描，但已登记的历史表格问题只告警，不因此改写 provenance。

受控范围只能在[机器政策](docs-verification-policy.json)中扩展。不得为使单个 PR 变绿而在脚本里按内容字符串临时跳过。

## 4. 当前显式例外

| 路径 | 例外 | 理由 | 处置 |
|---|---|---|---|
| `docs/templates/前端技术方案模板.md` | 不强制新元数据 | 历史模板不是当前前端方案或 Release schema | `REFERENCE_ONLY`；需要正式前端方案时基于当前规范另行产出 |
| `docs/site-builder/12-site-builder-design-intelligence-and-cc-implementation-v3.2.md` | 历史表格列错误只告警 | `DATED_PROPOSAL` 必须保持原始证据；错误不影响 current truth | 原位保留 banner；不在 Phase 8 修正文义或移动文件 |

新增例外必须记录路径、规则、风险、Owner、到期/关闭条件和 successor。永久 wildcard、整目录关闭链接检查或“历史所以都不检查”不允许。

## 5. Registry 引用规则

机器校验只把唯一 Registry 表格的声明列视为定义，再验证所有受控文档中的稳定 ID 引用。Registry 其他列中的 Parent、Pages、Owner 或正文引用不会反向创造定义：

| ID 族 | 唯一机器查找源 |
|---|---|
| `CAP-*` | [Capability Registry](capability-register.md) |
| `OBJ-FE-*` | [Object Registry](core-object-register.md) |
| `PAGE-FE-*` | [页面与能力目录](../frontend/04-page-and-capability-catalog.md) |
| `SCN-FE-*`、`FX-FE-*` | [Scenario Catalog](scenario-catalog.md) |
| `ADP-FE-*` | [OSS Registry](../backend/oss-registry.md) |
| `OWN-*` | [责任词典](terminology-and-status.md#9-责任角色) |

存在性检查不能判断“这个 Capability 是否真的应该引用这个 Page”。语义关系继续由 [Traceability Matrix](traceability-matrix.md)和对应 Owner 审核。

## 6. 状态与证据护栏

- `CURRENT` 说明该文档承担当前规范，不说明内容已实现。
- `APPROVED_AT_GATE_*` 只来自真实批准记录；脚本不根据推荐语句自动升级。
- `AS_BUILT` 声明必须在 Capability/Traceability/Release Bundle 中链接到代码或机器合同，并把 `TEST_ANCHOR` 与当前运行结果分开。
- 只有真实用户可见发布才创建 Release Bundle；不预建空目录、索引或模板，Gate、文档提交或开发机探针不能伪造 release。
- 大体积日志、截图、扫描报告和含敏感字段的证据放受控 artifact store；Markdown 只保存脱敏索引、hash、环境、提交、时间、结果和 Owner。
- “最后核验”日期仅是人工追溯信息，**不**作为自动过期门；模型、运行环境、阶段完成或发布事实必须由 PR 阶段回写清单和人工事实核验更新，不能让无关代码提交触发机械失败。

## 7. 阶段完成回写清单

任何 PR 若改变当前能力、阶段完成度、运行时合同、模型晋级或发布边界，审查必须逐项确认并在 PR 中列出更新或不适用原因：

1. [当前状态](../status/current.md)、[路线图](../roadmap/release-plan.md) 与 [as-built 架构](../architecture/current.md)；
2. [产品边界](../product-scope.md) 与相关 ADR 的 dated as-built 注记；
3. 对应 Site Builder 专题合同页、API/评测/媒体页；
4. 历史入口、handoff、实施记录是否仍须显著标记为历史，而非改写 provenance；
5. 变更是否涉及模型、运行环境、发布或来源政策；若涉及，已否以代码/运行证据核验，而非从文档措辞推定。

不改变当前能力的纯文案、链接或格式 PR 也必须在 PR 模板中明确说明为何不触发本清单。

## 8. 变更与例外流程

1. 在本地运行校验并阅读全部 error/warning；
2. 修正 current 文档；若问题来自冻结证据，先登记例外或 successor，不静默改写历史；
3. 政策变更与脚本变更同 PR，说明新增误报/漏报面；
4. CI 失败不得以删链接、删状态或把文件移出受控目录规避；
5. Release 前另做人类任务走查，机器 PASS 不替代独立 reviewer。

## 9. 当前边界

该校验器不校验外部 URL 在线状态、DOCX 内部链接、Figma/原型内容、OpenAPI 业务兼容、生产证据真伪或用户可用性。外部来源有效期由相应 Owner 管理；机器合同继续使用现有 OpenAPI drift/lint/breaking 门；文档可用性必须由非作者的真实角色走查。
