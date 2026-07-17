# 09 · M1 精装修管线 — 落地设计（implementation design）

> 状态：**已认可（2026-07-14 用户拍板：设计整体 go；D-M1-1=质量环进 M1、确定性优先；D-M1-2…9 按推荐执行；四通道后接不阻塞）**。设计真值 = 本目录 01-08（PR #90 已批准）；决策真值 = `docs/adr/registry.md`（ADR-013~019，2026-07-16 立）。本文是 M1 的**施工图**：实测证实的承重假设 + 镜像 M0 as-built 的 grounded 落地触点 + 合规 + 关键决策 + 主动风险/权衡 + TDD 步骤。对标先例：`docs/implementation-records/ted-provider-spec.md`。实现按 §7 分 PR 交付，每 PR 本地全绿 + 真机 verify + 对抗复审。
>
> **2026-07-16 回写（v3.2 §24/§26 分发入本文，Reviewed against 12 v3.2）**：新增 §10 生产化审计（R0–R4 定点修复 + 各阶段前置门）、§11 施工 PR 图（粒度/顺序/风险分级）、§12 目标态消费契约与 schema；并就地校正过时表述（组件库 17→26 型/ADR-015；rembg 移出 M1-c/ADR-018；「终选」改四态路由 currentRoute/targetCandidate/ADR-016；R0-3 禁虚构身份引 ADR-017）。**严格区分 as-built（§2 触点 + `@global/contracts` SiteSpec 1.0.0 type-only）与目标态（§12，SiteSpec 1.1 / 内容生命周期，未落地）**。
>
> **2026-07-17 as-built**：#121/#123/#124 已完成 intake 行为与安全修复；#125 已完成 truth-sync；#126 已完成 R0 contract closeout；R1-safety ①+②、**R2-A1–A4、MF0-A/B、M1-c、R3-A、R3-B1/B2 与 R4-A1 均已落地**。DQ-1 已由 #117 合并；下一施工序是 **R4-A2 → R4-B-min**，再进入 M1-d 并激活非 en build。

---

## 0. 定位与边界

- **M1 = 把 M0 的「demo v0 快速通道」升级为「精装修管线」**：输入 = intake + 向导五组档案 + 上传素材 + KB；输出 = 新 SiteVersion（source=`build`）+ 预览。核心四阶段：P1 理解（KB 摄入 Temporal 化 ‖ brandProfile 全网研究）→ P2 素材 fan-out（图片管线 ‖ 多语种文案 ‖ 动效预设）→ P3 组装（designSpec → siteAssembly → 三重校验 → Astro 构建 → 预览）→ P4 质量环（≤3 轮）→ P5 事件收尾。
- **一处口径张力（发现于设计提取，需拍板）**：01-prd §7 把「质量环（审核/SEO/审美）」列在 M2，而 02-architecture §4 把 P4 定义在精装修管线内。**推荐（D-M1-1）**：M1 含 P4 骨架，走「确定性优先」——qa（Playwright+Lighthouse，主体确定性）与 seo（确定性检查表）立即激活；**审美评审（需视觉模型）设计上自带「评审失败→该维弃权」降级（03 卡6），在候选通过真实图像输入 capability probe 前自动弃权**，通道就绪后零改码激活。这样既不违背 02 的管线完整性，也不把 M2 的模型评审成本提前。
- **不在 M1**：发布/域名/询盘后端（M2）、视频 Seedance 与店铺导入与 SEO 诊断（M3）、独立预览域名（等购域，2026-07-14 用户已定「后买、先本地路径预览跑通」，切换=改 `PREVIEW_URL_PATTERN` env 零代码）。
- **生产化审计前置（2026-07-17 as-built 复核）**：M0/M1-a/M1-b 的**主干保留**，已确认问题按消费者与正确性分流。truth-sync、R0 contract、**R1-safety ①+②、R2-A1–A4、MF0-A/B、M1-c、R3-A、R3-B1/B2 与 R4-A1**均已完成；当前关键顺序是：**R4-A2 → R4-B-min → M1-d**。R3-B2 已完成本地 durable artifact/原子 pointer；R1-min 剩余生产对象存储 Release、跨节点恢复/回收与 unknown component 门仍须早于 M1-e 可见预览；MODEL-0/EVAL-bootstrap、DI-0 等可按各自消费者并行。

## 1. 承重假设与实测证据（2026-07-14 全部只读真探，无 sandbox）

| # | 假设 | 探法 | 结果 | 对设计的影响 |
|---|---|---|---|---|
| H1 | 设计目标候选模型 targetCandidate（claude-sonnet-5 / gemini-3.1-pro / gpt-image-2 / seedance）可用 | 网关 `/v1/models` + 逐名微量真调；2026-07-17 用户补充当前通道真值 | ❌ GPT/Gemini/Claude 通道尚未接入；✅ 当前文本集合为方舟 11 个 + DeepSeek 双档 | 模型路由必须**配置驱动、按名探活**；targetCandidate=用户接通道后经评测晋级+翻配置（ADR-016，非永久终选） |
| H2 | 网关现有可用文本模型足以真跑 M1 全链文本任务 | DeepSeek 双档与方舟通道批测；具体任务再走 task-shaped probe | ✅ 方舟 11/11 连通，DeepSeek 双档已接；R4-A1 最终真跑由 DeepSeek Pro 完成两轮结构化 Activity，但此前同任务也观察到 DeepSeek 超时与 `glm-5.2` 空 content/`finish_reason=length`，证明连通不等于稳定 | currentRoute 只从已接集合选经具体任务评估的子集；调用层须给足 token/timeout 并对空 content 显式失败 |
| H3 | 图片/视觉/视频能力当下可用 | 同 H1 | ⚠️ `images/edits`（gpt-image-2）无通道；`minimax-m3` 虽在已接文本清单，plan 端点真实图像输入尚未真探；视频另待 M3 | imagePipeline 生成步与视觉质检、审美评审 = **capability-gated**，未就绪即显式跳过（`enhanceSkipped`/该维弃权），绝不拿文本模型硬顶 |
| H4 | Docling 能转真 PDF（M0 只软检） | 现造真 PDF 宣传册，按 `DoclingClient` 生产同形状 POST `/v1/convert/source` | ✅ status=success，全文精准转出 markdown | P1 资料解析可靠；M0 欠账在设计期即闭合 |
| H5 | 图片管线本地依赖可行（历史探测环境为 Mac arm64） | npm registry 查 Sharp、另对 rembg 做后置研究 | ✅ Sharp 有预编译；rembg 镜像当时可得 | **当前 M1-c 只据此采用纯 Sharp**（重编码/EXIF/多尺寸）；rembg 探测仅留历史证据，不构成 M1-c 依赖或已落地能力 |
| H6 | 品牌研究链路容器可用 | curl 健康探测 + egress 真机矩阵 | ✅ SearXNG:8081=200、Crawl4AI:11235=200；fake-IP-only DoH 回退下 `/md`+`/crawl` 公网可用，private/loopback/metadata/redirect 负向全绿 | P1 可复用 client；API 与 Crawl4AI 双层 pinning gate 已闭环，broad allow-internal 已移除 |
| H7 | 预览无需域名 | M0 as-built | ✅ `/preview/{slug}/` 路径式已跑通（PREVIEW_URL_PATTERN 晚绑定） | M1 全程本地路径预览；D7 独立预览域推迟到购域后 |

## 2. Grounded 落地触点（镜像 M0 as-built；完整盘点见提取记录，此处为施工要点）

### 2.1 Schema（packages/db/prisma）
- **新表 `brand_profile`**（schema:1137 注释已点名）：`id/workspaceId/siteId/version/valueProps(Json)/tone(Json)/glossary(Json)/keywords(Json)/differentiators(Json)/competitors(Json)/factSheet(Json)/gaps(Json)/researchDegraded(Bool)/createdAt`，版本化追加不覆盖；RLS + FORCE RLS（M0 六表先例）。**evidence 结构分级**：factSheet 每项 `{value, evidence:{sourceType: intake|upload|storefront|web_research, url?, fetchedAt?}}`（合规 D2）。
  - 🔴 **R4-4 幂等/provenance（M1-d 前）**：schema 增 `buildRunId(唯一)/inputHash/promptVersion/model|route/sourceSnapshotHash/usage|cost`——否则同一 Temporal 活动重试会**再调模型并追加版本**（不幂等、重复成本、不可重放）。同一 `buildRunId` 重试先**复用已有成功 BrandProfile**，不再调模型。
  - 🔴 **R4-A1 Evidence 2.0 基础（✅ 2026-07-17）**：`{sourceType,url}` 升级为共享 `EvidenceRefV2{sourceId,sourceType,sourceRole,contentHash,quote,selector,...}`；模型前冻结经 PII 清洗/规范化/有界截断的 intake/KB/storefront/research source，KB 精确到 chunk hash，web 正文由服务端重算完整 SHA-256。SearXNG 原始 title/snippet/path/query/fragment 不冻结，只按站主公司名 + external origin 生成最小 `research_hint`。所有新模型事实必须有 8–512 code point 精确 quote，并由服务端重新绑定 source/type/hash/selector 后追加进不可变、FORCE RLS 的 provenance 表；旧 v1 行不伪造回填。无公开 OpenAPI/SiteSpec 版本变化。
  - 🔴 **R4-A2 truth bridge（待完成，M1-d 前）**：R4-A1 只证明引用完整性。A2 负责 value 中数字/单位/认证代码/专名与 quote 语义一致，否则降 gap；web 搜索 snippet/`research_hint` 不得 publish；认证强制 ready cert Asset 或人工 verified；通过门的事实才关联公共 Claim/Evidence，并以 APPROVED 作为发布条件。
  - **站点渠道投影定位（v3.2 §9.1，1.1 目标态）**：BrandProfile 定位为**站点渠道投影**，消费仓库已有 `CompanyProfile/Offering/Claim/Evidence`（不复制）；新 Copy 只消费 `PublishableClaimSnapshot`（evidence gate 通过且 APPROVED 的 Claim），旧 `factSheet` 双读一个迁移周期。详见 §12.4。
- **Asset.meta 扩展**（Json 内，零迁移）：`hasPerson`（A5/A7 肖像分支）、`aiEdited`（E3 AI Act 钩子，M1 恒 false 但字段落地）、`derivedKeys` 已预留列直接用。
- **SiteVersion 并发修复（R1-3，M1-e/并行构建前）**：`version = count+1` 在多 run 下撞 `@@unique([siteId,version])`（M0 已埋雷；version-alloc.ts 注释「天然避开并发」不成立，并发/活动重试仍可 P2002）→ `allocateNextSiteVersion` 在**同一事务**先取 `site-version-{siteId}` advisory lock 再读 `max+1`（intake 先例），加 `buildRunId` 索引，若维持「一 run 一版本」则加唯一约束。
- `SiteBuildRun`：`kind='refurbish'`、`phase='P1_understanding'…'P5_publish'`、`scope/steps/costSummary/temporalRunId` 列全部 M0 已建未写，M1 零迁移直接写。🔴 **R3-4 修（M1-d 前）**：`temporalRunId` 从未写入且 `AlreadyStarted`/ACK 模糊——launcher 须回写 `firstExecutionRunId`，`WorkflowExecutionAlreadyStarted` 对同 `buildRunId` 视为幂等成功，不误标 failed。**R4-6 修（M1-d 前）**：`costSummary` 已暴露 API 但品牌任务未把成功/失败/fallback 真实成本持久聚合到 run（无法计费/审计）——落**持久聚合真值**（成功调用/失败调用/schema repair/timeout/fallback/工具成本）。
- **`SiteBuildStep` 一等可恢复记录（v3.2 §4.4，1.1 目标态，非 as-built）**：`SiteBuildRun.steps JSON` 只作**读模型**；进度真值改一等记录 `SiteBuildStep(buildRunId,key,itemKey,attempt,status,progress,degraded,errorCode,costCents,artifactRefs,startedAt,finishedAt)`，唯一键 `(buildRunId,key,itemKey,attempt)`。**R3-5 修**：每阶段活动完成后增量落 phase/progress/step/cost（前端轮询看真实进度、故障可定位），不只在 begin/finalize 写整块。
- **`AssetVariant` 新表（MF-0-thin，v3.2 §20.2，M1-c 前置门 · ADR-018）**：可发布派生 = `assetId、variantType、mime、width/height/duration/bitrate、objectKey、contentHash、pipelineVersion、recipeHash、sourceVariantId、status/error/metadata`，`unique(assetId,recipeHash)` 保幂等；RLS + FORCE RLS（M0 六表先例）。`MediaJob`/`AssetUsage` **不是 M1-c 前置**（无消费者不预建，MF-1 additive 补建，ADR-018）。表结构/删除守卫/derivedKeys 兼容投影完整契约见 [14 号](14-media-foundation-mf0.md)。
- KbDocument `status` 中间态（parsing/chunking/embedding）与 `source`（wizard/storefront/web_research）M0 已预留，M1 启用。

### 2.2 API（apps/api/src/site-builder，07 草案为准）
- `POST /sites/{id}/builds`（scope=site|page|section + options{stylePreset?,pages?,locales?}，`Idempotency-Key`，409=进行中/429=配额）——**取代 02 §3 的独立 regenerate 端点**（07 已归一）。
- `GET /builds/{id}`（phase/progress/steps/costSummary）；`POST /builds/{id}/cancel`。**SSE 推迟**（轮询先行，D-M1-6）。
- `GET /sites/{id}/kb/status`：`gaps[]` 从 brand_profile 最新版本回填（kb.service.ts:116 挂账）。
- `GET /sites/{id}/spec?locale&materialized` + `PATCH /sites/{id}/spec`（JSON-Patch 写回 CopyBundle/结构，422 带定位）+ versions/rollback + style-presets/style——工作台资料中心与手动微调面。
- 触发模式镜像 M0：`REFURBISH_LAUNCHER`（demo-launcher.ts 的 Symbol+DI 模式），`workflowId='site-refurbish-${buildRunId}'` 幂等；**patchProfile 绝不隐式触发构建**（显式 build 端点）。

### 2.3 Temporal（apps/api/src/temporal）
- `refurbishWorkflow`：P1（`ingestPendingKb` ‖ `buildBrandProfile`）→ P2 `Promise.all`（`processImages`（逐图，单图失败不阻断）‖ `writeCopy`（逐 locale，单语种失败缺席本轮）‖ `assignMotionPresets`（确定性零模型））→ P3（`buildDesignSpec` → `assembleSpec` → 校验/构建带错误回填重试）→ P4 循环 ≤3（`runQa` ‖ `runSeo` ‖ `runAestheticReview`（capability-gated）→ `applyFixPatch` → 重构建）→ P5 outbox `SiteDemoReady/SiteBuildProgress/SiteBuildFailed`。
- 编排单测复用 **PR #73 mock proxyActivities harness**（external-intent.workflow.spec.ts 先例，两行接线）；必测分支：scope 增量重跑/单素材失败不阻断/预算超限暂停/≤3 轮出环/同 site 并发去重。
- 🔴 **所有异步终态失败都保站**：#124 后 `cleanupFailedDemo` 只在该 run 仍为最新 demo 时把 Site 置 `setup_failed`，保留 intake 并允许原地重试；**refurbish 失败同样绝不能删用户站点**——不动 activeVersionId，version/run 标 failed。只有 intake **201 返回前**的新站同步 launch 失败仍可补偿删除本次新建 Site；不得把这条同步补偿扩到已接受的异步 workflow。
- KB 摄入 Temporal 化（assets.controller.ts:77 挂账）：commit 后不再 fire-and-forget，改走独立 `kbIngestWorkflow`（D-M1-7）；**保留「失败留 queued 可重触发」语义**。

### 2.4 L2 AiTask（新目录 apps/api/src/site-builder/agents/）
统一契约（03 §0，镜像获客侧 task-registry + M0 `site_builder.demo_copy` 先例）：输入 zod fail-fast → 固化 prompt（用户数据只进模板变量位）→ `gateway.generateStructured({task, schema, maxTokens},{workspaceId})` → 输出 zod 不过带错误重试 ≤2 → settle 落 `costSummary`。prompt = 版本化代码资产 `agents/<name>/prompt.ts`。
- `brandProfile`：KB digest（来源标注+截断，D4 注入防线）+ SearXNG/Crawl4AI 研究（**robots 遵守复用 web_watch 先例**；R1-safety API/Crawl4AI 双层 egress gate 已落地，C1/C3）→ 模型综合 → **确定性出口闸**：factSheet 逐项 evidence 非空 + web_research 单源不支撑认证类断言（降 gaps）；输出 schema 不设个人字段（C4 结构性排除）。
- `copy`：每 locale 独立原生写作；确定性槽位完整/长度校验+超长定向重写；**只引 factSheet**（认证/数字断言关键词表比对，`FABRICATION_PATTERNS`/`sanitizePolish` 从 demo-spec.ts 上移共享）；richtext=受限 ProseMirror JSON（D15 白名单节点）。
- `designSpec`：预设 token 空间内选择/微调，WCAG AA 对比度校验器拒绝不合格 overrides（themes.ts 白名单同步扩展）。
- `siteAssembly` / `assemblyFix`：输出完整 SiteSpec（Puck 形状，04）/ **只许 JSON-Patch**；三重门（zod/引用完整性/语义规则：每页恰 1 H1、询盘 ≤2 击、Footer 必在、alt 100%、nav 无孤岛）+ Astro 构建错误回填重试；`collectTextKeys` 升级为门 2 的 copyBundle 覆盖率断言，产物 grep `⟦` 做缺 key 零成本门。
- `qa` / `seo`：确定性主体（Playwright 三断点遍历 + Lighthouse 四分；SEO 检查表含 hreflang 互指、noindex 硬检查、**产物 HTML 第三方外呼域黑名单**——F1 字体判例的可执行化）+ 模型只做 findings 归并（flash 档）。qa 硬门：零死链/表单可用/console 零 error/Perf≥85/A11y≥90。
- `imagePipeline`（✅ **M1-c as-built = 纯 Sharp 确定性算法**，ADR-018/D-M1c-1 已把 rembg 与生成式重绘移出）：固定序为严格 MIME/20 MiB/40 MP/4 channels/单页解码 → 自动方向/sRGB → 重编码/去 EXIF·GPS·XMP → 版本化质量 warning → 显式 focal 的受控 cover、其他路径不放大 → 源图可承受的 320/640/960/1440/1920 AVIF/WebP/fallback。inspection 与编码均在可超时终止、全 worker 默认并发 1、有协议/路径/输出硬上限的子进程；Ubuntu 编译子进程另有 `prlimit`，仍不能表述为生产容器/cgroup/独立 UID/禁网隔离。writer 在首次对象写前持久预占完整 recipe set；过期 producer 只能写带一日 lifecycle tag 的 token 隔离 attempt key，当前 token 重新取得 Asset/key fence 才能在 15 秒有界窗口内 promote canonical 并转 ready，copy 去除 TTL tag；ready 账本缺对象 fail-closed，attempt 在重试前以 8 路有界 IO 对账压缩，settled cleanup 重放只重删冻结 attempt，cleanup IO 接 cancellation+110 秒 deadline。新 cleanup 原件+Variant+attempt 总对象≤128，历史无 attempt 合同保留 129 对象上界。生产 lifecycle 默认 validate-only/缺失阻启，仅单一部署 owner 可管理。refurbish 首个 Activity 物化≤512 个排序 Asset ID 的不可变 workset，再按两张/Activity 有界执行；旧 cursor 仅保留 replay。坏图逐项降级；`hasPerson` 只沿用已有真值，`aiEdited=false`；cert 图片只走确定性处理，PDF 跳过。生成式重绘/rembg/视觉质检/pHash+embedding = M1-c2/M3；公开 process/select API 与 Renderer 固定 Variant 消费不在 M1-c。

### 2.5 渲染器（apps/site-renderer）
- 组件库补齐 04 §5 v1 封闭 **26 型**（D12/ADR-015，17→26；现渲染器已注册 **10** 个：AboutBlock/CertWall/CtaBanner/FaqAccordion/HeroBanner/InquiryForm/MapLocation/ProcessTimeline/ProductGrid/StatsBand）：+TrustBar/ProductDetail/FactoryShowcase/CaseStudies/WhatsAppFloat/VideoBlock 等 + 既有组件补变体位；封闭枚举 `type`/`variant`，Section.astro 注册表扩展（🔴 **R1-4 修**：未知 type 从静默 null 改 **fail-closed**——契约漂移不再被掩盖）。26 型清单是 04 契约真值，本文只引不复述。
- 多语种：`getStaticPaths` 扩 locale 维（`/{locale}/...`，默认 locale 免前缀），CopyBundle per-locale，`ar` 触发 `dir="rtl"`；hreflang 互指由 seo 检查兜底。
- **自托管字体对**（F1 🔴）：fontsource 包内嵌构建，`typography.fontPair` 枚举；构建产物禁 `fonts.googleapis.com` 等外呼域（qa 静态检查）。
- 图片（v3.2 §20.5）：`props.image={assetId,usage,focalPoint?}` + 顶层 assets manifest 对账；M1-e 图片组件**统一输出 `<picture>`**（AVIF/WebP/fallback + `width/height` 避免 CLS + `loading/fetchpriority/sizes` 按角色）；**build 时固定 `variantId`**——禁组件自拼对象存储 URL、禁 Renderer 自选最新 Variant、**禁外链 URL 直嵌**（🔴 ADR-014，校验器已管）。

### 2.6 M0 已埋雷（实现时必须绕开）
① refurbish 补偿≠删站（见 2.3）；② `previewBasePath` 与 `previewUrlFor` 必须继续同源于 `PREVIEW_URL_PATTERN`；③ SiteVersion version 并发（见 2.1）；④ KB 摄入迁移保留 queued 重触发语义；⑤ 模型调用统一走 gateway 封装（禁散落 fetch）。

## 3. 模型路由与四通道现实

**per-task 路由表（配置驱动，`agents/task-registry`；「现役主选」列 = 今天就能真测的 `currentRoute` 默认值，「targetCandidate」列 = 用户接通道后经评测晋级再翻配置，02 §6 唯一真值）**：

> **路由四态（ADR-016，非「永久终选」）**：下表「现役主选」列 = `currentRoute`（as-built 真值 = 代码 `task-routes.ts`）；「升级位」列 = `targetCandidate`（成本约束候选，**须经评测晋级才成 `promotedRoute`，非采购承诺**）。10 号文档评测 + 用户拍板只作 `evaluatedCandidate` 证据，**推荐 ≠ 代码已切换**。deepseek 一律显式 `v4-pro`/`v4-flash`（chat/reasoner 官方 2026-07-24 关停）。唯一真值=02 §6 与 10 号文档，下表为施工执行版：

| task | 现役主选 currentRoute（已实测活） | deterministicFallback / 回退链 | targetCandidate（待通道评测晋级） |
|---|---|---|---|
| site_builder.brand_profile | deepseek-v4-pro（或 minimax-m3，评测并列） | glm-5.2；web 研究失败独立降级位 `researchDegraded` | gemini-3.1-pro / GPT-5.6 Terra |
| site_builder.copy | deepseek-v4-pro（🔴 护栏：`reasoning_effort:"low"`+长度裁剪+factSheet 白名单后校验） | glm-5.2 → doubao-seed-2.0-pro | GPT-5.6 Luna / gemini-3.1-pro |
| site_builder.design_spec | minimax-m3（与审美评审同档，多模态） | doubao-seed-2.0-pro | gemini-3.1-pro / GPT-5.6 Terra |
| site_builder.assemble / fix | **glm-5.2**（超时预算 180s） | 三重门校验→超时/违规自动回退 deepseek-v4-pro；批量档 doubao-seed-2.0-code | GPT-5.6 Terra / claude-sonnet-5 |
| site_builder.qa_summarize / seo_review | deepseek-v4-flash | doubao-seed-2.0-lite | gemini-3-flash |
| site_builder.image_qc / image_edit | seedream-5.0-lite（方舟已接真出图；图生图同端点，mask 保主体语义 M1-c 真探） | 确定性步兜底（`enhanceSkipped`） | gpt-image-2 `images/edits`（贵精档） |
| site_builder.aesthetic_review | minimax-m3（plan 端点收图与否 M1-f 真探） | **该维弃权**（03 卡6 降级语义），不阻断出环 | gemini-3.1-pro / GPT-5.6 Terra |

原则：**文本任务 = currentRoute 使用已评测的 DeepSeek 主档与方舟 fallback 子集（合法路由，非静默降级）；能力缺失任务（视觉/图编）= 显式跳过并落标记，绝不拿文本模型硬顶**。通道接入后翻 registry 配置 + 重启 worker 即切换（获客侧 #35 先例：旧进程持旧注册表须重启）。豆包视频中转坑（issue #2174/方案 B 直连方舟）与 M1 无关（视频=M3），仅在契约留降级位。

**MODEL-0 路由治理落地（v3.2 §23.4/§23.7，profile 化，非本文自封终选）**：Agent 只绑 **ModelProfile 语义档**（`structured.default/reasoning.high/copy.premium/text.bulk/multimodal.review/text.summary/image.*/video.*/…`）**不绑型号**（ADR-016）。`task-routes.ts` 从 `task→model string` 改 `task→profile + task budget`；保留 `SITE_BUILDER_MODEL_*` 紧急 model override，增 `SITE_BUILDER_PROFILE_*`；registry 解析后记录 `policyVersion` + model snapshot。建议文件布局（禁 provider fetch 散落）：`agents/model-profiles.ts`（profile/capability 类型）· `model-policy.registry.ts`（四态 + 流量模式/健康度/区域/价格/生命周期）· `model-capabilities.ts`（structured/vision/video/edit/async-job 静态声明）· `model-capability-probe.ts`（真 endpoint 验 IO/JSON/finish_reason/超时）· `model-promotion.service.ts`（**MODEL-0 不预建完整服务**，shadow/canary/rollback 状态机后期真流量才建）· `media-gateway/`（图/视频/语音异步任务）。**每 task 路由工程门**：固定 `maxTokens/timeout/reasoning effort/maxCost/fallback policy`；`finish_reason=length`、空 content、schema 不合、capability 不符**必须是显式错误码**；模型原始输出**先过 schema/事实/引用/安全门**再进 DB/Renderer；alias 运行时解析到 snapshot 存 ReleaseManifest（历史重放/回归定位）；Judge 尽量不与 candidate 同 provider（先确定性门再盲评，防高文风掩盖事实错）。分期晋级 MODEL-1（候选真探 + 6–12 样本 task-shaped eval）/MODEL-2（真流量前 30×3 + shadow/canary + 自动回退）见 §11。

**用户侧通道就绪清单（不阻塞 M1 开工，影响激活时点）**：① Anthropic → claude-sonnet-5（组装主力）② Google → gemini-3.1-pro + flash 档（研究/文案/视觉三评审）③ OpenAI → gpt-image-2 且**确认网关转发 `images/edits`**。接入一条我实测一条、翻一条。

## 4. 合规红线（编号沿用提取记录 A-F；🔴=硬闸）

- **A 素材**：A2 sharp 一律解码重编码+剥 EXIF（GPS=个人数据）🔴；A3 双闸（presign 出票限制 + commit 魔数复验，M0 已建沿用）；A4 Docling 容器非特权无网络（compose 规格化）；A5 人物照默认不做生成改动；A6 证书图永不生成式处理 🔴；A7【补】人脸检测落 `hasPerson` 标记。ToS 素材权属条款=SaaS 侧阻塞项（对外依赖清单）。
- **B KB**：B1 删除链路可证（document 级联删 M0 已建；workspace 注销接 Art.17 编排先例）；B2 embedding 只许自托管端点（配置校验非自由 URL）🔴；B3 检索 RLS；B4【补】**用户自有资料含 PII：用户=控制者/我们=处理者，可入 KB 仅限本 workspace 消费；(a) 不回流获客绿库 🔴 (b) copy 输出具名人白名单（仅显式团队素材可上站）(c) 受 B1 删除覆盖**。
- **C 研究**：C1 SSRF 的 R1-safety 门已完成：Crawl4AI、robots 与 `http.get` 均按解析后 global-unicast、连接 pinning、redirect 逐跳、metadata/内网/IPv4-mapped/上限校验，broad allow-internal 已移除 🔴；C2 抓取内容只进模板变量位（AiTask 基类结构性保证）🔴；C3【补】robots 遵守（web_watch 先例）+ 竞品只做定位参考不搬运；C4 第三方页面具名个人不落库不进 Brief（schema 结构性排除）🔴。
- **D 文案**：D0【🔴 红线 ADR-017 NO-FABRICATED-IDENTITY / R0-3】**demo-spec 与文案 agent 只用 intake 事实**——对未知企业类型**禁止**默认写 manufacturer/engineering team/production/QC/export packaging/认证/产能/年限/客户名单等身份声明；缺 = 留空 + 提示补录，绝不虚构。✅ #123 已把无证据措辞改为中性事实安全（`supplier/supply/requirement review/delivery & support`），并加 sanitizer/提示词/CI 守卫；仅 BrandProfile 明确证实企业类型后才升级措辞。D1 factSheet 零虚构=模型后置**代码闸**（evidence 非空，缺=gaps）🔴；D2【补】evidence 分级溯源（R4-A1 已落 `EvidenceRefV2` 引用完整性，R4-A2 待落 quote/value 与发布真值门，见 §2.1）；D3 只引 factSheet+禁绝对化宣称；D4 kbDigest 来源标注+截断；D5 预览产物过 L1 确定性筛查（词库资产先建，L2 模型审查挂 M2 发布门）。✅ **R0-4 #124**：`intakeToMarkdown` 已不再写 `businessEmail`；联系信息只留 `Site.intake` 受控结构区，并提供幂等存量脱敏脚本（各部署环境仍须执行并留证）。
- **E 图片**：E1 mask 外重绘、无 mask 不许调编辑端点 🔴；E2 主体 pHash+embedding 双保险（不过=原图）🔴；E3【补】`aiEdited` day1 落数据（AI Act 钩子）；E4 图库/图标许可白名单+禁外链直嵌。
- **F 渲染**：F1 字体自托管 + 产物外呼域黑名单检查 🔴；F2 构建沙箱（M1 先落资源限额+超时，无网络容器化列 M2 硬化项——本地 dev 构建本就同机）；F3 预览 noindex 硬检查+随机 slug（M0 已有）。

## 5. 关键决策（带推荐；D-M1-1 需拍板，其余默认可推翻）

| # | 决策 | 推荐与理由 |
|---|---|---|
| D-M1-1 | M1 是否含 P4 质量环（01/02 口径张力） | **含，确定性优先**：qa/seo 主体是 Playwright/Lighthouse/检查表（今天就能真测且价值最大）；审美维 capability-gated 自动弃权，Google 通道来了零改码激活。管线形状一次成型，避免 M2 再动编排 |
| D-M1-2 | 文本模型先用当前已接集合跑通全链 | **是**：currentRoute 采用已评测的 DeepSeek 主档与方舟 fallback 子集，不等 GPT/Gemini/Claude；registry 配置化，后续候选接入并通过评测后再翻配置。eval 基线在切换前后各跑一轮量化差异 |
| D-M1-3 | gpt-image-2 生成步现在写吗 | **不写调用代码，也不在 M1-c 预建其 rembg/mask 步骤位**：当前无真实消费者与可验证通道；M1-c 只落 Sharp 的重编码/方向/sRGB/EXIF-GPS/质量门/裁切/多尺寸。生成式编辑进入 M1-c2/M3 时再随真实合同加 feature flag |
| D-M1-4 | 组件库扩展幅度 | **补齐 04 §5 封闭 26 型**（D12/ADR-015，17→26）：契约是封闭枚举，P3 组装 prompt 需要完整菜单；现渲染器已注册 10 个，增量 16 个（M1-e-A）。ScrollVideoHero/Interactive3DHero 不进封闭库 |
| D-M1-5 | M1 语种范围 | **en + de 真跑**（golden=德国市场先例），`ar`(RTL) 进渲染器单测但不进 M1 golden；语种是 options 参数非硬编码 |
| D-M1-6 | 进度推送 | **轮询 `GET /builds/{id}` 先行**，SSE 端点 M1 末段可选（07 允许轮询替代；SaaS 前端未接，YAGNI） |
| D-M1-7 | KB 摄入 Temporal 化形态 | **独立小 workflow**（`kbIngestWorkflow`，commit 触发）而非并进 refurbish：上传时刻≠构建时刻，摄入失败重触发语义独立 |
| D-M1-8 | 观测 dashboard（02 §11.12） | costSummary/steps 落库全量 + 结构化日志；**可视化 dashboard 推 M2**（YAGNI，SaaS 前端未接） |
| D-M1-9 | rembg 接入形态 | **~~compose 常驻容器~~ → 移出 M1-c（2026-07-16 ADR-018/D-M1c-1 更新）**：M1-c = **纯 Sharp 确定性算法**，不加 rembg 容器——rembg 主体 mask 的唯一消费者=生成式背景重绘，已延后到 M1-c2/M3（无消费者不预建，YAGNI）。H5 记录的 rembg 本地可行性保留，待生成式重绘 feature flag 接入时以 compose 常驻容器（官方镜像 HTTP 模式，同 docling）落地 |

## 6. 主动风险/权衡（没问但该知道）

1. **模型任务形状与主档集中风险**：部分主任务仍优先 DeepSeek，方舟 fallback 已降低单 provider 风险，但“通道连通”不代表长结构化任务稳定；网关配置漂移、超时或空 content 仍可让 build fail-closed。缓解：AiTask 探活+显式失败+run 可重跑；按 task-shaped eval 晋级更多现有候选，后续再接 GPT/Gemini/Claude。
2. **P95<15min 与质量环相乘**：3 轮 × Astro 重构建（M0 单次 ~5-6s，M1 组件×语种×图片后会涨）+ 逐图处理。缓解：P2 素材并行 + content_hash 幂等跳过 + 增量 scope；verify-m1 落真实计时基线，超标再优化（不预优化）。
3. **reasoning 模型结构化输出**：v4 双档思考吃 token、JSON 模式行为与非 reasoning 模型不同。缓解：generateStructured 统一封装 maxTokens 预算 + zod 重试 ≤2；eval harness 记录每 task 成功率。
4. **后置 rembg 对工业产品图的分割质量未知**（管道/异形件/反光金属）。它不在 M1-c 范围；只有 M1-c2/M3 出现生成式背景重绘真实消费者后，才以独立 feature flag 和 Golden 图集 IoU/主体保护评测决定是否接入。
5. **成本**：03 §10.6 底数（一轮 ¥5-15）基于终选模型；deepseek 期间显著更低，但质量环×3 会放大调用数。缓解：ModelBroker 单 build 上限 + 预算超限暂停事件（02 §4 已定）。
6. **Golden Set 授权**（08 §10 待拍板）：真实工厂资料脱敏授权未定。缓解：EVAL-bootstrap 先用合成/明确授权资料完成 **6 fixture 启动集**，通过后扩到 **12 视觉子集**；不得用「2 家 smoke」冒充 Golden 覆盖完成。
7. **Playwright/Lighthouse 依赖**：CI 只跑纯单测（仓规），qa 的浏览器检查只进本地 verify——意味着质量环回归依赖本地跑。接受（与获客侧 verify 体系一致）。
8. **范围体量**：M1 是 M0 的 ~2.5 倍触点（新表 1 + 新 AiTask 7 + 组件 +7 + 多语言 + 质量环）。缓解：§7 分 7 步、每步独立 PR 独立可回滚，任一步卡住不连坐。

## 7. TDD 实施步骤（每步 = 1 PR：RED→GREEN→本地全绿→真机 verify→对抗复审→合并）

> **与 §11 生产化审计 PR 的交织（2026-07-17 as-built 复核）**：下表 M1-a…M1-g 是**能力主序列**；R0 contract、R1-safety、R2-A 四项、MF0-A/B、M1-c、R3-A、R3-B1/B2 与 R4-A1 均已完成。下一施工顺序为 R4-A2、R4-B-min，完成后才进入 M1-d。R1-min 余项早于 M1-e 可见预览；MODEL-0/EVAL-bootstrap、DI-0 按各自消费者并行。完整依赖与风险见 §11。

| 步 | 内容 | 主要触点 | 新增 spec（先红） |
|---|---|---|---|
| M1-a | 地基：brand_profile 表迁移+RLS、SiteVersion 并发修复、`POST /sites/{id}/builds`+`GET /builds/{id}`+cancel、REFURBISH_LAUNCHER、refurbishWorkflow 骨架（P1-P5 空活动+按 kind 分叉补偿）、KB 摄入 Temporal 化（D-M1-7） | schema/migrations、builds.controller/service、temporal 3 文件 | builds.service.spec、refurbish-workflow.spec（PR#73 harness）、kb-ingest-workflow.spec、version-alloc.spec |
| M1-b | P1 brandProfile：AiTask 基类+registry、KB digest 组装（D4）、web 研究（robots；受已落地的 R1-safety egress gate 约束）、factSheet evidence 分级闸（D1/D2）、gaps→kb/status | agents/base、agents/brand-profile、kb.service gaps | ai-task.spec、brand-profile.spec（含零虚构/单源降 gaps/schema 无个人字段）、kb-digest.spec |
| M1-c ✅ | P2 图片纯 Sharp 管线：严格解码、方向/sRGB、EXIF/GPS/XMP 剥离、warning-only 质量指标、focal crop、无放大响应式 AVIF/WebP/fallback；inspection/编码子进程可超时终止且低并发/有输出上限（不等于生产沙箱）；写前 durable owner + attempt→canonical token/key fencing、对象回读、当前 recipe manifest 原子发布；refurbish 冻结 ID workset + 两张有界批次/逐图降级/旧载荷兼容。无生成式、公开 API 或 Renderer 消费 | image-pipeline、runner/child、service、Temporal activity/workflow | 专项单测 + `verify-site-builder-m1c.mts` 真 PG/RLS/MinIO 30 断言 |
| M1-d | P2 文案：copy AiTask（多 locale/槽位/长度/factSheet-only 闸/受限 richtext）、CopyBundle 落 SiteVersion、渲染器多语种路径+RTL+自托管字体+外呼域检查 | agents/copy、renderer pages/layouts/themes | copy.spec、copy-bundle-validate.spec、renderer 侧 locale/字体检查进 verify |
| M1-e | P3 组装：designSpec+siteAssembly AiTask、三重门校验器（含语义规则）、构建错误回填重试、组件库补齐 **26 型**（M1-e-A：+16 变体/`<picture>` 固定 variantId/reduced-motion；M1-e-B：DesignBrief + Family/Blueprint/兼容矩阵受控组装）。**依赖 R1-min 已合**（可见预览原子化） | agents/design-spec、agents/assemble、spec-validator、renderer 组件 ×16 | spec-validator.spec（三门逐条）、assemble.spec、design-spec.spec、picture 消费测试 |
| M1-f | P4 质量环：qa（Playwright+Lighthouse+外呼域/⟦key⟧ 门）、seo 检查表、aesthetic capability-gate、assemblyFix JSON-Patch-only、≤3 轮编排 | agents/qa、agents/seo、agents/fix、workflow 循环 | qa-checks.spec、seo-checks.spec、fix-patch.spec（只许 patch）、loop 分支入 workflow.spec |
| M1-g | 收尾：`verify-site-builder-m1.mts`（§8）、执行完整 **Bootstrap 6 fixture** 并按门扩成 **12 个视觉 fixture**、eval 硬门基线（factSheet 零虚构/主体保护占位）、OpenAPI 重导出、状态文档更新；2 fixture 只可作日常 smoke，不算阶段覆盖 | scripts、test/fixtures/golden-companies、contracts | verify 脚本 + 6→12 分阶段评测报告=验收 |

## 8. 真机验证计划（verify-site-builder-m1.mts，真库真容器真网关，无 sandbox）

1. **is_superuser guard**（RLS 证明前置，获客侧先例）。
2. golden 一家（真实有界样本）：intake+向导+上传 3 图 1 PDF → `POST /builds` → 轮询至 ready，断言 phase 走全 P1→P5、steps/costSummary 非空。
3. P1 断言：brand_profile 落库、factSheet 全部带 evidence、无源项在 gaps、kb/status 返回 gaps。
4. P2 断言：每图 derivedKeys≥3 尺寸且 EXIF 已剥（复验）、cert 图未经生成路径、en+de 两份 CopyBundle 槽位齐。
5. P3/P4 断言：预览 HTTP 200 + 资产全 200（M0 回归守卫）+ 产物无 `⟦`、无第三方字体域、每页恰 1 H1、Lighthouse Perf≥85/A11y≥90、de 路径与 hreflang 互指。
6. 幂等与降级：同参重跑 content_hash 跳过；断网 SearXNG 再跑 → `researchDegraded=true` 管线不断。
7. RLS A/B：workspace B 读不到 A 的 brand_profile/builds。

## 9. 汇总：需要用户的事

- **拍板**：D-M1-1（P4 进 M1，确定性优先+审美弃权）——其余 D-M1-2…9 按推荐执行，不同意任一条直接指出。
- **审阅**：§10 生产化审计（R0-R4 定点修复）与 §11 施工 PR 图（粒度/顺序/风险分级）——R0 类正确性/隐私缺陷「确认即修」不以流量为借口延后；哪些 PR 升级人审见 §11 风险列。
- **不阻塞但影响激活时点**：new-api 三通道（Anthropic/Google/OpenAI images/edits）接入后逐条实测翻配置；golden 真实工厂授权方式定前用合成+自有数据。
- **已定事项回执**：域名后买（预览走本地路径，购域后改 env 零代码切换）；开发/验证唯一环境 = Ubuntu 服务器（Codex 直接在 `/global/backend` 工作，用户经 Tailscale/SSH 访问），真机 verify 与 §8 计划均在其上跑。

---

## 10. 生产化审计（R0–R4 定点修复）与阶段前置门

> 来源 v3.2 §24 回写。权威 = `docs/adr/registry.md`（ADR-013~019）+ `00-decisions-and-coordination.md`。审计对象 = 已合并的 M0/M1-a/M1-b **main 代码**（多为 as-built 已实现缺陷，非目标态设想）。

### 10.1 审计结论：保留主干 + 定点修复 + 明确前置门

M0、M1-a、M1-b 的**架构主干可保留**，但 main 上存在真实问题，分三类：

- **正确性/隐私不变量**：可能丢用户数据、泄漏联系信息、制造事实、破坏幂等或跨系统一致性——**一经确认就修，不以流量为借口延后**。
- **消费者前置**：不必阻断无关算法开发，但**必须早于第一个真实消费者**（R4 Evidence 早于 M1-d；原子 Release 早于 M1-e 可见预览/公开发布）。
- **规模化优化**：多 worker 自动预算、完整 canary、30×3 统计门等，可从**最小持久账/人工批准起步**，随真实流量扩展。

因此不用「返工/不返工」二分，而用「保留主干 + 定点修复 + 明确前置门」。结论：**旧阶段有问题就改；保留的是经过验证的主干，不是缺陷本身。**

### 10.2 审计项清单（R0–R4，含 2026-07-16 as-built 状态）

| ID | 阶段 | 代码证据 | 审计发现 / 当前状态 | 风险 | 处理时点 |
|---|---|---|---|---|---|
| R0-1 | M0 | intake.service.ts | ✅ #121：`hasWebsite` 不再造成行为分叉，有/无旧站都复用同一 Site 发起 Demo | 产品主流程错误 | 已修 |
| R0-2 / R0-contract | M0 | intake.controller/dto/service | ✅ #126：响应收口为 `{siteId,buildId,status:"generating_demo"}`，移除 `mode`；intake 幂等、稳定错误码、Temporal execution-chain ACK 与 Swagger/OpenAPI 已落地 | 前后端按错误/不完整契约开发 | 已修，breaking 迁移已登记 |
| R0-3 🔴 | M0 | demo-spec.ts / activities.ts | ✅ #123：中性模板 + sanitizer + 提示词 + 独立 CI 守卫四处收口 | **确定性模板本身虚构**（ADR-017） | 已修，守卫不可回退 |
| R0-4 | M0/M1-b | intakeToMarkdown+digestSources | ✅ #124：`businessEmail` 不再进 intake KB/brand Prompt；提供幂等存量脱敏脚本 | 不必要联系信息出域 | 代码已修；各环境执行清存量并留证 |
| R0-5 | M0 | polishCopy | ✅ #124：gateway 透传 AbortSignal，硬超时 2 秒，超时后真实取消 | 成本泄漏、延迟违约 | 已修 |
| R0-6 | M0 | cleanupFailedDemo | ✅ #124：201 后失败保留 Site/intake，置 `setup_failed` 可原地重试；含迟到 cleanup 防 clobber 与孤儿 version 收尾 | 用户数据被静默丢弃、无法原地重试 | 已修 |
| R1-1 | M0/M1-a | site-builder.activities.ts | Demo/refurbish 直接构建到 `previewRoot/site.slug`，finalize 前已覆盖当前可见目录 | 失败/取消构建破坏当前预览，activeVersionId 形同虚设 | M1-e 可见预览前（可并行 M1-c） |
| R1-2 | M0/M1-a | renderer-build.ts / site-builder.activities.ts | ✅ 2026-07-17：随机权限隔离临时目录 + `finally` 递归清理；固定 Node/Astro 入口，子进程仅接收 7 个 Renderer 必需变量，不继承 `process.env` | 内容残留、构建进程获无关密钥 | 已修；真 Astro 沙箱探针已过 |
| R1-3 | M1-a | version-alloc.ts | `max(version)+1` 无 advisory lock，注释「天然避开并发」不成立 | 并发/活动重试 P2002 | M1-e/并行构建前 |
| R1-4 | Renderer | Section.astro | 未知组件静默返回 null | 契约漂移被掩盖、页面悄缺块 | DQ-1 已合并；随下一 Renderer PR 修 |
| R2-1 | M0 Asset | assets.service commit | 无 `pending_upload→committing` CAS，重复 commit 可并发 | 重复复制/删除/状态竞争 | M1-c 前 |
| R2-2 | M0 Asset | assets.service commit | 两个相同内容资产同过 duplicate 查询，一个 P2002 时 staging 已删 | 行指向已不存在的 staging | M1-c 前 |
| R2-3 | M0 Asset | assets.service remove | 在 DB 事务内删对象，对象删成功但事务提交失败 | 跨系统不一致、已发布图失效 | M1-c 前 |
| R2-4 | KB | kb.service processQueued | `queued→processing` 后无 lease，worker 崩溃永久卡 | 文档永远不再处理 | M1-c 前 |
| R2-5 | KB | processQueued | 单文档异常被吞直接标 failed，Temporal 活动仍成功 | MinIO/Docling/embedding 瞬时故障变永久失败 | M1-c 前 |
| R2-6 | KB | ingestText+KbDocument | `assetId` 无唯一约束，重试重复建文档+向量 | 检索重复、删除/成本失真 | M1-c 前 |
| R2-7 | M0 | profile patch | 只校验五顶层组名，不校验组内 schema/数量/URL/大小；并发 read-merge-write 丢更新 | 大 JSON、脏数据、注入面、向导丢数据 | 公开 intake 前（可并行 M1-c） |
| R3-1 ✅ B1/B2 2026-07-17 | M1-a | builds.controller | targetId 已改 1–128 位 SiteSpec 标识符；B2 已让 page/section 基于 active SiteSpec 确定性局部消费，缺失/歧义 fail-closed | 不再用 UUID 假契约、静默整站重建或越界改写 | R3-B1/B2 已完成 |
| R3-2 ✅ B1/B2 2026-07-17 | M1-a | CreateBuildDto | 嵌套 DTO/白名单/数量上限/BCP-47/preset 目录已落；B2 已消费 pages，非 en 在 M1-d 前继续 fail-closed 422 | 无效或未实现 options 不进工作流 | pages 已完成；真实 locales 归 M1-d |
| R3-3 ✅ B1 2026-07-17 | M1-a | BuildsService | key 限长限字符；IdempotencyKey requestHash 核验同请求，旧 JSON key fail-closed；ACK 未得证不计配额 | 同 key 异请求不误重放，ACK-loss 不重复执行 | R3-B1 已完成 |
| R3-4 ✅ B1 2026-07-17 | M1-a | temporal-refurbish-launcher.ts | REJECT_DUPLICATE+USE_EXISTING；start/describe 恢复并持久化 workflowId+firstExecutionRunId 后才成功 | ACK-loss 收敛到同一 BuildRun/执行链 | R3-B1 已完成 |
| R3-5 ✅ B2 2026-07-17 | M1-a | build run steps | `SiteBuildStep` 按阶段/图片批次写 attempt 真值并投影公共 read-model；phase/progress 单调，迟到旧 attempt 不覆盖，终态关闭未完成 step | 前端轮询可见真实进度，重试/取消可审计 | R3-B2 已完成 |
| R3-6 ✅ 2026-07-17 | M1-a | SiteBuildRun DB invariant | 已落 `(siteId,workspaceId)` 复合 FK、validated status CHECK、每站 active 部分唯一索引与 nullable workflow identity；脏历史 fail-closed | Ubuntu 开发环境已验，不代表生产部署 | R3-A 独立 migration 已完成 |
| R4-1 | M1-b | enforceEvidenceGate | 普通事实无 quote 也过；quote 只查「存在于来源」，不查数字/实体/claim 被支持 | 真实 URL/无关引文给虚构事实洗白 | M1-d 前 |
| R4-2 ✅ A1 隐私半闭环 | M1-b | brand-research.ts | 新写不再冻结原始 title/snippet/path/query/fragment，只生成 external-origin hint；A2 仍须阻断任何 `research_hint` 发布并要求事实回抓权威正文 | 摘要错配/截断/过时与第三方具名个人均不得洗白事实 | A2 · M1-d 前 |
| R4-3 | M1-b | 认证 evidence | intake/upload 标签 + 任意命中 quote 即放行认证，无强制 ready cert 资产引用 | 自填「ISO」变站点事实 | M1-d 前 |
| R4-4 | M1-b | BrandProfile schema/activity | 无 buildRunId/inputHash/promptVersion/model/provenance，重试再调模型追加版本 | 不幂等、重复成本、不可重放 | M1-d 前 |
| R4-5 | M1-b | budget.ts | `BudgetLedger` 是进程内 Map，多 worker/重启重获完整额度 | 生产预算门可被自然绕过 | M1-d 付费扇出前 |
| R4-6 | M1-b | SiteBuildRun.costSummary | API 暴露 costSummary 但未把成功/失败/fallback 真实成本持久聚合到 run | 无法计费/审计/做成本决策 | M1-d 前 |

### 10.3 R0 已闭环

**已落地**：#121 完成无条件 Demo 行为；#123 完成中性事实安全模板与防回灌守卫；#124 完成邮箱隔离/存量脱敏工具、polish 真取消和 201 后失败保站/原地重试；#126 完成 intake 持久幂等、`{siteId,buildId,status}`、去响应 `mode`、稳定 `error.code`、Temporal ACK-loss 收敛与 controller/Swagger/OpenAPI 同步。对应回归、真 PostgreSQL 并发/RLS 和 Temporal live probe 已随交付验证。

### 10.4 R1 产物/版本/构建隔离（早于 M1-e 可见预览）

目标形态 `previewRoot/{slug}/versions/{siteVersionId}/` + `previewRoot/{slug}/current.json`。规则：① Astro 只构建到 run/version 独立 staging；② 构建成功+质量通过+run 仍 publishable 后**同事务切 activeVersionId**；③ DB 提交后原子 rename/`current.json` 临时文件替换更新预览指针；④ 预览服务按 active version 读，不把 slug 目录当正在构建的 outDir；⑤ 失败/取消只清本 run staging、不触当前 active artifact；⑥ `SiteVersion.artifactKey` 指不可变版本目录；⑦ version 分配 advisory lock（见 §2.1 R1-3）；⑧ **R1-safety ① 已完成**临时 SiteSpec 的 `finally` 清理和 Renderer env allowlist；可见预览的 per-run staging 清理仍属 R1-min，不得因临时 spec 已收口而宣称原子发布已完成。这是指针式发布/回滚成立的前提，优先级高于视觉优化。

### 10.5 R2 Asset/KB 状态机（阻断 M1-c）

**Asset commit/cleanup 状态机（✅ R2-A1/A4 + MF0-B 已落地）**：`pending_upload/failed_retryable/expired committing → committing → ready/queued ↘ rejected/duplicate/failed_retryable`。入口 CAS 分配 attempt+UUID token+lease；所有回写 fenced。staging cleanup 保持固定 15 分钟在途 grace + 两轮 Delete/HEAD。MF0-B 对 canonical key 以 key-level advisory xact lock 串行 producer，在最终门内拒绝任一 active/unsettled owner，copy 后才 fenced 激活；DELETE 与 Profile/activeVersion/Variant writer 共用 Asset 行锁，命中 Profile 或当前 `activeVersionId` SiteSpec 返回结构化 `409 ASSET_IN_USE`。DELETE 同事务只写 tombstone + schema v2 冻结 plan + Outbox；Temporal 两轮按 Variant 叶→根、canonical 最后清对象，重新核对 provenance 后删 Variant 行并 durable settle。历史 v1 parked 只经 dry-run 对账生成 causally-linked v2 successor；MF-1 后可切 `AssetUsage` 而不改 API。

**KB 状态机（✅ R2-A2/A4 已落地）**：`KbDocument.assetId` 在确定性 duplicate/orphan/cross-scope reconciliation 后加 nullable unique；复合 FK 同时绑定 document→Asset 的 workspace/site 与 chunk→document 的 workspace。`queued(due)/expired processing → processing` 复用 Asset 的 attempt+UUID token+lease，外部 IO 间续租，所有失败/完成回写 fenced；文档+chunks replace 与 Asset ready 在同一事务，接管后的旧 worker 无法 zombie write。Docling/MinIO/embedding 由边界客户端发 typed error，瞬时故障回 `queued/retry_at`，损坏/不支持格式才 `failed_terminal`。commit workflow 已改 asset 粒度；5 分钟 recovery Schedule 有界扫描 due/过期行并发结构化告警，另有人工 redrive。A4 已补齐公共脱敏合同与 cleanup 跨系统验收边界。

**Profile 与集成门分开**：R2-A3 已把 Profile 固化为独立 UUID token 的资源级 CAS：GET/PATCH 同回 `versionId` + 强 ETag，PATCH 必须 `If-Match`/`baseVersionId`，缺失 428、body stale 409、header stale 412；五组严格 schema、分组/总大小、数量、URL 与同站 Asset 引用均有界，保存无外部副作用。真 PostgreSQL 两连接 barrier 证明同 base 恰一胜，并由失败方 re-GET/retry 保留两组；合同细节见 07 §2。R2-A4 独立补齐 Outbox/Temporal staging cleanup、其余公共错误码、跨系统故障注入与 redrive；四块没有重新打成 mega PR。

### 10.6 R3 M1-a 消费者合同 · R4 Evidence + 预算真值（早于 M1-d）

**R3**：R3-A 已完成 SiteBuildRun 数据库背书；**R3-B1/B2 已在 2026-07-17 当前交付分支完成**。B1 收口有界 targetId、严格 BuildOptions、请求指纹幂等账本与 Temporal workflowId/firstExecutionRunId ACK；取消等待执行链关闭与补偿完成后才释放 active 单飞门。B2 新增 FORCE RLS `SiteBuildStep` attempt 真值，按 Activity/图片批次单调写 phase/progress/read-model，旧 attempt 迟到不覆盖，begin replay 不重写 startedAt，成功/失败/取消均终态化；page/section/pages 冻结请求时 active base version，只替换目标 page/block 与引用 copy keys，发布以 pointer CAS 防止覆盖期间人工编辑，缺失/歧义/脏 spec fail-closed，stylePreset 不逃逸局部 scope。非 en 继续 422，真实多语种生产与 Renderer 路径归 M1-d；costSummary 仍归 R4-B-min。Ubuntu 开发环境以独立真 PostgreSQL/app_user/FORCE RLS + 隔离真 Temporal 验证，**不代表生产部署**。

**R4-A1（✅ 2026-07-17）**：共享 `EvidenceRefV2`、冻结 source snapshot、完整 SHA-256、精确 quote/Unicode selector、KB chunk provenance、append-only RLS/FK 基础已落；SearXNG 原始页面元数据不冻结，只生成最小 origin hint；旧 v1 兼容读取、不伪造回填，公开 OpenAPI 不变。**R4-A2（待完成）**：value/quote 语义对齐、任何 `research_hint` 发布降级、cert Asset/人工 verified 门与公共 Claim/Evidence APPROVED bridge。**R4-B-min 预算真值**（v3.2 §24.7 · ADR 无既有条目，属施工承载假设）：M1-c 可继续不消费模型预算；**M1-d 首个付费 fan-out 前须有 DB 持久 `reserve/settle` + 人工停用开关**；`SiteBuildRun.costSummary` 是**持久聚合真值**（含成功/失败/schema repair/timeout/fallback/工具成本）；**进程内 `BudgetLedger` 只可作单测或本地单 worker 适配器，不能被描述为生产预算门**（Redis/多 worker 配额优化随部署拓扑后补）。

**R4-A1 迁移/兼容/回滚与验证**：schema 只 additive 增 `evidenceSchemaVersion`、两张 provenance 表和复合租户 FK；旧 BrandProfile 默认 v1，新写显式 v2，读取兼容两个版本，不做无法证明的历史回填。source snapshot 按 site+dedupe key 幂等复用，事实 ref 随新 BrandProfile 追加；BrandProfile 本身的 workflow 重试复用仍归 R4-B-min。两表 `FORCE RLS`，`app_user` 仅 `SELECT/INSERT`，复合 FK 绑定 workspace/site/profile/source/hash，UPDATE trigger 拒绝篡改；URL 去 credentials/fragment/敏感 query，Prompt 不暴露 URL/title/联系信息。迁移 forward-only：如需回退，先部署 v1 reader/writer，再仅在证明无 v2 行后用新的 forward migration 删除未用结构；不反向伪造数据。最新真机 verifier 已完整通过：真 PostgreSQL 两账本 A/B/unset RLS、跨租户/UPDATE 负例、SearXNG/Crawl4AI origin-only hint、BGE-M3，以及 DeepSeek Pro 两轮 Activity 的 9 条事实/关系 ref/quote selector/hash 与 snapshot 去重均绿；Activity 内一次 Crawl4AI 500 被显式标 `research degraded` 后安全继续，夹具清零。此前同任务的 DeepSeek 超时/GLM 截断仍作为外部波动证据保留。schema diff 仅剩与 A1 无关的 R3-B2 `site_build_step.id/updated_at` 默认表达式漂移，须独立处理。

### 10.7 各阶段最终判断

| 阶段 | 判断 | 处理 |
|---|---|---|
| M0 | 主干保留；#121/#123/#124/#126 已闭环 R0 行为、安全与 intake 合同；R1-safety ①+②、R2-A1–A4、MF0-A/B、M1-c、R3-A、R3-B1/B2 与 R4-A1 已完成 | 先做 R4-A2/B-min，再进入 M1-d；R1-min 生产 Release/跨节点/unknown component 余项在 M1-e 前完成 |
| M1-a | 工作流框架保留；R3-A 数据库背书、R3-B1 API/ACK 与 R3-B2 局部 scope/单调进度已完成；非 en 随 M1-d | 产物原子性随 R1 |
| M1-b | Agent 形状保留；R4-A1 引用完整性已补，事实真值与成本仍待 | 做 R4-A2/B-min，**必须早于 M1-d** |
| M1-c | ✅ 纯 Sharp writer 与 refurbish P2 已落地；生成式、公开 process/select API、Renderer `<picture>` 未做 | R2-A 与 MF0-A/B 前置已完成；R1 原子 Release 不耦合算法但须在 M1-e 预览前完成 |
| M1-d | 小改 + 新前置门 | 只能消费 R4 通过的 FactSheet 与 DesignBrief content budgets |
| M1-e | 设计主改 | DesignCatalog、6 Family、26 组件、受控组装 |
| M1-f | 质量主改 | 三断点、确定性 lint、审美、通用感、最多三轮 |
| 模型路由 | `currentRoute` 是事实，文档候选不是终选 | MODEL-0 保持行为；MODEL-1 小样本筛选；MODEL-2 真流量/高风险切换前 shadow/canary |
| M1-g | 阶段质量门 | 6 启动样本扩 12 视觉子集；30+ 系统集按成熟度建设，不伪装已完成 |

---

## 11. 施工 PR 图（粒度 / 顺序 / 风险分级）

> 来源 v3.2 §26 回写。映射本文 §7 的能力主序列；高风险项（migration/RLS/鉴权/GDPR/对外抓取/大量删除）必须经 Codex 专项复核并由用户明确确认是否合并，见 AGENTS.md §8 与 `docs/backend/ci-merge-automation.md`。

### 11.1 施工原则与分支处理

1. 每个 PR 开工前记录最新 main SHA、00 决策版本、依赖 PR 与合同版本。
2. **DOC-12 已由 #119/#120 入仓**；v3.2 已归档，未进入 00/活文档/ADR 的条目不得被实现者当既定决策——本文 `S12-Dxx` 不构成第三套常设决策系统。
3. M1-c 已在当前交付分支实现并完成开发环境验证；合并前仍以 PR/CI/审查证据为准，不以 worktree 或分支存在推断 main 已具备。旧分支中的 Sharp 代码仍只可在核对 provenance 后选择性提取。
4. Industrial Template 只是一条**效果测试泳道**，不直接获得组件合同/TemplateFamily/生产合并资格；任何恢复的测试分支须基于最新 main 重新提交截图、build/a11y/performance、组件清单和选择性提取清单，未经组件合同审查不得整包合并 Section/themes/demo-spec。
5. **文档、算法、schema、组件、模型迁移和公开发布不得打成一个 mega PR。**

### 11.2 PR 依赖与风险分级表

| PR | 范围 | 依赖 | 阻断谁 | 风险（专项验证 / 用户确认） | 映射 §7 |
|---|---|---|---|---|---|
| TRUTH-SYNC | ✅ #125：DOC-12 后续真值收口，修 00–14/权威状态漂移与归档 provenance；未重开 v3.2 设计范围 | #119/#120 已合 | 后续施工理解 | 🟢 纯文档 | — |
| R0-contract | ✅ #126：intake `Idempotency-Key`、`{siteId,buildId,status}`、去响应 `mode`、Swagger/OpenAPI + stable `error.code`（§10.3） | #121/#123/#124 已合 | API 前后端对接 | 🟡 API 契约 | M0 closeout |
| R1-safety | ✅ 2026-07-17 两个小 PR 完成：① 临时 SiteSpec `finally` 清理 + Renderer 子进程 env allowlist；② API/Crawl4AI/robots 完整 egress gate、fake-IP-only DoH 回退、连接 pinning，并完成公网正向及 private/loopback/metadata/IPv4-mapped/redirect 负向真机验证 | #125/#126 已合 | 已解除 R2-A 前置 | 🔴 已专项验证并按用户授权收口 | M0/M1-a |
| IT-0（测试泳道） | Industrial Template 效果验证：pump/auto-parts 各 sparse/rich fixture、1440/768/390 截图、build/axe/性能预算、unknown component/copy/事实风险、输出「保留/改造/丢弃」清单 | 可并行 R2 | 非架构主序列 | 🟡 不整包合并契约 | — |
| R2-A1 Asset | ✅ 2026-07-17：commit CAS + attempt/token/lease fencing、canonical copy 幂等、P2002→duplicate、failed_retryable、tombstone + 当时 parked cleanup Outbox；该历史门已由 MF0-B 接管 | #126、R1-safety | **MF-0/M1-c** | 🔴 开发环境 PostgreSQL/RLS/MinIO、空库 migration、并发/故障专项验证已过 | M1-c 前置 |
| R2-A2 KB | ✅ 2026-07-17：`assetId` 确定性 reconciliation+unique/复合 FK、单素材 lease+fencing、typed retry、原子完成、5m recovery/alert/manual redrive | R2-A1 schema 接缝串行 | **MF-0/M1-c** | 🔴 开发环境 PG/RLS/MinIO/Docling/BGE、脏升级与空库 migration 已验证，待 PR 人审 | M1-c 前置 |
| R2-A3 Profile | ✅ 2026-07-17：五组严格 schema/限额、UUID ETag、`If-Match`/`baseVersionId` CAS、旧脏 JSON fail-closed 与 Prompt PII 净化 | #126；A1/A2 | 公开 intake | 🟡 API 并发合同；真 PostgreSQL 双连接已验 | M0 closeout |
| R2-A4 Integration | ✅ 2026-07-17：staging-only Outbox/Temporal cleanup、15 分钟晚到上传门、双 provenance、稳定 Asset/KB/Build 错误码、cancel CAS、重试/告警与 guarded redrive；canonical 后由 MF0-B 启用 | R2-A1/A2/A3 | **MF-0/M1-c** | 🔴 跨系统一致性 → 人审 | M1-c 前置 |
| MF0-A/B | ✅ 2026-07-17：AssetVariant/RLS/provenance/derivedKeys 投影 + Profile/当前 activeVersion 引用守卫、409、共享行锁、canonical/Variant schema v2 清理、legacy quarantine/reconcile；MF0-A/B **自身未做** Sharp/MediaJob/AssetUsage/生成式 provider/视频，Sharp writer 由后续 M1-c 交付 | R2-A4 | **M1-c** | 🔴 Ubuntu 开发环境真 PG/RLS/MinIO/Temporal/迁移/对账已验；不代表生产部署 | M1-c 前置 |
| M1-c ✅ | 确定性图片处理：纯 Sharp、方向/sRGB、EXIF/GPS、解码炸弹、质量 warning、focal crop、AVIF/WebP/fallback、多尺寸、失败隔离与 manifest 双写；**禁** rembg/生成图/Readdy/设计 Agent/MediaJob-AssetUsage 预建/视频；picture 固定 Variant 消费仍归 M1-e（合并门见 14 号） | MF-0-thin | — | 🟡 算法 PR；开发环境真 PG/RLS/MinIO 已验，不代表生产部署 | 已完成 |
| R1-min（余项） | R3-B2 已完成本地 run-scoped durable artifact + 原子 symlink pointer；余项为生产对象存储不可变 Release、跨节点恢复/回收、版本锁与 unknown component fail-closed；`finally`/env allowlist/抓取 egress 已前移 R1-safety | 可并行 | **M1-e 可见预览** | 🔴 发布/预览路径 → 用户确认 | M1-e 前置 |
| R3-B1 ✅ | 请求合同 + 持久幂等 + Temporal ACK：targetId/BuildOptions/key 指纹/workflow+run trace 已完成；B1 时尚未实现的 scope/options 先行 422 | DQ-1、R3-A | R3-B2 | 🟡 API/ACK；真 PG+Temporal 开发验证 | 已完成 |
| R3-B2 ✅ | active SiteSpec 的 page/section/pages 局部消费 + `SiteBuildStep` 单调 step/progress/attempt/replay/终态化；本地 durable artifact/原子 pointer；非 en 随 M1-d，不伪造 cost | R3-B1 | **R4-A2/B-min → M1-d** | 🟡 真 PG/RLS + 隔离真 Temporal 已验 | 已完成 |
| R4-A1 ✅ | Evidence 2.0 基础：冻结有界来源，完整 SHA-256，KB chunk provenance，搜索仅留最小 origin hint，服务端水合精确 EvidenceRef v2 + quote/selector，不可变 FORCE RLS 关系表；旧 v1 不伪造回填，OpenAPI 不变 | — | **R4-A2** | 🔴 migration/RLS/隐私；真 PG/RLS + SearXNG/Crawl4AI/BGE-M3 + DeepSeek 两轮 Activity 已验，不代表生产部署 | 已完成 |
| R4-A2 | Claim/Evidence truth bridge：value/quote 语义对齐、snippet/`research_hint` 不可发布、认证强制 ready cert Asset/人工 verified、公共 Claim/Evidence + APPROVED 发布门 | R4-A1 | **M1-d** | 🔴 事实/合规门 → 人审 | M1-b→M1-d |
| R4-B-min | BrandProfile 幂等 + 最小成本真值：buildRunId/inputHash/prompt/model/snapshot/usage/cost、重试复用产物、DB reserve/settle + 人工停用开关（多 worker 高级配额后置） | — | **M1-d 付费 fan-out** | 🟡 预算门 | M1-b→M1-d |
| MODEL-0 | ModelProfile 与 as-built Registry：task→profile、登记 current primary/fallback（保持 #114 行为）、capability/region/lifecycle/maxCost/fallback；10 号研究只作 evidence | — | 付费路由治理 | 🟢 行为不变 | §3 |
| DI-0 | 设计学习与运行时设计契约：DesignSourceManifest/Observation/Rule/DNA/TemplateFamily/DesignBrief/DesignEvaluation + 静态 DesignCatalog；Tier A/B/C 授权分级、规则聚合≥5 源、运行时零读原始 Readdy（ADR-019） | DQ-1 已合并 | M1-e 受控组装 | 🟡 合规（来源授权） | M1-e 前置 |
| DV-0 | Demo v0 视觉升级：预编译 DemoVisualPack + industry archetype + deterministic family resolver；5–6 秒目标/10 秒 P95；无证据不伪造工厂/客户/认证/团队/统计 | DI-0 | — | 🟡 | — |
| M1-d | Copy slots/内容预算/最小询盘合同：按 slot/locale/Claim refs 生成，先事实门再文风；最小 inquiry/consent/outbox 合同（实际公开接收随 M2） | R3、R4-A1/A2、R4-B-min；DI-0 可并行且在 M1-e 前收口 | — | 🟡 | M1-d |
| M1-e-A | 26 组件与变体：04 的 17 回写为 26、variant compatibility、picture、motion/reduced-motion；从 IT-0 选择性提取 | R1-min | — | 🟡 组件契约 | M1-e |
| M1-e-B | DesignBrief 与受控组装：Family/Blueprint/DNA/兼容矩阵约束、SiteSpec 1.0.0 兼容演进、有非可信 JSON 消费者才加 Zod、模型不写任意 Astro/Tailwind | M1-e-A、DI-0 | — | 🟡 | M1-e |
| M1-f | 确定性 QA + 审美 + 反模板感：断点/溢出/对比度/资源/链接/schema/事实/a11y，再冻结截图多模态审美，最多三轮定向修复、禁随机全站重生成 | M1-e-B | — | 🟡 | M1-f |
| EVAL-bootstrap | 可执行启动集：6 fixture（3 行业 × sparse/rich，含 DE/EU locale），保存输入/不变量/desktop+mobile 截图/质量/成本延迟；4/6 成对偏好胜出 + 客观硬门全过才扩 12 | — | M1-g 扩集 | 🟢 | M1-g |
| MODEL-1 | 候选真探 + 小样本评测：每候选先 capability probe，跑 6–12 task-shaped 样本 + accepted-artifact cost，只产 evaluatedCandidate 报告不自动切生产 | MODEL-0、EVAL-bootstrap | — | 🟡 | §3 |
| M1-g | 阶段收口：启动集扩 12 视觉子集、Catalog/模型/事实/安全/a11y/性能/回滚回归、记录未完成 30+ 系统集不冒充覆盖；`verify-site-builder-m1.mts`、OpenAPI 重导、docs/status + AGENTS.md §4 更新 | 各 M1 PR | — | 🟡 | M1-g |
| M2-PUBLISH | 不可变 Release/域名/最小询盘：不可变 manifest、原子发布/回滚、域名 ownership、安全头、inquiry + consent + anti-abuse + outbox、AI 媒体披露 | R1-min、PublishReview、质量门 | — | 🔴 公开发布/域名 → 人审 | M2 |
| MF-1 / MODEL-2 | **由真实消费者/流量触发**：第一个生成式/异步媒体或跨 Release 引用反查前落 MediaJob/AssetUsage（成本/取消/补偿/rights）；真流量/高风险切换前扩 30×3 + shadow + 分档 canary + 自动回滚。两者**均需独立 ADR**，不能以「v3.2 已写」替代开工证据 | 真实消费者出现 | — | 🔴 | 后置 |

---

## 12. 目标态消费契约与 schema（施工承载假设，非 as-built）

> 来源 v3.2 §4/§9/§15/§16/§19/§20/§21 回写。这些是 M1-c…M1-f 各消费者的**目标契约形状**（SiteSpec 1.1 / 内容生命周期），**非当前已落地**——as-built 真值仍以 §2 触点、`@global/contracts`（SiteSpec 1.0.0 = type-only、`copyBundles` 纯字符串）与 04/03 专题文档为准。纯组件契约详见 04、纯 agent 职责详见 03，本节只留施工承载点。

### 12.1 两条构建通道与失败语义

- **Fast Demo 通道**（v3.2 §4.2）：`intake → deterministic archetype/family → safe copy → DemoVisualPack → SiteSpec → Astro → preview`。P95 < 10 秒；允许一次**可取消的异步文案润色**但 Demo 成功不依赖它（硬超时直接模板结果，见 R0-5）；只用注册明确事实（preview-only ≠ 可公开发布）；**不跑图片生成/视频/全页多模态 QA/网络研究**（§0.1 第 5 条：10 秒关键路径禁重模型）。
- **Refurbish 阶段职责与失败语义**（v3.2 §19.1/§4.4，对齐 §2.3 编排）：

  | 阶段 | 输入 → 产物 | 设计变化 | 失败语义 |
  |---|---|---|---|
  | P1 brandProfile | intake/资料/研究 → BrandProfile | 不改 | Brand 全路由失败用上一版 BrandProjection，无则走安全模板；研究可降级 |
  | P2 imagePipeline | 用户资产 → 派生图 + 能力摘要 | M1-c 纯 Sharp，不加设计模型 | 可选图片失败=原图优化 Variant/占位；Logo/Hero 必需素材不可用=明确 gap 阻断 |
  | P3 copy | BrandProfile + DesignBrief 内容预算 → CopyBundle | M1-d 增槽位长度+证据要求 | 默认 locale 失败阻断；非默认 locale 失败=本 Release 不含该 locale（degraded） |
  | P3 designSpec | BrandProfile + Catalog + AssetCapabilitySummary → DesignBrief | M1-e 新增 Family/Blueprint/variant 决策 | 有限修复，仍失败不切指针 |
  | P3 assembly | DesignBrief + CopyBundle + AssetManifest → SiteSpec | 只能引用批准组件/变体 | 三重门 + Astro 构建错误回填重试 |
  | P4 quality | 构建产物 + 三断点截图 → Findings + Patch | M1-f 新增审美/通用感 | 最多三轮；硬门不过不 publishable |
  | — | 预算耗尽 | — | 停发新调用、结算已完成、状态 `resumable` |
  | — | 取消 | — | 停新任务、执行不可取消补偿、不改旧 Release |

### 12.2 媒体地基与图片管线（施工依赖，**完整契约见 [14 号](14-media-foundation-mf0.md)**）

09 只承载**施工序与前置门**：`AssetVariant` + `SiteSpecAssetReferenceScanner` + 删除 409 已由 **MF0-A/B** 落地，M1-c 前置门已解除；`MediaJob/AssetUsage` = 事件触发的 **MF-1**（生成式/异步媒体或跨 Release 反查出现第一个真实消费者前不预建，ADR-018）；M1-c 图片管线 = 纯 Sharp 确定性固定序（见 §2.4）。`AssetVariant` 表结构、`DerivedImageManifest/ImageVariantSet` TS 形状与双写生命周期、类型处理矩阵、M1-c 合并门清单 = **14 号真值，本文不复述**（PR 依赖与风险分级见 §11）。

### 12.3 确定性动效 token（M1；**地基契约见 [14 号 §7](14-media-foundation-mf0.md)**）

M1 只做**确定性动效 token**（Ken Burns/轻微视差/数字递增/Marquee 低速版/hover/reveal），全部支持 `prefers-reduced-motion`、不影响正文可见性、不阻塞 LCP、**不以 three.js/GSAP 沉浸叙事作首批组件**；M1 不生成视频。`videoRef` 预留可演进 `kind`，视频 provider/MediaJob 属 M3/MF-1（须先于任何视频 provider adapter 合并 MF-1）——完整视频/动效地基见 14 号。

### 12.4 内容生命周期与单一真相源（v3.2 §9，M1-d/e/f 消费契约；架构真值见 02）

- **单一真相源**（§9.1）：`Site` 关联 `companyProfileId`（旧行 additive 回填后再改必填）；BrandProfile 消费仓库已有 `CompanyProfile/Offering/Claim/Evidence/AiTrace/UsageLedger/OutboxEvent`**不复制**；evidence gate 通过的事实 upsert/关联公共 Claim/Evidence，认证/数字/客户案例/性能结论**必须 APPROVED**；新 Copy 只消费 `PublishableClaimSnapshot`，旧 `factSheet` 双读一个迁移周期（落点见 §2.1）。
- **三种 Pack + 构建快照**（§9.3）：`IndustryPack`（术语/证据要求/推荐组件/行业 QA）· `MarketPack`（locale/法务/单位/联系方式格式/SEO/consent）· `GrowthMotionPack`（CTA/询盘字段/事件/实验建议）。构建开始解析 `ResolvedPackSnapshot`，本 run **不读变化中的 latest**；每次 build 冻结 Pack/Catalog/Prompt/Schema/RoutePolicy/Renderer/ComponentLibrary 版本；Pack 更新只创建维护建议或新 build，不改旧 Release。
- **Copy 元数据 + 多语言**（§9.4，agent 输出契约详见 03，落点见 §2.4）：Copy 内部元数据≥ `locale/contentType、claimRefs/offeringRefs、source、prompt/model route、locked/editor/time`；默认语言先生成，再按 glossary+MarketPack 本地化（**不逐字翻译**，型号/认证/公司名/术语锁定）；richtext = SiteSpec **1.1 目标态**受限 ProseMirror（D15 白名单节点，当前 1.0.0 `copyBundles` = 纯字符串）。**多语言失败/上线语义**：默认 locale 失败阻断；非默认失败 degraded、本 Release 不发该 locale；locale 上线前须 hreflang 互指/canonical/完整导航/表单/法务；**用户锁定内容只产生建议、不被增量 build 覆盖**。
- **SEO/GEO/结构化数据**（§9.5，对齐 §2.4 seo agent）：每 Release 生成 title/description/canonical/hreflang/OG/sitemap/robots/JSON-LD；`Organization/Product/FAQ/Article` 事实字段**只引用 Claim/Offering snapshot**；**preview 强制 noindex、published 不继承**；SEO Agent 只给 finding，canonical/hreflang/robots/sitemap/schema 合法性由**代码验证**；M2 加可引用事实问答、不堆关键词。
- **询盘/实验/维护/多站**（§9.6）：`InquiryForm` 配置来自 GrowthMotionPack，提交进 `Inquiry` 表 + Outbox（邮件只是可重试通知通道），保存 release/page/component/UTM/referrer/consentVersion/风险摘要/retention；**实验变体 = 不同 Release/Component variant**（不由前端运行时随机改 HTML，先做 CTA/Hero/表单长度与顺序）；Claim 过期/Offering 更新/Asset 撤权/链接失效/模型或组件弃用创建 `SiteMaintenanceTask`（不静默改已发布页）；数据层保留多站能力，**v1 每 workspace 1 站**，未来多站复用 company core、不复制 KB。⚠️ 询盘公开接收后端属 **M2**，M1 只落最小 inquiry/consent/outbox 合同形状（§0 边界）。

### 12.5 设计领域模型施工承载点（**领域契约真值见 [13 号](13-design-domain-model.md)**）

09 只承载两处**施工序/DoD 门**：① **R0 相关**——当前 `demo-spec` 把 `BusinessArchetype/TemplateFamily/StylePreset` 混成一个关键词主题选择，**必须拆开**（五概念完整定义见 13 号 §1，与 §10.3 中性措辞同批治理，DV-0 PR）；② **M1-e-B DoD 门**——首批 **6 个 TemplateFamily**（`precision-industrial/technical-catalog/oem-capability/scientific-trust/natural-origin/premium-innovation`），每家族至少 2 首页 + 2 内页 Blueprint + 2–3 Hero 变体 + 1 套移动端重排 + 2 StylePreset + 1 DemoVisualPack + 覆盖 12 Golden fixture 中≥2 个（`global-wholesale` 等 4 家留 M1-g 后）。Family 设计语言/避免项/DesignDNA/Blueprint/DesignBrief 完整契约 = **13 号真值（DI-0 PR），本文不复述**。

---

## 实施风险寄存器（17 项，v3.2 §34 回写 · DOC-12 补漏）

> 这些事项早期文档易被拆散，v3.2 §34 汇成实施检查项（completeness-critic 查漏后补回）。多数在他处有机制家（标指针）；**🔴 标注的是别处无家的独有承重项，必须在施工序里立项**。

1. **变更影响图**：Claim/Offering/Asset/Pack/Family/组件/Renderer/模型下线都能反查受影响 Release 并建维护任务（`SiteMaintenanceTask`，见 [06 §8.3](06-security-abuse.md)）。
2. 🔴 **人工编辑三方合并**（别处无家）：增量重建比较 base/current/generated；锁定字段不覆盖、未锁定冲突生成建议、**不 last-write-wins**（与 [07](07-api-contract-draft.md) 乐观并发 If-Match 互补，但三方合并语义独有）。
3. **按可接受产物计成本**：不只 token；统计被拒图片/重做 Shot/schema repair/fallback/最终 accepted artifact 单价。
4. **区域与供应商策略**：ModelPolicy 解析 data region/DPA/媒体保留/训练选项/workspace policy；能力更强 ≠ 允许出域（ADR-016 / [10](10-model-selection-study.md)）。
5. 🔴 **Kill switch**（别处无家）：按 provider/profile/task/workspace 禁用**不发版**；图片/视频失败返回原始/静态结果。
6. **依赖/模型弃用监控**：只告警/建变更单，不自动把 Preview alias 切进生产；Release 保存 snapshot。
7. 🔴 **灾难恢复**（别处无家）：DB 备份不够；对象存储/manifest/域名绑定/发布指针要定期**恢复演练 + digest 校验**（部署面见 [05](05-deployment-hosting.md)）。
8. **权利到期与撤回**：stock license/客户 Logo/音乐/人物授权到期能**阻断新发布并定位旧 Release**（[06](06-security-abuse.md)）。
9. 🔴 **搜索上线检查**（别处无家）：preview `noindex` 与 published `indexable` **必须互斥验证**；sitemap/hreflang/canonical/structured data 在域名切换后复扫。
10. **询盘交付可靠性**：邮件/CRM 失败可重试；Inquiry 表是数据真相；反垃圾不误删原始审计（[06](06-security-abuse.md)）。
11. **可访问性持续性**：人工编辑和实验变体也过 a11y，不只初始 AI 生成（[08](08-eval-testing.md)）。
12. **冻结获客、保留共享核心**：不开发获客新功能，但 Company/Claim/Offering/Outbox/Usage 共享域继续作独立站依赖，不复制/破坏。
13. **权威与时间漂移**：每 PR 记 asBuilt SHA/决策版本/消费者；设计稿"当前"不覆盖后续合并事实。
14. **单源设计支配**：规则多源聚合 + 过视觉/结构/代码相似度门；任一 Tier B 来源不主导可识别模板（ADR-019 / [13](13-design-domain-model.md)）。
15. **训练与运行数据混用**：DesignObservation/生产 DesignRule/训练语料/用户站点数据各有 retention/trainingAllowed；默认不因"可访问"推"可训练"。
16. **测试分支反向定规**：视觉试验可贡献原创实现 + 证据，但共享合同由主线 ADR/contract PR 决定；选择性提取非整包覆盖。
17. **只有展示、没有转化**：首次公开发布前必须有最小 inquiry/consent/outbox/anti-abuse；视觉提升不能以丢失询盘闭环为代价。

> **§35 依据索引**（Readdy/Relume/Astro/EU Art.50/各模型官方目录/仓库审查基线 PR 等 ~45 链接）：低损，多数链接已在各专题正文内联；完整索引保留在**归档 v3.2 §35**（仍在仓库内，随 DOC-12 committed），需要时查该处，不在活文档重复。
