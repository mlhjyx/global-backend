# Phase 9 Page Manifest 2.0

> 文档 ID：`DESIGN-FE-P9-007`
> 层级：`L2 / Page design registry`
> 状态：`DRAFT`
> 产品 Owner：`OWN-PRODUCT`
> 设计 Owner：`OWN-DESIGN`
> 最后核验：2026-07-23

## 1. 目的与状态边界

本文件为现有 76 个稳定 `PAGE-FE-*` 建立 Page Manifest 2.0 设计登记。它把页面的用户任务、对象/投影、SoR、产品状态、合同、场景、进入/主动作/退出、关键状态和 Figma 去向连在一起，但不改变 [Page 与 Capability 目录](../../frontend/04-page-and-capability-catalog.md)的稳定 ID 或产品事实。

状态解释：

- `CODE_BACKED`：后端合同/代码有证据，仍不表示正式 SaaS 前端存在；
- `APPROVED_NOT_BUILT`：体验方向已批准，页面和公开合同未实现；
- `FROZEN_MAP_ONLY`：保留完整设计地图，不恢复 Buyer Intelligence 新开发；
- `TARGET_NOT_RUNNABLE`：目标体验可设计，但当前不可作为可运行能力提供；
- `BLOCKED`：缺少 SoR、权限、公共合同、隐私或运行证据；
- `CANDIDATE`：尚未取得稳定 Page ID。

任何页面只有 Figma Frame、截图、Mock 或 API 时，都不能标记为 `AVAILABLE`。

## 2. 全局 Manifest 合同

每个页面统一继承以下字段：

| 字段 | 固定规则 |
|---|---|
| Workspace / actor | 所有 SaaS 页先验证 Workspace、角色、数据范围和服务端 `allowed_actions`；公共页另建匿名/身份边界 |
| canonical route | 刷新、新标签页和深链必须回到 canonical object；聚合页不拥有源状态 |
| entry / exit | 入口说明来源和 Workspace；退出返回安全目标，不恢复无权缓存或泄露对象存在性 |
| state axes | 业务、任务、同步、证据、新鲜度、权限分别表达；禁止一个绿色 Badge 概括全部 |
| required states | normal、empty、loading、partial、degraded、stale、denied、conflict、offline；长任务补 ACK unknown、cancel-confirming、late result |
| responsive | 1440/1280 桌面，1024/768 平板，390/320 手机；重编辑器移动端只支持审批/监控/接力 |
| accessibility | WCAG 2.2 AA；键盘、焦点恢复、错误摘要、live region、拖拽替代、200%/400% zoom |
| i18n | 中文优先；验证英文、德语长文本、RTL、时区、币种和服务端真实 locale capability |
| metrics / guide | 未登记 `MetricDefinition/GuideManifest` 时显示 `NONE/BLOCKED`，不填伪 KPI 或虚假教程 |

## 3. Shell、协作与企业资料

| Page | 用户任务 / 主要角色 | 对象或投影 / SoR | 产品与合同状态 | Scenario | 进入 → 主动作 → 退出 | 特有状态 | Figma |
|---|---|---|---|---|---|---|---|
| `PAGE-FE-001` 登录/会话入口 | 安全进入产品 / 所有用户 | Session/JWKS 投影 / 身份平台 | `TARGET_NOT_RUNNABLE`；本仓不发 token | `SCN-FE-SHELL-001` | 公共入口 → 登录/恢复 → 安全 return target | 过期、MFA、锁定、恢复失败 | `FIG-P9-005 activation representative 8:2 / Proto 9:2→9:45 / PROPOSED` |
| `PAGE-FE-002` Workspace 选择/切换 | 进入正确租户 / 多 Workspace 用户 | Workspace/Membership / SaaS | `TARGET_NOT_RUNNABLE` | `SCN-FE-SHELL-001/002` | 登录/切换器 → 选择 → 清缓存后进入目标 | 无权、切换失败、离线保留原 Workspace | `FIG-P9-005 activation representative 8:2 / PROPOSED` |
| `PAGE-FE-003` 今日 | 找到现在最重要的行动 / Operator | Task/Approval/Incident/Run read model / 各源 SoR | `MIXED / TARGET_NOT_RUNNABLE`；Site 局部可投影 | `SCN-FE-SHELL-003/004` | Shell → 打开源对象/继续任务 → canonical object | 聚合 partial、stale、source unavailable | `FIG-P9-004 Normal 6:2 / Degraded 18:2 / Mobile 20:2 / Proto 22:142` |
| `PAGE-FE-004` 全局搜索/命令面板 | 跨域找到对象和动作 / 全员 | Search projection / SaaS | `TARGET_NOT_RUNNABLE` | `SCN-FE-SHELL-001/002` | Shell/快捷键 → 搜索/打开 → 对象深链 | 无结果、无权结果隐藏、索引 stale | `NOT_CREATED` |
| `PAGE-FE-005` 通知中心 | 理解变化并恢复上下文 / 全员 | Notification projection / SaaS | `TARGET_NOT_RUNNABLE` | `SCN-FE-SHELL-003/004` | 顶栏 → 查看来源 → canonical object | 重复、已读同步、源已删除 | `NOT_CREATED` |
| `PAGE-FE-006` 任务/待办中心 | 分派、完成或转交任务 / Operator | Task / SaaS | `TARGET_NOT_RUNNABLE` | `SCN-FE-SHELL-003/004` | Today/对象 → 更新任务 → 返回源对象 | 过期、冲突、Owner 变更、批量部分失败 | `NOT_CREATED` |
| `PAGE-FE-007` 审批中心 | 基于证据做决定 / Approver | Approval 投影；决定写回源对象 / SaaS+Truth | `BLOCKED`；Claim public review 缺 | `SCN-FE-SHELL-003` | 通知/Today → 审阅 Evidence/diff → 源对象 | 无权、已被他人决定、证据撤销 | `NOT_CREATED` |
| `PAGE-FE-008` 异常与恢复中心 | 从失败/降级中恢复 / Operator | Incident/Run projection / 各源 SoR | `TARGET_NOT_RUNNABLE` | `SCN-FE-SHELL-004` | 告警 → 诊断/恢复 → 原对象 | partial、stale、late result、运营升级 | `NOT_CREATED` |
| `PAGE-FE-009` 长任务中心 | 跨设备监控/取消/重试 / Operator | Async Run projection / 各源 SoR | `TARGET_NOT_RUNNABLE`；Build 子集 code-backed | `SCN-FE-SHELL-004`、`SCN-FE-SITE-013..015` | 对象 → 监控/取消 → 结果或源对象 | ACK unknown、cancel-confirming、部分失败 | `NOT_CREATED` |
| `PAGE-FE-010` 帮助、反馈与支持 | 自助解决或提交诊断 / 全员 | Guide/Support case / SaaS | `TARGET_NOT_RUNNABLE` | `SCN-FE-SHELL-001..004` | Help → Tutorial/How-to/诊断 → 原任务 | 无指南、脱敏诊断、支持不可用 | `FIG-P9-005 node 6:2 / PROPOSED` |
| `PAGE-FE-020` 企业资料主页 | 管理最少企业资料与缺口 / Owner、Content | CompanyProfile projection / Site BE | `MAP_ONLY / PARTIAL_BACKEND` | `SCN-FE-TRUTH-001/003`、`SCN-FE-SITE-003` | Onboarding/Shell → 编辑通用组 → Site/内容消费者 | ETag 冲突、动态 gap、来源 stale | `FIG-P9-004 onboarding representative 31:2 / CODE_BACKED_SUBSET` |
| `PAGE-FE-021` 产品/服务目录 | 管理可复用 Offering / Owner、Content | Offering / Site BE + SaaS target | `NEXT_SITE/CROSS_DOMAIN` | `SCN-FE-TRUTH-001` | 企业资料 → 编辑/关联来源 → Site/Content | 空目录、批量导入 partial、Claim 缺 | `NOT_CREATED` |
| `PAGE-FE-022` 企业事实审查 | 审阅候选 Claim / Approver | Claim/Evidence / Truth BE | `FIRST_VERTICAL_BLOCKED` | `SCN-FE-TRUTH-001/002`、`SCN-FE-SITE-009/010` | gap/通知 → 批准/拒绝/冲突 → 影响范围 | withdrawn、expired、conflict、无 allowed action | `NOT_CREATED` |
| `PAGE-FE-023` Evidence Drawer | 检查来源、范围、时效 / 全域角色 | Evidence read model / Truth BE | `MAP_ONLY / PARTIAL_BACKEND` | `SCN-FE-TRUTH-001..003` | 任意 Claim/建议 → 查看锚点 → 返回调用页 | source unavailable、stale、redacted | `NOT_CREATED` |
| `PAGE-FE-024` 企业知识与资料 | 上传/导入并复核抽取 / Content | Asset/KbDocument/KnowledgeSource / Site BE | `CODE_BACKED SUBSET` | `SCN-FE-SITE-004..008`、`SCN-FE-TRUTH-003` | 企业/Site → 上传/重试/复核 → Profile/Build | duplicate、rejected、failed_retryable、partial | `FIG-P9-004 node 23:2 / CODE_BACKED_SUBSET` |
| `PAGE-FE-025` Buyer Trust / 动态缺口 | 把缺口转成行动，不建立准备度聚合 / Owner | gaps/completeness projection / Site BE | `TARGET_EXTERNAL`；独立 Readiness 已拒绝 | `SCN-FE-SITE-003/008/009` | Onboarding/Today → 补充/跳过 → 来源页 | 无分数、待审核、按行业动态变化 | `NOT_CREATED` |
| `PAGE-FE-026` 资产对象详情 | 查看处理、引用与删除影响 / Content | Asset / Site BE | `NEXT_SITE/CROSS_DOMAIN` | `SCN-FE-SITE-004..007` | 资料列表 → 查看/删除请求 → 引用对象 | processing、referenced、cleanup pending | `NOT_CREATED` |

## 4. 站点管理

| Page | 用户任务 | 对象 / SoR | 产品与合同状态 | Scenario | 进入 → 主动作 → 退出 | 特有状态 | Figma |
|---|---|---|---|---|---|---|---|
| `PAGE-FE-030` 站点列表 | 找到/创建站点 | Site / Site BE | `FIRST_VERTICAL` | `SCN-FE-SITE-001/002` | Shell → 选择/新建 → Site 概览 | empty、creating、无权 | `NOT_CREATED` |
| `PAGE-FE-031` 站点概览 | 了解当前版本、任务和下一步 | Site + projections / Site BE | `FIRST_VERTICAL` | `SCN-FE-SITE-011..017` | 列表/Today → 继续工作 → 对象详情 | active/candidate、degraded、old preview retained | `NOT_CREATED` |
| `PAGE-FE-032` 首次建站 Intake | 最少输入后安全创建 | CompanyProfile+Site+Build / Site BE | `CODE_BACKED` | `SCN-FE-SITE-001/002` | Onboarding → 幂等提交 → Demo/概览 | ACK unknown、payload conflict、timeout | `FIG-P9-004 onboarding representative 31:2 / Proto 32:2→32:119` |
| `PAGE-FE-033` Demo 准备/引导卡 | 理解 Demo 边界和缺口 | Site/Build projection / Site BE | `FIRST_VERTICAL` | `SCN-FE-SITE-001/014` | Intake → 查看进度/补资料 → Preview/资料 | generating、failed old preview、无虚构身份 | `NOT_CREATED` |
| `PAGE-FE-034` 建站资料向导 | 动态补充资料和目标 | Profile/Asset/KB / Site BE | `CODE_BACKED SUBSET` | `SCN-FE-SITE-003..008` | Site → 填写/上传/跳过 → 资料中心 | ETag conflict、partial KB、dynamic gaps | `FIG-P9-004 onboarding 31:2 / extraction review 23:2 / Proto 32:2→32:119` |
| `PAGE-FE-035` 站点资料中心 | 管理站点可消费资料 | Asset/KB/Claim projection / Site+Truth | `FIRST_VERTICAL` | `SCN-FE-SITE-004..010` | Site → 复核/补充 → Build | 来源过期、Claim blocked、引用影响 | `NOT_CREATED` |
| `PAGE-FE-036` 上传任务详情 | 恢复单个上传流程 | Asset upload run / Site BE | `CODE_BACKED` | `SCN-FE-SITE-004..006` | 上传队列 → 重试/重新 presign → Asset | URL expired、commit ACK unknown、duplicate | `NOT_CREATED` |
| `PAGE-FE-037` 站点知识状态 | 查看文档级处理和 gaps | KbStatus/KbDocument / Site BE | `CODE_BACKED SUBSET` | `SCN-FE-SITE-008` | 资料中心 → 重试失败文档 → Profile/Build | queued/parsing/chunking/embedding/partial | `NOT_CREATED` |
| `PAGE-FE-038` 站点事实/认证审核 | 决定公开 Claim | Claim/Evidence / Truth BE | `BLOCKED` | `SCN-FE-SITE-009/010` | 发布检查/资料 → 审核 → 影响页 | expired/revoked/conflict/无权 | `NOT_CREATED` |
| `PAGE-FE-039` 素材引用与删除影响 | 安全解除引用或保留 | Asset reference projection / Site BE | `NEXT_SITE` | `SCN-FE-SITE-007` | Asset → 查看消费者/解除 → Asset/Site | referenced、tombstone、cleanup pending | `NOT_CREATED` |
| `PAGE-FE-040` 生成配置 | 选择服务端允许的 scope/style/locale | Build request / Site BE | `CODE_BACKED` | `SCN-FE-SITE-011/012/018` | Site → 校验并启动 → Build 详情 | unsupported、active conflict、budget hard cap | `NOT_CREATED` |
| `PAGE-FE-041` Build 任务详情 | 监控步骤、成本和结果 | BuildRun / Site BE | `CODE_BACKED` | `SCN-FE-SITE-013..015` | Today/Site → 取消/重试/预览 → Preview | degraded、cost unknown、ACK unknown | `NOT_CREATED` |
| `PAGE-FE-042` Build 失败恢复 | 保留旧结果并恢复新候选 | BuildRun + active Version / Site BE | `CODE_BACKED` | `SCN-FE-SITE-014/015` | 异常中心 → 重试/补资料 → Build/Preview | old preview retained、late result、cancel | `NOT_CREATED` |
| `PAGE-FE-043` 开发预览 | 查看完整且 noindex 的开发产物 | Preview resolver / Site BE | `CODE_BACKED` | `SCN-FE-SITE-016/017/018` | Build/Site → 查看/返回修改 → Editor/Build | digest fail、object missing、locale degraded | `NOT_CREATED` |
| `PAGE-FE-044` Build 成本详情 | 理解 reported/estimated/unknown | CostSummary / Site BE | `NEXT_SITE SUBSET` | `SCN-FE-SITE-012/013` | Build → 查看明细 → Build | unknown settlement、fallback stopped | `NOT_CREATED` |
| `PAGE-FE-045` 站点结构编辑器 | 编辑页面结构并生成候选版本 | Site design target / Product+Site | `APPROVED_NOT_BUILT` | `SCN-FE-SITE-011/013` | Site → 编辑/请求生成 → Build | 未保存、冲突、目标动作禁用 | `FIG-P9-004 Normal 9:2 / Offline 18:146 / Mobile Handoff 20:40 / Proto 22:282` |
| `PAGE-FE-046` 内容/多语言编辑器 | 审核来源与语言变体 | Site content target / Product+Truth | `APPROVED_NOT_BUILT` | `SCN-FE-SITE-010/018` | Editor → 编辑/送审 → Preview | untranslated、fallback、Claim revoked | `NOT_CREATED` |
| `PAGE-FE-047` 风格与主题 | 选择受控 DesignDNA/变体 | DesignBrief/Family target / Product | `APPROVED_NOT_BUILT` | `SCN-FE-SITE-011/012` | Site → 选择允许变体 → Build | unsupported family、budget、preview diff | `NOT_CREATED` |
| `PAGE-FE-048` 版本历史与对比 | 比较、激活或回滚版本 | Release/Version target / Product | `TARGET_NOT_RUNNABLE` | `SCN-FE-SITE-019` | Site → 比较/激活 → Site | CAS conflict、retained rollback、stale | `NOT_CREATED` |
| `PAGE-FE-049` 发布前检查 | 汇总 Claim/Asset/locale/legal gate | PublishReview target / Product | `TARGET_NOT_RUNNABLE` | `SCN-FE-SITE-020` | Site → 修复/授权 → Publish | partial、expired Claim、form/legal block | `NOT_CREATED` |
| `PAGE-FE-050` 发布与回滚 | 对公网发布并保留旧站 | Deployment/Release target / Product | `TARGET_NOT_RUNNABLE` | `SCN-FE-SITE-019/020` | Review → 发布/回滚 → 公网站/历史 | publish fail old site retained、emergency down | `NOT_CREATED` |
| `PAGE-FE-051` 域名与 SSL | 验证绑定、DNS 和证书 | DomainBinding/Certificate target / Product | `TARGET_NOT_RUNNABLE` | `SCN-FE-SITE-021` | 发布 → 验证/重试 → 站点设置 | propagation、ownership fail、certificate fail | `NOT_CREATED` |
| `PAGE-FE-052` 站点设置 | 管理站点级配置和退出 | Site settings / Product | `NEXT_SITE` | `SCN-FE-SITE-019..021` | Site → 保存/导出/关闭 → Site | denied、danger confirm、export pending | `NOT_CREATED` |
| `PAGE-FE-053` 询盘表单设置 | 配置同意、字段和反滥用 | Inquiry form target / Product+Privacy | `BLOCKED` | `SCN-FE-SITE-022` | Site → 配置/预览 → PublishReview | consent missing、spam rule、receiver absent | `NOT_CREATED` |
| `PAGE-FE-054` 站点询盘 | 查看投递和会话映射 | Inquiry projection / Product+Conversation | `BLOCKED` | `SCN-FE-SITE-022` | 通知/Site → 核对/分派 → Inbox | duplicate、spam、delivery fail、DSR | `NOT_CREATED` |
| `PAGE-FE-055` 站点分析 | 理解可信访问与转化 | Metric projection / Data | `TARGET_NOT_RUNNABLE` | `SCN-FE-SITE-023` | Site → 下钻 → 页面/询盘 | no data、bot、sampling、consent denied | `NOT_CREATED` |
| `PAGE-FE-056` 站点诊断 | 诊断旧站和运行问题 | Diagnostic target / Product | `DEFERRED M3+` | `SCN-FE-SITE-023` | Site → 运行诊断 → issue/guide | unsupported、partial、privacy redaction | `NOT_CREATED` |
| `PAGE-FE-057` 公开站输出规范 | 约束生成站输出，不是 SaaS 导航页 | Static output contract / Renderer | `MODULE_OUTPUT / PARTIAL_BACKEND` | `SCN-FE-SITE-016..018` | Build → 生成/验证 → Preview/Release | integrity fail、locale fallback、noindex | `FIG-P9-006 node 3:10 / DESIGN_FIXTURE` |

## 5. 客户开发、增长、互动与洞察

| Page | 用户任务 | 对象 / SoR | 产品与合同状态 | Scenario | 进入 → 主动作 → 退出 | 特有状态 | Figma |
|---|---|---|---|---|---|---|---|
| `PAGE-FE-060` 市场机会扫描 | 选择市场证据范围 | Market research projection / Buyer BE | `FROZEN_MAP_ONLY` | `SCN-FE-BUYER-002` | 客户开发 → 建议扫描范围 → 研究工作台 | source disabled、partial、policy blocked | `NOT_CREATED` |
| `PAGE-FE-061` 市场研究工作台 | 对比来源和需求证据 | Research projection / Buyer BE | `FROZEN_MAP_ONLY` | `SCN-FE-BUYER-002` | 扫描 → 选择证据/市场 → ICP | stale、conflict、source attribution | `NOT_CREATED` |
| `PAGE-FE-062` ICP 与购买委员会 | 定义资格规则和角色假设 | ICP / Buyer BE | `FROZEN_MAP_ONLY` | `SCN-FE-BUYER-002` | 研究 → 保存规则/回测 → 发现任务 | invalid rule、country override、no reachability | `NOT_CREATED` |
| `PAGE-FE-063` 客户池/Lead Explorer | 查看可解释推荐队列 | Company/Lead projection / Buyer BE | `FROZEN_MAP_ONLY / BACKEND_CODE_BACKED` | `SCN-FE-BUYER-001/002` | 发现任务 → 查看 Evidence/队列 → Lead 详情 | unreachable、excluded、partial enrichment | `FIG-P9-004 Normal 10:2 / Stale 18:304 / Proto 22:474` |
| `PAGE-FE-064` 客户/Lead 详情 | 核对身份、信号和可达性 | CanonicalCompany/Lead / Buyer BE | `FROZEN_MAP_ONLY` | `SCN-FE-BUYER-001` | Explorer → 核对/抑制/打包 → Package | ambiguous identity、PII restricted、stale | `NOT_CREATED` |
| `PAGE-FE-065` 发现/富集任务 | 监控 fan-out 和失败子集 | Discovery/Enrich run / Buyer BE | `FROZEN_MAP_ONLY / BACKEND_CODE_BACKED` | `SCN-FE-BUYER-002` | ICP → 运行/重试 → Explorer | provider fail-safe、budget、starvation warning | `NOT_CREATED` |
| `PAGE-FE-066` 数据权利与 Suppression | 删除、抑制或限制数据使用 | Suppression/Delete request / Buyer BE+Privacy | `FROZEN_MAP_ONLY/OPS` | `SCN-FE-BUYER-001` | Lead/设置 → 提交/审计 → 原对象 | legal hold、residual window、partial delete | `NOT_CREATED` |
| `PAGE-FE-070` Goal/Initiative | 把业务目标转成受控执行 | Goal/Initiative / SaaS | `TARGET_NOT_RUNNABLE` | `SCN-FE-GROWTH-001` | Growth → 定义目标 → Campaign | no metric、owner missing、budget unknown | `NOT_CREATED` |
| `PAGE-FE-071` Campaign 列表 | 查找执行及其状态 | Campaign / SaaS | `TARGET_NOT_RUNNABLE` | `SCN-FE-GROWTH-001..004` | Growth → 选择/新建 → Canvas | empty、paused、degraded、blocked | `NOT_CREATED` |
| `PAGE-FE-072` Campaign Canvas | 组合受众、内容、渠道和授权 | Campaign / SaaS | `TARGET_NOT_RUNNABLE` | `SCN-FE-GROWTH-001/002/004` | Campaign → 配置/送审 → Dry Run | Claim revoked、scope missing、conflict | `NOT_CREATED` |
| `PAGE-FE-073` Audience/名单快照 | 冻结可审计受众 | AudienceSnapshot / SaaS | `TARGET_NOT_RUNNABLE` | `SCN-FE-GROWTH-001/004` | Canvas → 冻结/排除 → Dry Run | suppression、permission change、stale | `NOT_CREATED` |
| `PAGE-FE-074` Dry Run 与授权 | 发布前检查成本、风险和差异 | Authorization projection / SaaS | `TARGET_NOT_RUNNABLE` | `SCN-FE-GROWTH-001..004` | Canvas → 批准/修复 → 执行 | partial targets、budget、reauthorize | `NOT_CREATED` |
| `PAGE-FE-075` 内容库 | 管理 Master Content 和来源 | Content / SaaS | `TARGET_NOT_RUNNABLE` | `SCN-FE-GROWTH-002` | Growth → 选择/新建 → 编辑审核 | no source、rights expired、duplicate | `NOT_CREATED` |
| `PAGE-FE-076` 内容编辑/审核 | 生成语言/渠道变体并审批 | ContentVersion / SaaS | `TARGET_NOT_RUNNABLE` | `SCN-FE-GROWTH-001/002` | 内容库 → 编辑/送审 → 日历/发布 | Claim conflict、translation partial、denied | `NOT_CREATED` |
| `PAGE-FE-077` 内容日历 | 排程多渠道内容 | Publish schedule projection / SaaS | `TARGET_NOT_RUNNABLE` | `SCN-FE-GROWTH-003/004` | Growth → 排程/调整 → PublishJob | timezone、scope expired、schedule conflict | `NOT_CREATED` |
| `PAGE-FE-078` 发布任务 | 查看逐目标回执和重试 | PublishJob/DeliveryReceipt / SaaS | `TARGET_NOT_RUNNABLE` | `SCN-FE-GROWTH-003` | 日历 → 对账/重试失败子集 → 内容/互动 | ACK unknown、partial、rate limited | `FIG-P9-004 node 23:236 / Proto 24:2` |
| `PAGE-FE-079` 渠道账号 | 管理 capability-level binding | ProviderConnection/Binding / SaaS | `TARGET_NOT_RUNNABLE` | `SCN-FE-CONTROL-002`、`SCN-FE-GROWTH-003` | 集成 → 授权/重连/退出 → 日历 | partial scope、expired credential、revoked | `NOT_CREATED` |
| `PAGE-FE-080` Unified Inbox | 处理入站私密会话 | ConversationProjection / SaaS + Provider | `TARGET_NOT_RUNNABLE` | `SCN-FE-ENGAGE-001` | Shell/通知 → 身份核对/分派/草稿 → 对象/交接 | duplicate、identity pending、SLA、provider degraded | `FIG-P9-004 Normal 11:2 / ProviderDegraded 18:553 / Mobile 20:78 / Proto 22:719` |
| `PAGE-FE-081` 会话详情 | 回复、备注和查看上下文 | ConversationProjection / SaaS + Provider | `TARGET_NOT_RUNNABLE` | `SCN-FE-ENGAGE-001` | Inbox → 回复/升级/交接 → Inbox/对象 | opt-out、approval、delivery receipt、translation | `NOT_CREATED` |
| `PAGE-FE-082` Opportunity 列表/看板 | 管理业务机会候选 | Opportunity / SaaS | `TARGET_NOT_RUNNABLE` | `SCN-FE-ENGAGE-002/003` | Handoff/Inbox → 分派/阶段变更 → 详情 | candidate、QGO/SAO target、owner missing | `NOT_CREATED` |
| `PAGE-FE-083` Opportunity 详情 | 记录证据、Owner、下一步和 Outcome | Opportunity / SaaS | `TARGET_NOT_RUNNABLE` | `SCN-FE-ENGAGE-002/003` | 列表 → 接受/更新/关闭 → 洞察 | evidence incomplete、provisional outcome、conflict | `NOT_CREATED` |
| `PAGE-FE-084` 经营洞察 | 理解指标定义和对象贡献 | Insight projection / SaaS | `TARGET_NOT_RUNNABLE` | `SCN-FE-INSIGHT-001` | Shell → 下钻 → canonical object | no data、partial、stale、denied | `FIG-P9-004 MetricUnavailable 61:2` |
| `PAGE-FE-085` 归因与实验 | 比较不确定结果 | Attribution/Experiment target / Data | `TARGET_NOT_RUNNABLE` | `SCN-FE-INSIGHT-002` | 洞察 → 查看方法/样本 → 对象/报告 | inconclusive、sample low、privacy limited | `NOT_CREATED` |
| `PAGE-FE-086` 成本与用量 | 查看来源明确的成本/额度 | Cost projection / SaaS+Site | `TARGET_NOT_RUNNABLE`；Site 局部 code-backed | `SCN-FE-INSIGHT-002`、`SCN-FE-SITE-012/013` | 管理/Build → 下钻 → 任务/账单 | reported/estimated/unknown、late settlement | `NOT_CREATED` |

## 6. 管理与平台运营

| Page | 用户任务 | 对象 / SoR | 产品与合同状态 | Scenario | 进入 → 主动作 → 退出 | 特有状态 | Figma |
|---|---|---|---|---|---|---|---|
| `PAGE-FE-090` 成员与角色 | 邀请、移交和停用成员 | Membership/Role / SaaS | `TARGET_NOT_RUNNABLE` | `SCN-FE-CONTROL-001` | 设置 → 邀请/移交/停用 → 审计 | last-admin、pending invite、task handoff | `NOT_CREATED` |
| `PAGE-FE-091` 数据范围与委派 | 预览有效权限和委派范围 | Scope/Delegation / SaaS | `TARGET_NOT_RUNNABLE/OPEN_DECISION` | `SCN-FE-CONTROL-001` | 成员 → 配置/预览 → 成员/审计 | denied、scope conflict、expiry | `NOT_CREATED` |
| `PAGE-FE-092` 集成中心 | 连接、健康、同步、导出和退出 | ProviderConnection/Binding / SaaS | `TARGET_NOT_RUNNABLE` | `SCN-FE-CONTROL-002` | 设置 → 授权/重连/移除 → 业务页 | OAuth scope、credential expiry、outage、export | `FIG-P9-004 integration 23:119 / provider exit 30:2 / Proto 32:237→32:354` |
| `PAGE-FE-093` Workspace 设置 | 管理名称、默认值和关闭路径 | Workspace settings / SaaS | `TARGET_NOT_RUNNABLE` | `SCN-FE-SHELL-002`、`SCN-FE-CONTROL-001` | 设置 → 保存/转移 → Shell | conflict、last-admin、closure pending | `FIG-P9-004 data exit representative 29:119 / CONTRACT_BLOCKED` |
| `PAGE-FE-094` 安全与审计 | 查看高风险操作与会话 | Audit/Security projection / SaaS | `TARGET_NOT_RUNNABLE` | `SCN-FE-CONTROL-001..003` | 设置 → 审查/撤销 → 对象/支持 | redaction、break-glass、retention | `NOT_CREATED` |
| `PAGE-FE-095` 套餐、用量与账单 | 理解配额、降级和账单影响 | Plan/Usage/Billing / SaaS | `TARGET_NOT_RUNNABLE/OPEN_DECISION` | `SCN-FE-CONTROL-003` | 设置 → 变更/导出 → 账单/任务 | quota exceed、effective date、payment issue | `NOT_CREATED` |
| `PAGE-FE-096` 运营控制台 | 处理 Provider、事故、DSR 和限时支持 | Ops projections / Platform | `TARGET_NOT_RUNNABLE` | `SCN-FE-CONTROL-002/003` | 受限入口 → 审批/操作/结束访问 → 审计 | break-glass、dual approval、timeout、incident | `NOT_CREATED` |

## 7. 已通过对象/页面评审的候选页面族

以下不占稳定 `PAGE-FE-*`；它们保持 `CAND-P9-*`，只有通过独立对象、生命周期、权限、SoR、合同和深链 Gate 后才能申请 Page ID：

| Candidate | 任务 | 当前处理 | 状态 / Figma |
|---|---|---|---|
| `CAND-P9-PUBLIC-HOME` | 解释平台价值、产品表面、适用边界和信任入口 | `New public family`；不沿用 SaaS Shell，不使用伪客户、KPI 或上线承诺 | `PROPOSED / FIG-P9-005 node 3:10` |
| `CAND-P9-PAGE-ONBOARDING` | 最少输入、行业引导、上传/导入、KB 抽取和动态缺口 | `New family`；可复用 `PAGE-FE-020/024/025/032..037`，先验证是否需独立入口 | `CODE_BACKED_SUBSET / FIG-P9-004 node 31:2 / Proto 32:2→32:119` |
| `CAND-P9-PAGE-IMPORT-CENTER` | 批量导入、映射、校验、部分成功、回滚和问题处理 | `New family`；依赖 ImportRun/MigrationIssue 合同 | `CONTRACT_BLOCKED / NOT_CREATED` |
| `CAND-P9-PAGE-SITE-IMPORT` | 从网站/店铺导入建站资料 | `New family`；只作为知识来源，不复制第三方站点权利 | `CONTRACT_BLOCKED / NOT_CREATED` |
| `CAND-P9-PAGE-MEDIA-STUDIO` | 图片任务、权利、审核和渠道变体 | `Split`；完整视频工作室继续停车 | `CANDIDATE / NOT_CREATED` |
| `CAND-P9-PAGE-PUBLIC-ENGAGEMENT` | 评论、提及、公开回复、审核和升级私聊 | `Split`；与私密 Conversation 分离 | `CONTRACT_BLOCKED / FIG-P9-004 node 23:335 / Proto 24:101` |
| `CAND-P9-PAGE-OUTBOUND-SEQUENCE` | 受控一对一触达、审批、suppression 和回执 | `Split`；不扩展为通用自动化平台 | `CONTRACT_BLOCKED / NOT_CREATED` |
| `CAND-P9-PAGE-PERSONAL-SETTINGS` | 个人偏好、通知、语言和会话安全 | `New family`；与 Workspace 设置分离 | `CANDIDATE / NOT_CREATED` |
| `CAND-P9-PAGE-INTEGRATION-DETAIL` | 单连接授权、capability binding、健康、同步和退出 | `Deepen PAGE-FE-092`；先证明独立深链 | `CONTRACT_BLOCKED / FIG-P9-004 node 23:119` |
| `CAND-P9-PAGE-DEVELOPER-API` | API key 管理、Webhook、Reference 和诊断 | `New public/control family`；不得暴露 Provider secret | `CONTRACT_BLOCKED / FIG-P9-005 node 6:45` |
| `CAND-P9-PAGE-DATA-EXIT` | 数据导出、删除、账号关闭和保留解释 | `New family`；依赖 DataExportJob/DSR 合同 | `CONTRACT_BLOCKED / FIG-P9-004 node 29:119 / Proto 32:354` |
| `CAND-P9-PAGE-AI-STRATEGY` | 任务档位、权限、预算和降级记录 | `New admin candidate`；不展示 new-api 地址、密钥、Provider 或任意模型字符串 | `MIXED / FIG-P9-004 Normal 12:2 / Denied 18:744` |

完整公共官网、身份、帮助、开发者、状态和平台运营的候选页面数量仍由页面族评审决定，不能为了凑数提前分配稳定 ID。

## 8. Figma 与验证关闭门

当前有十三张 SaaS 桌面代表页、五个关键状态、三张移动端代表页、六条原型骨架、四张产品公共表面代表页和客户生成站首页代表页的高保真 Node。其余 `NOT_CREATED` 不表示遗漏被忽略，而是明确待交付。Page Manifest 只有同时满足以下条件才可从 `DRAFT` 升级：

1. Page 对象/投影、SoR、权限和 allowed actions 有正式 Owner；
2. 页面状态与当前合同一致，目标态动作不会表现为已运行；
3. normal 之外的关键异常、响应式、i18n 和 a11y 设计完成；
4. Figma Node 唯一、无孤儿 Frame、版本和 successor 可追踪；
5. 对应 Scenario、Metric 和 Guide 有正式 ID；
6. 真实目标角色完成两轮任务验证。
