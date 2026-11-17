---
date: 2026-11-17
title: Verify exact company HTML for project evidence
---

- 起因：项目证据需要确认正文来自搜索发现的原网址。
- 改动：显式原址 HTML 调用拒绝重定向、非 HTML 和未经确认的回退内容。
- 测试：已核对临时组装副本的抓取回归；真实调用未执行。
- 未做：不改业务搜索排序、来源政策或真实调用准入。
