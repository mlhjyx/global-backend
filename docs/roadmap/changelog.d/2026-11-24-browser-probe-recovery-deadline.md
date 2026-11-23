---
date: 2026-11-24
pr:
title: Bound browser probe cleanup recovery IO and de-flake its escape control
---

- 起因：PR1079 合并后终审发现恢复截止只包住 close Promise；目录 lstat/rm 与 /proc 读取仍直接 await，单次卡住的 I/O 会把单例的 pending 固定住。escaped-descendant 负控与恢复等待同边界，存在 close 在断言窗口内发生的竞态；暂态身份重观测错误此前被永久围栏。
- 改动：每次恢复使用单一截止覆盖 close 等待、进程组观察与根目录释放；超时 fail-closed 返回 pending 并保留同 attempt 的未完成 I/O Promise（组观察与 rm 各至多一个在飞，后续调用等待同一 Promise，不并发重复清理）。首次建根无身份、真实替换 root（dev/ino/uid/mode/symlink）仍永久 fenced；`lstat` 的 ENOENT 仍 fenced，EIO/EACCES 等暂态重观测错误改为 pending，下次重试必须重新完成完整身份核验。
- 测试：escaped-descendant 负控改为受控生命周期（逃逸子进程存活到 finally，close 在断言期间不可能发生）并在 finally 前缓存终态；新增“暂态身份错误可重试后成功”“卡住的 rm 不超预算且不重复清理、恢复后新 probe 成功”“卡住的 /proc 观察有界返回 pending”三组用例；既有负控与 soak 全部保留。
- 未做：不改探测/就绪策略、customer-write 准入、公共错误码或其它 readiness 组件；未启动真实浏览器、未部署。
