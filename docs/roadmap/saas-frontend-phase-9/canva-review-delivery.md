# Phase 9 Canva 评审交付登记

> 文档 ID：`DESIGN-FE-P9-006`
> 层级：`L2 / Review communication registry`
> 状态：`DRAFT`
> 交付状态：`NOT_CREATED / WAITING_FOR_FIGMA`
> 事实 Owner：`OWN-DESIGN`
> 最后核验：2026-07-23

## 1. 工具边界

Canva 只承担设计评审、方案汇报和管理层沟通，不创建产品事实、组件、页面状态或交互真值。所有 Canva 内容必须从已冻结的 Figma 节点和 Phase 9 总账派生，并回链原 Figma Node；Canva 修改不能反向覆盖 Figma。

## 2. 计划交付物

| Artifact ID | 交付物 | 版式 | 输入门 | 当前状态 |
|---|---|---|---|---|
| `CANVA-P9-001` | 《全产品体验与架构评审》 | 16:9 汇报 | 能力架构、Provider/SoR、页面族、设计系统 v1 和代表页面冻结 | `NOT_CREATED / WAITING_FOR_FIGMA` |
| `CANVA-P9-002` | 《关键旅程与页面族总览》 | 视觉报告 | 12 条 Journey、Page Manifest、关键状态和 Figma Node 可追踪 | `NOT_CREATED / WAITING_FOR_FIGMA` |
| `CANVA-P9-003` | 管理层单页路线图 | 单页，可选 | 里程碑、依赖、风险和非目标完成产品评审 | `NOT_CREATED / OPTIONAL` |

## 3. 内容结构

### `CANVA-P9-001`

1. 产品目标与六个产品表面；
2. 六项 SaaS 任务域和横向控制面；
3. 企业资料动态引导和知识抽取边界；
4. Site Builder 当前/目标分层；
5. Buyer Intelligence 冻结边界；
6. Aitoearn/Chatwoot/BaoTa/new-api Provider 架构；
7. 五张视觉基线与设计系统；
8. 24 个页面族及新增候选；
9. 12 条核心旅程；
10. 状态、权限、证据、成本和异常恢复；
11. 当前 blocker、停车项和采用门；
12. 验证计划、交付阶段与下一决策。

### `CANVA-P9-002`

- 一张全产品表面地图；
- 一张能力—对象—SoR—页面族矩阵；
- 12 条 Journey 分组总览；
- Today、Site Editor、Buyer Development、Unified Inbox、AI Task Strategy 五类代表模式；
- Figma Node、产品状态和评审结论索引。

## 4. 质量与安全门

- 不含真实密钥、客户 PII、生产账号、未脱敏截图或真实客户数据；
- 页面标题必须显示 `AS_BUILT / TARGET / PROPOSED / PARKED / BLOCKED`；
- 禁止把 Figma 空文件、Mock、竞品截图或 Provider API 写成已实现产品；
- 外部素材必须保留来源、权利和使用目的；
- 导出前检查 16:9、PDF、中文字体、德语长文本和移动阅读缩略图；
- 每次导出登记 Canva URL、版本、Figma 输入节点、Owner、reviewer 和日期。

## 5. 开始条件

Canva 不在 Phase 0 启动。至少满足以下条件后才创建：

1. `FIG-P9-003` 的 v1 Token 和核心组件通过设计评审；
2. 五类代表页面至少各有一个受控 Figma Frame；
3. 两个 FigJam 的固定规格、准备度和 RFQ 遗留节点已修正；
4. 评审材料所引用的页面均有产品状态和 Figma Node；
5. 用户确认需要进入管理层汇报制作。
