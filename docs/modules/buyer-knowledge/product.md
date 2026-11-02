# 买家知识网络 · 模块产品说明

> 文档 ID：`DOC-MODULE-BUYER-KNOWLEDGE-PRODUCT-001`
> 生命周期：`DRAFT`（依据 2026-11-02 已批准方案起草，待模块评审后转 `CURRENT`）
> 生命周期依据：承接已批准方案 D3/D9 与买家背调设计 §3.6。
> 上层总设计：[产品总设计](../../product.md)
> 模块技术方案：[technical.md](technical.md)
> 项目进度：[当前状态](../../status/current.md)、[实现状态矩阵](../../status/implementation-matrix.md)

## 文档信息

| 项目 | 内容 |
| --- | --- |
| 模块名称 | 买家知识网络（03） |
| 模块一句话职责 | 持续积累可核验的买家企业、联系人、信号与证据，供发现与资格判断复用 |
| 产品负责人 | 产品负责人（本工作区） |
| 技术负责人 | Claude Code（开发代理） |
| 最近实质更新日期 | 2026-11-02 |
| 上层总设计 | [product.md](../../product.md) 第二章模块 03 |
| 模块技术方案 | [technical.md](technical.md) |
| 项目进度与验收记录 | [status/current.md](../../status/current.md)、[implementation-matrix.md](../../status/implementation-matrix.md) |
| 其他依据 | 已批准方案 §3.6 买家背调；contact-discovery 计划；SD5 红线 |

## 1. 变更历史

| 日期 | 主要变更 | 原因 | 影响 | 来源 |
| --- | --- | --- | --- | --- |
| 2026-11-02 | 初稿：canonical 公司、联系人、信号、禁联、背调 | 模块文档结构落地 | 全模块 | 产品负责人批准方案 |

## 2. 模块定位与边界

### 2.1 用户与目标

- 服务用户：获客运营者（通过引擎与 SaaS 间接使用）。
- 要解决的问题：买家企业信息分散、身份不统一、联系人不可核验、风险无法识别。
- 期望结果：workspace 内 canoncial 公司唯一、字段级证据可回溯、联系人可用但合规、信号时新、背调报告可指导判断。
- 在产品中的责任：为模块 04 提供买家事实与证据；不负责卖家匹配判断。

### 2.2 负责范围

| 范围 | 负责内容 | 完成条件 |
| --- | --- | --- |
| 当前设计覆盖 | 企业身份（canonical/dedupe）、字段证据、公司级联系路径、联系人发现（M1–M4）、信号（TED/openFDA/SAM/海关）、禁联名单、买家背调（新） | 公司可搜索、证据可点开、联系人按 scope 可见、背调报告可生成 |
| 后续范围 | 公司级 customs（ImportYeti 等）、更多注册处/展会源、平台级绿色事实 | RL2+，按渠道地图 |

### 2.3 明确不做什么

| 明确不做什么 | 原因 | 承接 |
| --- | --- | --- |
| 个人联系方式默认展示 | SD5 红线：仅 admin 决策人卡片、窄 scope | 模块 01 权限 + 引擎 scope |
| 平台共享买家企业身份给其他租户 | 卖家私有信息不混入平台绿库 | 平台共享仅限零个人数据的绿色事实 |
| 发送/触达 | 模块 07（RL4） | 不在本模块 |

## 3. 术语与核心对象

| 术语 | 定义 | 说明 |
| --- | --- | --- |
| CanonicalCompany | workspace 内的买家企业身份 | dedupeKey 唯一；非全球主档 |
| IdentityLink | 跨源身份关联 | 邮箱/名称/外部 id |
| ContactPoint | 个人联系点 | 列级加密、最小化 |
| CompanyContactPoint | 公司级联系路径 | 官网/Impressum/表单 |
| Signal | 需求/时机信号 | TED/openFDA/SAM 等；7 天/类型 TTL |
| Suppression | 禁联名单 | 任何对外动作第一道检查 |
| 背调报告 | 多源交叉核验结论 | 证据链 + 风险项（新） |

## 4. 模块流程

```text
发现 run → canonicalize（身份归并/去重）
  → website profile（官网/Impressum/联系路径）
  → signals（TED/openFDA/SAM/海关）
  → contacts（fit=match 公司，M1–M4）
  → 背调（搜索/地图/官网/社媒/平台/海关/信用）
  → 报告落工作空间，供线索判断与外联前风险门
```

## 5. 子功能设计

### 5.1 企业身份与证据

- 规则：canonical 只在 workspace 内唯一；每字段带来源、时间、置信度；跨源冲突进 `KnowledgeConflict`。
- AC：同一公司多次发现不重复建档；证据可回溯到 URL/时间。

### 5.2 联系人与可达性

- 公司级联系路径默认可用；个人联系人按 `contact-discovery:read`（admin）与 lawful basis 门控；RISKY 不伪装确定。
- AC：成员看不到个人联系方式；无 lawful basis 时联系人阶段 fail-closed 或跳过。

### 5.3 信号

- ingest-once（provider+queryFingerprint+6h 窗口）；平台级 source_signal 零个人数据；租户投影按 ICP 过滤。
- AC：同一源同一窗口只拉一次；信号过期自动剔除。

### 5.4 禁联名单

- 退订/投诉/删除请求对象；任何对外动作前检查；append-only 决策。
- AC：禁联对象无法被 accept/导出/触达；决策留痕。

### 5.5 买家背调（新，Phase 3）

- 检查项：搜索引擎、地图实景、官网（About/Contact/邮箱类型/产品匹配）、社媒（LinkedIn/Facebook/Instagram/YouTube/X）、B2B 平台（Alibaba/Global Sources/BBB/Dubai Trade）、数据平台（Panjiva/Similarweb/D&B，免费优先/手动）。
- 输出：结论、风险项、证据链、建议；矛盾预警（如规模与订单不匹配）。
- 规则：证据逐条可点开；高风险进入外联前风险门（可配置）；结论进入公司池与 ICP 排除规则。
- AC：一键生成报告；证据完整；高风险客户需人工确认才能外联。

## 6. 与其他模块的关系

- 模块 02：卖家资料（不混入买家库）。
- 模块 04：提供企业、证据、联系人、信号；接受任务级查询。
- 模块 01：空间隔离与 scope。

## 7. 验收标准

| 编号 | 验收 |
| --- | --- |
| AC-BK-1 | 公司搜索/详情与字段级证据可用 |
| AC-BK-2 | 联系人按角色与 lawful basis 可见，成员不可见 |
| AC-BK-3 | 信号 ingest-once 与过期剔除 |
| AC-BK-4 | 禁联对象在 accept/导出/外联前被阻断 |
| AC-BK-5 | 背调报告多源交叉、矛盾预警、证据可点开 |

## 8. 待决问题

1. customs provider 的免费源/爬取边界（ImportYeti ToS）。
2. 平台级绿色事实与租户私有信息的边界（模块 03 vs 平台共享）。
3. 背调风险门的默认策略（高风险是否强制人工确认）。
