# 10 · M1 模型选型研究（外部研究 + 网关活模型真实评测）

> 2026-07-14。方法：①外部信源研究（官方发布/榜单/独立评测，禁编造分数）②三个 M1 任务形状在本地 new-api 网关上对活模型**真实调用评测**（确定性 python 判分 + 延迟实测）。结论用于 09 施工图 §3 路由表；换档（通道接入）时用同套题复测对比。

## 0. 结论：按任务路由（实测+外部证据合成）

| M1 任务 | 现在主力（实测背书） | 回退/降本 | 通道接入后升级位（外部证据） |
|---|---|---|---|
| brandProfile 研究综合 | **deepseek-v4-pro**（99/100，最省 token）或 **minimax-m3**（100/100，粒度最细） | glm-5.2（唯二主动消歧竞品认证，审计留痕最佳） | gemini-3.1-pro（MRCR 长文档王）/ claude-sonnet-5 |
| copy 多语种文案 | **deepseek-v4-pro**（用户 7/14 终版拍板；评测德语原生度 4.5 全场最佳；🔴 工程护栏必配：`reasoning_effort:"low"` + 长度超限自动裁剪重写 + factSheet 白名单后校验） | glm-5.2（约束遵循最佳零 reasoning 税）→ doubao-seed-2.0-pro | GPT-5.6 Luna / gemini-3.1-pro（claude-sonnet-5 仍是营销语气口碑第一，8/31 前介绍价） |
| siteAssembly / assemblyFix | **glm-5.2**（用户 7/14 拍板；应答质量满分，弱点=延迟尾部→超时预算 180s）→ 超时/校验违规**自动回退 deepseek-v4-pro**（加压全满分+跨 run 同构） | doubao-seed-2.0-code（快 3-6×省 4-9×，1/4 违规须配校验+重试升级链） | claude-sonnet-5 / GPT-5.6（唯二官方 Structured Outputs） |
| qa / seo 汇总 | **deepseek-v4-flash**（$0.14/$0.28 全场最低） | doubao-seed-2.0-lite | gemini-3-flash |
| designSpec / 审美视觉评审 | **minimax-m3**（网关内唯一原生图像输入——P4 审美维可能不必等 Google，待 M1-f 真探图像输入经 plan 端点是否可用） | doubao-seed-2.0-pro（VideoMME 89.5） | gemini-3.1-pro / claude-sonnet-5 |
| 图像生成/编辑 | **seedream-5.0-lite**（已接通实测出图；用户已定暂用） | — | **gpt-image-2**（文字渲染 Elo 第一；含长文字图必用；与 seedream 组"贵精/便宜快"双轨） |
| video（M3） | — | — | Seedance 直连方案 B（key 已在手） |

**与用户 7/14 调整表的对齐记录**：①组装维持用户拍板的 **glm-5.2 主选**——初版评测 90s 内 50% 超时是评测口径非生产约束（Temporal 预算 10min），生产给 180s + 三重门校验 + 超时/违规自动回退 deepseek-v4-pro；M1-g golden set 按生产口径双模型对比终审。**架构澄清（D1）**：组装 agent 不写前端代码——组件库是仓内手写 Astro，agent 只产 SiteSpec JSON，该任务考 schema 纪律非编码力；将来真出现代码生成任务（M2+ 自定义组件）glm-5.2 是无争议首选。②GLM-5.2 同时是 **copy 主选**（唯一零 reasoning 开销、约束全过）。③GPT-5.5 已被 GPT-5.6 三档取代（Terra $2.5/$15 同能力更便宜）——接 OpenAI 通道建议直接 5.6。④用户档位后期升 **Large**（seedance 解锁，供 M3 视频）。⑤用户 7/14 终版第三轮调整：**copy 主力对调为 deepseek-v4-pro**（glm-5.2 转回退）；各任务升级位统一指向 **GPT-5.6 Terra/Luna + gemini-3.1-pro**（组装升级 Terra、copy 升级 Luna、研究/视觉/qa 升级 gemini-3.1 系）。

## 0.1 评测暴露的工程硬教训（M1-b AiTask 基类必须内建）

1. 🔴 **reasoning 预算是头号杀手**：minimax-m3 在 max_tokens=4000 下推理吃光预算、`content=""` 静默失败；kimi/minimax 在 copy 形状 90s 纯推理零正文且**无视 reasoning_effort 参数**；deepseek 须 `reasoning_effort:"low"` 才出 copy 正文。→ AiTask 基类：按任务配 maxTokens+effort；`finish_reason=length && content 空` 判定为显式失败（换预算/换模型重试），绝不静默。
2. doubao 对 max_tokens 语义宽松（请求 3000 实回 3685）→ 预算控制不能只信请求参数，settle 按实际用量记账。
3. 全部模型「纯 JSON」指令遵从 100%（有产出的 run），但数量约束冲突（6 产品 vs items≤4）仍会击穿快档模型 → 校验器+重试升级链是结构性必需，非可选。
4. glm 德语拼写错（Schraubenspumpen×3）、doubao 翻译腔（Zentrifugalpumpen≠行业词 Kreiselpumpe）→ copy 管线的 glossary 强一致 + 拼写校验是硬需求（04 设计已含 glossary，M1-d 补拼写檢查）。

---


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

**设置**：统一 prompt（3 组件契约 + 泵业公司事实 → 纯 JSON SiteSpec），每模型 2 次，temperature=0，max_tokens=4000，超时 90s，走本地 new-api 网关。Python 确定性判分（10 分 = 解析 2 + 类型白名单 2 + 字段严格 3 + 首块 Hero/恰一 CTA 2 + i18n key 风格 1）。基础轮 12/12 全满分出现天花板，追加**加压轮**（同契约 + 4 页面 + 干扰项：口号诱导直写文案、6 产品线 vs items≤4 冲突、客户备注诱导 style 字段和每页 CTA）。原始输出：`/private/tmp/claude-501/-Users-xin-Documents-Global/43c9deda-5f28-41bd-a6f9-6b55b9e734c7/scratchpad/shape1_out/`

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

**选型建议**：copy 主力 = **glm-5.2**，回退 = **doubao-seed-2.0-pro**；deepseek-v4-pro 仅在"高价值页面 + 有裁剪/校验后处理"时作精修档。原始数据与判分脚本：`/private/tmp/claude-501/-Users-xin-Documents-Global/43c9deda-5f28-41bd-a6f9-6b55b9e734c7/scratchpad/copy_eval/`（`run_copy_eval.py`、`copy_eval_raw*.json`）。

---

# 附录 D：形状 3 品牌综合实测

# 形状 3：品牌研究综合（brandProfile）评测报告

**设定**：统一中文 prompt，4 段模拟源材料（intake 注册信息 / upload 画册 / web_research **竞品**页含 ISO9001 / storefront 店铺页），要求输出 BrandBrief JSON；max_tokens=4000，temp=0.2，每模型 1 次，端到端计时；判分 = python 脚本（schema 校验 + quote 逐字子串比对 + 陷阱词扫描含 valueProps/tone 二次核）+ 人工核 gaps 与粒度。原始输出与判分脚本在 `/private/tmp/claude-501/-Users-xin-Documents-Global/43c9deda-5f28-41bd-a6f9-6b55b9e734c7/scratchpad/shape3_*.json|*.py`。

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