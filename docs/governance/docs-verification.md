# 文档自动校验与例外治理

> 文档 ID：`GOV-FE-008`
> 层级：`L1 / Normative governance`
> 状态：`CURRENT`
> 评审状态：`APPROVED_AT_GATE_8`
> 事实 Owner：`OWN-DOC-GOV`
> 机器政策：[`docs-verification-policy/v1`](docs-verification-policy.json)
> 最后核验：2026-07-20
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
| Release Bundle | `docs/releases/` 中真实 bundle 缺必需元数据或章节 | 各证据真实通过或发布成功 |
| 敏感模式 | Markdown 出现高置信私钥、长 API key 或 AWS access key 模式 | 已完成完整 DLP/secret scan |

所有硬失败退出码为非零。输出中的计数是本次扫描范围，不是产品能力、测试通过数或发布证据。

## 3. 受控范围

受控范围包括：文档门户、治理 Registry、全局前端规范、设计规范、Phase 1–8 评审包、OSS 采用包、Release Bundle 与新模板。旧 Site/研究/实施记录仍参与链接、围栏、结尾换行、Document ID 唯一性和敏感模式扫描，但其历史表格问题默认告警，不因此改写冻结 provenance。

受控范围只能在[机器政策](docs-verification-policy.json)中扩展。不得为使单个 PR 变绿而在脚本里按内容字符串临时跳过。

## 4. 当前显式例外

| 路径 | 例外 | 理由 | 处置 |
|---|---|---|---|
| `docs/templates/前端技术方案模板.md` | 不强制新元数据 | 主工作区曾有用户删除现场；本分支中的历史基线不能被当成恢复授权 | `REFERENCE_ONLY`；新方案改用受控模板，后续删除/迁移另授权 |
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
- 只有真实用户可见发布才在 `docs/releases/` 创建 Release Bundle；模板、Gate 包、文档提交或开发机探针不能伪造 release。
- 大体积日志、截图、扫描报告和含敏感字段的证据放受控 artifact store；Markdown 只保存脱敏索引、hash、环境、提交、时间、结果和 Owner。

## 7. 变更与例外流程

1. 在本地运行校验并阅读全部 error/warning；
2. 修正 current 文档；若问题来自冻结证据，先登记例外或 successor，不静默改写历史；
3. 政策变更与脚本变更同 PR，说明新增误报/漏报面；
4. CI 失败不得以删链接、删状态或把文件移出受控目录规避；
5. Gate/Release 前另做人类任务走查，机器 PASS 不替代独立 reviewer。

## 8. 当前边界

该校验器不校验外部 URL 在线状态、DOCX 内部链接、Figma/原型内容、OpenAPI 业务兼容、生产证据真伪或用户可用性。外部来源有效期由采用/来源快照管理；机器合同继续使用现有 OpenAPI drift/lint/breaking 门；文档可用性由 Phase 8 角色任务执行。
