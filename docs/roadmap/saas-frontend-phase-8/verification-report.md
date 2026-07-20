# Phase 8 机器验证与边界报告

> 文档 ID：`EVID-FE-P8-001`
> 层级：`L4 / Machine evidence`
> 状态：`FROZEN_EVIDENCE` / `APPROVED_AT_GATE_8`
> Evidence Owner：`OWN-QA-EVIDENCE`
> 工程基线：Phase 8 checkpoint `d3472c8`，基于 `origin/main@676c6cdc175326927ec341a2d585168aa0a1a374`
> 运行日期：2026-07-20

## 1. 验证结论

Phase 8 候选通过脚本语法、机器政策、全库文档校验、格式/差异卫生和变更边界检查。唯一保留告警是 v3.2 dated proposal 的一行历史表格分隔符列数错误；按已登记的冻结证据政策保留原文，不将告警升级为 current truth 风险。

本报告已用 Gate 8 候选树的最终命令输出回填计数。它不证明独立人工验收、产品实现、真实用户发布或生产可用。

## 2. 分层命令

| Layer | Command | 证明 | 当前结果 |
|---|---|---|---|
| 语法 | `node --check scripts/verify-docs.mjs` | verifier 可由 Node 解析 | `PASS` |
| 格式 | `pnpm exec prettier --check package.json .github/workflows/ci.yml scripts/verify-docs.mjs docs/governance/docs-verification-policy.json` | 新/改机器文件格式可重复 | `PASS` |
| 文档功能 | `pnpm docs:verify` | 结构、ID、状态、链接、Registry、历史 banner、Bundle schema、敏感模式 | `PASS_WITH_1_EXPECTED_HISTORY_WARNING` |
| 差异卫生 | `git diff --check` | whitespace/conflict marker 基础卫生 | `PASS` |
| 范围 | `git diff --name-only origin/main...HEAD` + working tree inventory | 没有产品代码、Schema、OpenAPI、依赖版本或 infra 产品变更 | `PASS_DOC_GOVERNANCE_ONLY` |

完整 API build/test、Prisma、真实 provider、数据库和浏览器 E2E 未运行：本阶段不修改产品 TypeScript、Schema、OpenAPI、renderer、依赖或运行环境。新增 Node verifier 以语法检查和全功能自运行覆盖；普通 CI 仍会执行既有完整 build/test jobs。

## 3. `docs:verify` 覆盖

最终运行应记录以下摘要：

| Metric | Final value |
|---|---:|
| Markdown files | `156` |
| Controlled Markdown | `101` |
| Unique Document IDs | `100` |
| Local links | `790` |
| Heading anchors | `50` |
| Markdown tables | `533` |
| Actual Release Bundles | `0` |
| Errors | `0` |
| Warnings | `1` expected historical warning |

Release Bundle 模板在 `docs/templates/`，空索引在 `docs/releases/README.md`；两者都不计为真实 Bundle。

## 4. 预期历史告警

| Code | Path / line | 原因 | 处置 |
|---|---|---|---|
| `TABLE_COLUMNS` | `docs/site-builder/12-site-builder-design-intelligence-and-cc-implementation-v3.2.md:1549` | dated proposal 的表头 5 列、分隔行 6 列 | 原文冻结；顶部强 banner + Registry successor + 自动 warning；不为全绿改写历史 |

若该告警消失，reviewer 必须检查历史文件是否被误改或政策是否被放宽，不能把“零 warning”自动视为更好。

## 5. 机器检查明确不覆盖

- 外部 URL 当日可用性与网页内容可信度；
- DOCX 内部内容、Figma/原型和二进制资产；
- 文档事实的产品/技术/法务最终正确性；
- 独立用户、产品、设计、前端、后端、QA 或运营可用性签发；
- 真实发布、生产流量、指标学习或回滚演练；
- 通用 DLP、完整 secret scanner、供应链和 License 最终审查。

上述边界分别由来源快照、事实 Owner、[角色任务](reading-route-acceptance.md)、[Release/学习治理](../../governance/release-and-learning-governance.md)和既有 Security/CI 门承担。

## 6. 人工路径状态

`ROUTE-FE-001..009` 已由作者完成路径 dry-run，结果为 `AUTHOR_ROUTE_DRY_RUN`；真实独立执行人为 `UNASSIGNED`，状态 `NOT_RUN / BLK-FE-006`。因此本报告不能把 Gate 8 的“人工检查通过”写成已满足。Gate 8 只能要求补做，或由产品负责人显式接受为收口后的首个真实设计/实现/Release 前置门。
