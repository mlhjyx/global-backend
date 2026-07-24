# 评测与测试策略 v1（活文档，分阶段实施）

> 文档 ID：`SITE-EVAL-001`
> 生命周期：`CURRENT`
> 当前事实来源：资格证据、Golden 资产与 [状态](../status/current.md)。
> 落实 [02 §11.8](02-architecture.md)（eval harness）+ 仓库 TDD 硬规矩。两层质量体系：**运行期质量环**（每次 refurbish build 内的确定性 QA/SEO/a11y/genericness 与 capability-gated 审美评审，02 §4 P4，M1-f 已落）管"这一站好不好"；**离线评测基线**（本文件）管"整条管线有没有随改动退化"。借鉴 Mastra"evals 一等公民"思想（03 §10.5）。
>
> **as-built vs target**：`task-routes.ts` 已登记 7 个 AI Task；只有 BrandProfile 已完成 MODEL-1 task-shaped 晋级。M1-d 已为现役 `copy` route 接入真实 workflow 消费者、immutable snapshot/slot gate、空 snapshot 中性路径与 en/de-DE/RTL renderer 测试，但**带 approved Claim 的 de-DE 模型质量尚无独立晋级报告**。M1-e-B 已使 design/assemble 成为真实受控消费者，但其 402 后确定性降级不构成模型成功证据。M1-f 已落确定性 P4 与 closed repair；Gemini task-shaped 矩阵超时，因此审美状态只能明确为 unavailable，未晋级、不得冒充模型成功。55 型均为 `m1_e_a_qualified`，不是蒸馏产物状态。
>
> 模型档相关一律遵 **ADR-016**（ModelProfile 四态路由：`currentRoute`/`evaluatedCandidate`/`targetCandidate`/`promotedRoute` + `deterministicFallback`）；deepseek 只用显式 `v4-pro`/`v4-flash`（`chat`/`reasoner` 别名官方 2026-07-24 关停）。

## 0. 定位与两层质量体系

**质量闭环落在三个构建位置**（v3.2 §0.2 回写），本文的离线评测为这三处提供回归基线：

| 位置 | 当前痛点 | 质量环内容 | 状态 |
|---|---|---|---|
| Demo v0 | 兼容 1.0 路径 | 固定确定性 spec；不继承受控 1.1 结论 | as-built compatibility |
| M1-e | 六 Family 的受控整站组装 | DesignBrief、Blueprint、内容预算、四层 validator、12 个 sparse/rich Golden 与 36 张三断点整站快照 | 已完成（M1-e-A/B） |
| M1-f | 每个候选必须先过发布前质量门 | 三断点截图 + 确定性 QA/SEO/a11y/genericness + capability-gated 审美评审 + round 0 后最多三次闭合修补 | 已完成；审美 unavailable、未晋级 |

**生成与评审分离三原则**（v3.2 §14.1 回写，评测公信力地基）：

1. 生成角色**不能给自己的产物打最终分**。
2. 评审提示词**不能含诱导**（如"这是 Readdy 风格应高分"）；不得让评审看到期望标签。
3. **确定性工具结果优先于模型主观判断**——能机器判的绝不交给模型。

## 1. 分阶段 Golden Set（评测集）

评测集**分阶段建设、累积增长**，不是一次性验收表演；每一阶段只声称它能诚实证明的范围（v3.2 §1.5/§27 回写：完整 shadow/canary、30×3、5 人盲测判为 YAGNI → 6 样本启动，真实流量后再扩）。

### 1.1 Bootstrap：6 个现在可执行的 fixture

3 个行业 × sparse/rich（v3.2 §27.1）：

- **industrial pump**：检验技术规格、询盘 CTA 与工业视觉。
- **auto parts**：检验产品矩阵、兼容/型号事实与测试分支成果。
- **lab / medical instrument**：检验高信任、合规措辞与信息密度。

约束：至少 1 个 fixture 覆盖 **EU 目标市场**；另建 1 个**不计审美胜率的 ar/RTL 合同 smoke fixture**（考组件库 RTL 承载）。`sparse` = 只有公司名/主营/国家/联系方式；`rich` = 含批准产品/图片/地址/证据素材。

作用 = 尽快发现**结构、事实、响应式与"没效果"问题**；**不**用于宣称统计显著、永久终选或跨行业胜率。

**当前 as-built 的最小子集**：6 个 `brand-profile` fixture 已提交在 `apps/api/test/fixtures/golden-companies/brand-profile/`，均为无个人数据的合成文本资料，且至少包含一个 EU 目标市场 rich 样本。它们可用生产 BrandProfile AiTask 与证据门执行模型候选评测；每个候选先经过真实结构化能力 probe，probe 与每个 fixture attempt 均继承该 Task 路由的 `timeoutMs`，而不是套一个全局秒数；失败即记录并跳过整个 fixture 矩阵。最终 JSON 报告只在完整矩阵结束后生成，避免半途结果被误用；运行中的每个 probe/fixture 会以 JSON Lines 写入 stderr，供操作员确认仍有进展。**传输协议也是候选契约的一部分**：2026-07-18（Asia/Shanghai；UTC 日期为 2026-07-17）真网关对照已证明 Terra 的 `chat/completions` 会间歇给出 200/`stop`/role-only 空正文，而同一任务通过 `responses` 有可解析嵌套正文；Sonnet 的原生 `messages` 同样可返回 text（thinking 块不进入产物）。因此报告逐 probe/run 固定 transport；只允许已实测的 `gpt-5.6-terra → openai-responses`、`claude-sonnet-5 → anthropic-messages` 进入本次评测，未登记模型仍默认 OpenAI Chat。#147 只建立协议/评测证据、未启用生产；#148 才把同一已验证映射注入 production provider，并仅晋级 BrandProfile。BrandProfile 当前没有 locale 输入，故该样本**不**构成 de-DE 本地化验证。桌面/移动截图、视觉偏好、RTL smoke 以及其余 AI Task 的 fixture 仍是后续消费者出现后的工作，不能由这 6 个文本 fixture 冒充覆盖。

**2026-07-19 BrandProfile MODEL-1 fast-follow 晋级记录（代码级，非生产部署声明）**：active evidence id=`model1-brand-profile-20260719-v20`。同一 final-code/source bundle（起止 SHA-256 均为 `32c208972e999e0a382ee1cd307a06fc45505565d17066720ff513adea6f745b`）下，候选 [candidate-report.json](../evidence/model-routing/model1-brand-profile-20260719-v20/candidate-report.json) SHA-256=`76f30d38dc958e777b036a29f430963d185399b761e7de5d63f7189b303bad60`、167689 字节的 legacy route 基线 [current-route-baseline-report.json](../evidence/model-routing/model1-brand-profile-20260719-v20/current-route-baseline-report.json) SHA-256=`3aa408b68978779b4a81f3696f68c761adca453e5fafa9d513bf128d41b2d69b`；候选文件为 281456 字节，报告 schema=`site-builder-model1-brand-profile-report/v5`。候选矩阵 **24/24 accepted、0 hard failure**：Terra/Responses 12/12（P95 57,449ms）与 Sonnet/Messages 12/12（P95 59,082ms）；每次正文均由 new-api upstream response 精确证明 requested=reported=resolved。legacy DeepSeek Pro→GLM 路由基线 **12/12 accepted、0 hard failure**（P95 123,099ms）：两成员 probe 均通过，12 次正文全由 DeepSeek Pro/Chat 完成，fallback 0 次；因此这里比较的是完整 legacy route，不把 GLM 冒充为已执行正文。

旧证据不覆盖也不回写：`20260718-v2` 的 attempt 1–11 均是不完整失败矩阵，attempt 12 是 24 次调用完成但仅 **23/24 accepted**；最后一个 Sonnet `lab-instrument-sparse` 因 valueProps/roleLabel 被拒，随后三次定点诊断虽通过但未捕获该次失败原文，故不得据此猜测放宽 roleLabel。`20260719-v3`–`v19` 保留后续失败、诊断、source-drift/preflight incident；其中 v13 candidate 曾在当时 source 上 24/24，但其 baseline 仅 7/12 且此后评测器/source 继续变化，所以不是 final release checkpoint。只有 v20 同时满足 final-code candidate、完整 legacy baseline、同 source bundle 与 transport/model provenance 门。

沿用 2026-07-18 冻结的 TeamoRouter 价格快照（每 1M tokens：Terra $0.25/$1.50、Sonnet $0.54/$2.70、DeepSeek Pro $0.435/$0.87）对 v20 token 重新核算：Terra 12 件合计 $0.03014175、单位 $0.0025118125；Sonnet 合计 $0.17509446；DeepSeek 12 件合计 $0.06435825、单位 $0.0053631875，Terra 单位成本约低 **53.17%**。三者本轮质量硬门均通过，故保留已批准的 **Terra 主、Sonnet 回退**，DeepSeek Pro→GLM 作为一键 rollback，而不是再用旧基线失败论证晋级。主选 provider/schema/截断/超时或 BrandProfile EvidenceRef v2 任务硬门失败会进入 Sonnet；`SITE_BUILDER_MODEL_ROLLBACK_BRAND_PROFILE=true` 回到完整 legacy route。其他 6 个文本 task 与全部图片/视频仍未晋级；本记录不宣称部署、真实租户流量、视觉/locale 覆盖或 R4-B-min 持久成本真值已完成。

**2026-07-24 M1-f Gemini 审美 MODEL-1 记录（未晋级）**：`gemini-3.5-flash` 在 new-api `/v1/models` 的 39 型目录中可见，原始 runner 随后记录了用 `natural-origin-rich` 375/768/1440 三张冻结 PNG 完成的视觉 capability probe：transport=`openai-chat-completions`，39,903ms，requested/reported/resolved 均为 `gemini-3.5-flash`。矩阵随后遇到 120,000ms 硬超时并停止，故候选状态为 **`unavailable`，不是 `evaluatedCandidate`**。原始不可变报告 [v1/report.json](../evidence/model-routing/model1-aesthetic-review-20260724-v1/report.json) SHA-256=`db17af253b9a6096c573b85f4fa845dfc823ed93dcd56c6c96f8b6103a72bb7f` 保留当时 runner 将 partial matrix 写为 `skipped 0/24` 的 incident；该报告没有锚定 partial artifact manifest，也没有保存 SHA-256=`3db07b…` 的精确 runner 源码，因此同目录 12 个 `run-*.json` 只能视为**未锚定诊断文件**，不得事后称为那次执行的 exact provenance、completed runs 或 partial quality 统计。只读 inventory [v9/report.json](../evidence/model-routing/model1-aesthetic-review-20260724-v9/report.json) SHA-256=`3788988f9c7f964e9083037886700401ddad78954f989804e8dd6c10aace80f8` 未再调用模型，仅固定这些现存文件的 hash，并显式设置 `completedRunsProven=null`、`originalArtifactSetAnchored=false`、`originalExecutionProvenanceExact=false`；同时区分历史 evaluator `@1.0.0` / prompt v1 与当前加权硬门 evaluator `@2.0.0` / prompt v2，12 个历史诊断文件在当前 closed output 门下全部无效。当前 evaluator 只有在 capability probe 文件落盘并取得 SHA-256 后才记录 probe accepted，并在任何未来 timeout 报告中用统一 manifest 锚定 probe 与已完成 matrix artifact 的 path + file SHA-256，避免复发同类 provenance 缺口。因此本轮不能宣称 24 件 schema/provenance 硬门、recall、false-blocker、paired preference 或 accepted-artifact unit cost。M1-f 运行时继续使用 deterministic QA 并显式标记 aesthetic unavailable；不创建 PR7，不启用未经同形评测的模型 fallback。

**2026-07-24 原生协议复测与四模型诊断（不能用于晋级）**：按上游接口说明把 Gemini 改为原生 `generateContent`，Terra/Sol 使用 Responses，Sonnet 使用 Messages；这只增加候选适配器和评测入口，不改变生产路由。四个模型均真实连到上游，但复核发现初版 benchmark 自身不合格：模型可从 case/artifact ID 看到 `approved/degraded` 标签；更重要的是，M1-e-B `rich` 截图只证明确定性构建通过，页面仍含中性占位文案和空白图片区，不是独立审定的审美 Gold。Terra/Sol/Sonnet 对这些基线给出 56–79 分并指出 imagery/mobile/credibility，不能自动算作 false blocker。旧 v3 产物只保留为本地历史诊断，不作为 final-code MODEL-1 证据。当前代码已把模型可见 ID 改为不透明值，并把现有图片降为 `deterministic_render_baseline`；即使跑完整矩阵也只能产生 `diagnosticOnly`，`aestheticGoldCalibrationReady=false` 时绝不产生 `evaluatedCandidate`。真正晋级前须另建独立审美 Gold，再恢复 good-fixture false-blocker 门。

final-code v4 均绑定 new-api 镜像 digest、起止源码 hash 与脱敏失败 artifact：Gemini probe 在 50.7 秒后因 `VISION_REVIEW_SCHEMA_INVALID` 停止（[报告](../evidence/model-routing/model1-aesthetic-review-20260724-gemini-3-5-flash-v4/report.json)）；Terra probe 通过、完成 5 次 matrix 后因 `AESTHETIC_REVIEW_OUTPUT_SCORE_INCONSISTENT` 停止（[报告](../evidence/model-routing/model1-aesthetic-review-20260724-gpt-5-6-terra-v4/report.json)）；Sol probe 通过、首个 matrix 调用即遇到同一算分不一致（[报告](../evidence/model-routing/model1-aesthetic-review-20260724-gpt-5-6-sol-v4/report.json)）；Sonnet probe 通过并完成 18 次 matrix，随后 4000 token 用尽而 `VISION_REVIEW_OUTPUT_TRUNCATED`（[报告](../evidence/model-routing/model1-aesthetic-review-20260724-claude-sonnet-5-v4/report.json)）。四者均为 `unavailable`、`routePromoted=false`；这说明 Sonnet 在本轮结构稳定性最好，但仍不构成质量胜出或晋级。

本次终端 A-B-B-A 观察中，Gemini 直连与 new-api 都出现过十几秒和一分钟以上的返回，new-api 原生通道也有约 12 秒的正常响应；主机显式代理会增加短请求握手时间，但 new-api 容器未注入代理变量并直接访问上游。这些是当次排障观察，不是仓内可重放的正式延迟报告，因此只支持“尚无证据证明 new-api 或系统代理固定制造 120 秒延迟”，不支持精确性能结论。运行时继续只信确定性 P4，并明确记录审美不可用。

**2026-07-25 双模型盲评视觉校准 harness（仅代码，尚未运行）**：独立模块从六个 approved Family 各取一张 M1-e-B `rich` 的确定性截图，并复用冻结劣化算法组成 6 对；这些源图仍只叫 `deterministic_render_baseline`，不是审美优秀样本或 aesthetic Gold。每对只给模型两张同断点图，按私有哈希固定首轮左右并以 A-B-A 顺序运行 3 次；模型请求看不到 Family、source/degraded、已知问题或其他模型答案。输出严格缩成 `{choice:left|right|tie, findings:[{ruleCode,severity,imageNumber}]}` 且 findings 最多 4 条；总分、维度分、通过结论、修复、代码与自由文本全部由 schema 拒绝。Gemini、Sonnet、Terra、Sol 的候选协议分别冻结为 `google-generate-content`、`anthropic-messages`、`openai-responses`、`openai-responses`，每模型计划固定为 1 次三图 probe + 18 次成对调用、120 秒、800 tokens。经用户确认，首轮保留原图并以质量、稳定性和完整证据为先；中转站预算与原图成本预测只在实际调用后记录和计算，不作为首轮执行前门。

单模型统计只由服务端纯函数生成：18/18 closed format、图片编号与 requested/reported/resolved model/协议 provenance 全部精确，已知劣化命中至少 17/18，且至少 5/6 Family 三轮选择一致；任一 timeout、truncation、格式、型号、协议、provider provenance 或 usage 失败即停止并标 `unavailable`。120 秒 deadline 会立即 abort 并判整轮不可用，但证据定稿前再给在途 promise 最多 10 秒 settlement grace：如落定则保留迟到的 usage/provenance，如仍未落定则显式记录 `unknown_after_grace`，不把未知成本写成零。campaign launcher 固定 Gemini→Sonnet→Terra→Sol 串行运行，输出不会成为后续模型输入；它在调用前只验证四个候选型号/协议、固定提交、source bundle 和输入哈希，逐次保存 token/实际成本，完成后才计算原图下一轮成本预测。只有通过单模型门的候选才按正确率、稳定性、19 次调用 P95、成本、型号排序；程序最多选择两个不同 upstream model family，并要求二者绑定相同提交、source bundle、harness/prompt/schema 与 6×3 输入矩阵，再检查双方都选中劣化图且以同 ruleCode+语义位置共同命中至少 17/18。没有两个通过者就不产生组合结论，本阶段不加第三裁判。即使双模型通过，最高字面量也只是 `eligible_for_aesthetic_gold_calibration`；它不创建 `evaluatedCandidate`、不晋级或切路由，也不接 P4。**本 PR 没有调用真实模型、没有新增或改写评测证据**；真实四模型运行只能在 harness 补丁合并后的独立证据 PR 中进行，运行时双模型审美门仍须两个稳定候选、独立审美 Gold 和用户再次批准。

主入口为 `apps/api/scripts/evaluate-site-builder-blind-visual-calibration-campaign.mts`。它默认拒绝付费调用，只有显式设置 `BLIND_VISUAL_CALIBRATION_EXECUTE=1`、新的 repository-relative campaign report 路径、gateway image digest 与 gateway URL/key 后才运行四模型；在创建网关或任何付费调用前，它会冻结输入/源码哈希并检查 `/models` 中四个型号和协议。随后它依次调用底层单模型入口，各自产生 create-only report 与 sibling artifacts；campaign envelope 锚定报告 hash、固定顺序、输入矩阵、型号/协议、逐次 token/实际成本、原图后验成本预测和双模型纯函数结论。GPT-5.6 的成本预测仍使用未缩放的 32×32 patch 数作为 `detail=high` 的保守上界，不套用 GPT-4o tile 公式；它只用于首轮后的下一轮预算判断，绝不缩图或改变劣化图。候选 probe、timeout、truncation、格式或 provenance 失败只使该候选不可用，后续候选仍独立执行；型号、协议、源码或输入完整性预检失败才在首个模型调用前 fail-closed。运行中 source bundle 漂移会保留已完成调用并标 `unavailable_source_integrity_changed`，不得进入模型选择。两个入口在本 PR 只完成 wiring 和 `--help`/拒绝未授权执行检查，**未被实际武装或运行**。

### 1.2 视觉子集：6 扩 12（M1-g）

Bootstrap 通过后扩为 **6 个 Family × sparse/rich**，补 CNC/五金、包装机械、食品原料/创新材料等（v3.2 §27.2）。每个 Family **必须在层级、hero 构图、section rhythm、卡片语法、密度上可区分，不能只换颜色**（呼应审美 rubric 的原创性维与通用感检测）。

### 1.3 成熟系统集：逐步达 30+（M2 / 真实流量后，含对抗样本）

规模化验收**不当作零流量硬前置**（v3.2 §27.3）：

- **5 BusinessArchetype × 3 Market × 2 资料完整度**。
- **≥10 个对抗样本**：虚假认证、冲突参数、人物/证书、低清产品、prompt injection、缺图、超大 PDF、重复素材、恶意外链。
- 建议构成 = **20 个平台合成/明确授权 + 5 个脱敏真实 + 5 个历史失败回归**；真实数据需权利与隐私审批。
- **新失败案例必须最小化后回灌**；Golden Set 是**累积资产**。

### 1.4 每个 fixture 必存清单

每个 fixture 固定保存（v3.2 §27.4，缺一即回归不可复现）：

- 输入、市场、资料完整度、期望 Archetype/候选 Family。
- **不允许出现的 Claim**、必需页面/section、客观不变量。
- desktop/tablet/mobile 三尺寸截图 + 确定性 QA 结果。
- **DesignEvaluation、owner preference 与选择原因**。
- catalog / model / **transport** / prompt / schema / evaluator 版本与不可变指纹 + Claim/Offering/Asset snapshot；当前 BrandProfile report 在 header 固定 task、prompt version、output-schema hash、evaluator version/rubric hash，并对每个 fixture/run 固定 fixture、实际 prompt hash、完整执行策略、transport 与已判定 artifact hash。
- accepted/rejected artifact、trace、token/latency/cost。
- 来源许可、是否允许训练、保留策略；**不得混入原始 Tier B 页面语料**（净室边界，ADR-019）。

### 1.5 存放与脱敏

- **构成**：真实合作工厂（脱敏，授权见 §10.1）+ 合成企业，覆盖 行业 × 资料完整度 × 市场特例（小语种/RTL/多认证）两维矩阵。
- 每家 = **固定输入**（intake+向导+素材+文档）+ **期望锚点**（factSheet 关键事实清单、必出 section、关键词落位、必过硬门）。
- 存 `apps/api/test/fixtures/golden-companies/`（全部脱敏/合成，过 gitleaks，§8 硬门）。

## 2. 评测维度与量化

### 2.1 质量评分 Rubric（9 维加权）

审美 evaluator 的 closed output 支持**结构化 9 维加权分**（v3.2 §28 回写）；当前运行时 route 因 MODEL-1 未晋级而明确 unavailable，不伪造分数。未来模型可用时，硬失败仍**不靠总分抵消**：

| 维度 | 权重 | 高分标准 | 典型扣分 |
|---|---:|---|---|
| 信息层级 | 15 | 一眼理解业务、主次清晰 | 首屏无业务对象、H1 与正文同权 |
| 全站一致性 | 15 | 同一视觉语法贯穿多页 | 每个 section 像不同模板 |
| 留白与节奏 | 10 | 密度有变化、呼吸合理 | 全站等距、连续卡片墙 |
| 对比与可读性 | 10 | 文本/背景/CTA 清楚 | 灰字过浅、叠图不可读 |
| 图片策略 | 10 | 角色明确、裁切稳定 | 重复占位、拉伸、主题不符 |
| 移动端构图 | 15 | 重排自然、CTA 可触达 | 只是缩小、横向溢出 |
| CTA 清晰度 | 10 | 主要 CTA 单一、路径明确 | 每段都抢主 CTA |
| 可信度 | 10 | 事实与证据匹配 | 虚构数字、空洞形容词 |
| 原创性 / 非模板感 | 5 | 家族一致但不机械重复 | 只换色、结构全同 |

**硬失败清单**（任一命中即阻断，不被总分抵消）：虚构认证/客户/数字/地址、页面不可构建、关键 CTA 不可用、移动端横向溢出、对比度严重不合格、未批准外部请求、未知组件被静默删除。

### 2.2 可量化发布门（11 维阈值 + 阻断条件）

M1 发布门（v3.2 §10.2 回写）；每维带**独立阻断条件**，不允许总平均掩盖单维硬伤：

| 维度 | M1 目标 | 阻断条件 |
|---|---:|---|
| Demo API P95 | < 10 秒 | 超过现有 PRD 红线 |
| Demo 生成成功率 | ≥ 99% | 无兜底或生成失败 |
| Lighthouse Performance | ≥ 85 | 任一 Golden 页面 < 85 |
| Lighthouse Accessibility | ≥ 90 | 任一 Golden 页面 < 90 |
| 结构化审美分 | ≥ 85/100 | 任一硬伤维度 < 60 |
| 事实安全 | 100% | 出现无证据认证/客户/数字/承诺 |
| 外部运行时依赖 | 0 个未批准域名 | 字体/图片/脚本/表单偷偷出站 |
| 组件契约覆盖 | 100% | 未知组件被静默丢弃（ADR-015 fail-closed） |
| 三断点溢出 | 0 | 375 / 768 / 1440 任一横向溢出 |
| 新方案盲测胜率 | ≥ 80% | 对当前 Demo 的成对盲测未达标 |
| 同质化 | 10 样本中 ≥ 4 个明显结构家族 | 10 样本只换色不换结构 |

### 2.3 Core Web Vitals 工程阈值

采用公开良好阈值：**LCP ≤ 2.5s / INP ≤ 200ms / CLS ≤ 0.1**（v3.2 §10.2）。**M1 先做实验室门**（Lighthouse/Playwright），**发布后再采集 RUM 真实用户数据**——不把实验室门冒充真实体验数据。

### 2.4 用户可见结果 DoD（7 条质量 bar）

一个合格 Demo 首次生成即应满足（v3.2 §10.1 回写，评测须能逐条判定）：

1. 首屏 5 秒内可判**做什么/服务谁/下一步**。
2. 看起来像**同一品牌**，而非组件样例合集。
3. 不同行业、不同资料完整度**结果差异明显**。
4. 无用户图片时也有**安全、克制、非事实性**视觉占位。
5. **无虚构**客户/认证/年限/团队/案例/统计（ADR-017 红线）。
6. 手机端**独立成立版式**，非桌面压缩。
7. **零**外部字体/图片/未知脚本/托管表单依赖。

### 2.5 DesignEvaluation 输出契约（M1-f as-built）

运行时写 closed-shape `DesignEvaluation v2`：身份绑定 candidate spec/DesignBrief digest、round 与 evaluator 版本；确定性结论含 `passed|failed`、冻结 `ruleCode`、严重度、page/section/breakpoint target 与 evidence ref；审美结论为 `passed|failed|unavailable`，unavailable 时 `overallScore=null`。合同拒绝未知字段、自由文本 target、`suggestedPatch` 以及任何 props、组件、variant、CSS、HTML、Astro、路径或 JSON Patch。

修复使用独立 `RepairOptionCatalogV1`，由服务端按当前 digest 生成同 Family approved Blueprint、允许 variant、item 数量或既有 Asset 选择。模型若可用也只能返回 `{optionId}`；服务端应用实际变化并重跑全部 validator。取消、预算关闭或结算未知不得借确定性 fallback 继续发布；普通选项选择失败才可按服务端冻结排序选第一个安全 option，并记录 `deterministic_fallback`。

### 2.6 通用感检测（M1-f as-built）

审美分之外保留 **genericness 检查 8 指标**（v3.2 §17.4 回写，专治"换更强模型也治不好"的模板感）：

- 相邻区块结构重复率；卡片组件占全站比例；多页 Hero 构图重复率；图像占位重复率；CTA 文案与位置重复率；与同批次其他站点的 Blueprint 重复率；颜色只换皮但版式相同比例；无证据营销形容词密度。

**建议数值门**（4 条）：

- 同站连续结构重复 ≤ 2；
- 同一站点页面 Hero 构图完全相同 ≤ 50%；
- 同一批 10 样本首页 Blueprint 完全相同 ≤ 30%；
- 卡片式 section ≤ 可见 section 的 50%。

### 2.7 事实忠实度与 Evidence 硬规则

事实忠实度 = **零容忍硬门**（锚点比对 + evidence 门），呼应 ADR-017（禁虚构身份）。

**R4 Evidence 硬规则**（v3.2 §24.7 回写，evidence 门须强制）：

- 所有模型产出的 FactSheet 事实**都须有 quote**，且 quote 命中 `sourceId` 对应的**冻结语料**。
- value 中的**数字/单位/认证代码/关键专名**必须在 quote 中一致出现，否则降 gap。
- 新 A1 写入中，web 搜索原始 **title/snippet/path/query/fragment 一律不冻结**，只保留由站主公司名 + external origin 生成的最小 `research_hint`；旧数据或其他 `research_hint` 仍不得直接成 publishable fact。
- web_research 若要支撑事实，须**抓取原始权威页并冻结正文 hash**，仍按低信任来源处理。
- 认证必须**引用 ready 的 cert Asset 或人工 verified**；intake 自填/官网文案不能直接上站。
- valueProps/differentiators/tone **只能从已过闸的 FactSheet 推导**。

**已确认的 evidence 门缺陷**（v3.2 §24.2，as-built 代码问题，**须 M1-d 前修**，评测 fixture 须含对抗回归）：

| ID | 代码证据 | 问题 |
|---|---|---|
| R4-1 | `enforceEvidenceGate` | 普通事实无 quote 也过；quote 只查"存在于来源"，不查数字/实体/claim 是否被支持 → 可用真实 URL/无关引文给虚构事实洗白 |
| R4-2 ✅ A1 隐私半闭环 | `brand-research.ts` | 新写已不冻结原始 title/snippet/path/query/fragment，只生成 origin hint；A2 仍须让任何 `research_hint` 不可发布，并要求事实回抓权威正文 |
| R4-3 | 认证 evidence | intake/upload 标签 + 任意命中 quote 即放行认证，无强制 ready cert 资产引用 → 自填"ISO"可变成站点事实 |

### 2.8 视频 QA rubric（M3 目标态）

视频/动效不塞进 M1；QA 契约预埋（v3.2 §21.4 回写）：

- **多模态评审模型**（`multimodal.review`，型号经 ADR-016 档选、不硬编码）**按时间戳输出 finding**；当前已接文本集合中 `minimax-m3` 是视觉候选，但 plan 端点能否接收真实图像输入仍须 M1-f capability probe，未通过不得冒充可用。模型不可用时保留**确定性时长/编码/闪烁基础门**。
- 检查：产品形状/标签/Logo/人物异常/闪烁/字幕/音画/品牌色/黑帧/违规内容。
- **关键产品或人物严重漂移直接拒绝 Shot**；低风险缺陷可替换为静态图/上一版镜头。
- **证据记录要求**：必须记录输入帧/时间戳、rubric、model snapshot 与置信度，**不能只保存总分**（v3.2 §21.4）。

## 3. task-shaped 模型评测与晋级（ADR-016 四态）

**按 7 个 AI Task 各自的输入→输出契约做有界评测，非笼统跑分**。评审顺序固定：**确定性硬门 → schema/reference → 匿名偏好 → 独立 Judge/人工**（v3.2 §27.6/§23.6）。

### 3.1 task-shaped 分期表

| Task | 永久硬门 | Bootstrap 排序指标 |
|---|---|---|
| Brand | 事实虚构=0、引用捏造=0 | 覆盖、gap、schema、accepted cost |
| Copy / Localization | 未批准 Claim=0、术语/槽位合法 | 目标市场偏好、清晰度、长度、成本 |
| Design / Assemble | 未知组件=0、最终 schema/引用门通过 | 一次成功、修复轮数、审美、P95 |
| Aesthetic Review | 高风险缺陷不能被文风掩盖 | 漏检、误报、定位、成本 |
| Image / Video | 身份/证件/人像违规=0 | 可用率、重做次数、单位合格成本 |
| QA / SEO | 硬门由代码命中 | finding 归并与解释准确度 |

> as-built 覆盖：Brand=`brand_profile`、Copy=`copy`、Design/Assemble=`design_spec`+`assemble`+`assembly_fix`、QA/SEO=`qa_summarize`+`seo_review`（7 个已落地）。Aesthetic Review / Localization / Image·Video 为目标态。

### 3.2 MODEL-1 / MODEL-2 分期

- **MODEL-1（候选接通/无真实外部流量的代码级晋级）**：真实 endpoint 先跑 **capability probe（失败即停）**，不把官方规格当租户可用事实；probe 同时验证**模型 × 协议 × 响应字段映射**，不能把 HTTP 200 或 `/v1/models` 可见当作结构化能力；每 task 用 **6–12 代表样本 × 固定 prompt/schema/rubric × 2 次**，**先判 schema/事实/身份/延迟/成本，再做偏好比较**。报告完成默认只得到 `evaluatedCandidate`；只有任务硬门、相对现役质量/成本门、owner 明确批准、生产协议映射、失败门和任务级 rollback 同时具备，才允许用独立 PR 手工写成 `promotedRoute`，绝不自动晋级。默认选择原则 = **"满足所有硬门的最低 accepted-artifact 成本"**，只有高价值页面证明可见质量增益才用 premium。
- **MODEL-2（有真实流量或高风险生产切换前）**：扩至 **≥ 30 样本 × 3 次 + 100% shadow**；经批准进 **5%→25%→100% canary**（每档样本/时间门由当时流量与风险写入 ADR，不假装已有统计基础）；任一事实/身份硬失败、P95、provider error 或 accepted-cost regression **触发自动回 `promotedRoute`**。

### 3.3 全阶段硬门阈值（6 条）

所有晋级阶段共用（v3.2 §23.6）：**① 事实/引用违规=0；② 结构化输出经一次 repair 后合法；③ 关键 QA 漏检不超阶段门；④ 产品身份破坏=0；⑤ P95 不超 task 预算；⑥ accepted-artifact 单位成本可核对。** 启动集只用于**筛掉明显不合格候选**，不能宣称统计显著或永久终选。

### 3.4 视觉偏好 5 问与客观硬门

Bootstrap 由产品 owner/用户做**成对比较**（v3.2 §27.5）：

1. 哪个更像可真实发布的海外 B2B 站？ 2. 哪个更快讲清业务和产品？ 3. 哪个更可信？ 4. 哪个移动端更完整？ 5. 哪个更少模板感？

候选需**≥ 4/6 成对比较胜出**，且**事实/a11y/移动端溢出/关键 CTA/性能等客观硬门全过**，才推广。**5 名以上目标用户盲测属 12/30+ 阶段，不阻塞启动集**。

### 3.5 晋级判定

启动集报告本身只能把候选标为 `evaluatedCandidate`。成为 `promotedRoute` 前必须（v3.2 §27.8）：① 永久硬门全过；② 主要质量显著优于现路由，或质量非劣且 accepted-artifact 成本更低，或解锁必要 capability；③ 开工时 ADR 明确样本量/成本预算/流量档/回退阈值/owner；④ 报告按 **task / locale / archetype / 资料完整度 / provider failure 切片**，不能用总平均掩盖高风险子集；⑤ 生产 transport、失败门、可回滚开关与实际 route snapshot 一并落地。**"最贵/最新"不是晋级理由**。BrandProfile 的上述晋级记录满足当前合成文本子集门，但在真实租户流量或高风险部署前仍须进入 MODEL-2，不能把代码合并冒充生产 canary 完成。

### 3.6 Judge 反串谋与可重放

- Judge **尽量不与 candidate 同 provider**；**先跑确定性门再盲评**，避免模型用高文风掩盖事实错误。
- Judge 固定为一个 **ModelProfile**（固定模型+snapshot+温度 0，ADR-016）；换 Judge 需先跑基线校准，否则分数漂移无法归因。
- 所有模型 **alias 运行时解析到 snapshot**；**ReleaseManifest 保存 snapshot**，保证历史重放与回归定位。

## 4. 回归纪律

- **触发**：改 agent prompt / 换模型或模型档 / 改组件库或主题 / 改校验器/evidence 门 → 必须跑回归再合并（写进 PR 模板检查项）。
- **模型档晋升回归门**（ADR-016）：任何 `evaluatedCandidate → promotedRoute` 切换前，**必须过 Golden Set 回归**（§3.2/§3.3 硬门 + §3.5 切片报告），无回归门的晋级 = 违背 ADR-016。
- **分层**：`smoke`（从 Bootstrap 固定抽 2 个 fixture，分钟级日常冒烟；**不代表 Golden Set 规模或覆盖完成**）/ `full`（先跑完整 Bootstrap 6；M1-g 扩成视觉 12 后再跑完整 12，模型或组件库级改动）。Golden 口径始终是 **6 启动 → 12 视觉扩集 → 真实流量后 30+ 成熟集**。
- **执行**：本地 verify 脚本真网关真构建（§8 硬规矩，CI 不跑）；报告（各维分数 vs 基线差值，按 §3.5 切片）贴 PR 描述；**硬门回退 = 改动打回**。
- **基线更新**：有意的质量提升合并后，重跑 full 落新基线（基线文件随 repo 版本化）。

## 5. 代码与真机测试七层（TDD 落到本功能）

**先写测试再实现**（RED→GREEN→IMPROVE），七层覆盖（v3.2 §27.7 回写）：

1. **单测**（vitest，CI 跑）：schema/状态机/**引用扫描**/evidence 门/object key/image recipe/budget reserve-settle/**route registry**；SiteSpec 校验器（合法/非法/边界表驱动）、richtext 白名单序列化（注入样本集）、prompt 模板变量转义、发布门 L1 规则表、CopyBundle 槽位与长度、locale/RTL 工具、指针切换幂等。
2. **属性 / fixture 测**：**SiteSpec 兼容演进**（`specVersion` minor 容错）、RichText sanitize、JSON Patch、locale、lock preservation。
3. **编排单测**：复用 PR #73 的 mock `proxyActivities` harness——`siteBuilderWorkflow` 分支覆盖：scope 增量重跑 / 单素材失败不阻断 / 预算超限暂停 / 质量环 ≤3 轮出环 / 同 site 并发去重 / **补偿 / 取消 / provider 回退**。
4. **集成（本地真库）**：intake→demo v0 全链、素材状态机（presign→commit→处理→引用对账）、spec PATCH→秒级重渲染、**RLS/FORCE RLS 隔离证明**（`APP_DATABASE_URL` app_user 跑 + is_superuser guard，复用既有先例）。
5. **真机 verify（真实数据无 sandbox）**：PostgreSQL/FORCE RLS、MinIO、Docling、BGE-M3、Gateway、Sharp、Astro、Playwright/Lighthouse。每里程碑一份 `verify-site-builder-m{N}.mts`——M0=真网关真构建出真预览 URL 并可访问；M1=Golden 一家全管线；M2=发布门+域名绑定干跑。
6. **契约测试**：OpenAPI diff/schema 快照 + [07](07-api-contract-draft.md) 示例作 contract fixtures、**SiteSpec fixtures**、**Renderer 兼容**、**capability snapshot**——防接口与渲染契约无声漂移（前端依赖面，ADR-014）。
7. **安全测**：恶意文件、解码炸弹、SSRF、prompt injection、XSS、外呼域、撤权与下架。R1-safety ① 已锁定 Renderer 子进程 env 精确 allowlist、临时目录/文件权限、成功/异常双路径清理，并以真 Astro build 证明产物可用且父进程密钥未进入子进程。R1-safety ② 已用单测与真机覆盖公网 `/md`+`/crawl`、无二次 DNS pinning，以及 private/loopback/metadata/IPv4-mapped/redirect-to-metadata 负向。

## 6. 里程碑评测门与测试泳道

各里程碑的**合并门/测试泳道**（DoD，v3.2 §26 回写）：

- **测试泳道 IT-0（Industrial Template 效果验证）**：可与 R2 并行、非架构主序列。基于最新 main 重跑（或记录落后 SHA）；industrial pump 与 auto-parts 各有 sparse/rich fixture，存 1440/768/390 截图；记录 Astro build/axe/性能预算/unknown component/copy 与事实风险；输出**"可保留原创 / 需按合同改造 / 应丢弃"清单**；**未经组件合同审查不得整包合并 Section/themes/demo-spec**。
- **M1-c 合并门（9 条 DoD，ADR-018）**：`AssetVariant` additive migration + RLS/FORCE RLS A/B 租户测试（不预建 MediaJob/AssetUsage）；原件永不覆盖 + recipe 相同不重复；commit/processing CAS/lease/重试/取消/zombie write；EXIF-GPS 真图复验 + 方向/色彩/透明 + AVIF/WebP/fallback 可解码；cert/person/logo 不进生成式且无 provider 调用；单图失败隔离、仅必需 Hero 无 fallback 才阻断；被引用 Asset 删除 409 + 扫描器覆盖 SiteSpec 1.0.0 全 AssetRef；MinIO 对象/Variant/checksum 可对账且对象清理不在 DB 事务；derivedKeys 双写兼容 + 停双写迁移条件；MF-1 触发条件已记录。
- **PR M1-f（确定性 QA + 审美与反模板感）**：先断点/溢出/对比度/资源/链接/schema/事实/a11y，**再冻结截图多模态审美**；**最多三轮定向修复，禁随机全站重生成**。
- **PR EVAL-bootstrap（可执行启动集）**：6 fixture（§1.1）；存输入/不变量/desktop-mobile 截图/质量/成本-延迟；产品 owner 成对偏好，**4/6 胜且客观硬门全过才扩 12 视觉 fixture**；启动集不宣称统计显著。（施工顺序 #11，v3.2 §0.3）
- **PR MODEL-1（候选真探与小样本评测）**：依赖 MODEL-0/EVAL-bootstrap；每候选先 capability probe（含协议/响应映射），再跑 6–12 task-shaped 样本与 accepted-artifact cost；**只产 `evaluatedCandidate` 报告，不自动切生产**。（施工顺序 #12 分期，v3.2 §0.3）
- **PR M1-g（阶段收口）**：启动集扩至 12 视觉子集；跑 Catalog/模型/事实/安全/a11y/性能/回滚回归；**记录尚未完成的 30+ 成熟系统集，不得把计划冒充覆盖**。

## 7. 指标与可观测性

**指标六层**（v3.2 §3.6 回写，事件进公共 Outbox、不建第二套消息系统）：

| 层 | 至少记录 |
|---|---|
| 激活 | Demo ready rate、P95 |
| 资料 | profile completion |
| 构建 | publishable Claim 覆盖、build success/degraded、成本 |
| 发布 | preview→publish |
| 增长 | CTA / form / inquiry conversion |
| 护栏 | hallucination、identity rejection、a11y/performance、abuse/takedown |

- 访客分析受 region/consent 控制；**询盘正文与个人信息不得进入分析事件**。
- **Search Console、Safe Browsing 状态监控**按 [06](06-security-abuse.md) 后续接入；sitemap/canonical/hreflang/JSON-LD/OG 继续归 **SEO/QA**（`seo_review` task）（v3.2 §22.3）。

## 8. CI 边界

CI 只跑**纯单测 + 契约快照**（仓库规矩，无 DB/网络）；集成/E2E/评测 = 本地 verify + 里程碑门；**gitleaks 覆盖 fixtures**（Golden Set 必须脱敏）。

## 9. Demo"没效果"八根因（评测须能捕捉）

评测机制存在的理由——**换更强模型无法替代设计资产、受控变体与质量闭环**（v3.2 §2.2 回写，按优先级）：

1. 素材为空（无视觉锚点）→ 任何主题只能像线框稿。
2. 结构过于固定（行业不同但页面/区块节奏相同）。
3. 主题过薄（只换色/圆角/字体，不改构图/密度/图片占比/节奏/CTA 策略）。
4. 组件覆盖不足（设计意图落不成合法 SiteSpec，退化通用卡片）。
5. 缺内容预算（短标题塞长文，或无事实时生成空洞 Stats/Testimonials/Certificates）。
6. 缺整站一致性契约（每 section 单独合理不代表全站像同一套设计）。
7. 缺截图级审美门（schema/构建/Lighthouse 都过，页面仍可能"廉价、拥挤、AI 味重"）。
8. 无反模板感指标（判不出"连续三卡片网格""每页同 Hero""所有站蓝色工业风"）。

> §2（rubric/发布门/通用感检测）与 §3（task-shaped eval）逐条对应上述根因：3/6→一致性维、7→审美门、8→通用感检测、5→内容预算门、4→组件契约覆盖 + 未知组件 fail-closed。

## 10. 待拍板

1. 真实工厂资料进 Golden Set 的**授权方式**（2~3 家合作工厂：口头授权+书面记录 or 简单授权书模板）。
2. **Judge 固定 ModelProfile 选型**（ADR-016）：需固定模型+snapshot+温度 0，且**尽量异 provider 于被评 candidate**（§3.6 反串谋）。2026-07-17 本机网关已扩到 39 个可调用型号，包含 GPT/Claude/Gemini 候选与原方舟/DeepSeek；但不能由清单可见或单次连通直接指定 Judge。多模态与跨 provider Judge 均须 MODEL-1 用真实输入、固定 snapshot 校准后再写入 ADR；ADR-020 只决定目标组合，不代替 Judge 校准。
3. Bootstrap 6 fixture 的 sparse/rich 素材与期望锚点**由谁产出、何时冻结**（EVAL-bootstrap PR 前置）。

---

## 完成定义（DoD）— M0-M3 分层验收门（v3.2 §33 回写 · DOC-12 补漏）

> **只有分层全部满足才能说 M1 完成**——"页面看起来不错"不能替代可靠性、安全与发布合同。本节是**跨里程碑的正式验收契约**（此前散在 v3.2 §33、未分发，completeness-critic 查漏后补回）。多数条目的**机制真值在他处**（R0 审计见 [09 §10](09-m1-implementation-design.md)、MF-0 见 [14](14-media-foundation-mf0.md)、组件/契约见 [04](04-sitespec-contract.md)、模型门见 [10](10-model-selection-study.md)、发布治理见 [06](06-security-abuse.md)/[05](05-deployment-hosting.md)）；本清单是**统一的"是否可发布"门**，按 ID 引 ADR。
>
> **as-built 注记（2026-07-16）**：#121/#123/#124 已完成无条件 Demo、禁虚构身份、业务邮箱隔离、真取消与失败保站；#126 已补齐 `buildId`、intake 幂等、Temporal 启动证据和 Swagger/OpenAPI，并以单测、真 PostgreSQL 与真实 Temporal probe 覆盖 DoD-1 第一项。

### DoD-1 M0~M1-b 回补
- [x] hasWebsite true/false 都无条件产生同一 site 的 demo buildId，Idempotency-Key 可重放。（R0-1/2，#121/#126）
- [ ] Demo 不虚构企业类型/工厂/团队/认证/年限/客户/数字；P95 < 10s。（🔴 ADR-017 / R0-3）
- [ ] active preview 不被失败/取消/未发布 build 覆盖；Release/版本分配并发安全。（ADR-013）
- [ ] businessEmail 不进通用 KB/embedding/品牌 Prompt；存量 chunk 已重建清理。（R0-4 隐私）
- [ ] Asset/KB 在重复 commit/duplicate race/worker 崩溃/存储故障下可恢复。
- [ ] BrandProfile 同 buildRun 幂等；事实有冻结 quote；snippet 不洗白；认证强引 cert Asset/人工批准。（ADR-017）
- [ ] 首个付费 fan-out 前预算 reserve/settle、AiTrace、costSummary 可持久对账。

### DoD-2 M1-c 媒体基础与图片
- [x] AssetVariant additive migration/RLS/recipe 幂等/derivedKeys 兼容/回滚通过；M1-c 不预建 MediaJob/AssetUsage。（MF0-A/B + M1-c verifier；ADR-018 / 14）
- [x] M1-c 纯 Sharp；原图 immutable；EXIF/GPS/方向/色彩/透明与响应式格式由实际 Sharp fixture/开发环境 MinIO 对账覆盖；不把编码子进程描述为生产容器/cgroup 隔离。
- [x] active SiteSpec 引用素材不可删（→409）；对象/DB/checksum 可对账；MF-1 后无感切 AssetUsage。（MF0-B + M1-c verifier）
- [x] video/audio/poster/caption 演进方向已记录，且 M1-c 未调用 video/TTS provider。（14 §6–7）

### DoD-3 M1-d~g 内容、设计与质量
- [ ] 6 Family 各 ≥2 首页 + 2 内页 Blueprint，差异可解释；26 组件 schema/Astro/fixture/a11y/content budget/visual test 一致。（04 / 13）
- [ ] Demo 无模型也有视觉锚点；sparse 不虚构、rich 正确利用产品/工厂/证书/地址。
- [x] Copy 只消费 PublishableClaimSnapshot；locale default 阻断、optional 省略/degraded 与空快照中性路径已覆盖。人工编辑锁定仍属后续编辑能力，不在 M1-d 冒充完成。
- [ ] SiteSpec 三重门 / Renderer compatibility / 三断点 / Lighthouse / WCAG / 外呼域进 CI。
- [ ] aesthetic review 不可用有显式降级；修复 ≤3 轮；安全 Family fallback 可重放。（ADR-013）
- [ ] SiteReleaseManifest 可重建相同 artifact digest；回滚恢复完整文案/素材/代码/配置。
- [ ] 6 Bootstrap fixture ≥4/6 成对偏好胜出，性能/事实/a11y 无回退；扩 12 后设多人盲测门。

### DoD-4 模型、运维与公开发布前门
- [x] MODEL-0 的 profile/能力/策略 registry 已落；Agent 卡不散落型号。（ADR-016）
- [x] BrandProfile 完成 capability probe + 6×2 候选/现役同形报告并经 owner 批准为代码级 `promotedRoute`；有任务失败门、原生协议与 rollback。其余 task 仍逐项待评测，不能继承本结论。
- [ ] 每 Release 可追溯 model snapshot/routePolicy/prompt/schema/rubric/accepted-artifact cost。
- [ ] PublishReview / 域名 ownership+tombstone / 询盘隐私+滥用 / Claim 过期维护 / taken-down+appeal 在首次公开发布前可用。（06）
- [ ] Readdy/字体/图标/图片/视频/音乐许可来源撤权可审计；Tier B 原始输出不入生产 RAG/训练。（ADR-019）

### DoD-5 M3 媒体门（不阻断 M1）
- [ ] MF-1 MediaJob/AssetUsage 由视频真实消费者驱动落地；Seedance Shot job/取消/重试/成本/QA/静态降级可用，Veo 仅 policy 进 premium/shadow。
- [ ] 旁白/转写/字幕/poster/reduced-motion/移动端码率完整；无声音克隆。
- [ ] 产品/Logo/人物/文字时序 QA 通过；失败只重做 Shot，回滚恢复整套媒体。
