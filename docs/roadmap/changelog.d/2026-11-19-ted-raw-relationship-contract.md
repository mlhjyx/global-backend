---
date: 2026-11-19
pr:
title: Align TED role metadata with the raw writer contract
---

- 起因：独立测试经销轮第一条TED查询失败；已结算结果零出网复放得到3条TS准入而SQL拒绝的记录，SQL旧闭集尚不支持已有self_role/relationships。TED/OSM来源归一化还会拒绝自身canonical输出。
- 改动：新前向迁移严格验证现有最小化角色关系后，把仅用于旧验证链的副本去掉新字段；实际Raw payload保留关系、主体国家及来源。保留原name/identifier、大小、策略、租户、ACL和search_path保护。归一化接收精确canonical端点，转换前拒绝不安全URL组件；CI增加真实app_user/RLS writer回归。
- 测试：先取得真实PostgreSQL五项RED及来源归一化八项RED；修复后验证实际写入、读回角色、旧记录、幂等、策略/租户、恶意字段与数量边界，相关CI随PR核验。
- 未做：不删除实际角色字段，不改历史迁移/失败运行/账本，不放宽费用、来源、身份或资格门；只向独立测试发布并重跑受影响经销搜索，生产保持不动。
