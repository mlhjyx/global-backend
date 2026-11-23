---
date: 2026-11-24
pr:
title: Bound browser readiness probe cleanup recovery to the same attempt
---

- 起因：浏览器就绪探针把任一清理未确认折叠成模块级永久锁存——此后所有调用不再进入 `runProbe`，而浏览器属于客户写入硬依赖，一次瞬时的进程组观测/受控目录删除失败会持续关闭受门控的客户写操作，且没有恢复入口。
- 改动：
  - 单例不再保存裸 boolean，而是保留同一 attempt 的清理义务：owned ChildProcess、stdio 关闭信号、建根时的 dev/ino/uid/mode 与未完成清理阶段；该义务只由 singleflight 调用链推进，晚到回调不会清掉更新的围栏。
  - 后续调用先做有界重观测：有界等待 close、复验原进程组终止、复验原身份目录后重试删除；只有终止与删除都证实后才重新武装，并必须马上跑一次完整 probe 成功才算就绪；清理成功本身不等于就绪。
  - 身份不明（建根后 lstat 失败）或身份被替换（dev/ino/uid/mode 不符、symlink）仍永久隔离，不猜测删除、不对未知 PID/组发信号；持续 EPERM/EIO/进程枚举超界保持原围栏。
  - 既有负控（EPERM 组确认、/proc EACCES/EIO、4096 枚举界、escaped descendant、替换根、单飞与可执行文件不匹配、PASS 不复用）全部保留；新增瞬态组观测恢复、清理成功≠就绪、瞬态删除重试三组反例。
- 测试：`browser-readiness-probe.spec.ts` 27/27（含 1000 次真实子进程 soak）；wiring/readiness/write-guard 回归 5 套件 122/122；`nest build` 与改动文件 ESLint 通过；未启动真实浏览器，未运行 smoke。
- 未做：未改浏览器依赖策略、customer-write 准入、readiness 其他组件、DB/schema/权限/预算；未部署或发布；真实浏览器 smoke 与现场 phase/errno 复现留待独立窗口。
