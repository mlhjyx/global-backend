# Phase 9 冲突、决策与阻塞总账

> 文档 ID：`AUD-FE-P9-002`
> 层级：`L3 / Audit and decision evidence`
> 状态：`DRAFT`
> 事实 Owner：`OWN-DOC-GOV`
> 产品裁决 Owner：`OWN-PRODUCT`
> 工程基线：`origin/main@8dcbbcb8254a561f33abc59c49da4cb6a3de30b1`
> 核验日期：2026-07-23
> 来源：[Phase 9 来源与事实总账](source-and-truth-ledger.md)

## 1. 使用规则

- `CON-FE-P9-*` 记录两份或多份来源对同一事实给出不兼容解释；裁决只决定本阶段如何诚实表达，不自动修改事实 Owner 的文档、代码或 Registry。
- `DEC-FE-P9-*` 记录用户批准的 Phase 9 设计边界。设计决策不等于后端实现、外部 Provider 采用、采购、许可或生产发布批准。
- `BLK-FE-P9-*` 记录缺失输入；没有相反证据时不伪装成 conflict。责任人使用已登记 `OWN-*`，未指派帽子仍保持未指派。
- 每条必须有当前状态和关闭门。`RESOLVED_WITH_REMEDIATION` 表示当前解释已定但 successor/合同/证据尚未闭环；不得缩写为“已解决”。

## 2. 本阶段决策

| Decision ID | 决策 | 状态 | Owner | 条件与影响 |
|---|---|---|---|---|
| `DEC-FE-P9-001` | Phase 9 以 `8dcbbcb` 为工程事实基线；Phase 1–8 原样冻结并以 delta 承接 | `APPROVED_WITH_CONDITION` | `OWN-DOC-GOV` | 所有 current 数字必须机器重算；不得改写旧 Gate 证据 |
| `DEC-FE-P9-002` | 产品覆盖公共站、身份/激活、SaaS、客户生成站、帮助/开发者、平台运营六个表面 | `APPROVED_WITH_CONDITION` | `OWN-PRODUCT` | 六个表面共享品牌与对象接缝，但不共享一套导航、权限或页面模板 |
| `DEC-FE-P9-003` | SaaS 一级 IA 继续采用“今日/客户开发/站点管理/增长执行/互动与商机/洞察” | `APPROVED_WITH_CONDITION` | `OWN-PRODUCT` | 企业真相、任务、审批、通知、集成、权限和事故是横向控制面；公共站/帮助/运营不塞进主导航 |
| `DEC-FE-P9-004` | 我方平台拥有业务对象、权限、批准/授权、回执、成本、审计与 Provider 映射；外部系统只经 Adapter 执行 | `APPROVED_WITH_CONDITION` | `OWN-SAAS-PLATFORM` | 设计可先做；runtime 必须有 Contract、数据最小化、幂等、退出和实际 Owner |
| `DEC-FE-P9-005` | 内容分发/公开互动与私密会话采用双引擎边界：Aitoearn 候选执行前者，Chatwoot 候选执行后者 | `APPROVED_WITH_CONDITION` | `OWN-PRODUCT` | 只批准设计与受控 Pilot 方案，不覆盖 Gate 7 的 `DEFER` runtime 状态；Campaign/Content/Conversation/Opportunity SoR 留我方 SaaS |
| `DEC-FE-P9-006` | 默认发布目标为 immutable SiteRelease → object storage/CDN → Caddy/ACME；BaoTa 仅为客户自管服务器的可选 Hosting Adapter | `APPROVED_WITH_CONDITION` | `OWN-SITE-BE` | BaoTa 不嵌 UI、不改源码、不拥有 Site/Release/Domain/Certificate；许可与 API Pilot 未过门 |
| `DEC-FE-P9-007` | new-api 继续是后台统一模型网关；普通用户只见任务档位或服务端允许别名 | `APPROVED_WITH_CONDITION` | `OWN-AI-PLATFORM` | Base URL、key、上游 provider、路由和 fallback 只在平台运营边界；前端不持 secret |
| `DEC-FE-P9-008` | 76 个稳定 Page ID 是下限而非功能上限；新页面须先证明独立用户结果、对象/投影、SoR、权限、生命周期、深链和退出 | `APPROVED_WITH_CONDITION` | `OWN-PRODUCT` | 审计候选先用 `PFAM-P9-*`/working ID；产品 Gate 后才分配 current `PAGE-FE-*` |
| `DEC-FE-P9-009` | 首客群继续聚焦 B2B 制造、工贸一体和传统出口企业；企业真相与商机须表达规格、证书、产能、MOQ/交期、RFQ 和技术资格化 | `SUPERSEDED` | `OWN-PRODUCT` | 2026-07-22 被 `DEC-FE-P9-013` 取代；其中把完整 RFQ 技术资格化放入本产品核心范围的部分不再有效 |
| `DEC-FE-P9-010` | 正式组件库前必须用同场景、同数据、同状态、同视口生成恰好三套视觉方向并由用户选择 | `SUPERSEDED` | `OWN-DESIGN` | 2026-07-22 被 `DEC-FE-P9-014` 取代；基于旧“买家详情 + RFQ 技术资格化”基准产生的三张图不再是设计方向 |
| `DEC-FE-P9-011` | 交互语言采用“稳定 Shell → 对象头 → 主任务区 → 按需 Inspector → 持久任务/事故落点” | `APPROVED_WITH_CONDITION` | `OWN-DESIGN` | 业务、任务、同步、证据、新鲜度、权限状态分层；一个绿色 Badge 不得概括全部 |
| `DEC-FE-P9-012` | 本阶段交付事实/能力/页面/接口文档、设计系统与 Figma 原型，不实施前端产品代码 | `APPROVED_WITH_CONDITION` | `OWN-PRODUCT` | 不恢复 Buyer backend 新开发，不安装/采购/部署外部 Provider，不产生虚假 Release |
| `DEC-FE-P9-013` | 制造业核心资料边界固定为产品/型号、关键参数、材料/工艺、MOQ/交期/产能、OEM/ODM、认证和准备度工作台 | `SUPERSEDED` | `OWN-PRODUCT` | 2026-07-23 被 `DEC-FE-P9-015` 取代；这些只是可能出现的行业资料，不是所有客户的固定字段或独立对象 |
| `DEC-FE-P9-014` | 以“企业与产品资料准备度工作台”再生成恰好三套方向 | `SUPERSEDED` | `OWN-DESIGN` | 2026-07-23 被 `DEC-FE-P9-016` 取代；用户已确认五张界面足以作为方向基线，不再重复生成三方向 |
| `DEC-FE-P9-015` | 资料采用“最少结构化资料 + 引导填写 + 文件/图片上传 + 网站/店铺导入 + KB 抽取/动态追问”模型；行业字段按行业、市场、目标和已有资料动态出现 | `APPROVED_WITH_CONDITION` | `OWN-PRODUCT` | current 合同只认 Profile 五组、Asset/KbDocument/KnowledgeSource、Offering/Claim/Evidence 等通用对象；动态问题和 gaps 是引导/读模型，不提前新建固定 ProductFamily/Variant/TechnicalSpecification 或 Readiness 聚合 |
| `DEC-FE-P9-016` | 用户提供并确认的五张界面是当前视觉基线：Today、Site Editor、Buyer Development、Unified Inbox、AI Task Strategy | `APPROVED_WITH_CONDITION` | `OWN-DESIGN` | 只批准布局、密度、层级和视觉语言；示例内容不证明对象/API。Phase 0 已确认，Foundations 和五张核心页面为草稿；仍须完成响应式、a11y、全状态和用户评审 |
| `DEC-FE-P9-017` | 当前不建立 `RFQ Lite` 独立聚合和工程生命周期；Inbox 只设计私密会话、分派、上下文、AI 草稿和可追踪外部交接 | `APPROVED_WITH_CONDITION` | `OWN-PRODUCT` | Conversation/Opportunity 均属待确认 SaaS SoR；未来若有结构化询盘对象，必须基于真实用户任务、合同、权限、附件和外部系统边界另过 Gate |
| `DEC-FE-P9-018` | 视觉与功能设计前必须完成 `docs` 全量阅读总账，且 current truth 优先级固定为产品边界 → as-built/代码/OpenAPI → ADR → 当前状态/Release Plan → 活文档 → 实施记录 → 历史输入 | `APPROVED_WITH_CONDITION` | `OWN-DOC-GOV` | 旧 Word、Mock、截图、竞品和记忆只能发现候选；没有 current 合同支持的内容必须明确 `PROPOSED/BLOCKED` |

## 3. 事实冲突

| Conflict ID | 主题与证据 | 当前裁决 | Owner | 状态 | 关闭门 |
|---|---|---|---|---|---|
| `CON-FE-P9-001` | Phase 1–8 固定在 `c3f0cca/676c6cd`；当前 main 已到 `8dcbbcb` 并合入 #178–#181 | 旧阶段保持冻结；Phase 9 只写 post-baseline delta，current 真值按主题回到 L1/机器源 | `OWN-DOC-GOV` | `RESOLVED_WITH_REMEDIATION` | Phase 9 trace matrix 不再引用旧数字作当前值，且 docs verifier 通过 |
| `CON-FE-P9-002` | Site 00/08/09 仍出现 M1-e “26 型”；ADR-015、contracts 和 Renderer 的当前目标集合为 55 型 | 55 型是 current target/machine set；26 型只保留历史 provenance，不得作为现行验收边界 | `OWN-SITE-BE` | `RESOLVED_WITH_REMEDIATION` | Site 事实 Owner truth-sync 所有 current 26 型残留或加精确 history qualifier，机器/文档测试锁定 55 型 |
| `CON-FE-P9-003` | Site 04 摘要写 9 qualified/1 transitional/45 gallery；`status/current`、资格目录和当前代码显示 13/1/41 | 资格注册表和证据字节是实现真值；当前设计只可写 13/1/41，M1-e-A 仍未完成 | `OWN-SITE-BE` | `RESOLVED_WITH_REMEDIATION` | Site 04/相关活文档同步且 CI 从同一 registry 生成或验证计数 |
| `CON-FE-P9-004` | 项目记忆仍记录 #165 冲突/失败、26 型和 no-readiness；当前 main 已合 #165 并继续四批资格化 | 记忆只作历史搜索索引；`main + current docs + machine evidence` 优先 | `OWN-DOC-GOV` | `MITIGATED` | 后续记忆刷新由独立显式授权完成；产品文档不再引用旧结论 |
| `CON-FE-P9-005` | Gate 6 称 76 Page ID `MAP_COMPLETE`；用户要求完整公共站、身份、SaaS、生成站、帮助/开发者和运营体验 | 76 页只证明旧地图覆盖；Phase 9 必须先做功能/对象/页面 gap audit，再提出新增页面族 | `OWN-PRODUCT` | `RESOLVED_WITH_REMEDIATION` | 每个既有/新增页面在 Feature Coverage Ledger 关联用户问题、对象、SoR、状态、Scenario、Metric、Guide、Figma node |
| `CON-FE-P9-006` | architecture/旧文档手写 40 paths；当前机器 OpenAPI 为 56 paths/64 operations；原型页数又被当成能力数 | OpenAPI 数量与页面数量均不代表用户闭环；API 唯一真值按 operationId 机器读取 | `OWN-SITE-BE` | `RESOLVED_WITH_REMEDIATION` | 64 operations 全部归类为用户动作、运营动作或 backend-only，且删除长期手抄 count 依赖 |
| `CON-FE-P9-007` | Gate 7 对 Aitoearn 是 `LEARN/NO_RUNTIME; DEFER`；用户批准计划提出受控 Pilot | 允许设计 Provider 合同与 Pilot；runtime 仍 `DEFER`，直到独立 Card/G0–G6 和实际批准 | `OWN-GROWTH-PRODUCT` | `RESOLVED_WITH_REMEDIATION` | 官方 OAuth/账号、上传、发布、回执、评论/互动、429/失败、删除/导出和退出 probe 全有版本化证据 |
| `CON-FE-P9-008` | Gate 7 对 Chatwoot 是 `LEARN/NO_RUNTIME; DEFER`；计划提出 API + signed webhook Inbox | 允许原生 Unified Inbox 设计；runtime 仍 `DEFER`，且只用我方投影/映射，不继承 Chatwoot SoR | `OWN-CONVERSATION-PRODUCT` | `RESOLVED_WITH_REMEDIATION` | 固定版本上验证 Application API、HMAC/timestamp/delivery、重放/乱序/回补、PII/删除/导出、渠道/EE 边界和退出 |
| `CON-FE-P9-009` | BaoTa 官网开源协议允许 API 应用但限制源码修改/分发场景；GitHub `license.txt` 是另一软件许可文本；现 Registry 无 BaoTa Card | 不按宽松 OSS 处理。设计只保留 optional API Adapter，商业使用前需书面许可适用性确认 | `OWN-SEC-COMMERCIAL` | `OPEN_DECISION` | 固定产品/版本/API 文档、许可书面确认、账号/secret/tenant/审计、能力 probe、替换与卸载证据齐全 |
| `CON-FE-P9-010` | Postiz 官方 API 可作分发候选；当前 OSS Registry 无 Card，计划只把它当退出候选 | 仅作为 Aitoearn Adapter 合同的可替换性对照，不安装、不双写两个主分发器 | `OWN-GROWTH-PRODUCT` | `RESOLVED_WITH_REMEDIATION` | 新 Card 经产品/许可/安全批准，或从正式方案删除并保留研究记录 |
| `CON-FE-P9-011` | ZIP 自述“47 页全部完成”，但含 `src/mocks`、Supabase/Firebase 配置且无 Git/Owner/CI/deploy；正式前端仍 `BLK-FE-001` | ZIP 为 `LOCAL_UNCONTROLLED` 设计/路由输入，不是正式 repo 或实现真值 | `OWN-SAAS-FE` | `INPUT_BLOCKED` | 正式 repo/remote/branch protection/CI/deploy/Owner 和 OpenAPI client provenance 明确 |
| `CON-FE-P9-012` | 用户要求 Figma 项目/原型；两张 FigJam 已纠偏，四个 Design 文件均已有受控内容，SaaS 已有九张桌面代表、关键状态、移动端和三条原型骨架，公共站/生成站各有一张代表页 | locator、结构纠偏、首批 Node、文件非空和原型 API 可用性已关闭；Library 发布、组件属性、全页面/12 旅程、全断点/a11y 和 reviewer 尚未闭环。代表页不得标 `SPEC_DESIGNED` | `OWN-DESIGN` | `RESOLVED_WITH_REMEDIATION` | 六文件权限/Owner、Variables/Library、资产权利、current 节点、页面 Frame、responsive/a11y、reviewer 和版本登记完整 |
| `CON-FE-P9-013` | 完整产品前端需要 Campaign/Content/Conversation/Opportunity/Identity；本仓明确不拥有这些 SoR | 设计全产品接缝，但状态必须为 `EXTERNAL_OWNED/PROPOSED`，不能把目标 API 或外部 Provider 冒充 current backend | `OWN-SAAS-PLATFORM` | `CONTRACT_BLOCKED` | 每个外部域有正式 SoR/repo/Owner、对象/状态/allowed actions、API/event/read model 与 E2E evidence |
| `CON-FE-P9-014` | ADR/Hosting 文档描述 immutable Publish 目标；当前公开 API止于开发 Preview，Domain/TLS/Publish/Rollback 未闭环 | 目标旅程完整设计，当前入口和文案保持 `TARGET_NOT_RUNNABLE` | `OWN-SITE-BE` | `CONTRACT_BLOCKED` | Publish/Deployment/DomainBinding/Certificate 合同、infra、安全、运营和真实 release/rollback evidence |
| `CON-FE-P9-015` | 宝塔截图展示用户自配 AI 模型/new-api；平台边界要求 new-api 为后台 gateway | 普通用户不配置 endpoint/key/provider；只选择服务端批准档位/别名。平台运营可看 route/evidence/cost，但不回显 secret | `OWN-AI-PLATFORM` | `RESOLVED` | 设计稿、Page Manifest 和 client contract 均无通用 key/base URL 字段 |
| `CON-FE-P9-016` | 旧增长/互动页面容易把帖子评论、公开提及、私信、网站聊天和客服会话合为一个“互动”列表 | PublicInteraction 与 private Conversation 拆对象、队列、权限、保留和回复面；允许受控升级公开→私密 | `OWN-PRODUCT` | `RESOLVED_WITH_REMEDIATION` | 两套 lifecycle/Scenario/Page family/Provider capability 和身份映射经产品 Gate 批准 |
| `CON-FE-P9-017` | 社交内容分发和一对一销售触达都可能叫“发布/发送” | Social Publish 与 Outbound Sequence 拆 Campaign、授权、suppression、回执和合规门；Aitoearn 不负责一对一触达 | `OWN-GROWTH-PRODUCT` | `RESOLVED_WITH_REMEDIATION` | 两个 Capability Pack、状态机、权限和 Receipt 合同独立完成 |
| `CON-FE-P9-018` | 现有原型/历史文档常把事实审核、内容批准、执行授权和外部 accepted 合并为“已批准/成功” | Claim Approval、Content Approval、ExecutionAuthorization、accepted、delivered、business outcome 永久分层 | `OWN-SAAS-PLATFORM` | `RESOLVED_WITH_REMEDIATION` | 所有高风险 Journey/Frame 使用独立对象/时间戳/actor/version/receipt；测试含过期与撤销 |
| `CON-FE-P9-019` | 现有 Enterprise/Site/Opportunity 地图偏通用；早期 Phase 9 把产品规格、准备度与 RFQ 技术流程固化为全行业对象和页面 | 按 `DEC-FE-P9-015/017` 收回：资料动态引导进入通用 Profile/Asset/KB/Offering/Claim/Evidence；Inbox 不新建 RFQ 聚合 | `OWN-PRODUCT` | `RESOLVED_WITH_REMEDIATION` | 对象、页面、Journey、Fixture 和 Figma 登记移除固定行业规格、独立准备度和 RFQ Lite；未来候选另过合同与用户研究 Gate |
| `CON-FE-P9-020` | 现有页面目录偏 SaaS；公共营销站、完整身份、帮助、开发者、状态、平台运营没有等深 Page Manifest | 建六个产品表面，各自导航/权限/内容模板；不塞入 SaaS 一级导航 | `OWN-PRODUCT` | `RESOLVED_WITH_REMEDIATION` | 公共/身份/帮助/开发者/运营页面族有 manifest、状态、owner、scenario、responsive、a11y 和 Figma node |
| `CON-FE-P9-021` | 原型有“导出”，但完整导入、映射、校验、回滚、迁移 issue、数据退出和账号关闭生命周期未建 | 建 ImportRun/MigrationIssue/DataExportJob 候选和独立用户旅程；设计不表示 API 已存在 | `OWN-SAAS-PLATFORM` | `CONTRACT_BLOCKED` | 身份/对象 ownership、格式/schema、幂等、部分成功、回滚、DSR/保留和审计合同完成 |
| `CON-FE-P9-022` | Today、Search、Task、Approval、Notification、Incident 已有 UX 地图；正式跨域读模型/allowed actions/社会属性合同缺失 | 继续做 projection/deep-link 设计，不在前端聚合跨域主状态或自建角色表 | `OWN-SAAS-PLATFORM` | `CONTRACT_BLOCKED` | 服务端 projection、scope、freshness、allowed actions、事件与 privacy 合同通过 contract test |
| `CON-FE-P9-023` | Capability/Page/Scenario Registry 较完整；MetricDefinition 和 Tutorial/How-to/Reference/Explanation 的稳定 Guide 映射不足 | Phase 9 每个能力必须补 Metric/Guide 去向；没有真实 UI 时不伪写逐步操作 | `OWN-DOC-GOV` | `OPEN_DECISION` | Metric/Guide registry schema、Owner、事件/隐私和真实 UI deep link 获批 |
| `CON-FE-P9-024` | Readdy/宝塔/Aitoearn/附件视觉可观察，但代码、素材、商标、账号条款和二次用途权利不等 | 只做带来源的多来源净室观察；不得复制资产、CSS、代码、文案或把单一产品变成设计系统 | `OWN-SEC-COMMERCIAL` | `MITIGATED` | 每项进入 Figma 的外部参考有 source/date/rights/use，设计稿通过多来源/原创性复审 |
| `CON-FE-P9-025` | 用户曾展示本地 Chrome 登录态；当前没有受控路径、版本、录屏、截图索引或操作结果包 | 不把口头浏览过程列为可复现证据；高风险功能另做研究记录 | `OWN-DESIGN` | `INPUT_BLOCKED` | 同意范围内记录产品版本、URL、任务脚本、截图/录屏、日期、账号类型、finding 和敏感信息处置 |
| `CON-FE-P9-026` | 一个社交账号可能支持 publish/comment/DM/analytics 的不同 scope，旧集成页往往把“已连接”当全能力 | 引入 ProviderCapabilityManifest + capability-level binding；Connection 状态不得覆盖每项 scope/health | `OWN-SAAS-PLATFORM` | `CONTRACT_BLOCKED` | 真实授权 scope、re-consent、partial capability、health、revocation、数据副本与 UI contract 完成 |
| `CON-FE-P9-027` | 外部 API `200/accepted`、webhook、轮询状态和最终渠道结果可能乱序、重复、未知或互相矛盾 | ProviderReceipt/DeliveryReceipt/WebhookDelivery 分层；ACK unknown 先对账，不自动重试副作用 | `OWN-PLATFORM` | `CONTRACT_BLOCKED` | 幂等 key、delivery ID、signature/replay window、ordering、reconciliation、DLQ/redrive、exit replay 测试完成 |
| `CON-FE-P9-028` | Chatwoot/Aitoearn 可能拥有自己的 contact/account/channel identity；我方 Company/Contact/Workspace 不能按名称直接合并 | 使用稳定外部 ID + tenant + provider + capability mapping；不确定身份进入人工确认 | `OWN-DATA-PRIVACY` | `CONTRACT_BLOCKED` | IdentityMatch/merge/split、PII 最小化、跨境、保留、删除、审计和人工恢复合同完成 |
| `CON-FE-P9-029` | 设计计划要求中文优先/i18n；Site 生成当前只支持 en/de-DE，ar 只是 renderer smoke | SaaS UI 国际化与生成站 locale capability 分开；选择器只显示服务端真实支持 | `OWN-PRODUCT` | `RESOLVED_WITH_REMEDIATION` | locale capability registry 覆盖 UI/content/generation/publish/provider 四轴并有伪本地化/RTL/长文本证据 |
| `CON-FE-P9-030` | 文档和设计可形成全产品闭环；正式用户研究、前端 E2E、外部 Provider Pilot、生产 release 仍不存在 | 设计状态最高只能到相应证据轴；不得从文档完整推出 `VALIDATED/DEPLOYED/GA` | `OWN-QA-EVIDENCE` | `INPUT_BLOCKED` | 真实责任角色评审、目标用户任务测试、formal FE E2E、Provider/Release evidence 分别完成并记录环境/版本 |
| `CON-FE-P9-031` | 原三方向先后使用“买家详情 + RFQ 技术资格化”和固定“资料准备度”内容，都把示例字段误当产品事实 | 两批旧图统一降为 `SUPERSEDED_RESEARCH_PROVENANCE`；按 `DEC-FE-P9-016` 采用五张用户确认基线，不再生成新三图 | `OWN-DESIGN` | `RESOLVED_WITH_REMEDIATION` | 资产登记、Fixture、交互、Journey 和 Figma register 只保留五张基线；每张基线明确“视觉批准不等于功能批准” |
| `CON-FE-P9-032` | Profile/KB 当前支持通用五组资料、上传/导入来源和动态 gaps；设计稿曾把行业字段变成固定规格库与独立 Readiness 对象 | 行业差异由引导元数据、KB 抽取、Offering attributes 和 Claim/Evidence 表达；gaps 是派生读模型 | `OWN-PRODUCT` | `RESOLVED_WITH_REMEDIATION` | current 文档、对象总账和页面不再声明独立 ProductFamily/TechnicalSpecification/Readiness 合同；新增 schema 前另过对象评审 |

## 4. 阻塞项

| Blocker ID | 缺失输入 | Owner | 阻止 | 安全降级 | 关闭门 |
|---|---|---|---|---|---|
| `BLK-FE-P9-001` | 正式 SaaS 前端 repo、remote、CI/deploy 与实际 assignee | `OWN-SAAS-FE` | 前端实现、Storybook、E2E、发布 | 仅做 stack-neutral 规格/Figma | repo/Owner/branch protection/CI/env/deploy/rollback 书面登记 |
| `BLK-FE-P9-002` | Figma Library 发布/别名迁移、组件文本属性、全页面、剩余九条 Journey、全断点/a11y 和实际 reviewer；六文件 locator、FigJam 纠偏、首批 Variables/Frame、九张 SaaS 桌面代表、五个状态、三张移动端、三条原型骨架与两张产品表面代表页已登记 | `OWN-DESIGN` | 组件定稿、页面原型和无孤儿 Frame 验收 | `FIG-P9-003` 保持 `FOUNDATIONS_DRAFT`，`FIG-P9-004/005/006` 保持 `HIGH_FIDELITY_DRAFT`；不生成替代视觉方向 | 六文件权限/Owner、Library、source/rights、页面 node URL、版本、responsive/a11y、12 条 Journey、无孤儿 Frame 和 reviewer 齐全 |
| `BLK-FE-P9-003` | Workspace/Membership/Entitlement/allowed-actions 机器合同 | `OWN-SAAS-PLATFORM` | Shell、入口可见性、跨域动作和外部授权 | UI 只读/隐藏高风险动作；服务端 fail-closed | projection/Guard/contract tests + actor/object/version/policy actions |
| `BLK-FE-P9-004` | Claim public review/impact/紧急下架合同 | `OWN-TRUTH-BE` | 事实审核、发布审查、撤销影响旅程 | 显式阻塞或经批准运营兜底 | public API/event/allowed actions/impact read model/audit/E2E |
| `BLK-FE-P9-005` | 指标定义、事件、baseline、隐私/保留和 Data Owner assignee | `OWN-DATA-PRIVACY` | KPI、产品验证、分析/归因页面 | 显示 unavailable/definition，禁止 Mock 数字 | MetricDefinition/Event schema/consent/retention/baseline/QA evidence |
| `BLK-FE-P9-006` | Aitoearn/Chatwoot/BaoTa/Postiz 的更新 Adoption Card、许可/安全/隐私/成本/退出和实际 Owner | `OWN-SEC-COMMERCIAL` | runtime Pilot、采购、安装、账号和生产流量 | 只设计 Provider-neutral Adapter/状态 | G0–G6、书面许可、version pin、threat model、test/exit evidence、用户批准 |
| `BLK-FE-P9-007` | Publish/Deployment/Domain/TLS/Rollback/Inquiry 合同和 infra | `OWN-SITE-BE` | 公网发布、域名与访客转化当前承诺 | 可信开发 Preview；后置页面 `TARGET_NOT_RUNNABLE` | 对象/API/workflow/security/privacy/ops/real release 全链通过 |
| `BLK-FE-P9-008` | Campaign/Content/PublicInteraction/Conversation/Opportunity/Outcome 的 SaaS SoR、状态和 API/event | `OWN-SAAS-PLATFORM` | 非 Site 产品域进入 Dev-Ready | 保持地图/原型，标 `EXTERNAL_OWNED/PROPOSED`；Inbox 不新增 RFQ 聚合或工程评审 | 各域 Owner、repo、contract、projection、failure/exit 和 E2E 定位 |
| `BLK-FE-P9-009` | 制造业目标用户、工程/采购/销售/运营的真实任务研究 | `OWN-PRODUCT` | 把制造业对象/术语/密度从假设升为验证 | 使用合成 fixture，保持 `HYPOTHESIS` | 两轮任务测试，记录样本、场景、finding、修订和签发 |
| `BLK-FE-P9-010` | QA、运营、安全/商业的实际 assignee 和发布职责 | `OWN-PRODUCT` | `VALIDATED`、Provider Pilot、Release Gate | 责任帽保持 `UNASSIGNED`，Codex 不代签 | 实际人员、职责/SLA/escalation、review evidence 与批准记录 |
| `BLK-FE-P9-011` | 可复现的已登录竞品/产品交互研究包 | `OWN-DESIGN` | 以真实交互作为高风险流程证据 | 只使用当前附件和官方文档，标限制 | 授权范围、版本、路径、截图/录屏、finding、权利与敏感信息审查 |
| `BLK-FE-P9-012` | Metric/Guide Registry 与 current Page/Capability 的机器追踪 | `OWN-DOC-GOV` | “每能力均有指标和指南”完成定义 | 先在 Feature Coverage Ledger 留显式空值 | schema/唯一 ID/Owner/link verifier/迁移覆盖经 Gate 批准 |

## 5. 关闭顺序

```text
事实 delta 与文档漂移（001–006）
  → 能力/对象/页面完整性（005、019–023、029）
  → SaaS/Provider 合同（007–010、013–018、021–028）
  → 五张视觉基线登记与跨页面模式验证
  → Figma 全量规格
  → 用户/角色/QA 验证
  → 独立实施、Pilot 与 Release Gate
```

Phase 9 文档评审可以在 `BLK-FE-P9-*` 保留时进行；任何受阻项只能保持 `DRAFT/PROPOSED/TARGET_NOT_RUNNABLE/EXTERNAL_OWNED` 等诚实状态。只有相应 Owner 和关闭证据齐全，才能进入 Dev-Ready、runtime Pilot 或用户 Release。
