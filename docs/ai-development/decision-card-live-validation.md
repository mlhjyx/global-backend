# PR 决策卡真实验证记录

> 文档 ID：`GUIDE-AIDEV-005`
> 层级：`L5 / Guide`
> 生命周期：`GUIDE`
> 维护 Owner：`OWN-DOC-GOV（当前 UNASSIGNED）`
> 产品批准：[`DEC-AIDEV-001`](../governance/conflict-register.md#11-aidev-gate-1-已批准决策)
> 最后核验：2026-07-27，`origin/main@1f17636137a0efb826200866bacb21ceb007aa54` + `codex/decision-card-live-validation` 运营验收候选

## 目的与边界

本记录用于在 GitHub 真实 PR 上验证 `PR decision card` 工作流，而不是用单元测试代替运营验收。

- 只验证 bot-owned 评论、head 绑定、过期阻断、恢复和 main 规则集接入。
- 不改变 Site Builder 产品能力、公共 API、数据库、身份权限、模型路由、运行服务或发布状态。
- 验证 PR 的产品负责人授权保持 `NOT_AUTHORIZED`；技术建议、CI 和独立审查都不能代替逐 PR 合并授权。
- 工作流只能 checkout 默认分支的受信 base SHA，不执行验证分支代码。

## 验证矩阵

| 编号 | 操作 | 预期自动状态 | 预期检查结果 |
| --- | --- | --- | --- |
| V1 | PR 正文绑定当前 head，技术门和 Codex 建议保持 `HOLD` | `HOLD` | 通过 |
| V2 | CI 与独立审查通过后，正文绑定当前 head 并声明 `PASS / RECOMMEND_MERGE / MERGE` | `CURRENT_UNVERIFIED` | 通过 |
| V3 | 推送新的 canary head，但暂不更新 V2 决策卡 | `STALE` | 失败 |
| V4 | 把决策卡更新到新的精确 head，等待门保持 `HOLD` | `HOLD` | 恢复通过 |
| V5 | 新 head 的 CI 与独立审查完成后再次收口 | `CURRENT_UNVERIFIED` | 通过 |
| V6 | 将 `nontechnical decision card freshness` 加入 main 必需检查 | 当前 PR 继续可判定 | 规则集包含且强制该检查 |

## 证据要求

每个结果必须来自当前验证 PR 的 GitHub Actions run、bot 评论和实时 head，不从聊天或本地模拟推断：

- 记录 PR 编号、head SHA、run URL、自动状态和检查结论；
- `STALE` 必须由真实 `synchronize` 事件产生，并证明旧的 `MERGE` 声明会使检查失败；
- 恢复必须由 `edited` 事件重新绑定同一当前 head，不通过重跑旧 run 冒充；
- 规则集修改前后都读取完整规则，保留既有 pull request、删除保护、非快进保护、严格更新和必需检查；
- 规则集修改失败时不删除或弱化任何既有保护。

## 回退

工作流异常时，先从 main 规则集中移除新增的 freshness context，保留原有必需检查；必要时再通过独立 PR revert 工作流。验证 PR 不自动合并，关闭它不会改变产品或运行环境。
