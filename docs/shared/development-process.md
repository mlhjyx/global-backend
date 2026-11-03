# 开发与实施流程

> 文档 ID：`DOC-SHARED-DEVELOPMENT-PROCESS-001`
> 生命周期：`GUIDE`（2026-11-04 由 `DRAFT` 转正，产品负责人批准文档治理计划）
> 生命周期依据：承接已批准方案 §12；与 `AGENTS.md`、`docs/backend/ci-merge-automation.md` 一致。

## 0. 适用判断与开工准入

按改动性质选择最小充分流程（对标 Rust RFC 的 substantial change 判据）：

| 改动性质 | 必须 | 可以跳过 |
| --- | --- | --- |
| 对外行为、数据合同、安全边界、平台权威、费用路径 | 计划或 ADR + 独立自审 + 证据 | 无 |
| 内部重构、文档、测试、脚本 | 相关测试 + 自审 | ADR / 计划 |
| 紧急热修 | 先修复并留痕，事后补记录 | 事前计划 |

**Definition of Ready**（缺任一项不开工）：目标 / 非目标 / 验收标准 / 证据计划 / 回退方案；涉及不变量、费用或外部动作时，另记授权。

## 1. 文档梳理与实现状态

- 全部人类文档按 [documentation-rules.md](../documentation-rules.md) 放置；`docs/status/implementation-matrix.md` 是「设计 ↔ 实现」唯一矩阵。
- 每个模块 `technical.md` 必须维护「实现状态与缺口」：as-built 路径、测试、运行证据、缺口、下一步、owner。
- 文档生命周期：`DRAFT` → 评审 → `APPROVED`/`CURRENT` → 实施 → `CLOSED`；被取代标 `SUPERSEDED` 并归档。
- 矛盾登记在 `docs/governance/conflict-register.md`，不得在多个文档复制同一事实。

## 2. 功能开发流程

1. **需求/决策**：产品负责人拍板；写入模块 `product.md` 的「待决问题」→ 决定。
2. **设计**：模块 `technical.md` + ADR（对象归属/边界/安全/数据合同）。
3. **计划**：`docs/superpowers/plans/YYYY-MM-DD-<topic>.md`（生命周期字段、验收、回退）。
4. **TDD**：RED → GREEN → refactor；安全/RLS/预算/幂等用例优先；80%+ 覆盖。
5. **PR**：独立自审（`/code-review` 或逐文件）；5 项必需检查全绿；squash 合并（DEC-AIDEV-004）。
6. **dev 自动发布**：main 构建镜像 → `gctl switch-backend`（dry-run 后执行）→ 健康检查 → 失败回滚。
7. **验收**：Playwright 主链路 + 真数据有界样本；RuntimeEvidence；不把 dev 观察当生产证据。
8. **文档回写**：changelog 片段 + `status/current.md` + 模块矩阵状态。
9. **发版列车**：pilot/prod 人工审批；Release Bundle。

## 2A. 提案与验证生命周期

计划与提案统一四态；ADR 与证据各自只证明一轴：

| 状态 | 进入条件 | 谁确认 |
| --- | --- | --- |
| `DRAFT` | 计划落盘 | 作者 |
| `APPROVED` | 产品负责人批准 | 产品负责人 |
| `IMPLEMENTED` | PR 合入 main | 机器门 |
| `VERIFIED` | RuntimeEvidence PASS 或用户验收 | 产品负责人 / 证据 |
| `CLOSED` | 已交接或归档 | Owner |

ADR 的 `ACCEPTED` 只表示决定生效，不等于实现或验收；`docs/evidence/` 只证明验证，不升级产品承诺。

## 3. Definition of Done

- 代码 + 测试（单元/集成/RLS）+ 文档（模块 technical + status）+ 证据（运行/验收）+ 回退方案。
- 安全：scope/RLS/预算/幂等/错误分类通过负向测试。
- 数据：迁移可回退（expand-and-contract、迁移前备份）。
- 前端：i18n/四模式/七态/可见性红线通过走查。
- 闭环：功能声明上下游连接与端到端演示；孤立功能不算完成。

## 3A. 自审清单（合并前逐条）

1. 改动聚焦，无无关重排；2. 调用方与类型同步；3. 错误、权限与数据归属完整；4. RLS / 租户用例；5. 预算、幂等与重试语义；6. 迁移可回退且窗口有备份；7. 文档与合同同步；8. changelog 片段；9. 秘密与个人数据无泄漏；10. PR 如实披露未验证项。

## 4. 发布与回退

- dev 自动、pilot/prod 人工；镜像按 digest 钉住；`gctl switch-backend` 内置绑定续期与回滚。
- 数据库迁移 forward-only + 备份；破坏性变更分两步（expand → contract）。
- 失败回退：镜像回滚 + 配置回滚；不回滚数据时明确记录。
