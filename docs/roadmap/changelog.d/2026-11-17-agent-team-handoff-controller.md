---
date: 2026-11-17
pr:
title: Add the agent-team handoff controller state machine, hooks and installer
---

- 起因：批准任务的工序接力（工程交付 → 独立审查 → 合并 → 已批准下一任务）此前依赖人工转发，曾出现漏派同 head 复审；需要可恢复、可审计的持久状态推进，同时不引入服务、模型框架或 CI 轮询。
- 改动：
  - 新增 `scripts/agent-team/state_machine.py`：严格 schema 校验、SHA256 规范化、flock 原子文件事务（fsync + replace）、纯 reducer、唯一 ready action、gate/action ledger、claim/finish lease、重复事件幂等、新 head 失效旧通过、容量上限。
  - 新增 `scripts/agent-team/controller.py`：薄 CLI、Stop 护栏、一次性 PostToolUse 原生会话探针、`bind-commit` 绑定、仅合并自有条目的 settings 安装/卸载；hook 不调用 gh/MCP/模型，不执行事件携带的 shell。
  - 新增 `schema-v1.json`、脱敏 S1 回放样例与 README；governance 工作流在既有 job 增加标准库 unittest 步骤（不新增 job/action/依赖）。
- 测试：`python3 -I -B -m unittest discover -s scripts/agent-team -p 'test_*.py' -v` 全过，覆盖 S1 漏派回放、重复事件/并发 claim、同 head 补证据、新 head 失效、FAIL 回原 writer、EOF 三次上限、merge readback、门缺失、暂停、坏状态、非主管/subagent no-op、探针矩阵、settings 保留/幂等/冲突/卸载与秘密不外拷。
- 未做：真实 PostgreSQL 并发、真实宿主 Stop 交付与主机级 EOF 重唤醒未在本 PR 验证；本工具首次 PR 仍走现有审查与合并流程，安装与真实烟测由主管在合并后协调。
