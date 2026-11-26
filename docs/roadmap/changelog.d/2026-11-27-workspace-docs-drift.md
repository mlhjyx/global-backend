---
date: 2026-11-27
pr:
title: Align project documentation with source and add local drift checks
---

- 起因：工作区 Agent 指令、运行说明和主线状态出现旧检查、旧命令与历史部署混写。
- 改动：收口工作树、模块、运行模式与发布文档入口。增加两仓关键文档的本地提示，复用 Markdown 解析，按改动主题提示回写，并补记当前主线的渠道与获客增量、Worker 租约和合成验收边界。
- 测试：本地漂移 CLI 回归覆盖断链、标题、失效脚本、合法入口及 Git diff 输入。完整检查结果随本次交付核验清单记录。
- 未做：运行配置、业务代码与发布采用各按现有流程处理。
