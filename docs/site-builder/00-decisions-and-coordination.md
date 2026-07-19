# 00 · Site Builder 拍板决策与协同事实源

> **Site Builder 协同事实源**。开工前先读这份，并以代码、[09 施工图](09-m1-implementation-design.md)、[10 选型](10-model-selection-study.md) 和 `docs/adr/registry.md` 交叉核验。
> **2026-07-16 当前基线**：DOC-12 已由 #119/#120 形成并分发，[12 v3.2](12-site-builder-design-intelligence-and-cc-implementation-v3.2.md) 现为归档 proposal；#125 已完成项目 truth-sync，#126 已完成 R0 contract closeout。施工真值是代码 + 00–14 + ADR/status/roadmap。

## 1. 已拍板决策台账（改动需经拍板人，勿单方推翻）

| 决策 | 内容 | 出处/日期 |
|---|---|---|
| **组件库 v1 = 26 型** | 17 → 26（+Testimonials/PricingTable/TeamGrid/GalleryGrid/MarqueeStrip/IconFeatureGrid/HistoryTimeline/PageHeader/BackToTop）；v1.5 候选=NewsList 筛选/BeforeAfter/RegionsGrid；ScrollVideoHero/Interactive3DHero 不进封闭库 | **ADR-015 / D12**；11 号仅保留历史研究证据 |
| **🔴 R0-3 虚构身份红线** | demo-spec/文案**只用 intake 事实**；对未知企业类型**禁止**默认写 manufacturer/engineering team/QC/export packaging/认证/产能/年限/客户。缺=**中性措辞**（supplier/supply），绝不虚构 | 01 事实红线 + **[ADR-017](../adr/registry.md)**；✅ #123 已合并：确定性模板、`sanitizePolish`、提示词与强制守卫四处收口。后续任何 demo-spec 改动都必须保持该守卫绿 |
| **R0 intake 行为与契约** | 有/无旧站都无条件在同一 Site 发起 Demo；`hasWebsite/websiteUrl` 仅作背景。正式客户端使用 `Idempotency-Key`，响应固定为 `{siteId,buildId,status:"generating_demo"}` | ✅ #121 已去掉行为分叉；✅ #126 已补齐持久幂等、Temporal 启动证据、稳定错误码及 Swagger/OpenAPI，并移除响应 `mode` |
| **R0-4/5/6 生产化加固** | 联系邮箱不进通用 KB/品牌 Prompt；copy polish 真取消；201 后异步失败保留 Site/intake 并可原地重试 | ✅ #124 已合并（含存量脱敏脚本、`setup_failed` 契约与迟到 cleanup 守卫） |
| **模型路由** | currentRoute（现役=测试档）：7 task 走 deepseek-v4-pro/flash · glm-5.2 · minimax-m3 · doubao fallback。deepseek 一律**显式 v4-pro/v4-flash**，弃 chat/reasoner（官方 07-24 关停）。targetRoute（后期升级位）：copy→Claude Sonnet 5、视觉评审→Gemini 3.5 Flash 等，接通+评测后才切，**现在不接** | 02 §6 + 用户 2026-07-15 拍板；task-routes.ts |
| **D9 Readdy** | 默认 `visual_research_only`；仅有覆盖 AI 建站产品/衍生/商业分发的书面授权，且授权证据、范围、期限、地域、撤回与再分发权完整登记后，才可升为 `owned_export_authorized`；缺任一项 fail-closed。运行时零依赖，禁止逆向/sourcemap；旧字面量 `visual_reference_only` / `owned_export` 不再使用 | **ADR-019（现行真值）**；11 号已归档为历史研究 |
| **MF-0 媒体合同（薄版）** | MF0-thin 只落 `AssetVariant` 表 + 「删除查 active SiteSpec 引用→409」；执行拆为 MF0-A 数据地基与 MF0-B 删除安全两个连续 PR，总范围不缩水。`MediaJob`/`AssetUsage` **事件触发**（接生成式图片/视频前再补），不提前建 | 2026-07-15 裁决；MF0-A 2026-07-17 |
| **rembg 延后** | M1-c 纯 sharp，不加 rembg 容器（其唯一消费者=生成式重绘已延后）D-M1c-1 | 2026-07-14 认可 |
| **DOC-12 裁决与分发** | 三版 ChatGPT 稿（v2/v3/v3.2）是外部起草材料；接受项已分发进活文档和 ADR。12 v3.2 仅保留 provenance，不覆盖后续代码或决策 | ✅ #119 + #120，2026-07-16；本次 truth-sync 继续修正文档状态漂移，不重开 DOC-12 设计范围 |

## 2. 热点文件公约（防跨人冲突）

这些文件双人都会碰，**改前在 §5 认领，且尽量只追加不重写**：

| 文件 | 为何热 |
|---|---|
| `apps/api/src/site-builder/demo-spec.ts` | R0-3 修复 + demo 结构 |
| `apps/site-renderer/src/components/Section.astro` | 组件注册总表 |
| `apps/site-renderer/src/lib/themes.ts` | StylePreset |
| `packages/db/prisma/schema.prisma` | 迁移必须 additive、串行 |
| `apps/*/src/**/spec.ts`（SiteSpec 类型） | DQ-1 已由 #117 统一；共享形状**只改 `packages/contracts`** |

## 3. 合并顺序（谁先落地谁不 rebase）

1. **DQ-1 已完成并由 #117 合并**（`packages/contracts` 统一 SiteSpec 1.0.0 type-only）；后续分支均以它为基线，不再把 DQ-1 列为待办。
2. 改热点文件的先合、后合者 rebase。
3. schema 迁移串行，不并行两条迁移。
4. 风险类（schema/RLS/鉴权/迁移/合规）人审后合，见 [CONTRIBUTING.md](../../CONTRIBUTING.md)。

## 4. 交叉评审与合并权

每个 PR 都要经过 Codex 自动审查与至少一轮独立复核；碰热点文件、schema、迁移、鉴权或合规红线时，增加针对该风险面的对抗复审。处置每条 inline 意见后回复并 resolve。

**开发与合并权（2026-07-16 用户更新）**：**Codex 是当前开发主体**，负责读记忆/文档、规划、实现、验证、提 PR、处理审查意见和状态回写；旧 CC/Claude 会话及 `tugjvnh` 分支/worktree 是待 Codex 审计的历史/迁移 provenance，不再承担当前开发责任，独有提交核验前不得删除。Codex **不得自行合并到 `main`**；在 CI、审查线程与专项验证全部收口后，须由用户明确确认，再由用户或用户当次明确授权的 Codex 执行合并。碰热点文件 / schema / 合规红线（如 R0-3 去虚构身份）的 PR，**红线未清不予合并**。

## 5. 谁在做什么（滚动状态只查 Git，不固化临时分支）

Developer B 当前只负责 R1-min；template-distillation／DI-0 由既有独立任务所有，B 不得写入其 worktree、分支或活跃文件。R1-min 的任务边界、冲突停止门与 B1 开工门见 [Developer B R1-min 执行交接](handoffs/developer-b-r1-min-execution-brief.md)。该 handoff 是任务执行约束，不替代本页、09、ADR、status 或现场 Git 状态。

分支/worktree 是易变运行态，提交进文档会在合并后立即失真。开工前必须现场执行 `git worktree list`、`git branch -vv` 与各 worktree 的 `git status --short`，再把**本次认领**写进 PR 描述或协同评论；分支存在、旧锁记录或计划草案都不等于能力已开工/已落地。

当前持久事实以合并提交、开放 PR 和现场 Git 状态为准；后续施工顺序由本页 §1 与 [09 §11](09-m1-implementation-design.md) 决定。当前活跃认领不得从本仓旧表推断。

> 认领必须暴露热点文件冲突；无法从现场 Git 状态与 PR/协同记录核验时，一律视为**未确认**，不得擅自接管或覆盖。
