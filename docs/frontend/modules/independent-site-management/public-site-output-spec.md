# 独立站公开输出规范

> 文档 ID：`FE-SITE-003`
> 层级：`L2 / Public output target specification`
> 生命周期：`ACTIVE_INPUT`
> 评审状态：`APPROVED_AT_GATE_5`
> 内容 Owner：`OWN-PRODUCT`
> Runtime Owner：`OWN-SITE-BE`
> 关联：`CAP-SITE-PUBLIC-OUTPUT-001`、`PAGE-FE-057`、`SCN-FE-SITE-016..023`、`BLK-FE-007`

## 1. 边界与结论

公开站是独立站管理生成的版本化输出，不是 SaaS 管理面。当前 main 有 SiteSpec 1.0.0 TypeScript 合同、Astro 静态 renderer、10 个组件、两个 style preset、immutable SiteRelease 地基、active READY 开发预览和完整性门；没有公网 Publish/Domain/SSL/rollback、Inquiry receiver 或生产 analytics。

| Surface | 当前状态 | 用户表达 |
|---|---|---|
| SaaS 管理前端 | 正式 repo/实现未知 | 创建、准备、Build、恢复和审看对象 |
| Development Preview | internal resolver + active READY substrate | “这是开发预览，不是已公开发布的网站” |
| Public site service | `TARGET_NOT_RUNNABLE` | 只有 Publish/Domain/health/rollback 证据完备后才可称上线 |
| Inquiry receiver | `disabled_until_m2` | 不显示可提交成功承诺；表单必须禁用或替换为明确说明 |

## 2. 输出对象合同

```text
Approved Company/Offering/Claim/Evidence/Asset
→ immutable PublishableClaimSnapshot + BrandProfile + CopyBundle
→ SiteVersion / SiteSpec 1.0.0
→ Astro renderer
→ immutable SiteRelease(manifest + digest + artifacts)
→ active READY development preview
→ [future PublishReview + execution authorization]
→ [future public service + domain + health + rollback]
```

- 公开文案中的关键事实必须引用获准 Claim/Evidence；推断、建议和风格文案不能伪装成认证事实。
- Snapshot/CopyBundle 是派生输入，不得反向覆盖 Company/Claim SoR。
- Release manifest/digest/artifacts 不可变；修订产生新 Version/Build/Release，不原地覆盖旧产物。
- Build 和 renderer 只消费稳定合同。前端编辑器未来也必须通过版本化 SiteSpec runtime validation，不能直接写任意 JSON。

## 3. 页面与组件

当前 registry 有 10 个 renderer 组件：

| Component | 用户目的 | 必要内容/状态 | 安全与 a11y 要求 |
|---|---|---|---|
| `HeroBanner` | 迅速说明企业提供什么 | 一条有证据的价值主张、主 CTA、可选视觉 | H1 唯一；背景不承载唯一文字；CTA 目标有效 |
| `StatsBand` | 展示可信规模/能力 | 数值、单位、范围、Evidence ref | 无证据不显示；列表语义；不以动画计数替代值 |
| `ProductGrid` | 浏览 Offering | 名称、摘要、关键规格、图片/占位 | 卡片标题层级；图片 alt/尺寸；当前 initials 占位须披露 |
| `AboutBlock` | 理解企业/工厂 | 审核后的简介和媒体 | 不生成虚构历史、客户或身份 |
| `CertWall` | 查看认证/信任 | 认证名、范围、状态、证据/素材 | expired/revoked 不显示为有效；徽标权利检查 |
| `ProcessTimeline` | 解释制造/服务流程 | 有序步骤、说明 | 有序列表；移动端保持顺序；不只用线条/颜色 |
| `FaqAccordion` | 回答购买疑问 | 问答和事实 refs | 原生 button/expanded 语义；键盘/焦点可用 |
| `CtaBanner` | 给出下一步 | 明确动作和可用渠道 | 不出现不可用 Inquiry 提交；外链可识别 |
| `InquiryForm` | 未来接收询盘 | 字段、同意、错误、状态 | 当前 disabled；现有 placeholder 不能视为 label/a11y 完成 |
| `MapLocation` | 表达位置/服务范围 | 审核后的地址/区域 | 不泄漏个人位置；地图失败仍有文本；第三方 consent 待定 |

未知组件必须在 Release promotion 前 fail-closed。当前 `Section.astro` 直接渲染路径会跳过未知组件，因此 public/preview 服务只能消费通过 `assertReleaseContract` 的 Release；不得绕过该门把“页面还能打开”当正确结果。

## 4. 内容与事实安全

| 内容类型 | 允许来源 | 输出规则 |
|---|---|---|
| 企业身份、地点、成立时间 | approved Company Claim/Evidence | 无证据留空或使用非事实型占位，不编造 |
| 产品规格/能力 | approved Offering/Claim + applicability | 标明单位、范围、适用市场和证据版本 |
| 认证/测试/标准 | approved Claim + Asset/Evidence | 显示有效期/范围；过期、撤销、冲突 fail-closed |
| 客户/案例/Logo | 明确授权的 Asset + Claim | 无权利证明不输出；不从抓取素材自动复用 |
| AI 生成价值主张 | BrandProfile/CopyBundle + Evidence refs | 标为草稿直到审核；不能扩大事实语义 |
| 联系信息 | approved business contact + locale/market policy | 个人数据默认不公开；用途和同意遵守市场政策 |

Claim 在 Build 后撤销时，至少阻止新 Build 继续使用。对已 active preview/未来 live 站点的紧急影响评估、下线或回滚属于 `BLK-FE-004/007`，不能由前端定时隐藏代替服务端处置。

## 5. Asset 输出

- 原始上传、派生 Variant、裁剪/格式、alt、rights/provenance 和使用范围分开记录；页面只引用可公开用途的 Variant。
- 目标输出使用 `<picture>`/`source`，提供现代格式与安全 fallback，并固定 `width/height` 或 aspect-ratio 防 CLS。
- 首屏 Hero 只预加载实际 LCP 候选；其余图片 lazy load，避免无差别预加载。
- alt 由内容目的决定：信息图描述内容，装饰图空 alt，认证图同时有可读名称/范围；文件名不作为 alt。
- 当前 renderer 尚未消费 `AssetVariant`/`<picture>`，不能标为已实现；`ProductGrid` initials 占位也不能冒充产品图。
- 删除 Asset 前必须验证 active/future Release、SiteSpec 和 Claim Evidence 引用；物理清理不能破坏不可变 Release 的可恢复性。

## 6. Locale、方向与翻译

| 能力 | 当前事实 | Phase 5 规则 |
|---|---|---|
| 生成 locale | `en`、`de-DE`；必须先 `en` | SaaS 选择器只提供服务端枚举；不自由输入 |
| renderer locale | `en`、`de-DE`、`ar` | `ar` 仅 renderer smoke，不列为可生成能力 |
| 文档方向 | Base 按 locale 设置 `lang/dir` | 每页根元素必须正确；RTL 组件需真实视觉/a11y 测试 |
| optional locale degraded | 可部分失败 | 主语言保留；列出缺失段落和回退，不宣称全语言完成 |
| 翻译与事实批准 | 两个独立维度 | 翻译通过不能批准事实；Claim 批准也不能证明翻译正确 |

目标 public SEO 为每个 locale 使用稳定 URL、canonical 与 hreflang 映射；当前 Base 只有 `lang/dir/title/description/noindex`，canonical/hreflang 未建。

## 7. SEO 与可发现性

### Development Preview

- 保持 `noindex`，不生成可被误传播的 canonical/public sitemap 承诺。
- 页面标题可带 Site 名称和“开发预览”；管理条不进入站点内容语义。
- 预览 URL 的访问控制、TTL、分享政策和生产域仍缺，不能称“安全分享链接”。

### Future Public Site

Public Release Gate 需要：

1. 每页唯一 title、description、canonical；locale 页 hreflang/x-default 一致；
2. robots、sitemap、404/410、redirect 和旧 URL 策略；
3. 结构化数据只使用获准事实，schema 类型与页面内容一致；
4. link/image/font 资源完整性、缓存和 immutable asset policy；
5. Publish 后健康检查能验证 HTML、关键资源、canonical、noindex 移除和主要 CTA；
6. 回滚保留旧健康版本和 URL 一致性。

这些均是目标门，不能从 Astro 静态构建能力推导生产完成。

## 8. Accessibility

目标为 WCAG 2.2 AA，至少包括：

- 语义 landmark、唯一 H1、顺序标题、skip link、可见焦点、键盘可操作；
- 200% zoom 与 320 CSS px reflow 无双向滚动（必要数据表除外）；
- 文本/非文本对比、reduced motion、触控目标和方向变化支持；
- 表单持久 label、指令、字段错误、error summary、状态确认和防重复提交；
- accordion/menu/dialog 使用原生语义优先，ARIA 与实际行为一致；
- locale/dir/读屏文本正确，动态内容不高频打断；
- 发布前自动检查 + 键盘 + 主流读屏/浏览器人工证据。

当前 `InquiryForm` 使用 placeholder 且 receiver disabled，因此不能通过目标表单 a11y Gate；在 M2 前应禁用交互或以非表单联系说明替代。

## 9. 性能与可靠性

- 目标使用真实生产分布的 LCP/INP/CLS 第 75 百分位；具体 SLO、设备/网络和观测窗口由 Data/Frontend Owner 批准。
- Build-time 预算：每页 HTML/CSS/JS/媒体 manifest 可审计；组件默认静态，只有确需交互的局部 hydrate。
- Font 有权利、子集、preload 与 fallback 策略；不得因品牌字体阻塞首屏或产生大布局漂移。
- 所有关键资源带 immutable identity/digest；对象缺失、hash 错或 manifest 不一致 fail-closed。
- 第三方 script 默认不引入；地图、analytics、chat、cookie manager 需目的、consent、region、retention、CSP 和 exit plan。
- Production Release Bundle 需记录 build hash、manifest、健康检查、a11y/perf/security 证据和 rollback owner。

## 10. Security、Privacy 与合规

- 公开输出只包含被明确授权公开的字段/Asset/Claim；管理 API token、Workspace ID、内部对象 key、Prompt、trace 和 error details 不进入静态产物。
- 输出 HTML 对用户/AI 文本做上下文转义和 URL 协议校验；不允许 arbitrary script/HTML 注入。
- CSP、security headers、dependency provenance、SRI/asset policy、abuse/WAF 和区域策略由 future public service Owner 定义。
- Inquiry 上线前必须有 data controller/notice/consent、字段最小化、anti-abuse、重复处理、保留/删除、DSR、投递 ACK 和 incident SOP。
- Analytics 上线前必须有 event schema、合法目的、consent/opt-out、bot、timezone、retention、vendor/region 和 Data Owner；Phase 5 不接 SDK。

## 11. Publish/Domain/Inquiry Readiness 门

| Gate | 必需证据 | 当前 |
|---|---|---|
| Runtime contract | SiteSpec runtime validator、known component、manifest/digest | `PARTIAL`；TypeScript contract/Release precheck 有，通用 runtime validator 缺 |
| Content truth | Claim review/impact/approval/withdrawal | `BLOCKED` `BLK-FE-004` |
| Visual/a11y | 受控设计源、组件、responsive/a11y review | `BLOCKED` `BLK-FE-002` |
| Public activation | PublishReview/auth/public routing/health/rollback | `BLOCKED` `BLK-FE-007` |
| Domain | ownership/DNS/cert/renewal/incident | `BLOCKED` `BLK-FE-007` |
| Inquiry | receiver/consent/anti-abuse/outbox/SaaS ACK/DSR | `BLOCKED` `BLK-FE-007` |
| Analytics | schema/privacy/retention/Data Owner/observability | `BLOCKED` `BLK-FE-005/007` |
| Operations | actual QA/Ops/Security/Commercial sign-off | `BLOCKED` `BLK-FE-006` |

在上述门关闭并有运行证据前，本规范的 target 部分不能进入“Dev-Ready、production-ready 或已发布”状态。
