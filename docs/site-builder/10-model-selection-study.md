# 10 · M1 模型选型研究（外部研究 + 网关活模型真实评测）

> 2026-07-14。方法：①外部信源研究（官方发布/榜单/独立评测，禁编造分数）②三个 M1 任务形状在本地 new-api 网关上对活模型**真实调用评测**（确定性 python 判分 + 延迟实测）。结论用于 09 施工图 §3 路由表；换档（通道接入）时用同套题复测对比。
>
> 🔴 **治理定位**：模型选型分状态治理见 §0.2（四态路由 + Agent 绑定 ModelProfile，决策见 ADR-016）。本文的"主力/首选/升级位"是**评测队列候选或已接通 currentRoute，非生产终选**；晋级只经评测（Golden Set 回归 + 成本/质量门），非采购承诺或永久定档。
>
> **环境迁移说明（2026-07-16）**：正文的本地实测产生于旧 Mac 会话，只保留为 dated evidence；当前开发根目录是 `/global/backend`，网关通道/价格/额度均为活动配置，不能把旧探测结果当 Ubuntu 当前可用性。运行时事实只认 `task-routes.ts` 的 `currentRoute`，候选需在当前环境重新探活与回归后才能晋级。
>
> **2026-07-19 supersession**：本研究的“不改 currentRoute/未做效果实测”只描述 2026-07-17 当时的 target 决策。BrandProfile fast-follow 已在 Ubuntu 当前 new-api 上以 final-code 同形 6×2 证明 Terra/Responses 与 Sonnet/Messages 各 12/12；完整 legacy DeepSeek Pro→GLM 路由同样 12/12，旧 10/12 结论不再作为晋级依据。三路硬门全过后按 accepted-artifact 成本、原生 transport/provenance、失败门与 rollback 保持首个代码级 promotedRoute，active evidence id=`model1-brand-profile-20260719-v20`。其他 task 和媒体仍不得继承该结果；现役继续只认 `task-routes.ts`。

## 0A. 2026-07-17 已批准方案 1：质量优先目标组合（ADR-020）

本节覆盖本文所有“升级位/终选”措辞，但**不覆盖附录历史实验，也不改 currentRoute**。研究口径是公开官方资料、公开榜单/测评与任务特性对照；按用户要求，本轮**没有做模型生成效果实测**，因此以下只能是 approved `targetCandidate`，不能伪称 `evaluatedCandidate/promotedRoute`。价格不是本轮主决策因子；重点是结构化可靠性、长上下文、海外文案质量、多模态理解、图像编辑控制、稳定/Preview 生命周期与安全边界。

| 任务 | 唯一目标主模型 | 唯一模型回退 / 降级 | 选择依据与边界 |
|---|---|---|---|
| BrandProfile、FactSheet、Claim Gap、DesignBrief、SiteSpec 普通组装/修复 | `gpt-5.6-terra` | `claude-sonnet-5` | 长上下文、图片输入与 Structured Output 适合作为结构化中枢；只处理冻结证据/封闭 Catalog |
| 海外英文/德文文案、产品页、品牌叙事、本地化 | `claude-sonnet-5` | `gpt-5.6-terra` | 重点利用 Sonnet 的高质量长文、语气与多语言表达；事实只能来自批准 Claim |
| 连续两次失败后的高难 SiteSpec 修复 | `gpt-5.6-sol` | 确定性安全 Blueprint | 旗舰只处理显式 escalation，避免普通请求滥用高推理档 |
| 三断点截图审美、图片/后续视频 QA，低风险 QA/SEO 摘要 | `gemini-3.5-flash` | `gpt-5.6-terra` | 原生多模态、结构化输出和高吞吐；模型只产 Finding/摘要，硬门仍由代码执行 |
| 企业知识库向量 | `bge-m3` 自托管 | 无 | 保持既有多语言向量空间、1024 维与 `embed_version`；仅把传输统一到 new-api |

| 媒体任务 | 目标主模型 | 回退 | 生产边界 |
|---|---|---|---|
| 批量非事实 Hero/抽象背景/通用工业场景 | `gemini-3.1-flash-image` | `doubao-seedream-5.0-lite` | 只生成非事实视觉；当前缺目标型号时可由已接 Seedream 承担候选替代 |
| 高价值首页 Hero/品牌主视觉/复杂营销合成 | `gemini-3-pro-image` | `gpt-image-2` | 少量高价值任务；当前缺目标型号时以已接 GPT Image 2 作候选替代 |
| 产品主体敏感的 mask 外编辑 | `gpt-image-2` | 原图 Sharp Variant | 产品 mask 内锁定；OCR/Logo/标签/颜色/比例/接口/孔位/轮廓任一失败即拒绝 |
| OG/带文字营销横幅 | `gpt-image-2` | 确定性 HTML/SVG | 文字来自批准 Claim，不让图片模型创造事实 |
| 产品几何、证书/报告、人物身份图 | **禁生成式编辑** | 原图 | 永久 fail-closed |
| M3 5–10 秒图生视频 | `seedance-2.0` | 确定性动效/静态图 | 后续接火山能力；不进 M1/Demo，须主体/时序/权利 QA |

`gemini-omni-flash-preview` 与 `veo-3.1-generate-preview` 只进评测池：Preview 不作为唯一生产依赖。Omni 当前没有独占职责，已由稳定的 `gemini-3.5-flash` 覆盖截图/媒体 QA；这就是基于当前支持型号的平替。`gemini-3.1-flash-image` 缺失时用 `doubao-seedream-5.0-lite`，`gemini-3-pro-image` 缺失时用 `gpt-image-2`，但替代也须真实媒体任务评测后才能 promoted。

**当前网关反证**：2026-07-17 用通用应用令牌读取本机 `/v1/models` 得 39 个可调用型号；上表中 `gpt-5.6-terra/sol`、`claude-sonnet-5`、`gemini-3.5-flash`、`gpt-image-2` 可见，三个 Gemini 图片/Omni 型号不可见。自托管 BGE-M3 不再暴露公共名，只以 `site-builder-bge-m3-local` 私有别名存在；#140 合并并完成 Ubuntu 开发环境切换后，专用令牌只返回该别名，真实 `EmbeddingsClient` 返回两组 1024 维有限向量。清单可见和 embedding 连通都**不能证明**结构化任务、视觉输入、mask 编辑或质量达标，也不代表生产部署。

公开依据入口：[OpenAI GPT-5.6 models](https://developers.openai.com/api/docs/models)、[Anthropic Claude models](https://docs.anthropic.com/en/docs/about-claude/models/overview)、[Gemini models](https://ai.google.dev/gemini-api/docs/models)、[Gemini image generation](https://ai.google.dev/gemini-api/docs/image-generation)、[BGE-M3](https://huggingface.co/BAAI/bge-m3)。更换本组合必须新建 ADR；上线仍须 §0.2.6 的真实 endpoint 与 Golden Set 门。

## 0. 2026-07-14 dated 结论：按任务路由（保留为历史实测证据）

> **历史表，不再拥有目标组合权威**：currentRoute 列仍需与代码核对；旧“升级位”仅保留 2026-07-14 研究 provenance，2026-07-17 目标组合统一见 §0A/ADR-020。本表非"终选"，也不因后来通道接通自动晋级。

| site_builder task | currentRoute（as-built 代码事实） | deterministicFallback / 降本回退 | evaluatedCandidate / targetCandidate（评测队列，未接通） |
|---|---|---|---|
| brandProfile 研究综合 | **deepseek-v4-pro**（99/100，最省 token）或 **minimax-m3**（100/100，粒度最细） | glm-5.2（唯二主动消歧竞品认证，审计留痕最佳） | gemini-3.1-pro（MRCR 长文档王）/ claude-sonnet-5 |
| copy 多语种文案 | **deepseek-v4-pro**（currentRoute，用户 7/14 定，as-built 非永久终选；评测德语原生度 4.5 全场最佳；🔴 工程护栏必配：`reasoning_effort:"low"` + 长度超限自动裁剪重写 + factSheet 白名单后校验） | glm-5.2（约束遵循最佳零 reasoning 税）→ doubao-seed-2.0-pro | GPT-5.6 Luna / gemini-3.1-pro（claude-sonnet-5 仍是营销语气口碑第一，8/31 前介绍价） |
| siteAssembly / assemblyFix | **glm-5.2**（currentRoute，用户 7/14 定；应答质量满分，弱点=延迟尾部→超时预算 180s）→ 超时/校验违规**自动回退 deepseek-v4-pro**（加压全满分+跨 run 同构） | doubao-seed-2.0-code（快 3-6×省 4-9×，1/4 违规须配校验+重试升级链） | claude-sonnet-5 / GPT-5.6（唯二官方 Structured Outputs） |
| qa / seo 汇总 | **deepseek-v4-flash**（$0.14/$0.28 全场最低） | doubao-seed-2.0-lite | gemini-3-flash |
| designSpec / 审美视觉评审 | **minimax-m3**（网关内唯一原生图像输入——P4 审美维可能不必等 Google，待 M1-f 真探图像输入经 plan 端点是否可用） | doubao-seed-2.0-pro（VideoMME 89.5） | gemini-3.1-pro / claude-sonnet-5 |
| 图像生成/编辑 | **seedream-5.0-lite**（已接通实测出图；用户已定暂用） | — | **gpt-image-2**（文字渲染 Elo 第一；含长文字图必用；与 seedream 组"贵精/便宜快"双轨） |
| video（M3） | — | — | 历史曾提 Seedance 直连方案 B；已被 ADR-020 的 new-api-only 决策取代，当前只保留网关能力探针与确定性降级 |

**与用户 7/14 调整表的对齐记录**：①组装维持用户拍板的 **glm-5.2 主选**——初版评测 90s 内 50% 超时是评测口径非生产约束（Temporal 预算 10min），生产给 180s + 三重门校验 + 超时/违规自动回退 deepseek-v4-pro；M1-g golden set 按生产口径双模型对比终审。**架构澄清（D1）**：组装 agent 不写前端代码——组件库是仓内手写 Astro，agent 只产 SiteSpec JSON，该任务考 schema 纪律非编码力；将来真出现代码生成任务（M2+ 自定义组件）glm-5.2 是无争议首选。②GLM-5.2 同时是 **copy 主选**（唯一零 reasoning 开销、约束全过）。③GPT-5.5 已被 GPT-5.6 三档取代（Terra $2.5/$15 同能力更便宜）——接 OpenAI 通道建议直接 5.6。④用户档位后期升 **Large**（seedance 解锁，供 M3 视频）。⑤用户 7/14 第三轮调整定 currentRoute：**copy 现役对调为 deepseek-v4-pro**（glm-5.2 转 fallback；注：本文附录 C 实验建议仍是 glm-5.2，evidence 与 currentRoute 分栏记录，见 §0.2.2）；各任务升级位统一指向 **GPT-5.6 Terra/Luna + gemini-3.1-pro**（组装升级 Terra、copy 升级 Luna、研究/视觉/qa 升级 gemini-3.1 系）——均为 targetCandidate（未接通未评测），非终选。

## 0.1 评测暴露的工程硬教训（M1-b AiTask 基类必须内建）

1. 🔴 **reasoning 预算是头号杀手**：minimax-m3 在 max_tokens=4000 下推理吃光预算、`content=""` 静默失败；kimi/minimax 在 copy 形状 90s 纯推理零正文且**无视 reasoning_effort 参数**；deepseek 须 `reasoning_effort:"low"` 才出 copy 正文。→ AiTask 基类：按任务配 maxTokens+effort；`finish_reason=length && content 空` 判定为显式失败（换预算/换模型重试），绝不静默。
2. doubao 对 max_tokens 语义宽松（请求 3000 实回 3685）→ 预算控制不能只信请求参数，settle 按实际用量记账。
3. 全部模型「纯 JSON」指令遵从 100%（有产出的 run），但数量约束冲突（6 产品 vs items≤4）仍会击穿快档模型 → 校验器+重试升级链是结构性必需，非可选。
4. glm 德语拼写错（Schraubenspumpen×3）、doubao 翻译腔（Zentrifugalpumpen≠行业词 Kreiselpumpe）→ copy 管线的 glossary 强一致 + 拼写校验是硬需求（04 设计已含 glossary，M1-d 补拼写檢查）。

---

## 0.2 模型治理：四态路由 + Agent 绑定 ModelProfile（v3.2 §23 回写；决策见 ADR-016）

> 🔴 **本研究是"评测证据"，不是"终选定档"。** 上表 §0 与附录 A–D 里所有"主力/首选/升级位"都是**评测队列里的候选或已接通路由**，不因为写进本文档就自动成为生产终选或采购承诺。模型选型的真值分两处：**代码 `task-routes.ts` 的 `currentRoute` = as-built 唯一真值**；**候选晋升为默认生产路由只经评测（Golden Set 回归 + 成本/质量硬门）后写 ModelRegistry**。02/10 的实测只作 evidence——**推荐 ≠ 代码已切换**。

### 0.2.1 四态路由分类法（+ deterministicFallback）

v3.0/v3.1 的错误不是列了新模型，而是把"官方看起来合适"直接命名成 `targetRoute` 终选。模型选型必须分状态（ADR-016）：

| 状态 | 含义 | 谁能进 |
|---|---|---|
| **currentRoute** | 代码 + 真实 endpoint 已接通的 as-built 路由 | 只有 `task-routes.ts` 里现役的型号 |
| **evaluatedCandidate** | 已用本项目 task shape 在网关上跑过能力/质量/成本/延迟评测，但未默认 | 附录 A–D 已在网关实测的活模型（glm-5.2、minimax-m3、doubao 系、deepseek-v4-\*） |
| **targetCandidate** | 官方/公开证据和产品决策选定、但尚未通过本项目 task-shaped 评测的候选；可以已接通，也可以待接 | ADR-020 目标组合及其他获准进入评测池的型号 |
| **promotedRoute** | 过硬门 + 获批准 + 写 ModelRegistry 的默认生产路由 | 经 MODEL-1/2 晋级判定的候选 |
| **deterministicFallback** | 模型不可用时仍产事实安全结果的代码路径 | 回退链末端 / 弃权分支 |

`shadow / canary` 是**流量模式，不是真值状态**，只能作用于 evaluatedCandidate/promotedRoute。**禁止**把任何"榜单第一 / 官方看起来强"的型号直接写成 targetRoute 终选。**Agent 卡只绑 ModelProfile 语义档（能力/成本/延迟约束），不硬编码型号字符串**（ADR-016）。

### 0.2.2 as-built currentRoute 登记（核对 `task-routes.ts`，PR #114）

7 个 task 全部为已接通 currentRoute；DeepSeek 已切显式 `v4-pro`/`v4-flash`（旧别名 `deepseek-chat`/`deepseek-reasoner` 官方 2026-07-24 关停，禁再用）。回退链语义 = 合法路由（AiTask 基类逐模型尝试），**非静默降级**：

| task id | currentRoute primary | fallback | maxTokens | timeout | 备注 |
|---|---|---|---|---|---|
| `brand_profile` | deepseek-v4-pro | glm-5.2 | 12000 | 150s | 12000=真机校准（6000 时 v4-pro 两跑截断落回退） |
| `copy` | deepseek-v4-pro | glm-5.2 → doubao-seed-2.0-pro | 4000 | 120s | 🔴 `reasoningEffort: low`（reasoning 护栏） |
| `design_spec` | minimax-m3 | doubao-seed-2.0-pro | 4000 | 120s | 网关内唯一原生图像输入 |
| `assemble` | glm-5.2 | deepseek-v4-pro | 16000 | 180s | 宁慢勿错，超时/违规走回退链 |
| `assembly_fix` | glm-5.2 | deepseek-v4-pro | 8000 | 180s | |
| `qa_summarize` | deepseek-v4-flash | doubao-seed-2.0-lite | 3000 | 90s | 全场最低价 |
| `seo_review` | deepseek-v4-flash | doubao-seed-2.0-lite | 3000 | 90s | |

即 currentRoute = **deepseek-v4-pro**（brand/copy）+ **minimax-m3**（design）+ **glm-5.2**（assemble/fix）+ **deepseek-v4-flash**（qa/seo），fallback 落 glm-5.2 / doubao-seed-2.0-pro/lite / deepseek-v4-pro。

🔴 **代码事实与实验建议分栏**：本文附录 C（copy 形状实测）**推荐 glm-5.2**，但 copy 的 currentRoute 是 **deepseek-v4-pro**（用户 7/14 第三轮定为现役）。二者必须分别记录、不能互相改写：**附录是 evidence，`task-routes.ts` 是 as-built**；MODEL-0 先把 as-built 完整登记，MODEL-1 再真探候选。

### 0.2.3 ModelProfile 能力档矩阵（评测队列，非采购承诺 / 永久终选）

下表是 v3.2 的评测队列，不是采购承诺或终选。目标态实现文件（MODEL-0 落地）：`model-profiles.ts`（profile/capability 类型）、`model-policy.registry.ts`（current/evaluated/target/promoted + 流量模式/健康度/区域/价格/生命周期）、`model-capabilities.ts`、`model-capability-probe.ts`、`model-promotion.service.ts`（MODEL-2 才建全）。`task-routes.ts` 目标态从 `task → model string` 演进为 `task → profile + task budget`，保留 `SITE_BUILDER_MODEL_*` 作紧急 override，新增 `SITE_BUILDER_PROFILE_*`。

| ModelProfile | 任务 | currentRoute（代码事实） | evaluated / target candidates | 晋级前提 |
|---|---|---|---|---|
| deterministic | 编排、Demo、Schema/SEO/安全硬门 | 代码 | 代码 | 可复算规则，不用模型 |
| structured.default | BrandProfile、DesignBrief、SiteSpec assembly/fix | Brand=deepseek-v4-pro；Design=minimax-m3；Assembly=glm-5.2 | **GPT-5.6 Terra → Claude Sonnet 5** | schema、事实、稳定性、长任务与修复率过门 |
| reasoning.high | 两次修复失败后的复杂组装 | glm-5.2 / deepseek-v4-pro | **GPT-5.6 Sol → deterministic safe blueprint** | 只作显式升级位；普通请求不得进入 |
| copy.premium | 英文/德文首页与高价值产品页 | deepseek-v4-pro | **Claude Sonnet 5 → GPT-5.6 Terra** | 事实零违规、术语正确、目标市场偏好胜出 |
| text.bulk | 批量本地化、标签、低风险改写 | deepseek-v4-flash / doubao-seed-2.0-lite | Gemini 3.5 Flash → GPT-5.6 Terra | 价格非本轮主因，仍须事实/术语/结构门 |
| multimodal.review | 截图审美与图片/视频 QA | 现路由须**重新验证视觉输入** | **Gemini 3.5 Flash → GPT-5.6 Terra** | 图像/视频 capability 真探、关键漏检率、Finding schema |
| text.summary | finding 归并和解释 | deepseek-v4-flash | **Gemini 3.5 Flash → GPT-5.6 Terra** | 只摘要；硬门仍由代码执行 |
| image.precise_edit | 产品主体敏感的 mask 外编辑 | **无 as-built 生成路由** | GPT Image 2、其他支持 mask/edit 档 | OCR、几何、Logo/标签、主体身份零破坏 |
| image.bulk.creative | 非事实 Hero 背景与抽象场景 | seedream-5.0-lite | **Gemini 3.1 Flash Image → Seedream 5.0 Lite** | 权利/事实门、构图/文字/一致性任务集 |
| image.premium.design | 少量高价值合成 | seedream-5.0-lite | **Gemini 3 Pro Image → GPT Image 2** | 只在高价值页面证明可见质量增益后使用 |
| video.primary | 5–10 秒参考镜头 | 无 M3 as-built | **Seedance 2.0 → deterministic motion/static** | provider 真探、主体/时序/权利 QA；不进 Demo |
| video.premium | 少量复杂镜头 | **无** | Veo 3.1 preview、其他受支持候选 | Preview 不能是唯一依赖；静态降级必须成立 |
| speech.production | M3 旁白 | **无** | 仍受支持的 OpenAI/Google/provider TTS + 人工授权旁白 | 生命周期、语言、品牌词回听、授权与成本 |
| transcription | 字幕与旁白质检 | **无** | GPT-4o Transcribe/mini 或当时受支持等价档 | 真探后选；转写须与品牌词/数字比对 |
| moderation.media | 文本与图片内容安全 | 现有规则/provider safety | omni-moderation-latest + 本地规则或等价档 | 不替代权利、事实和行业政策门 |
| embedding.private | 企业 KB 多语言检索 | BGE-M3 self-hosted | **同一 BGE-M3，经 new-api `/v1/embeddings`** | 1024 维/`embed_version` 不变；无召回收益不换空间 |

官方目录只用于**生成候选池与生命周期信号**，不代替内部证据；任何型号**开工当天必须重新核对** GA/Preview/Deprecated、区域、价格与租户可用性（链接见 §35 与附录 A 信源）。

### 0.2.4 明确不选 / 不直接上线（§23.3）

- **Gemini 3.1 Pro Preview**：可 shadow 研究，Preview 不作默认生产主路由。
- **已关闭的 Gemini 3 Pro Preview**：不进入任何新配置。
- **Veo 3.1 Preview**：只 premium/shadow，不替代 Seedance 生产主路由。
- **Sora 2 / Sora 2 Pro**：官方目录标 deprecated，不接新生产功能。
- **Gemini 3.1 Flash TTS Preview**：保留表达力实验，不作唯一旁白路由。
- **GPT-4o mini TTS**：官方目录出现弃用信号，不得新锁为 production target；先核对迁移窗口和替代型号。
- **`deepseek-chat` / `deepseek-reasoner` 旧别名**：一律迁显式 DeepSeek `v4-pro`/`v4-flash`，避免弃用窗口造成隐式漂移。
- **任何"榜单第一"模型**：没有 task-shaped Golden Set、结构化能力探针、数据区域和成本证据，不进入 canary。

### 0.2.5 媒体档治理（image / video / audio；§20.6 / §21.3 / §21.5 回写）

- **图像**：M1-c 仍是纯 Sharp。生成式阶段的 target portfolio 为 bulk `gemini-3.1-flash-image → doubao-seedream-5.0-lite`、premium `gemini-3-pro-image → gpt-image-2`、precise mask-outside edit `gpt-image-2 → original Sharp`；产品几何、证书/报告、人物身份生成式编辑永远禁用。当前缺两个 Gemini 图片型号，不得把文档目标冒充可调。
- **视频**（M3）：`video.primary` target = **Seedance 2.0 → deterministic motion/static**；先经 new-api/MediaGateway capability probe、主体/时序/权利门，过 M3 门才写 promotedRoute。`Veo 3.1` 与 `gemini-omni-flash-preview` 仅 shadow/evaluation，Preview 不能是无 fallback 的唯一依赖。产品/工厂优先 image-to-video，降低主体漂移；网关不支持时保持静态降级，任何直连例外须新 ADR。
- **旁白 / 字幕**（M3）：`speech.production` **无 as-built**，MODEL-1 比较**仍受支持的 OpenAI TTS / Gemini TTS / 现有 provider + 人工授权旁白**，把 **provider 生命周期作硬门**，不做未授权声音克隆；**GPT-4o mini TTS 因弃用信号只留迁移观察位**，Gemini 3.1 Flash TTS Preview 只 shadow 表达控制。`transcription` 主选 **GPT-4o Transcribe**，批量低风险回退 **GPT-4o mini Transcribe**，输出 WebVTT/SRT Variant；转写须与品牌词/数字比对。

### 0.2.6 分阶段晋级（MODEL-0/1/2）与晋级判定（§27.8）

**MODEL-0（现在做）**：把 7 个 task 的真实 primary/fallback 登记为 currentRoute，保持 #114 行为不变；每 profile 固定 task budget / 数据区域 / 最大单次成本 / capability / deterministicFallback；02/10 历史实验记为 evidence，**不自动晋级为 current/promoted**。

**MODEL-1（候选接通时做，依赖 MODEL-0 + EVAL-bootstrap）**：每候选先在真实 endpoint 跑 **capability probe**（失败即停，不把官方规格当租户可用事实）→ 每 task 用 **6–12 个代表样本 × 2 次** + accepted-artifact 成本，先判 schema/事实/身份/延迟/成本再做偏好比较 → 通过者成 **evaluatedCandidate 报告，不自动切生产**。

**MODEL-2（有真实流量或高风险切换前做）**：扩到 ≥30 样本 × 3 次 + 100% shadow → 批准后 5%→25%→100% canary（各档样本/时间门写进 ADR）→ 任一事实/身份硬失败、P95、provider error、accepted-cost regression 触发**自动回 promotedRoute**；Preview 不得是无 fallback 的唯一依赖，Deprecated 须在截止日前迁移。

**晋级判定（evaluatedCandidate → promotedRoute，§27.8）**：① 永久硬门全过（事实/引用违规 0、结构化输出一次 repair 后合法、关键 QA 漏检不超阶段门、产品身份破坏 0、P95 不超预算、accepted-artifact 成本可核对）；② 质量显著优于现路由 **或** 非劣且 accepted 成本更低 **或** 解锁必要 capability；③ 开工 ADR 明确样本量/成本预算/流量档/回退阈值/owner；④ 报告按 task/locale/archetype/资料完整度/provider failure 切片，不用总平均掩盖高风险子集。**"最贵/最新"不是晋级理由；默认选满足质量门的最低 accepted-artifact 成本。** 启动集只能标 evaluatedCandidate，**不能宣称统计显著或永久终选**。

### 0.2.7 路由工程门与可观测性（§23.7）

- 每 task 固定 maxTokens、timeout、reasoning effort、maxCost 和 fallback policy。
- `finish_reason=length`、空 content、schema 不合、capability 不符**必须是显式错误码**（不静默降级/静默失败——见 §0.1 硬教训）。
- 模型原始输出**不直接进数据库或 Renderer**；先过 schema/事实/引用/安全门。
- 记录 profile、policyVersion、channel/provider/model/modelSnapshot、fallbackIndex、prompt/schema/rubric、token/latency/cost、finish/fallback/rollback reason。
- **Judge 尽量不与 candidate 同 provider**；先跑确定性门再盲评，避免高文风掩盖事实错误。
- 所有 alias 运行时解析到 snapshot；ReleaseManifest 保存 snapshot 供历史重放与回归定位。

---

# 附录 A：外部研究全文

# 模型选型评测报告 — AI 外贸独立站建设 L2 AI 任务（外部证据版，2026-07-14）

**方法**：全部结论来自 2026 年公开信源（官方发布、Artificial Analysis、LMArena、OpenRouter/llm-stats、独立评测博客）。五维评分为**相对强弱**（●=1~5），非绝对基准分；查不到的明确标注。图像模型不适用五维,单列。

## A 组：已接入网关

### 评分表（●●●●● = 该维度第一梯队）

| 模型 | 综合 | 编码 | 多语言写作 | 结构化输出 | 长上下文 | 价格档($/M in/out) |
|---|---|---|---|---|---|---|
| GLM-5.2 | ●●●●◐ | ●●●●● | ●●●◐(证据少) | ●●●◐(无独立评测) | ●●●●◐ (1M) | 1.20 / 4.10 |
| doubao-seed-2.0-pro | ●●●●◐ | ●●●●◐ | ●●●◐ | ●●●● | ●●●◐(~260K 级) | 0.47 / 2.37 |
| doubao-seed-2.0-lite | ●●●● | ●●●● | ●●● | ●●●◐ | ●●●◐ | 低于 Pro(具体价查不到) |
| doubao-seed-2.0-mini | 独立基准**查不到** | — | — | — | — | 最低档 |
| doubao-seed-2.0-code | ●●●◐ | ●●●●◐ | ●● | ●●●◐ | ●●●◐ (260K) | 0.30 / 1.20 |
| kimi-k2.6 | ●●●●◐ | ●●●●◐ | ●●●●(据 K2.5 翻译 61%=Gemini 3.1 Pro) | ●●●◐ | ●●●◐ (256K) | 0.95 / 4.00 |
| kimi-k2.7-code | ●●●◐ | ●●●●◐(仅自家基准⚠️) | ●●◐ | ●●●◐ | ●●●◐ (256K) | 0.95 / 4.00 (cache hit 0.19) |
| minimax-m2.7 | ●●●◐ | ●●●● | ●●● | ●●●◐ | ●●● | 0.24~0.30 / 0.96~1.20 |
| minimax-m3 | ●●●●◐ | ●●●●◐ | ●●●◐ | ●●●◐ | ●●●●● (1M+MSA) | 0.30 / 1.20 |
| deepseek-v4-flash | ●●●◐ | ●●●● | ●●●◐(中英强) | ●●●◐ | ●●●●◐ (1M) | **0.14 / 0.28** |
| deepseek-v4-pro | ●●●●◐ | ●●●●● | ●●●●(中英最佳性价比) | ●●●● | ●●●●◐ (1M) | 0.435 / 0.87 |

### 关键观察 + 每模型一句话

- **GLM-5.2**（智谱，6/13 发布，753B MoE，MIT，1M ctx）：SWE-bench Pro 62.1 **超 GPT-5.5(58.6)**、Terminal-Bench 2.1 81.0，被多方评为"当前最强开源编码模型"，约 GPT-5.5 成本 1/6。坑：多语言写作与 JSON schema 遵循**无独立评测数据**；营销文风非其宣传强项。→ **一句话：编码/agentic 主力首选，SiteSpec 组装可用但 schema 遵循需自测。**
- **doubao-seed-2.0 系**（字节，2/14 发布）：Pro 对标 GPT-5.2/Gemini 3 Pro（AIME 98.3、SWE-V 76.5、VideoMME 89.5=**多模态强**）；Lite 与 Pro 差距极小（MMLU-Pro 87.7 vs 87.0，可平替日常任务）；Code 与 Pro 同基准但更低价低延迟（LCB v6 87.8）；**Mini 独立基准查不到**，仅定位"高吞吐批处理"。→ **一句话：Pro 做视觉评审/中文综合，Lite 做量大任务，Code 做渲染器代码类，Mini 只配打杂。**
- **kimi-k2.6**（月之暗面，4/20，1T MoE/32B active）：AA Intelligence Index 54=**开源最高**，HLE-with-tools 54.0 领先，agent swarm（300 子代理）适合研究编排；SWE-bench Pro 58.6 持平 GPT-5.5。多语言：前代 K2.5 翻译基准与 Gemini 3.1 Pro 并列 61%（K2.6 本身数据查不到）。→ **一句话：品牌研究综合（多源工具调用+归纳）网关内最佳。**
- **kimi-k2.7-code**（6/12）：自报 Kimi Code Bench v2 +21.8%、推理 token **省 30%**。⚠️ 最大坑：发布时**全部为自家基准，无第三方 SWE-bench/LCB 数据**。→ **一句话：长程编码降本候选，但先小流量验证再提权。**
- **minimax-m2.7**：SWE-Pro 56.22、agentic index 62.1 上游水平；⚠️ **verbosity tax**：AA 评测中输出 token 达同价位中位数 4 倍（87M vs 20M），实际成本远高于标价。→ **一句话：便宜但话痨，批量任务成本会失控，被 M3 全面取代。**
- **minimax-m3**（6/1，428B/23B active，1M ctx，**原生图像+视频输入**）：SWE-Pro 59.0 超 GPT-5.5/Gemini 3.1 Pro，SWE-V 80.5；MSA 稀疏注意力使 1M 长上下文成本约前代 1/20。→ **一句话：网关内唯一"强多模态+1M 长文+便宜"三合一，视觉评审首选。**
- **deepseek-v4**（4/24）：Flash（284B/13B）SWE-V 79% 只要 **$0.14/$0.28=全场最低价**；Pro（1.6T/49B）SWE-V ~80.6 追平 Gemini 3.1 Pro、LCB/Codeforces 领先，输出比 GPT-5.5 便宜 34.5×；独立翻译评测称其**中英互译最佳性价比**。⚠️ 网关注意：本仓网关 reasoner/chat 已别名到 v4-flash，要强档需显式选 v4-pro。→ **一句话：Flash=QA/SEO 等海量便宜活的默认，Pro=高质编码+中英文案的性价比王。**
- **doubao-seedream-5.0**（图像）：Lite（2/13）主打**双语文字渲染**与角色一致性、成本低；Pro（7/8 刚发布）**公开基准尚未放出**。对比评测：布局/风格/事实排版好，但**文字的细粒度准确性输给 GPT Image 2**。→ **一句话：中英双语站图/横幅的低成本产线，含长文字的图交给 gpt-image-2。**

## B 组：待接通道

| 模型 | 综合 | 编码 | 多语言写作 | 结构化输出 | 长上下文 | 价格档($/M in/out) |
|---|---|---|---|---|---|---|
| GPT-5.5 | ●●●●● | ●●●●◐ | ●●●●●(50+语对最稳) | ●●●●●(官方 Structured Outputs) | ●●●●◐ (1M) | 5 / 30 (贵,已被 5.6 分层取代) |
| gemini-3.1-pro | ●●●●● | ●●●● | ●●●●◐ | ●●●●◐ | ●●●●●(MRCR v2@128K 84.9%) | 2.50 / 15 |
| gemini-3-flash | ●●●◐ | ●●●◐ | ●●●● | ●●●●(schema 模式+thinking levels) | ●●●●◐ (1M/65K out) | **0.50 / 3** |
| claude-sonnet-5 | ●●●●● | ●●●●◐ | ●●●●◐(营销语气最佳口碑) | ●●●●●(官方 JSON schema) | ●●●●◐ (1M/128K out) | 介绍价 2/10→8 月底后 3/15 |
| gpt-image-2 | 图像 | — | 五种非拉丁文字~95% | — | — | ~$0.006-0.211/张(1024²) |

- **GPT-5.5**（4/23，$5/$30，1M ctx）：Terminal-Bench 82.7，长文档/工具调用/结构化输出/代码"均衡无短板"；但**价格翻倍**且 6~7 月已被 **GPT-5.6 三档**（Sol 5/30、Terra 2.5/15、Luna 1/6，7/9 GA）取代。→ **一句话：别接 5.5，直接接 5.6 Terra/Luna 拿同能力更低价。**
- **gemini-3.1-pro**：推理均分 77.1 顶级，MRCR v2 128K 84.9% =**长文档检索王**，多语种覆盖广；坑：~80 tok/s 慢、32K 输出上限、且 3.5 Flash 已在 8 项基准（含 SWE-Pro）反超它。→ **一句话：超长品牌资料/竞品文档吃进去做研究综合的封顶选项。**
- **gemini-3-flash**：$0.50/$3、1M ctx、65K 输出、AA Index 38（同档平均 29），带 schema 结构化输出与可调 thinking。注意 Google 已推 3.5 Flash（1.50/9，289 tok/s）作为新甜点位。→ **一句话：待接通道里最便宜的"够用型"全能副手，适合 QA-SEO 汇总。**
- **claude-sonnet-5**（6/30，Anthropic 官方）：agentic coding 63.2%（>前代 58.1，逼近 Opus 4.8 的 69.2），**GDPval-AA v2 知识工作 1618 反超 Opus 4.8**；1M ctx/128K 输出/2576px 视觉/官方 JSON schema；独立翻译评测口碑：Claude 系在**营销/语气敏感翻译**上最强。→ **一句话：多语种 B2B 文案+SiteSpec 组装的质量封顶位，介绍价窗口（8/31 前 $2/$10）值得尽快接。**
- **gpt-image-2**（4 月）：**AA Image Arena Elo 1339 第一**，文内文字渲染约 95%（含五种非拉丁文字，CJK 近乎完美），原生 2K、连续宽高比；坑：token 计价复杂（image out $30/M）、高清单张可到 $0.4。→ **一句话：带文字的营销图/OG 图/多语横幅的质量封顶位，与 seedream 5.0 组成"贵精/便宜快"双轨。**

## 任务 × 推荐模型（外部证据版）

| Site Builder 任务 | 首选(证据) | 备选/降本 | 待接通道升级位 |
|---|---|---|---|
| 品牌研究综合(多源抓取+归纳) | **kimi-k2.6**(HLE-tools 54.0、agent swarm、AA 开源第一) | deepseek-v4-pro(1M ctx 便宜) | gemini-3.1-pro(MRCR 长文王)、claude-sonnet-5 |
| 多语种 B2B 文案 | **deepseek-v4-pro**(中英最佳性价比) + kimi-k2.6(翻译 61%=Gemini 3.1 Pro) | seed-2.0-pro(中文语感) | **claude-sonnet-5**(营销语气口碑第一)、GPT-5.6 Terra(语对覆盖最广) |
| SiteSpec 结构化组装(JSON/schema) | **glm-5.2**(编码第一但 schema 遵循需自测) / seed-2.0-pro | deepseek-v4-pro | **claude-sonnet-5 / GPT-5.6**(唯二有官方 Structured Outputs 强保证) |
| 渲染器/模板代码生成 | **glm-5.2**(SWE-Pro 62.1) | seed-2.0-code($0.30 最便宜前沿编码)、k2.7-code(省 30% token,先验证) | claude-sonnet-5 |
| QA-SEO 汇总(海量便宜) | **deepseek-v4-flash**($0.14/$0.28,SWE-V 79%) | seed-2.0-lite、minimax-m3 | gemini-3-flash |
| 视觉评审(截图/页面多模态) | **minimax-m3**(网关内唯一原生图像+视频+1M) | seed-2.0-pro(VideoMME 89.5) | claude-sonnet-5(2576px)、gemini-3.1-pro |
| 站点配图/横幅生成 | **seedream-5.0**(双语文字渲染、低成本;Pro 基准未出) | — | **gpt-image-2**(文字渲染 Elo 第一,含长文字图必用) |

**查不到/不确定项（勿当已知）**：seed-2.0-mini 独立基准、seed-2.0 全系精确上下文窗口与 Lite/Mini 官方 API 价、GLM-5.2/kimi/minimax/deepseek 的 **JSON-schema 遵循率独立评测**（均缺，国产系只有 OpenAI 兼容 API 的"支持"声明）、kimi-k2.6 本代多语言写作独立数据、seedream-5.0-pro 公开基准、minimax 系上下文窗口精确值。**横向锚点**：LMArena 2026-07 总榜 Claude Opus 4.6 Thinking 1501 Elo 居首，四大闭源厂在噪声区间内并列；开源最高 AA Index = kimi-k2.6(54)，与闭源旗舰差 3 分。

**信源**：[GLM-5.2 (eigent)](https://www.eigent.ai/blog/glm-5-2) · [GLM-5.2 benchmarks (technology.org)](https://www.technology.org/2026/07/02/glm-5-2-coding-how-good-is-it-really-2026-benchmarks/) · [Seed 2.0 (TechNode)](https://technode.com/2026/02/14/bytedance-releases-doubao-seed-2-0-positions-pro-model-against-gpt-5-2-and-gemini-3-pro/) · [Seed 2.0 Pro/Lite/Mini 对比 (Apiyi)](https://help.apiyi.com/en/seed-2-0-pro-lite-mini-model-comparison-en.html) · [Seed 2.0 Code (TokenMix)](https://tokenmix.ai/blog/doubao-seed-2-0-code-review-2026) · [Kimi K2.6 (miraflow)](https://miraflow.ai/blog/kimi-k2-6-explained-moonshot-ai-open-source-model-ties-gpt-5-5-coding) · [K2.7-Code (MarkTechPost)](https://www.marktechpost.com/2026/06/12/moonshot-ai-releases-kimi-k2-7-code-a-coding-model-reporting-21-8-on-kimi-code-bench-v2-over-k2-6/) · [K2.7-Code token 效率 (DevOps.com)](https://devops.com/moonshot-ais-kimi-k2-7-code-targets-token-efficiency-in-agentic-coding/) · [MiniMax M3 (VentureBeat)](https://venturebeat.com/technology/minimax-m3-debuts-eclipsing-gpt-5-5-and-gemini-3-1-pro-on-key-benchmark-performance-for-just-5-10-of-the-cost) · [M2.7 verbosity (Thomas Wiegold)](https://thomas-wiegold.com/blog/minimax-m-2-7-review-is-it-worth-the-hype/) · [DeepSeek V4 (morphllm)](https://www.morphllm.com/deepseek-v4) · [V4 Flash (Artificial Analysis)](https://artificialanalysis.ai/models/deepseek-v4-flash) · [Seedream 5.0 vs GPT Image 2 (Atlas Cloud)](https://www.atlascloud.ai/blog/guides/2026-ai-image-api-benchmark-gpt-image-2-vs-nano-banana-2-pro-vs-seedream-5-0) · [Seedream 5.0 Lite (Bytedance Seed)](https://seed.bytedance.com/en/seedream5_0_lite) · [GPT-5.5 定价 (aipricecompare)](https://aipricecompare.org/models/gpt-5-5.html) · [GPT-5.6 分层 (finout)](https://www.finout.io/blog/gpt-5.6-pricing-2026-sol-terra-and-luna-tiers-explained) · [Gemini 3.1 Pro vs 3.5 Flash (BenchLM)](https://benchlm.ai/compare/gemini-3-1-pro-vs-gemini-3-5-flash) · [Gemini 3 Flash (llm-stats)](https://llm-stats.com/models/gemini-3-flash-preview) · [Claude Sonnet 5 (Anthropic 官方)](https://www.anthropic.com/news/claude-sonnet-5) · [Sonnet 5 对比 (MarkTechPost)](https://www.marktechpost.com/2026/07/13/anthropic-claude-sonnet-5-vs-sonnet-4-6-vs-opus-4-8-agentic-coding-benchmarks-api-pricing-and-cost-performance-tradeoffs-compared/) · [GPT Image 2 (Apiyi)](https://help.apiyi.com/en/gpt-image-2-official-launch-beginner-complete-guide-en.html) · [翻译评测 (Lokalise)](https://lokalise.com/blog/what-is-the-best-llm-for-translation/) · [翻译评测 (hakunamatata)](https://www.hakunamatatatech.com/our-resources/blog/best-llm-for-translation) · [LMArena 2026-07 (Swfte)](https://www.swfte.com/ai/leaderboard)

---

# 附录 B：形状 1 组装实测

# 形状 1 评测报告：SiteSpec 结构化组装（siteAssembly/assemblyFix）

**设置**：统一 prompt（3 组件契约 + 泵业公司事实 → 纯 JSON SiteSpec），每模型 2 次，temperature=0，max_tokens=4000，超时 90s，走本地 new-api 网关。Python 确定性判分（10 分 = 解析 2 + 类型白名单 2 + 字段严格 3 + 首块 Hero/恰一 CTA 2 + i18n key 风格 1）。基础轮 12/12 全满分出现天花板，追加**加压轮**（同契约 + 4 页面 + 干扰项：口号诱导直写文案、6 产品线 vs items≤4 冲突、客户备注诱导 style 字段和每页 CTA）。原始输出当时位于旧 Mac 临时 `scratchpad/shape1_out/`，已随临时目录清理，不是当前可执行证据。

## 评分表

| 模型 | 基础轮 (r1/r2) | 加压轮 (r1/r2) | 综合(4 run 均分) | 延迟 基础轮 | 延迟 加压轮 | 加压 completion tokens |
|---|---|---|---|---|---|---|
| **deepseek-v4-pro** | 10 / 10 | **10 / 10** | **10.0** | 10.2s / 7.4s | 28.5s / 33.9s | 1663 / 2094 |
| doubao-seed-2.0-code | 10 / 10 | 9.57 / 10 | 9.89 | 8.5s / 9.9s | **10.9s / 12.5s** | **494 / 561** |
| doubao-seed-2.0-pro | 10 / 10 | 10 / 10 | 10.0 | 28.5s / 17.1s | 62.2s / 68.3s | 4990 / 4819 |
| kimi-k2.7-code | 10 / 10 | 10 / 10 | 10.0 | 43.7s / 17.7s | ⚠️ 90.0s / 76.8s | 3391 / 2825 |
| glm-5.2 | 10 / 10 | ❌ 0(超时) / 10 | 7.5 | 26.3s / 20.9s | >90s / 47.7s | — / 2702 |
| minimax-m3 | 10 / 10 | ❌ 0(空串) / 10 | 7.5 | 16.5s / 8.8s | 38.3s / 33.5s | 4000(耗尽) / 3415 |

## 典型失败样例（截断 100 字）

- **doubao-seed-2.0-code** r1：`{"type": "ProductGrid", "titleKey": "products.grid.title", "items": [{"nameKey": "products.grid.it…` —— 被「销售总监要求 6 条产品线全展示」带偏，单 grid 塞 6 items 违反 2-4 上限（其余 5 模型均正确拆成 3+3 或 4+2 双 grid）
- **glm-5.2** r1：`timed out` —— 90s 无返回，r2 也要 47.7s，加压下延迟极不稳定
- **minimax-m3** r1：`finish_reason=length, content=""` —— 推理 15966 字符吃光全部 4000 max_tokens，**正文一个字没出**；对 reasoning 模型这是最危险的静默失败模式

## 关键观察

1. **陷阱全员抗住的**：style 字段诱导、口号直写文案、每页放 CTA——12 个加压 run 无一违反（恰一 CtaBanner、无契约外字段全对）。分化点全在**数量约束冲突**（6 产品 vs items≤4）、**延迟稳定性**、**token 预算管理**。
2. **deepseek-v4-pro 跨 run 结构完全一致**（两次都是 products 页 3+3 双 grid 同构输出），确定性最强，适合 assemblyFix 这种要可复现的场景。
3. **doubao-seed-2.0-code 几乎不推理**（reasoning 仅 70-543 字符），因此快 3-6 倍、token 省 4-9 倍，但换来 1/4 概率的 schema 违规——配 ajv 校验 + 违规重试的管线可用，裸用不行。
4. **max_tokens=4000 对 minimax-m3 / doubao-seed-2.0-pro 不够安全**：前者已翻车，后者 4990 tokens 贴着上限。选它们必须给 ≥8000 或走思考预算控制。
5. 全部 12+12 run 均直接 `JSON.parse` 通过（无一带 markdown 围栏），「纯 JSON」指令遵从率 100%（有产出的 run 中）。

## 每模型一句话结论

- **deepseek-v4-pro**：两轮全满分 + 输出跨 run 同构 + 延迟中等可控（≤34s）——**siteAssembly 主选**。
- **doubao-seed-2.0-code**：最快最便宜（~11s / ~500 tok）但加压下 1/4 违规——**降级快路/重试候补**，必须配 schema 校验兜底。
- **doubao-seed-2.0-pro**：质量满分但 62-68s + ~5000 tok，贵且慢，被 deepseek-v4-pro 全面压制——不选。
- **kimi-k2.7-code**：质量满分但加压延迟 77-90s 贴超时线——批处理可用，交互式管线不可用。
- **glm-5.2**：加压轮 50% 超时率，延迟方差过大——不选。
- **minimax-m3**：思考失控吃光预算输出空串（静默失败）——除非上调 max_tokens≥8000 并实测，否则不选。

**选型建议**：siteAssembly/assemblyFix 主模型 **deepseek-v4-pro**（max_tokens 给 4000 即可），fallback/低成本批量档 **doubao-seed-2.0-code**（管线必须带 SiteSpec ajv 校验 + 违规自动重试，重试一次后仍违规再升级到主模型）。

---

# 附录 C：形状 2 文案实测

# 形状 2 评测报告：多语种 B2B 文案（copy）

**设置**：统一 prompt（Acme Pump / 离心泵+螺杆泵 / 目标市场 DE / 无认证无年限），要求 en+de 双语 JSON（headline≤70 / subhead≤160 / aboutBody≤420 字符），零虚构、禁绝对化、de 须原生。每模型 1 次有效调用，`max_tokens≥2500`、超时 90s，python 确定性判分 + 人工德语定性。

## 评分表

| 模型 | ①JSON+槽位 | ②长度约束(6槽) | ③零虚构(regex+定性) | ④绝对化 | ⑤de原生度(1-5) | ⑥延迟(端到端) | 综合(0-10) |
|---|---|---|---|---|---|---|---|
| **glm-5.2** | ✅ | **6/6 全过** | ✅ / "fertigt"(制造)轻度角色假设 | ✅ 0 命中 | 3.5（语域最地道但核心术语拼错） | 47.5s，reasoning_tokens=0 | **8.5** |
| **doubao-seed-2.0-pro** | ✅ | 5/6（de.headline 74>70） | ✅ / 最克制，全程贴 factSheet | ✅ 0 命中 | 3.0（语法对但翻译腔+术语偏） | 46.7s（reasoning 3459 tok） | **8.0** |
| **deepseek-v4-pro** | ✅（须 `reasoning_effort:"low"`） | **3/6**（en.subhead 171、de.subhead 206、de.aboutBody 440 全超） | regex ✅ / 定性软虚构：自加行业场景（Fertigung/Verfahrenstechnik/Wasseraufbereitung）+ 技术支持承诺，均不在 factSheet | ✅ 0 命中 | **4.5（最佳）** | 39.7s（默认参数下不可用，见下） | **6.5** |
| **kimi-k2.6** | ❌ 超时 | — | — | — | — | >90s 硬超 | **0（此形状不可用）** |
| **minimax-m2.7** | ❌ 超时 | — | — | — | — | >90s 硬超 | **0（此形状不可用）** |

## 关键观察

1. **reasoning 预算是本形状第一杀手**：deepseek-v4-pro / kimi-k2.6 / minimax-m2.7 在 max_tokens=3000 时把 **100% token 烧在 reasoning**（content 空、finish=length）。提到 8000 后 deepseek 仍烧 8000 全 reasoning；只有加 `reasoning_effort:"low"` 才出正文（39.7s）。**kimi/minimax 无视该参数**——stream 诊断实测 90s 墙钟内 kimi 吐 11k 字符、minimax 吐 20k 字符纯 reasoning，**正文一个字没开始**。生产上 copy 任务若限 90s，这两个直接出局。
2. **glm-5.2 是唯一"零 reasoning 开销"选手**（reasoning_tokens=0，completion 仅 2374），约束遵循满分（6 槽长度全过、零虚构、零绝对化）——最像"听话的产线模型"。
3. **德语质量与约束遵循呈反向**：deepseek 德语最原生（Kreiselpumpen/Schraubenpumpen 术语双对、"überzeugen durch Langlebigkeit und Betriebssicherheit"、"Entdecken Sie unser Programm" 是真行业语域），但 3/6 槽超长 + 软虚构行业清单。glm 语域同样地道（"robuste Fördertechnik"、"auf die technischen Spezifikationen Ihrer Anlagen ausgelegt"）但把螺杆泵拼成 **"Schraubenspumpen"（多个 s，连错 3 处含 headline）**，德国买家一眼见拼写错。doubao 语法干净但翻译腔明显：**"Zentrifugalpumpen"**（英语直译，行业标准词是 Kreiselpumpe）、"Transfer großer Fluidmengen"、"Pumpenlinien"（英语 product lines 直搬）；且 "Schneckenpumpen" 实指偏心螺杆/蜗形泵，术语漂移。
4. **虚构与绝对化护栏三家全过 regex 扫描**（无年限/ISO/CE/数字客户），说明 prompt 红线可被遵守；唯一定性风险是 deepseek 的"行业应用清单"式软虚构——工厂化生成时需 factSheet 白名单后校验。
5. doubao 上游对 max_tokens 语义宽松（请求 3000 实回 3685 完成 stop），网关层预算控制不能只信 max_tokens。

## 每模型一句话结论

- **glm-5.2**：copy 形状首选——零 reasoning 税、约束全过、语域地道，唯需下游德语拼写校验兜底（Schraubenspumpen 类错误）。
- **doubao-seed-2.0-pro**：可靠备胎——最守事实、约束近全过，但德语翻译腔和术语漂移使其 de 文案发布前需人审/术语表约束。
- **deepseek-v4-pro**：德语质量天花板但工程成本高——必须带 `reasoning_effort:"low"` 护栏，且长度超限+软虚构需强后校验，适合"生成后裁剪"管线而非直出。
- **kimi-k2.6**：90s 内纯 reasoning 不出正文且无视 effort 参数，此任务形状直接淘汰。
- **minimax-m2.7**：同 kimi，90s 烧 20k 字符 reasoning 零正文，淘汰。

**选型建议**：copy 主力 = **glm-5.2**，回退 = **doubao-seed-2.0-pro**；deepseek-v4-pro 仅在"高价值页面 + 有裁剪/校验后处理"时作精修档。原始数据与判分脚本当时位于旧 Mac 临时 `scratchpad/copy_eval/`，已清理；只保留本文结论作为 dated evidence。

---

# 附录 D：形状 3 品牌综合实测

# 形状 3：品牌研究综合（brandProfile）评测报告

**设定**：统一中文 prompt，4 段模拟源材料（intake 注册信息 / upload 画册 / web_research **竞品**页含 ISO9001 / storefront 店铺页），要求输出 BrandBrief JSON；max_tokens=4000，temp=0.2，每模型 1 次，端到端计时；判分 = python 脚本（schema 校验 + quote 逐字子串比对 + 陷阱词扫描含 valueProps/tone 二次核）+ 人工核 gaps 与粒度。原始输出与判分脚本当时位于旧 Mac 临时 `scratchpad/shape3_*`，已清理，不可按路径复现。

## 评分表（满分 100 = schema 25 / 证据真实性 30 / 🔴竞品陷阱 25 / gaps 15 / 延迟 5）

| 模型 | schema | 证据真实性（exact 子串） | 🔴 竞品 ISO9001 陷阱 | gaps 质量 | 延迟 | 总分 |
|---|---|---|---|---|---|---|
| **minimax-m3** | 25 (PASS) | 30 (10/10 exact) | 25 (未踩，认证列入 gaps) | 15 (14 条最全：认证/视觉资产/联系方式/差异化) | 5 (31.8s) | **100** |
| **deepseek-v4-pro** | 25 (PASS) | 30 (6/6 exact) | 25 (未踩，"无 ISO9001…认证信息"入 gaps) | 14 (6 条，切中要害但未点名竞品) | 5 (31.7s) | **99** |
| **glm-5.2** | 25 (PASS) | 30 (5/5 exact) | 25 (未踩+**主动消歧**："ISO9001…属于上海佳业泵业，与目标公司无关") | 15 (11 条，建站视角最贴) | 4 (47.2s) | **99** |
| **kimi-k2.6** | 25 (PASS)* | 30 (6/6 exact) | 25 (未踩+主动消歧："源材料 3 为上海佳业泵业信息，不可混用") | 15 (7 条精准) | 2 (76.8s) | **97** |
| **doubao-seed-2.0-pro** | 25 (PASS)† | 30 (3/3 exact) | 25 (未踩，但 gaps 仅泛称"行业体系认证"未点 ISO) | 12 (6 条偏品牌咨询套话) | 4 (43.9s) | **96** |

\* kimi 的 tone 字段输出英文（"Professional / Reliable…"），中文管线小瑕疵，未扣 schema 分。
† doubao schema 合规但**事实粒度最粗**：仅 3 条 factSheet，一条 claim 打包多事实、quote 是整句搬运——下游按 claim 做证据溯源/选择性渲染时可用性最差。

## 关键观察

1. **本形状没有拉开正确性差距**：5 模型合计 30 条 quote 全部逐字命中源材料（0 虚构），竞品 ISO9001 陷阱 0/5 踩（含对 valueProps/tone 的二次扫描）。带明确规则+带标注源的输入下，这批 reasoning 模型的 grounding 都可靠；**区分维度落在延迟、粒度、gaps 深度、token 经济**。
2. **陷阱处理分两档**：glm-5.2 / kimi-k2.6 走「主动消歧」（在 gaps 里点名 ISO9001 属上海佳业泵业）——对需要审计留痕的合规场景更有价值；deepseek / minimax 走「正确忽略+把认证列为缺口」——恰好符合 prompt 规则；doubao 最弱（只泛称"体系认证"，丢失了"竞品有而我没有"这一竞争情报）。
3. **粒度谱系**：minimax 10 条原子事实 > deepseek/kimi 6 条 > glm 5 条 > doubao 3 条打包。原子化程度直接决定 brandProfile 下游（分区块渲染、事实级增量更新）可用性。
4. **token 经济**：deepseek 最省（completion 1911，reasoning 占 1365）；doubao 最亏——completion 3503 中 **83% 是 reasoning**（2902），产出反而最粗；minimax completion 3590 但换来最全产出。
5. **延迟风险**：kimi-k2.6 76.8s 已逼近 90s 超时预算，生产上遇长材料大概率超时，若选用需放宽超时或降级路径。

## 每模型一句话结论

- **minimax-m3**：本形状最优——最快档 31.8s + 10 条原子事实 + 14 条 gaps 最全，全部硬规则零失误，**首选**。
- **deepseek-v4-pro**：与 minimax 并列第一档——同速、全对、输出最精炼最省 token，追求成本/延迟稳定时的**等价首选**。
- **glm-5.2**：质量同档且唯二做出竞品主动消歧（审计留痕最佳），延迟中等，**强备选**。
- **kimi-k2.6**：内容质量同档+主动消歧，但 76.8s 贴着超时线且 tone 漏英文，只宜做非默认备选。
- **doubao-seed-2.0-pro**：合规但粒度最粗、83% token 花在推理产出反而最少，本形状**不推荐**。
