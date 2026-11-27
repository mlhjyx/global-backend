---
date: 2026-11-27
pr:
title: Keep qualified market routing and governed directory intake consistent
---

- 起因：行业名录的实际来源 URL 带 www 时，入库校验与应用归一化不一致，流式寻源可能在入池前缺少查询回执。带项目尾注的中国市场标签也会造成选源和检索语言错误。
- 改动：数据库对名录来源保留实际 HTTPS 地址，识别与应用一致的单个 www 别名，仍拒绝其它来源。计划补齐读取市场主体，识别中国大陆并在中国市场过滤只覆盖英国的 Companies House。
- 测试：隔离 PostgreSQL 用真实 app_user 确认名录写入、精确 URL 读回和异域拒绝。市场补齐、语言识别与名录回归通过。
- 未做：正式站点已有失败任务的重试和客户评测待部署后开展。
