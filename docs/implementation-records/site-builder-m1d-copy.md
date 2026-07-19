# Site Builder M1-d — 多语种、事实受限文案实施记录

> 状态：2026-07-19 已在独立 Codex worktree 实施并通过 Ubuntu 开发环境验证；不代表生产部署。仓库活文档与代码仍优先于本记录。

## 1. 边界与结论

M1-d 已把 R4-A2 的内部 Claim/Evidence bridge 变成正式文案消费门，并复用 R4-B-min 的 task-attempt/spend ledger；没有重新开展 MODEL-1 或 R4-B。上线生成 locale 冻结为 `en`（source/default）与 `de-DE`，`ar` 只作为 renderer RTL 合同/构建 smoke，不接受 build 生成请求。

范围外保持不变：M1-e 组件/可见预览、R1-min 生产 Release、M1-f/g、M2 公网询盘接收/投递、DI-0 设计研究、MODEL-2。

## 2. PublishableClaimSnapshot v1

- 每个 BuildRun 至多一个不可变 snapshot；空集合合法，走确定性中性文案，不调用模型。
- 候选必须同时满足：`APPROVED`、未到期、human-review proof 可重算、精确 `Site + CompanyProfile + BrandProfileClaimBridge + EvidenceRef + Evidence + frozen source hash/quote/selector`，认证另须 live ready cert Asset。
- manual/legacy 或任何没有 exact Site bridge 的 Claim 不进入 snapshot；不按名称猜 Site/Company 身份。
- digest 对稳定排序后的完整快照信封做 SHA-256。激活事务重新锁定相关 Claim，比较 status/version/validity/bridge/cert proof 与当前 publishable 集；撤销、到期、新批准或 bridge 漂移均令指针保持不动。
- 两张表 FORCE RLS、`app_user` 仅 `SELECT/INSERT`、UPDATE trigger 拒绝改写；迁移不回填旧 factSheet。

## 3. CopyBundle v1

权威合同为 `site-builder-copy-bundle/v1` + `site-builder-copy-slots/v1`：每个 `SiteVersion + locale` 唯一，绑定 snapshot、BuildRun、locale task attempt、input hash 与 bundle digest。

槽位类型包含 plain/rich/SEO/CTA/form/alt/legal；预算按 Unicode grapheme 硬判，超限拒绝而非截断。restricted rich text 只允许 doc/paragraph/text/strong/em/list/link，禁 raw HTML；外链须命中精确 HTTPS host allowlist。factual slot 必须引用 snapshot Claim，未知/重复 ref 拒绝；任何带 Claim ref 的文本由代码重建为引用 Claim statement 的逐字确定性表示（多条固定以 ` · ` 连接），模型不能追加、翻译或润色断言。数值、单位与认证 token 另作不变保护。

SiteSpec 保留一个迁移周期的 `copyBundles` 字符串投影，并新增权威 `copyBundleSet`。新集合存在时 reader 绝不回退 legacy；缺 locale/key 直接构建失败。历史 1.0 行无新集合时继续可读，不伪造 provenance、不批量回填。

## 4. Temporal 与模型

- 新 workflow 历史在 assembly 前 capture snapshot，再逐 locale 建 `site_builder.copy:<locale>` logical task attempt；物理模型调用仍使用既有 `site_builder.copy` route，未改 currentRoute、promotion evidence 或 MODEL-1 transport。
- 同一 locale 的全部 slot 合并为一次 structured task，冻结 input/output/result；provider ACK unknown、预算/状态/取消门继续沿用 R4-B fail-closed 语义。
- default/source locale 失败阻断；可选 locale 失败从本 SiteVersion 省略并记录 degraded，renderer 不生成该路径。
- authoritative SiteSpec 的 page/section/pages 局部构建必须显式请求完整 active locale 集，且候选 locale/bundle/source-default 集合须再次完全一致；否则 API 提前 422，assembly 仍二次 fail-closed，不能把既有非默认语种静默删掉。
- 空 snapshot 不把 intake/factSheet 送模型，而由版本化 task attempt 持久化中性 en/de-DE 文案；避免“无事实时让模型自由发挥”。
- `SiteVersion` 与 `SiteCopyBundle` 同事务写入；激活前核对 bundle locale/digest 和 snapshot 当前性。

## 5. Renderer 与 inquiry 边界

- 默认 locale 保持无前缀，其他 locale 使用 `/{locale}/...`；每页精确 `html[lang][dir]`。方向来自冻结 locale registry，不由模型判断。
- Noto Sans / Noto Sans Arabic 由 Fontsource 自托管打包；构建后扫描 HTML/CSS/JS 等文本产物，任何非 allowlist HTTPS host、HTTP 或 protocol-relative 外链均失败。
- 明示 locale/key 缺失不返回英文 200。`ar` fixture 验证 RTL 与本地 Arabic font，但当前不开放 copy generation。
- 只新增 versioned inquiry form、consent notice ref 与未来 `site_builder.inquiry.submitted` v1 payload 类型。表单仍 disabled；没有公网 endpoint、Inquiry 表、anti-abuse、recipient delivery 或 outbox emission，这些仍属 M2。

## 6. R1-min / DI-0 稳定接口

- R1-min 的未来 ReleaseManifest 必须冻结：snapshot id/digest、每 locale bundle digest/inputHash/status、实际 locale route manifest、renderer/font/catalog versions。M1-d 不实现对象存储 Release、跨节点恢复/回收或 unknown component 门。
- DI-0 可引用 `slotCatalogVersion`、slot type/budget 与 locale registry做布局适配；不得提供事实、改写 Claim refs、放宽预算或覆盖 CopyBundle。当前 `codex/template-distillation` 与 renderer 有文件热点，合并时须以这两个稳定合同协调，不接管其实现范围。

## 7. 迁移与验证

- forward-only migrations：`20260719220000_site_builder_m1d_claim_snapshot`、`20260719223000_site_builder_m1d_copy_bundle`。回滚先部署 legacy-only reader/writer，确认无新行后再另作 forward cleanup；不反向 DROP。
- 隔离空库从零顺序应用 77 migrations 成功；三张新表均确认 ENABLE+FORCE RLS、应用角色仅 SELECT/INSERT、immutable trigger 生效。随后 additive migration 已部署 Ubuntu `global_dev`。
- `verify-site-builder-m1d.mts` 在 app_user RLS 下真实完成：空 snapshot → 中性 en/de-DE bundle → Astro build → activation recheck → 跨 workspace 不可见，并清理数据库/预览夹具。
- renderer 真实三语 build 产出 `/`、`/de-DE/`、`/ar/`，lang/dir 正确、字体为本地 woff/woff2、无外链；CI 固定运行 renderer locale 单测与该 smoke build。

已知门：带已批准 Claim 的 de-DE 模型路径尚无独立 task-shaped 质量晋级证据，因此仍走现役 copy currentRoute，并继续受 deterministic bundle gate 与 R4-B hard cap 约束；在出现可审计的 claim-localization 合同前，事实 statement 即使位于 de-DE bundle 也保持原文，只有非事实槽本地化。不得据此宣称 MODEL-1 晋级或生产流量验证。
