# 安全与滥用防控设计 v1（草稿，待用户确认）

> 落实 [02-architecture.md](02-architecture.md) §7/§11 与遗漏面盘点第 1/3/4/5 条。原则：**平台域名信誉是全体客户的公共资产**，滥用防控是生死线不是可选项。
>
> _Reviewed against 12 v3.2（2026-07-16 回写 §8/§13/§18/§20–22/§24/§29；站建承重决策见 [ADR-013~019](../adr/registry.md)）。_ **收紧原则（v3.2 §1.3#6）**：安全/RLS/事实门与对外发布要求**只能收紧**；但"更重的系统"不自动等于更安全，**每道前置门必须绑定真实消费者与真实失败风险**，不为形式堆门。**落地时点（v3.2 §0.3）**：R0（产品口径 / Demo 虚构身份 / 联系信息误出域）**立即修**（§6/§10）；最小询盘持久化、反垃圾、同意记录、PublishReview、域名与媒体披露策略必须在 **M2 公开发布前**可用；完整获客评分后置。

## 0. 威胁模型总览

| # | 威胁 | 攻击面 | 防线（详见对应节） |
|---|---|---|---|
| T1 | 恶意租户建钓鱼/仿牌/违禁品站 | 发布链路 | §1 发布审查（L0–L3 分级 + PublishReview）+ 运行期复扫/下架 + 响应流程 |
| T2 | 恶意上传（payload 图片/超大文件/恶意文档） | 素材上传 | §2 |
| T3 | Prompt 注入（资料/抓取内容指挥 agent） | agent 管线 | §3 |
| T4 | SSRF（店铺导入/参考站 URL/web 研究） | 抓取器 | §4 |
| T5 | 构建期攻击（构建炸弹/构建期外呼/临时盘残留/env 泄漏） | Astro 构建 | §5 |
| T6 | 询盘垃圾与 PII 泄漏（含联系信息误出域） | 客户站运行期 | §6 |
| T7 | 跨租户越权 | 数据面 | 已由 RLS+对象存储前缀+签名 URL 覆盖（02 §7） |
| T8 | 预览链接被滥用 | 预览域 | §7；发布页第三方资源/CSP 见 §11 |
| T9 | 媒体权利/版权/肖像·声音误用、AI 内容披露不当 | 素材与生成式媒体 | §8 |
| T10 | 第三方设计资产被拷贝/未授权训练（来源合规） | 设计学习管线 | §9 |
| T11 | 我方系统虚构身份/事实（Demo 反造假） | Demo/文案生成 | §10 |

## 1. 滥用防控与发布审查（T1，平台生死线）

发布链路按**内容风险分级**决定门的强度（v3.2 §8.1 回写）——不是所有站走人审，也不是所有站免审：

| 风险级 | 内容 | 门 |
|---|---|---|
| **L0** | 结构、链接、格式、资源、安全头 | 确定性硬门（毫秒级、全量、不可绕） |
| **L1** | 普通企业事实、图片安全、SEO | 规则筛查 + 模型复核 |
| **L2** | 认证、性能数字、客户 logo/案例、医疗/金融等受限主张 | 必须绑定 **APPROVED Claim**（无证据不放行） |
| **L3** | 首次公开发布、投诉恢复、受限行业 | 人工 **PublishReview** |

**门的实现机制**：
- **L0/L1 确定性筛查**（毫秒级、全量）：仿牌关键词库（知名品牌名 × 类目错配，外贸仿牌高发）、违禁类目清单（武器/管制药械/烟草等）、钓鱼特征（SiteSpec 里不可能合法出现的元素：password 字段、银行/支付品牌仿冒词、非白名单外链聚集）。组件封闭枚举天然缩小攻击面——没有自由 HTML 就没有伪造登录页的载体（ADR-015；D15 富文本节点白名单同理不含 form/input）。
- **L1 模型复核**（发布前一次）：整站文案+图片抽样过内容安全审查（品牌安全/违禁内容），复用视觉评审 agent 通道加安全 rubric。
- **L2 事实硬门（evidence gate）**：认证、数字、客户案例、性能结论必须由 evidence gate 通过并关联 **APPROVED** 的公共 Claim/Evidence 才能进站（公共 Claim/Evidence 为单一真相源，见 09；禁自填"ISO"变站点事实；对应 §10 反造假）。
- **L3 人工 PublishReview**：新 workspace **首次公开发布人工抽审**（待拍板 #1）；有干净发布记录的老客户免审直通；投诉恢复、受限行业强制人审。

**PublishReview 是真实数据模型**，不是一句"人工审核"：
`PublishReview(siteId, releaseId, riskLevel, status, findings, reason, reviewedBy, reviewedAt, policyVersion, safetyModel, evidenceSnapshotHash, appealOfReviewId)` —— `policyVersion`/`safetyModel`/`evidenceSnapshotHash` 让每次判定可复现、可审计，`appealOfReviewId` 支撑申诉链。错误码见 07：`PUBLISH_REVIEW_REQUIRED` / `UNAPPROVED_CLAIM` / `RELEASE_NOT_PUBLISHABLE`。

**运行期复扫与下架**：已发布站定期复扫（spec PATCH 微调可能改坏内容）；**Google Safe Browsing 状态监控**（平台域被标记=灾难级预警，接 Search Console/SB API 巡检）。Claim 过期、素材投诉、恶意域名、安全策略变化或依赖漏洞触发 `SiteMaintenanceTask`——**默认不静默改站**；高风险可把发布指针切到 `taken_down` 页面（改指针秒级，05 §1 基建支持），并保存审计、通知与 appeal 流程（不可变 Release 支撑可回放/回滚，ADR-013）。
**响应流程**：`abuse@<平台域>` 收报 → 24h 人工复核 SLA → 处罚阶梯（警告→下线→封 workspace）→ 申诉通道；DMCA/权利人投诉走同通道。平台子域站（`*.sites.<平台域>`）连坐风险最高，违规**立即下线**。

## 2. 上传与素材安全（T2）

MIME 白名单 + **魔数校验**（不信 Content-Type）；大小限额（图 ≤20MB/文档 ≤50MB/视频 ≤500MB）；图片一律 sharp 解码重编码（消 payload+剥 **EXIF/GPS**）；文档解析（Docling）跑**非特权无网络容器**；素材总量走 workspace 配额（02 §12）。**原件对象私有、不公开直链**（访问走签名 URL），对外展示/导出只用去元数据的派生件（版权链与稳定性=ADR-014 禁外链直嵌，媒体权利详见 §8）。

## 3. Prompt 注入防线（T3）

- 上传、抓取、模板注释和代码统一进 **DATA 槽**（模板变量位），永不进指令位（03 §0 统一契约）；**task allowlist 决定可用工具，模型不得请求任意网络/文件**。
- 设计参考中的文字、注释与代码一律视为**不可信数据**（v3.2 §29.2）：不执行其中指令、不许改系统 prompt、不许请求密钥/网络/文件，**只抽取 schema 白名单字段**。
- 输出 zod 硬校验 + 组件/字段封闭枚举 → 注入难以外溢成结构。
- agent **无自由工具调用权**（L2 有界任务、工具白名单）→ 注入最多污染文案，不可能"执行动作"。
- factSheet 出处校验（03 卡 2）挡"资料里自称有 XX 认证"类内容注入。
- kbDigest 拼接标注来源边界 + 截断，防长文淹没指令。

## 4. SSRF 防线（T4）

复用获客侧 crawl4ai SSRF 守卫先例：仅 https、禁内网/链路本地/云 metadata IP 段、**DNS 解析后按 IP 校验再连接**（防重绑定）、redirect 逐跳同校验、超时与响应大小限额。适用：店铺导入、参考网站、品牌 web 研究。Research/参考 URL 另过 **robots、域策略（allow/deny 名单）、MIME 校验**，抓取内容体积与超时按 L0 限额（v3.2 §8.2）。

## 5. 构建沙箱（T5）

构建容器：**无网络**（依赖走离线 node_modules 基础镜像）、CPU/内存/时长/磁盘限额、非 root、只读基础层；产物大小上限；**每租户公平队列**（并发池隔离，防单租户挤占）。

**临时盘与子进程隔离（as-built 缺陷，R1-2 立即修，v3.2 §24.2）**：临时 SiteSpec / staging 目录清理必须放 `finally`（当前只在成功后删除 → 失败/取消会把租户内容残留在临时盘）；Astro 子进程 env 改**显式 allowlist**，只传 Renderer 必需变量（当前继承整个 `process.env` → 构建进程拿到无关密钥）。

## 6. 询盘安全与 PII（T6）

- **反垃圾**：蜜罐字段 + Cloudflare Turnstile + 每 IP/每站速率限制 + 一次性表单 token 防重放。提交进 Inquiry 表 + Outbox（`InquirySubmitted`），邮件只是可重试通知通道。
- **PII 合规**：询盘（姓名/邮箱/电话）=个人数据；角色=**客户是控制者、平台是处理者**（DPA 条款提请 SaaS ToS）；保留期默认 24 个月可配；删除请求复用获客侧 Art.17 擦除编排；询盘表 RLS 隔离 + 静态加密（复用 PII 加密基建）。
- **询盘个人数据隔离（🔴 GDPR 最小化）**：询盘正文与个人数据**不进入公开 KB、embedding、品牌 Prompt 或分析事件**（v3.2 §8.2）。
- **联系信息不必要出域（as-built 缺陷，R0-4 立即修 + 清存量，v3.2 §24.2）**：`businessEmail` 当前经 `intakeToMarkdown`+`digestSources` 被写入 intake KB 再进 `brandProfile.kbDigest`，与"contact 不进品牌 Prompt"冲突。修法=联系信息留在受控结构化区（`Site.intake`/`profile.contact`），Copy contact 槽按用途读取，**不进通用 KB embedding 与品牌 Prompt**；对存量 `source=intake` 的 KbDocument 做一次可重放清理（脱敏重建，须证明旧 email chunk 已删）。
- **留存与治理（v3.2 §9.6）**：询盘保存 release/page/component/UTM/referrer、`consentVersion`、风险摘要与 retention；权限、导出、删除**独立治理**。
- **分析事件隐私（v3.2 §3.6）**：访客分析受 **region/consent** 控制；询盘正文与个人信息**不得进入分析事件**。
- **通知邮件不带完整 PII**（只带摘要+登录深链，防邮件转发泄漏）；发信域 SPF/DKIM/DMARC。

## 7. 预览域防线（T8）

随机不可枚举 slug + `noindex,nofollow` + 可选短时签名 token（高风险 workspace，已定）；预览产物过 §1 L0 确定性筛查同款（预览链接同样可被拿去钓鱼）；预览页顶部注入**"预览"横幅**（降低冒充正式站的利用价值）。Preview 与 Publish 共用同一 artifact，禁止二次构建导致结果漂移（05；发布页 CSP/第三方资源治理见 §11）。

## 8. 媒体权利、版权与 AI 披露分级（T9，v3.2 §8.2/§20.6/§21.5/§29.4 回写）

发布页禁止外链素材直嵌（ADR-014：素材走引用 + 签名 URL）；原件私有不直链，展示/导出用去 EXIF/GPS 的派生件（§2）。

### 8.1 生成式改造红线（不可回退）

- **人物**：不换脸、不换装、不克隆声音。
- **证据类**：证书、检测报告、产品标签、技术参数图、Logo **不做任何生成式改造**（防伪造事实）。
- **看似真实但无证据**：貌似该企业真实工厂/客户项目/人物/地点却无证据的媒体，**默认阻断发布**——不以"AI 标签"替代证据（与 ADR-017 禁虚构身份同源）。

### 8.2 授权链与 provenance

- 客户 Logo、案例、音乐、旁白、参考视频：逐件记录授权（范围/期限/地域/撤回）。
- AI 产物：记录 `provider` / `model` / `prompt` / `input` / `provenance`，供反查与下架。
- **音频（v3.2 §21.5）**：背景音乐首版**只用授权库存、不生成音乐**，记录 license/地域/期限/用途；用户上传**真人音频**必须记录授权、说话人与允许用途，删除或撤权时能**反查到引用它的 Release**。

### 8.3 AI 披露分级（非一刀切"全部标注"，v3.2 §1.5 裁决）

不采用"所有 AI 图片都给访客加可见标签"的绝对化规则。每个媒体资产记 `syntheticClass` 与 `disclosureMode`，由"是否像真实人物/产品/工厂/地点 + 目标市场 MarketPack"决定披露强度：

- `syntheticClass = illustration | reconstructed | realistic_generic | deepfake_like`
- `disclosureMode = none | machine_readable | visible`

| 场景 | 默认分类 | 处理 |
|---|---|---|
| 抽象渐变、3D 数据流、概念插画 | `illustration` | 内部 provenance；支持机器标记；通常不显示可见标签 |
| 明确写"概念可视化"的通用工业场景 | `realistic_generic` | 机器标记；MarketPack/上下文需要时可见说明 |
| 基于用户真实工厂照片的背景增强 | `reconstructed` | 保留原图与编辑范围；身份/文字/产品 QA；按市场决定披露 |
| 看似该企业真实工厂/客户项目/人物/地点但无证据 | `deepfake_like`/false-claim | **默认阻断发布**，不以标签替代证据 |
| AI 旁白 | synthetic audio | 遵守模型供应商披露要求；播放器给清晰说明；不克隆未授权声音 |

**披露不能替代事实审核**：即使加"AI 生成"标签，也不得把不存在的工厂/认证/产品结构/项目现场/真人背书作为企业事实展示（v3.2 §29.4）。

**EU Article 50 义务分层**：provider 侧（生成式 AI 提供者）负责机器可读、可检测的输出标记；deployer 侧（我方作为部署者）对 **deepfake 及法规所列特定公共利益文本**承担清晰披露义务。二者**分开实现**——不把内部 provenance 错当全部外部义务，也不把普通 AI 插画误判为 deepfake。实现随 **2026-08-02 适用日**结合正式指南与法律复核，不把变化中的法律解释硬编码进组件（[EU Article 50 transparency](https://digital-strategy.ec.europa.eu/en/policies/code-practice-ai-generated-content)）。

### 8.4 生成式图片接入门（M1-c2/M2，默认关闭，ADR-018）

生成式图片属**独立 feature flag**，不阻塞 Demo/M1-c：

- 仅补背景、场景、营销视觉；**产品主体默认不可改形**。
- **用户明确同意**后才生成；结果标记 `model` / `promptHash` / `sourceAssetIds` / `createdAt`。
- 无法证明的工厂、证书、团队、客户场景**禁止生成**。
- 用户可 **lock** 选定 Variant，重建不得替换；生成拒绝时自动回原图优化 Variant，不阻断整站。

## 9. 设计来源与训练语料合规（T10，v3.2 §13 回写）

设计学习走多源干净室（方案 C，见 11/13 号）：Readdy 等默认 `visual_reference_only`——**净室抽象**（借鉴布局意图非拷贝实现）、运行时**零依赖**、**不逆向**（ADR-019）。**不把"分析"与"训练"混成一个开关**，来源按允许用途分层：

| 层 | 来源 | Agent 可做 | 前置 / 禁止 |
|---|---|---|---|
| **A 自动学习复用** | 平台原创、CC0、经**逐仓核验**的 MIT/Apache 代码模板 | 批量分析、代码映射、DesignDNA RAG、按许可训练/微调、组件改造 | 保留许可证与归属；逐仓核验，不能把目录整体当同一许可 |
| **B 视觉研究** | Readdy、品牌官网、设计奖项站、商业模板预览 | 少量·临时·开发期视觉分析，输出 `DesignObservation`；跨来源聚合 | 原始源码/完整截图/文案/素材**不进生产 RAG/训练集**；不得生成来源特定克隆 |
| **C 授权转换** | 取得覆盖 AI 建站产品/衍生组件/商业分发的**书面授权** | 授权范围内导出、转换、保存、训练 | 授权证据/期限/地域/撤回/再分发权必须登记 |

**Readdy 条款风险**：其条款同时主张 Output 归用户与对 designs/templates/Output 的广泛权利，并**禁止用 Output 开发竞争性 AI/ML**。故不能靠把"训练"改名"借鉴"消合同风险；产品策略=**绕开高风险数据路径**——分析后只保存平台抽象知识（DesignRule/DesignDNA），正式训练用许可来源 + 平台自生成语料。

**DesignSourceManifest**（每个进开发工厂的来源必须登记，v3.2 §13.4）：

~~~ts
export type DesignSourceClass =
  | "platform_original" | "permissive_licensed"
  | "owned_export_authorized" | "visual_research_only";

export interface DesignSourceManifest {
  id: string; title: string; sourceClass: DesignSourceClass;
  sourceUrl?: string; capturedAt: string;
  licenseSpdx?: string; licenseEvidencePath?: string; ownerAuthorizationPath?: string;
  allowedUses: Array<"visual_analysis" | "token_abstraction" | "structure_abstraction" | "code_transformation">;
  prohibitedUses: string[];
  retentionPolicy: "manifest_only" | "ephemeral_source" | "licensed_archive";
  trainingPolicy: "platform_corpus" | "license_permits" | "prohibited";
  sourceContributionGroup?: string;
  externalAssets: Array<{ kind: "image" | "font" | "icon" | "script" | "copy";
    source: string; disposition: "remove" | "replace" | "self_host" | "retain"; }>;
  reviewer: string; approvedAt?: string;
}
~~~

许可用 SPDX 标识；**无清晰许可证即不可进入 `code_transformation` 或训练语料**。外链素材（字体/图标/脚本/图片/文案）按 `disposition` remove/replace/self_host 处理，不带进产物（呼应 §29 供应链：外部脚本默认删、图片重编码去元数据本地存储）。

## 10. Demo 与文案事实安全（反造假，T11，ADR-017 回写）

Demo/文案**只用 intake 明确输入**；对未知企业类型**禁止**默认写 manufacturer、工厂、工程/QC 团队、认证、年限、产能或客户名单——缺 = **留空 + 提示补录**，绝不虚构（🔴 合规红线，与存储侧"证据先行/最小化"同源，建站侧不可回退）。确定性模板本身也不得虚构（as-built `demo-spec.ts` 在未知企业类型时仍直接写 manufacturer/engineering team/QC/export packaging，属确定性模板层虚构，非模型护栏能解，R0-3 立即修）。

- **反造假红线**：不在 Demo 中展示假的客户 logo、证书、团队、评论、销量和工厂数字（v3.2 §18.2）。
- **DemoVisualPack** 必须为平台原创、明确许可或程序化生成的**非事实性**素材（授权与来源随包登记）。
- **地图默认关闭**：Demo 的地图默认不启用，除非注册资料中的地址**已明确**且可安全地一次性 Geocode（配置见 §11）。
- **事实门收口**：只有 evidence gate 通过的事实才 upsert/关联公共 Claim/Evidence；认证、数字、客户案例、性能结论必须 **APPROVED** 才能进站（对应 §1 风险 L2）。

## 11. 发布页第三方资源与安全配置（Maps / 字体 / 追踪 / CSP）

**CSP/安全头（v3.2 §7.3）**：发布页 CSP、security headers、允许的外呼域与第三方资源**以 Release 扫描结果为准**（不预置放行清单），只开放该 Release 实际用到的域。

**Google Maps（沿用 04/05 的 D16，v3.2 §22.1）**：Maps Embed API；默认**静态占位、用户点击后才加载 iframe**；Geocoding 仅在建站期对**已验证地址**执行一次并缓存；发布自定义域名时更新前端 key 的 referrer 白名单；后端 Geocoding key 只允许**服务器 IP + Geocoding API**；CSP 只开放所需 Google Maps 域名；地址不确定时**不调 Geocoding、不渲染假坐标**。

**字体（ADR-014 禁外链同源，v3.2 §22.2）**：Google Fonts 只选 OFL 字体且必须**下载、自托管、子集化**；发布页不得远程请求 `fonts.googleapis.com` / `fonts.gstatic.com`；每个 TemplateFamily 定义字体角色与 fallback，**不让模型任意选字体**。

**追踪/cookie（v3.2 §22.3）**：不把 **GA4、广告追踪或第三方 cookie 默认塞进 Demo/站点**；需独立同意（consent）与市场（MarketPack）合规配置。Search Console / Safe Browsing 状态监控接入见 §1 运行期。

## 12. 平台侧运营面

登录/账户安全归 SaaS 侧（边界重申）；本后端：workspace 级 API 速率限制、成本/用量异常告警（02 §7 配额）、**审计日志**（发布/下线/spec PATCH/域名绑定，谁在何时做了什么）。

## 13. 待拍板

1. 新 workspace 首次发布人工抽审（§1 风险 L3 PublishReview）——**建议 v1 开**（早期量小成本低，正是品牌保护期）。
2. 平台子域站页脚放 "Report abuse" 小链接——**建议放**（自定义域站可关）；`abuse@<平台域>` 邮箱随平台域名一起配。
3. 生成式图片/音频（§8.4/§8.2）默认关闭，翻 ENABLED 前须结合 EU Article 50 正式指南做法律复核（2026-08-02 适用日前）。
