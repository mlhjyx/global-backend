# 00 · Site Builder 拍板决策与协同事实源

> **双人协同的单一事实源**（mlhjyx + tugjvnh）。开工前先读这份。
> 完整设计真值仍在 01-11 + [09 施工图](09-m1-implementation-design.md) + [10 选型](10-model-selection-study.md) + `docs/adr/registry.md`；本文只汇总**已拍板、且影响协同**的决策 + 协作公约，避免决策散在个人 memory 里对方读不到。

## 1. 已拍板决策台账（改动需经拍板人，勿单方推翻）

| 决策 | 内容 | 出处/日期 |
|---|---|---|
| **组件库 v1 = 26 型** | 17 → 26（+Testimonials/PricingTable/TeamGrid/GalleryGrid/MarqueeStrip/IconFeatureGrid/HistoryTimeline/PageHeader/BackToTop）；v1.5 候选=NewsList 筛选/BeforeAfter/RegionsGrid；ScrollVideoHero/Interactive3DHero 不进封闭库 | 11 号 + D12，2026-07-14 拍板 |
| **🔴 R0-3 虚构身份红线** | demo-spec/文案**只用 intake 事实**；对未知企业类型**禁止**默认写 manufacturer/engineering team/QC/export packaging/认证/产能/年限/客户。缺=留空提示补，绝不虚构 | 01 事实红线 + **[ADR-017](../adr/registry.md)**；🔴 **分派 tugjvnh 在其 `feat/site-builder-industrial-template` demo-spec PR 内修**（用户 2026-07-16 拍板）——该分支现把 demo-spec 290→577 行且**新增更多虚构身份**（"Manufacturer & Exporter" 等），合并前须按 ADR-017 清成只用 intake 事实、缺项留空。CC 侧不各改一版（避免与该热点文件冲突） |
| **模型路由** | currentRoute（现役=测试档）：7 task 走 deepseek-v4-pro/flash · glm-5.2 · minimax-m3 · doubao fallback。deepseek 一律**显式 v4-pro/v4-flash**，弃 chat/reasoner（官方 07-24 关停）。targetRoute（后期升级位）：copy→Claude Sonnet 5、视觉评审→Gemini 3.5 Flash 等，接通+评测后才切，**现在不接** | 02 §6 + 用户 2026-07-15 拍板；task-routes.ts |
| **D9 Readdy** | 默认 `visual_reference_only`；仅拥有授权后升 owned_export 走一次性改造工序入封闭库；运行时零依赖、不逆向 | 11 号 D9，2026-07-14 认可 |
| **MF-0 媒体合同（薄版）** | M1-c 只落 `AssetVariant` 表 + 「删除查 active SiteSpec 引用→409」；`MediaJob`/`AssetUsage` **事件触发**（接生成式图片/视频前再补），不提前建 | 2026-07-15 裁决 |
| **rembg 延后** | M1-c 纯 sharp，不加 rembg 容器（其唯一消费者=生成式重绘已延后）D-M1c-1 | 2026-07-14 认可 |
| **12 号裁决版** | 三版 ChatGPT 稿（v2/v3/v3-2）为**外部起草稿**；采纳其 24 条审计 + 设计智能层，按裁决版口径落地。裁决版成文前，01-11 + 09 仍是施工真值 | 2026-07-15 评审完毕，裁决版待成文 |

## 2. 热点文件公约（防跨人冲突）

这些文件双人都会碰，**改前在 §5 认领，且尽量只追加不重写**：

| 文件 | 为何热 |
|---|---|
| `apps/api/src/site-builder/demo-spec.ts` | R0-3 修复 + demo 结构 |
| `apps/site-renderer/src/components/Section.astro` | 组件注册总表 |
| `apps/site-renderer/src/lib/themes.ts` | StylePreset |
| `packages/db/prisma/schema.prisma` | 迁移必须 additive、串行 |
| `apps/*/src/**/spec.ts`（SiteSpec 类型） | DQ-1 统一前是双真值；统一后**只改 packages/contracts** |

## 3. 合并顺序（谁先落地谁不 rebase）

1. **DQ-1 共享契约最先**（packages/contracts 统一 SiteSpec/DesignBrief）——两人之后都 rebase 到它。
2. 其次：改热点文件的先合、后合者 rebase。
3. schema 迁移串行，不并行两条迁移。
4. 风险类（schema/RLS/鉴权/迁移/合规）人审后合，见 [CONTRIBUTING.md](../../CONTRIBUTING.md)。

## 4. 交叉评审与合并权

Codex 自动审之外，**双人互审对方 PR**（尤其碰热点文件、schema、合规红线时）。处置每条 inline 意见后回复并 resolve。

**合并权（2026-07-16 用户定）**：tugjvnh **只推审核 PR，不自行合并到 `main`**；合并一律由 **CC + 用户审核后进行**。碰热点文件 / schema / 合规红线（如 R0-3 去虚构身份）的 PR，**红线未清不予合并**。

## 5. 谁在做什么（滚动更新，开工即认领）

| 人 | 分支 | 在做 | 碰的热点文件 |
|---|---|---|---|
| mlhjyx/CC | `chore/deepseek-v4-and-execution-baseline` | deepseek v4 迁移（已合 #114） | — |
| tugjvnh | `feat/site-builder-industrial-template` | M1-e 组件 + demo-spec（**测试中，未完成**）；**+ 🔴 R0-3 去虚构身份**（ADR-017，用户 2026-07-16 分派——本分支现新增虚构身份，合并前须清成只用 intake 事实） | demo-spec.ts / Section.astro / themes.ts |

> 更新本表 = 认领工作、暴露热点文件冲突。空着=没人认领。
