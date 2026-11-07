---
date: 2026-11-08
title: Add the Pack Studio ops API with deterministic evaluation receipts and a publish gate
---

- 起因：S1 Pack v1 第 3 步（设计 `docs/superpowers/plans/2026-11-08-s1-pack-v1.md`，S1-D1~D10 已批准）——让 Pack 的编辑、校验、试跑、评测、发布、激活/回滚与灰度有可运营的引擎 ops 面，并且发布必须过评测门。
- 改动：
  - 新增 `/api/v1/packs` ops API（ops:read/ops:write）：目录/详情、草稿创建与编辑（可从已发布版本派生）、validate（四类 Schema + 语义 + 单包冲突模拟）、dry-run（按行业/市场/动作选择器解析并给与当前版本的简报差异）、eval（运行 `evals/evals.json` 的确定性用例并写不可变 `eval_receipt`）、publish（要求摘要匹配且 30 天内有效的通过回执）、activate（platform 默认或 workspace 白名单灰度；回滚=激活旧版本）、workspace 启停覆盖。
  - 7 个内置内容包各新增 5 条确定性评测用例（选包/排除、规则摘要、简报上限、内容要点、去营销化），随生成目录进入运行时。
  - 迁移 `20261108140000_pack_version_publish_grant`：`pack_version` 对 app_user 开放 INSERT（Studio 发布），UPDATE/DELETE/TRUNCATE 仍禁止；`app-user-table-privileges.json` 同步。
  - 漂移判定修正：内置目录只钉住同版本的 seed 行；Studio 发布的新版本由不可变版本行与发布门自证（新增单测）。
  - OpenAPI 重新导出（11 个新路径 + Packs tag + 门户正文说明）；ai-foundation 模块文档补 Studio 一节。
- 测试：单测 139 例（Studio core 发布门矩阵/简报 diff、评测执行器 7 包全过与篡改用例失败、控制器授权与参数校验、迁移静态契约含新授权）；一次性真库端到端：草稿→校验→评测 5/5→发布 1.1.0→平台激活→解析器见 1.1.0→停用过滤→未评测草稿发布被拒；一次性容器（CI 口径）ACL 20 例、raw-SQL 2 例、pack RLS 5 例、skill RLS 5 例全过。
- 未做：gain-saas 运营台页面（P6 后置）；S1-4 两个新技能与导入 A 档；模型实测层回执（S1-4 起用于模型技能）。
