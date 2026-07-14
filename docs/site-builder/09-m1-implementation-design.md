# 09 · M1 精装修管线 — 落地设计（implementation design）

> 状态：**已认可（2026-07-14 用户拍板：设计整体 go；D-M1-1=质量环进 M1、确定性优先；D-M1-2…9 按推荐执行；四通道后接不阻塞）**。设计真值 = 本目录 01-08（PR #90 已批准）；本文是 M1 的**施工图**：实测证实的承重假设 + 镜像 M0 as-built 的 grounded 落地触点 + 合规 + 关键决策 + 主动风险/权衡 + TDD 步骤。对标先例：`docs/implementation-records/ted-provider-spec.md`。实现按 §7 分 PR 交付，每 PR 本地全绿 + 真机 verify + 对抗复审。

---

## 0. 定位与边界

- **M1 = 把 M0 的「demo v0 快速通道」升级为「精装修管线」**：输入 = intake + 向导五组档案 + 上传素材 + KB；输出 = 新 SiteVersion（source=`build`）+ 预览。核心四阶段：P1 理解（KB 摄入 Temporal 化 ‖ brandProfile 全网研究）→ P2 素材 fan-out（图片管线 ‖ 多语种文案 ‖ 动效预设）→ P3 组装（designSpec → siteAssembly → 三重校验 → Astro 构建 → 预览）→ P4 质量环（≤3 轮）→ P5 事件收尾。
- **一处口径张力（发现于设计提取，需拍板）**：01-prd §7 把「质量环（审核/SEO/审美）」列在 M2，而 02-architecture §4 把 P4 定义在精装修管线内。**推荐（D-M1-1）**：M1 含 P4 骨架，走「确定性优先」——qa（Playwright+Lighthouse，主体确定性）与 seo（确定性检查表）立即激活；**审美评审（需视觉模型）设计上自带「评审失败→该维弃权」降级（03 卡6），在 Google 通道接入前自动弃权**，通道就绪后零改码激活。这样既不违背 02 的管线完整性，也不把 M2 的模型评审成本提前。
- **不在 M1**：发布/域名/询盘后端（M2）、视频 Seedance 与店铺导入与 SEO 诊断（M3）、独立预览域名（等购域，2026-07-14 用户已定「后买、先本地路径预览跑通」，切换=改 `PREVIEW_URL_PATTERN` env 零代码）。

## 1. 承重假设与实测证据（2026-07-14 全部只读真探，无 sandbox）

| # | 假设 | 探法 | 结果 | 对设计的影响 |
|---|---|---|---|---|
| H1 | 设计终选模型（claude-sonnet-5 / gemini-3.1-pro / gpt-image-2 / seedance）可用 | 网关 `/v1/models` + 逐名微量真调 | ❌ **四通道全未接**；且 `/v1/models` 列表不可信（列出的 gemini 全系 429 额度耗尽；未列出的 deepseek-v4 双档反而可直呼） | 模型路由必须**配置驱动、按名探活**；终选模型=用户接通道后翻配置 |
| H2 | 网关现有可用文本模型足以真跑 M1 全链文本任务 | `deepseek-v4-flash`/`deepseek-v4-pro` 直呼微调 | ✅ 双档 200（pro 当日一度「价格未配置」后恢复→网关配置是活动的，实现须探活不缓存结论）；⚠️ v4 是 reasoning 模型，`max_tokens` 过小时 content 为空 | M1 文本任务（brandProfile 综合/copy/assembly/fix/qa·seo 汇总）当下即可真测；调用层给足 token 预算 |
| H3 | 图片/视觉/视频能力当下可用 | 同 H1 | ❌ `images/edits`（gpt-image-2）无通道；无任何活的多模态模型；veo 在列但同 Google 额度大概率 429 | imagePipeline 生成步与视觉质检、审美评审 = **capability-gated**，未就绪即显式跳过（`enhanceSkipped`/该维弃权），绝不拿文本模型硬顶 |
| H4 | Docling 能转真 PDF（M0 只软检） | 现造真 PDF 宣传册，按 `DoclingClient` 生产同形状 POST `/v1/convert/source` | ✅ status=success，全文精准转出 markdown | P1 资料解析可靠；M0 欠账在设计期即闭合 |
| H5 | 图片管线本地依赖在 Mac arm64 可行 | npm registry 查 sharp、Docker Hub API 查 rembg | ✅ sharp 0.35.3 + `@img/sharp-darwin-arm64` 预编译；`danielgatis/rembg` 官方镜像 19.3 万拉取、2026-06 仍更新 | 确定性图片步（重编码/EXIF/多尺寸/抠图 mask）零阻塞落地 |
| H6 | 品牌研究链路容器可用 | curl 健康探测 | ✅ SearXNG:8081=200、Crawl4AI:11235=200（Mac SNI 过滤照旧走放行侧引擎） | P1 web 研究复用获客侧现成 client 与 SSRF 守卫 |
| H7 | 预览无需域名 | M0 as-built | ✅ `/preview/{slug}/` 路径式已跑通（PREVIEW_URL_PATTERN 晚绑定） | M1 全程本地路径预览；D7 独立预览域推迟到购域后 |

## 2. Grounded 落地触点（镜像 M0 as-built；完整盘点见提取记录，此处为施工要点）

### 2.1 Schema（packages/db/prisma）
- **新表 `brand_profile`**（schema:1137 注释已点名）：`id/workspaceId/siteId/version/valueProps(Json)/tone(Json)/glossary(Json)/keywords(Json)/differentiators(Json)/competitors(Json)/factSheet(Json)/gaps(Json)/researchDegraded(Bool)/createdAt`，版本化追加不覆盖；RLS + FORCE RLS（M0 六表先例）。**evidence 结构分级**：factSheet 每项 `{value, evidence:{sourceType: intake|upload|storefront|web_research, url?, fetchedAt?}}`（合规 D2）。
- **Asset.meta 扩展**（Json 内，零迁移）：`hasPerson`（A5/A7 肖像分支）、`aiEdited`（E3 AI Act 钩子，M1 恒 false 但字段落地）、`derivedKeys` 已预留列直接用。
- **SiteVersion 并发修复**：`version = count+1` 在多 run 下撞 `@@unique([siteId,version])`（M0 已埋雷）→ 改事务内 `max(version)+1` 或对 siteId advisory lock（intake 先例）。
- `SiteBuildRun`：`kind='refurbish'`、`phase='P1_understanding'…'P5_publish'`、`scope/steps/costSummary/temporalRunId` 列全部 M0 已建未写，M1 零迁移直接写。
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
- 🔴 **补偿按 kind 分叉**：`cleanupFailedDemo` 删整站只适用 demo_v0；**refurbish 失败绝不能删用户站点**——回滚 = 不动 activeVersionId + version 行标 failed + run 标 failed。
- KB 摄入 Temporal 化（assets.controller.ts:77 挂账）：commit 后不再 fire-and-forget，改走独立 `kbIngestWorkflow`（D-M1-7）；**保留「失败留 queued 可重触发」语义**。

### 2.4 L2 AiTask（新目录 apps/api/src/site-builder/agents/）
统一契约（03 §0，镜像获客侧 task-registry + M0 `site_builder.demo_copy` 先例）：输入 zod fail-fast → 固化 prompt（用户数据只进模板变量位）→ `gateway.generateStructured({task, schema, maxTokens},{workspaceId})` → 输出 zod 不过带错误重试 ≤2 → settle 落 `costSummary`。prompt = 版本化代码资产 `agents/<name>/prompt.ts`。
- `brandProfile`：KB digest（来源标注+截断，D4 注入防线）+ SearXNG/Crawl4AI 研究（SSRF 守卫复用 + **robots 遵守复用 web_watch 先例**，C3）→ 模型综合 → **确定性出口闸**：factSheet 逐项 evidence 非空 + web_research 单源不支撑认证类断言（降 gaps）；输出 schema 不设个人字段（C4 结构性排除）。
- `copy`：每 locale 独立原生写作；确定性槽位完整/长度校验+超长定向重写；**只引 factSheet**（认证/数字断言关键词表比对，`FABRICATION_PATTERNS`/`sanitizePolish` 从 demo-spec.ts 上移共享）；richtext=受限 ProseMirror JSON（D15 白名单节点）。
- `designSpec`：预设 token 空间内选择/微调，WCAG AA 对比度校验器拒绝不合格 overrides（themes.ts 白名单同步扩展）。
- `siteAssembly` / `assemblyFix`：输出完整 SiteSpec（Puck 形状，04）/ **只许 JSON-Patch**；三重门（zod/引用完整性/语义规则：每页恰 1 H1、询盘 ≤2 击、Footer 必在、alt 100%、nav 无孤岛）+ Astro 构建错误回填重试；`collectTextKeys` 升级为门 2 的 copyBundle 覆盖率断言，产物 grep `⟦` 做缺 key 零成本门。
- `qa` / `seo`：确定性主体（Playwright 三断点遍历 + Lighthouse 四分；SEO 检查表含 hreflang 互指、noindex 硬检查、**产物 HTML 第三方外呼域黑名单**——F1 字体判例的可执行化）+ 模型只做 findings 归并（flash 档）。qa 硬门：零死链/表单可用/console 零 error/Perf≥85/A11y≥90。
- `imagePipeline`：确定性状态机——sharp 解码重编码剥 EXIF → rembg（compose 新容器）主体 mask → **[capability-gated：视觉质检→gpt-image-2 edits(mask 外重绘)→pHash+embedding 主体校验]** → 多尺寸 webp/avif 落 `derivedKeys` + putBuffer 直写（`generated` 键位已预留，presign 白名单不含=后端专用）。人物照（hasPerson）只裁剪调色；`kind=cert` 永不生成式处理。

### 2.5 渲染器（apps/site-renderer）
- 组件库补齐 04 §5 v1 封闭 17 型（现 10）：+TrustBar/ProductDetail/FactoryShowcase/CaseStudies/WhatsAppFloat/VideoBlock + 既有组件补变体位；Section.astro 注册表扩展（未知 type 跳过语义不变）。
- 多语种：`getStaticPaths` 扩 locale 维（`/{locale}/...`，默认 locale 免前缀），CopyBundle per-locale，`ar` 触发 `dir="rtl"`；hreflang 互指由 seo 检查兜底。
- **自托管字体对**（F1 🔴）：fontsource 包内嵌构建，`typography.fontPair` 枚举；构建产物禁 `fonts.googleapis.com` 等外呼域（qa 静态检查）。
- 图片：`props.image={assetId,usage,focalPoint?}` + 顶层 assets manifest 对账；渲染 `<picture>` 消费 derivedKeys；**禁外链 URL 直嵌**（校验器已管）。

### 2.6 M0 已埋雷（实现时必须绕开）
① refurbish 补偿≠删站（见 2.3）；② `previewBasePath` 与 `previewUrlFor` 必须继续同源于 `PREVIEW_URL_PATTERN`；③ SiteVersion version 并发（见 2.1）；④ KB 摄入迁移保留 queued 重触发语义；⑤ 模型调用统一走 gateway 封装（禁散落 fetch）。

## 3. 模型路由与四通道现实

**per-task 路由表（配置驱动，`agents/task-registry`；「现在」列 = 今天就能真测的默认值，「终选」列 = 用户接通道后翻配置，02 §6 唯一真值）**：

> **2026-07-14 终版定档**（真实评测 + 用户三轮拍板；唯一真值=02 §6 与 10 号文档，下表为施工执行版）：

| task | 现役主选（已实测活） | 回退链 | 升级位（待通道） |
|---|---|---|---|
| site_builder.brand_profile | deepseek-v4-pro（或 minimax-m3，评测并列） | glm-5.2；web 研究失败独立降级位 `researchDegraded` | gemini-3.1-pro / GPT-5.6 Terra |
| site_builder.copy | deepseek-v4-pro（🔴 护栏：`reasoning_effort:"low"`+长度裁剪+factSheet 白名单后校验） | glm-5.2 → doubao-seed-2.0-pro | GPT-5.6 Luna / gemini-3.1-pro |
| site_builder.design_spec | minimax-m3（与审美评审同档，多模态） | doubao-seed-2.0-pro | gemini-3.1-pro / GPT-5.6 Terra |
| site_builder.assemble / fix | **glm-5.2**（超时预算 180s） | 三重门校验→超时/违规自动回退 deepseek-v4-pro；批量档 doubao-seed-2.0-code | GPT-5.6 Terra / claude-sonnet-5 |
| site_builder.qa_summarize / seo_review | deepseek-v4-flash | doubao-seed-2.0-lite | gemini-3-flash |
| site_builder.image_qc / image_edit | seedream-5.0-lite（方舟已接真出图；图生图同端点，mask 保主体语义 M1-c 真探） | 确定性步兜底（`enhanceSkipped`） | gpt-image-2 `images/edits`（贵精档） |
| site_builder.aesthetic_review | minimax-m3（plan 端点收图与否 M1-f 真探） | **该维弃权**（03 卡6 降级语义），不阻断出环 | gemini-3.1-pro / GPT-5.6 Terra |

原则：**文本任务 = 配置默认 deepseek 双档（合法路由，非静默降级）；能力缺失任务（视觉/图编）= 显式跳过并落标记，绝不拿文本模型硬顶**。通道接入后翻 registry 配置 + 重启 worker 即切换（获客侧 #35 先例：旧进程持旧注册表须重启）。豆包视频中转坑（issue #2174/方案 B 直连方舟）与 M1 无关（视频=M3），仅在契约留降级位。

**用户侧通道就绪清单（不阻塞 M1 开工，影响激活时点）**：① Anthropic → claude-sonnet-5（组装主力）② Google → gemini-3.1-pro + flash 档（研究/文案/视觉三评审）③ OpenAI → gpt-image-2 且**确认网关转发 `images/edits`**。接入一条我实测一条、翻一条。

## 4. 合规红线（编号沿用提取记录 A-F；🔴=硬闸）

- **A 素材**：A2 sharp 一律解码重编码+剥 EXIF（GPS=个人数据）🔴；A3 双闸（presign 出票限制 + commit 魔数复验，M0 已建沿用）；A4 Docling 容器非特权无网络（compose 规格化）；A5 人物照默认不做生成改动；A6 证书图永不生成式处理 🔴；A7【补】人脸检测落 `hasPerson` 标记。ToS 素材权属条款=SaaS 侧阻塞项（对外依赖清单）。
- **B KB**：B1 删除链路可证（document 级联删 M0 已建；workspace 注销接 Art.17 编排先例）；B2 embedding 只许自托管端点（配置校验非自由 URL）🔴；B3 检索 RLS；B4【补】**用户自有资料含 PII：用户=控制者/我们=处理者，可入 KB 仅限本 workspace 消费；(a) 不回流获客绿库 🔴 (b) copy 输出具名人白名单（仅显式团队素材可上站）(c) 受 B1 删除覆盖**。
- **C 研究**：C1 SSRF 全套复用获客守卫 🔴；C2 抓取内容只进模板变量位（AiTask 基类结构性保证）🔴；C3【补】robots 遵守（web_watch 先例）+ 竞品只做定位参考不搬运；C4 第三方页面具名个人不落库不进 Brief（schema 结构性排除）🔴。
- **D 文案**：D1 factSheet 零虚构=模型后置**代码闸**（evidence 非空，缺=gaps）🔴；D2【补】evidence 分级溯源（sourceType+url+fetchedAt；web_research 单源不支撑认证类断言上站）；D3 只引 factSheet+禁绝对化宣称；D4 kbDigest 来源标注+截断；D5 预览产物过 L1 确定性筛查（词库资产先建，L2 模型审查挂 M2 发布门）。
- **E 图片**：E1 mask 外重绘、无 mask 不许调编辑端点 🔴；E2 主体 pHash+embedding 双保险（不过=原图）🔴；E3【补】`aiEdited` day1 落数据（AI Act 钩子）；E4 图库/图标许可白名单+禁外链直嵌。
- **F 渲染**：F1 字体自托管 + 产物外呼域黑名单检查 🔴；F2 构建沙箱（M1 先落资源限额+超时，无网络容器化列 M2 硬化项——本地 dev 构建本就同机）；F3 预览 noindex 硬检查+随机 slug（M0 已有）。

## 5. 关键决策（带推荐；D-M1-1 需拍板，其余默认可推翻）

| # | 决策 | 推荐与理由 |
|---|---|---|
| D-M1-1 | M1 是否含 P4 质量环（01/02 口径张力） | **含，确定性优先**：qa/seo 主体是 Playwright/Lighthouse/检查表（今天就能真测且价值最大）；审美维 capability-gated 自动弃权，Google 通道来了零改码激活。管线形状一次成型，避免 M2 再动编排 |
| D-M1-2 | 文本模型先用 deepseek 双档跑通全链 | **是**：不等通道；registry 配置化，接入后翻配置+重启即切终选。eval 基线在切换前后各跑一轮量化差异 |
| D-M1-3 | gpt-image-2 生成步现在写吗 | **不写调用代码，只留状态机步骤位+flag**：真实数据红线=没通道就没法真测，写了也是死代码；确定性步（重编码/EXIF/rembg mask/多尺寸）全量落地 |
| D-M1-4 | 组件库扩展幅度 | **一次补齐 04 §5 封闭 17 型**：契约是封闭枚举，P3 组装 prompt 需要完整菜单；M0 一个里程碑做了 10 个，增量 7 个成本可控 |
| D-M1-5 | M1 语种范围 | **en + de 真跑**（golden=德国市场先例），`ar`(RTL) 进渲染器单测但不进 M1 golden；语种是 options 参数非硬编码 |
| D-M1-6 | 进度推送 | **轮询 `GET /builds/{id}` 先行**，SSE 端点 M1 末段可选（07 允许轮询替代；SaaS 前端未接，YAGNI） |
| D-M1-7 | KB 摄入 Temporal 化形态 | **独立小 workflow**（`kbIngestWorkflow`，commit 触发）而非并进 refurbish：上传时刻≠构建时刻，摄入失败重触发语义独立 |
| D-M1-8 | 观测 dashboard（02 §11.12） | costSummary/steps 落库全量 + 结构化日志；**可视化 dashboard 推 M2**（YAGNI，SaaS 前端未接） |
| D-M1-9 | rembg 接入形态 | **compose 常驻容器**（官方镜像 HTTP 模式），与 docling 同模式；避免 per-build 拉起开销 |

## 6. 主动风险/权衡（没问但该知道）

1. **模型单一供应商集中**：M1 期间全链文本压在 deepseek 一家——网关配置漂移（今天 v4-pro 就短暂「价格未配置」）或供应商故障=全管线停。缓解：AiTask 探活+显式失败+run 可重跑；通道多元化本身就是解药（用户侧清单）。
2. **P95<15min 与质量环相乘**：3 轮 × Astro 重构建（M0 单次 ~5-6s，M1 组件×语种×图片后会涨）+ 逐图处理。缓解：P2 素材并行 + content_hash 幂等跳过 + 增量 scope；verify-m1 落真实计时基线，超标再优化（不预优化）。
3. **reasoning 模型结构化输出**：v4 双档思考吃 token、JSON 模式行为与非 reasoning 模型不同。缓解：generateStructured 统一封装 maxTokens 预算 + zod 重试 ≤2；eval harness 记录每 task 成功率。
4. **rembg 对工业产品图的分割质量未知**（管道/异形件/反光金属）。缓解：mask 只用于「生成步保护区」，生成步 M1 关闭 → M1 实际风险=0；激活前用 golden 图集实测 IoU。
5. **成本**：03 §10.6 底数（一轮 ¥5-15）基于终选模型；deepseek 期间显著更低，但质量环×3 会放大调用数。缓解：ModelBroker 单 build 上限 + 预算超限暂停事件（02 §4 已定）。
6. **golden set 授权**（08 §6.1 待拍板）：真实工厂资料脱敏授权未定。缓解：M1 用「合成 2 家 + 你自己可授权的 1 家真实」起步，不阻塞。
7. **Playwright/Lighthouse 依赖**：CI 只跑纯单测（仓规），qa 的浏览器检查只进本地 verify——意味着质量环回归依赖本地跑。接受（与获客侧 verify 体系一致）。
8. **范围体量**：M1 是 M0 的 ~2.5 倍触点（新表 1 + 新 AiTask 7 + 组件 +7 + 多语言 + 质量环）。缓解：§7 分 7 步、每步独立 PR 独立可回滚，任一步卡住不连坐。

## 7. TDD 实施步骤（每步 = 1 PR：RED→GREEN→本地全绿→真机 verify→对抗复审→合并）

| 步 | 内容 | 主要触点 | 新增 spec（先红） |
|---|---|---|---|
| M1-a | 地基：brand_profile 表迁移+RLS、SiteVersion 并发修复、`POST /sites/{id}/builds`+`GET /builds/{id}`+cancel、REFURBISH_LAUNCHER、refurbishWorkflow 骨架（P1-P5 空活动+按 kind 分叉补偿）、KB 摄入 Temporal 化（D-M1-7） | schema/migrations、builds.controller/service、temporal 3 文件 | builds.service.spec、refurbish-workflow.spec（PR#73 harness）、kb-ingest-workflow.spec、version-alloc.spec |
| M1-b | P1 brandProfile：AiTask 基类+registry、KB digest 组装（D4）、web 研究（SSRF+robots）、factSheet evidence 分级闸（D1/D2）、gaps→kb/status | agents/base、agents/brand-profile、kb.service gaps | ai-task.spec、brand-profile.spec（含零虚构/单源降 gaps/schema 无个人字段）、kb-digest.spec |
| M1-c | P2 图片确定性管线：rembg 容器入 compose、sharp 重编码+EXIF+多尺寸 derivedKeys、hasPerson/aiEdited/cert 分支闸、putBuffer 直写 generated 键、渲染器 `<picture>` | agents/image-pipeline、assets.service 分叉、compose、ProductGrid 等 | image-pipeline.spec（EXIF 剥离/cert 硬分支/幂等/单图失败不阻断） |
| M1-d | P2 文案：copy AiTask（多 locale/槽位/长度/factSheet-only 闸/受限 richtext）、CopyBundle 落 SiteVersion、渲染器多语种路径+RTL+自托管字体+外呼域检查 | agents/copy、renderer pages/layouts/themes | copy.spec、copy-bundle-validate.spec、renderer 侧 locale/字体检查进 verify |
| M1-e | P3 组装：designSpec+siteAssembly AiTask、三重门校验器（含语义规则）、构建错误回填重试、组件库补齐 17 型 | agents/design-spec、agents/assemble、spec-validator、renderer 组件 ×7 | spec-validator.spec（三门逐条）、assemble.spec、design-spec.spec |
| M1-f | P4 质量环：qa（Playwright+Lighthouse+外呼域/⟦key⟧ 门）、seo 检查表、aesthetic capability-gate、assemblyFix JSON-Patch-only、≤3 轮编排 | agents/qa、agents/seo、agents/fix、workflow 循环 | qa-checks.spec、seo-checks.spec、fix-patch.spec（只许 patch）、loop 分支入 workflow.spec |
| M1-g | 收尾：`verify-site-builder-m1.mts`（§8）、golden 2 家 smoke fixtures、eval 硬门基线（factSheet 零虚构/主体保护占位）、OpenAPI 重导出、docs/status+CLAUDE.md §4 更新 | scripts、test/fixtures/golden-companies、contracts | verify 脚本本身=验收 |

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
- **不阻塞但影响激活时点**：new-api 三通道（Anthropic/Google/OpenAI images/edits）接入后逐条实测翻配置；golden 真实工厂授权方式定前用合成+自有数据。
- **已定事项回执**：域名后买（预览走本地路径，购域后改 env 零代码切换）；WSL 已从一切流程剔除。
