---
date: 2026-11-15
title: Add a protected development candidate publication boundary
---

- 起因：现有不可变镜像发布限定 main，未合并分支无法用正常受证 API 验证新规划。
- 改动：增加受保护 main 的候选发布 workflow，分离无发布权限构建与可信发布。候选使用独立包权限、受信外部字节验证、获批标记比对、digest 回读及独立定制 attestation；主线正式发布规则不放宽。
- 测试：workflow 权限/顺序/固定 action 合同、owner/source/marker/实例绑定、提交 archive 排除 ignored 文件与可信验证 CLI；action 版本从官方仓库只读解析并记录完整提交。
- 未做：GitHub environment 或凭据配置、workflow dispatch、镜像发布与部署。候选不得用于 pilot/production，运行与业务验收仍需真实证据。
