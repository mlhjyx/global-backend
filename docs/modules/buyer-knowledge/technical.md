# 买家知识网络 · 模块技术方案

> 文档 ID：`DOC-MODULE-BUYER-KNOWLEDGE-TECH-001`
> 生命周期：`DRAFT`（依据 2026-11-02 已批准方案起草）
> 生命周期依据：承接已批准方案 §3.6 与 contact-discovery；实现事实以代码与 status 为准。
> 模块产品说明：[product.md](product.md)

## 1. 变更历史

| 日期 | 变更 | 来源 |
| --- | --- | --- |
| 2026-11-02 | 初稿：canonical/identity/contacts/signals/suppression/背调 | 已批准方案 |

## 2. 技术概览

- 归属：引擎 `/global/backend`（NestJS + Prisma + Temporal + ToolBroker + Provider Adapters）。
- 数据面：workspace/RLS（canonical/contacts/signals 投影）；平台级 `source_signal` 无 RLS、零个人数据（ADR-003）。
- 执行面：所有出网经 ToolBroker（source_policy/预算/限速/SSRF/字节上限）；provider 注册表见 `docs/governance/provider-registry.json`。

## 3. 数据模型（核心）

| 表 | 要点 |
| --- | --- |
| `canonical_company` | workspaceId + dedupeKey 唯一；身份/行业/属性 |
| `identity_link` / `field_evidence` | 跨源身份与字段证据（来源/时间/置信度） |
| `company_contact_point` | 公司级联系路径（contact_page/impressum/contact_form/supplier_page） |
| `canonical_contact` / `contact_point` | 个人联系人（列级加密、最小化、scope 门控） |
| `source_signal` / `signal_ingest` | 平台级信号 + ingest-once 账本 |
| `suppression` / `suppression_decision` | 禁联事实与 append-only 决策 |

## 4. 管线与执行

- 发现 run：query → canonicalize（128 条/批）→ profile（官网/Impressum，30 天 TTL）→ signals（7 天 TTL）→ contacts（fit=match，2 并发、18 分钟软限）→ watches → patent。
- 联系人：`decision_maker`/`companies_house`/`inpi_rne`/`smtp_self`/`social_presence`/`social.fetch`；lawful basis 缺失时 fail-closed 或跳过；ToolPolicyDenied 不拖垮整家。
- 信号：TED/openFDA/SAM/海关（Comtrade 国家级）；共享源 ingest-once（指纹 × 6h 窗口）。
- 背调（新）：Temporal workflow 多源并行（searxng/Google Maps/Wayback/WHOIS/官网/社媒/平台），每源限速与缓存，证据入库 `field_evidence` + 背调报告表（新）。

## 5. 实现状态与缺口

**已实现**：canonical/identity/证据；公司级联系路径；联系人 M1–M4（十班车验收 4 名决策人）；信号 ingest-once；禁联；provider registry。
**缺口**：公司级 customs 源（仅 Comtrade 国家级）；背调工作流与报告表（Phase 3）；平台绿色事实与租户私有边界；contact 表 PII 保留期；`GET /suppressions` scope 调整待 gain-saas 跟进。

## 6. 测试

- 现有：discovery/contact/suppression 相关 spec；ingest-once 账本；RLS 真库测试。
- 需补：背调工作流（多源失败/超时/缓存）、跨空间 404、禁联阻断路径、信号过期。

## 7. 风险与回退

- 爬取 ToS 风险（Alibaba/Global Sources/BBB/Dubai Trade）→ 受控抓取 + 人工确认；可单独关闭 provider。
- 个人数据：scope + lawful basis + 最小化；删除走 DSR。
