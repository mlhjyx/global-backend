# 独立站建设 · 模块技术方案

> 文档 ID：`DOC-MODULE-SITE-BUILDER-TECH-001`
> 生命周期：`DRAFT`（依据 2026-11-02 已批准方案起草）
> 生命周期依据：承接已批准方案 §3.3；实现事实以代码与 site-builder 00–14 为准。
> 模块产品说明：[product.md](product.md)

## 1. 变更历史

| 日期 | 变更 | 来源 |
| --- | --- | --- |
| 2026-11-02 | 初稿：as-built 架构、SiteSpec/Release、证据门、与模块 02 关系 | 已批准方案 |

## 2. 技术概览（as-built）

- 归属：引擎 `/global/backend`（`apps/api/src/site-builder`、`apps/site-renderer`、Temporal DAG、MinIO、Postgres/RLS、pgvector）。
- 编排：`refurbish.workflow`（intake→brand→asset→copy→assemble→quality→Release）；KB ingest 独立 workflow。
- 存储：`global-site-builder` bucket；`ws/{workspace}/{site}/{kind}/{hash}.{ext}`；Release `sites/{siteId}/releases/{releaseId}/...`。
- 证据：R4-A1（冻结源快照/quote/selector/hash）、R4-A2（allowlist/PII 门/审批链）；`PublishableClaimSnapshot`。

## 3. 数据模型（核心）

| 表 | 要点 |
| --- | --- |
| `site` / `site_version` / `site_release` | 站点与不可变发布 |
| `asset` / `asset_variant` | 素材、变体、引用保护删除 |
| `kb_document` / `kb_chunk` | 建站 KB（siteId NOT NULL） |
| `brand_profile` | 版本化品牌档案 |
| `site_build_run` / `site_build_step` | 构建运行与步骤 |
| `site_build_budget*` | 建站预算与结算 |

## 4. 实现状态与缺口

**已实现（M1 收口）**：intake、档案、素材、KB、固定 DAG、SiteSpec 1.0/1.1、Release/预览、R4-A1/A2 证据门、预算账本。
**缺口**：M2（编辑器/发布/域名/询盘/PublishReview）与 M3（视频/店铺导入/诊断）未实现；公网 inquiry 未实现；建站线冻结（PRD4-D1 未拍板）；KB 只读状态、无文档级管理；素材 bucket 无 SSE/versioning；`Asset.siteId` NOT NULL 使公司级资产不可用。

## 5. 与模块 02 的关系（重启后）

- 当前：KB 以 siteId 绑定；素材/AI 任务只服务建站。
- 目标：模块 02 为卖家知识唯一 SoR；建站 KB 改为消费 `seller_document`（过渡期双读，不迁移历史 `kb_document`）。
- 迁移风险：Site.profile 投影冲突；KB 双读一致性；Site Builder 合同变更需 ADR。

## 6. 测试

- 现有：M1 相关 spec、KB/assets、migration integrity、OpenAPI。
- 需补（重启时）：M2 发布/询盘、KB 双读、SiteSpec 1.1 兼容。

## 7. 风险与回退

- 冻结期间不得新增投入；重启前需重新审计价值、成本、owner 与验收证据。
- 回退：保留 Release 指针，回滚到上一版本。
