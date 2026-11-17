---
date: 2026-11-17
title: Accept the same company's www evidence URL
---

- 起因：旧写入器拒绝同公司的 www 官网证据网址。
- 改动：只在公共网页公司来源核验中识别单个 www 别名，保留原网址。
- 测试：真实隔离 PostgreSQL 对照和 24 项写入测试；确认权限、其他站点和来源限制不变。
- 未做：没有迁移共享数据库或改变业务搜索与推荐。
