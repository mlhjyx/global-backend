---
date: 2026-11-15
title: Prepare protected candidate verification and conservative grant allocation tools
---

- 起因：未合并工业泵分支需要可验证的开发制品来源；画像、计划和 Run 分账户授权不能独立证明本轮合计不超 US$5。
- 改动：增加候选 owner SSH 与外部 CI 证明合同、精确提交导出/验证 CLI，以及 SQLite 原子不可回收上界分配器。普通发布不变；文件保全测试夹具显式初始权限，避免 umask 077 下模式变更断言成为空操作。
- 测试：真实临时 SSH 签名、Git 提交导出、子进程并发预算、崩溃重开、未知状态与冲突身份拒绝；文件保全在 umask 077/022 下均通过。
- 未做：真实候选发布、机器身份或凭据创建、实例部署、真实 A/B 与供应商费用结算。后续运行和发布接线需完整 bootstrap 才可使用。
