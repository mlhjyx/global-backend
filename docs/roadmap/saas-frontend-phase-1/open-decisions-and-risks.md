# Phase 1 待决策、缺失输入与风险清单

> 文档 ID：AUD-FE-P1-008
> 状态：`COMPLETE_FOR_GATE_1`
> 事实基线：`main@c3f0cca80e228f08f35c89776f759748dac78ce2`；#157 后续合并只改变 R1-min 技术 delta，不替产品负责人决定发布范围、SaaS UX 或商业承诺
> 原则：Phase 1 提供证据、选项和建议，不替产品负责人静默决定导航、商业规则、数据权利、OSS、设计工具或跨仓 ownership

## 1. 需要产品负责人拍板的承重决策

| 决策 ID | 问题 | 已知事实 | 建议 | 最晚 Gate / Owner | 未决影响 |
|---|---|---|---|---|---|
| `DEC-FE-001` | 统一 SaaS 的一级产品域和导航是什么 | “独立站管理”为一级产品区域已固定；Word 与原型其余导航不一致 | Phase 2 从用户任务/对象/频率出发做 2–3 个 IA 选项，不沿用任一旧稿 | Gate 2 / 产品负责人 | 无法写正式页面目录、深链与权限入口 |
| `DEC-FE-002` | 正式 SaaS 前端仓库与 Owner | `/global/frontend` 无 Git；本仓规定 SaaS UI 外部拥有 | 建立独立受控仓库或明确 mono-repo ownership；保留原型为有版本输入 | Gate 2 前 / 产品+工程 | 无法定义 CI、分支、发布、Code Owner 和契约变更流程 |
| `DEC-FE-003` | 身份 SoR 与旧 Spring 服务去留 | 权威边界要求 SaaS JWKS/Workspace；本地 Spring 自签 JWT/本地用户 | 推荐以现行 JWKS/Workspace 边界为唯一目标，旧服务先隔离和密钥轮换，再决定归档/迁移 | Gate 2 / 架构+安全+SaaS Owner | route guard、权限、用户迁移和安全风险无法收口 |
| `DEC-FE-004` | 正式设计事实源与工具 | 未发现 Figma/Token/Storybook；只有代码原型/模板/Word | 先定“设计 ID + version + owner + capability/scenario 关联”规则，再选工具；工具不能代替规范 | Gate 3/4 / 设计 Owner | 页面、组件和评审无法稳定追踪 |
| `DEC-FE-005` | 原型和 Readdy 模板可复用到什么程度 | 代码/图片来源存在，但权利、条款版本和 Owner 不完整 | 默认 visual reference only；逐资产许可通过后才允许 code/image reuse | 使用前 / 法务+资产 Owner | 版权、条款、训练/竞争性用途和供应链风险 |
| `DEC-FE-006` | Workspace 角色、对象权限和数据社会属性 | 后端有 tenant/RLS；SaaS 没有统一角色/对象矩阵 | 先定义团队/个人/审批/公开/系统对象，再做 RBAC/ABAC；管理员不默认越权读个人数据 | Gate 2/4 / 产品+安全 | 导航可见、编辑、审批、发布、导出、删除都无法验收 |
| `DEC-FE-007` | 独立站发布、域名、SSL、回滚首期范围 | main 只有开发预览；R1-min 未合入；原型展示更多 | 首期分开定义 Release、Preview、Publish、Domain 四个能力和 Gate，不做“一键发布”笼统承诺 | Gate 2/5 / 产品+Site Builder | 用户承诺、状态机、SLA、人工兜底漂移 |
| `DEC-FE-008` | 询盘、同意、投递和 SaaS inbox 归属 | Inquiry receiver 明确后置；互动/机会归 SaaS | 推荐 receiver/consent/event 属 Site Builder 边界，客户/Conversation/Opportunity 投影属 SaaS；需正式 ADR | M2 前 / 产品+隐私+架构 | 访客数据合规、重复客户、路由和留存无法设计 |
| `DEC-FE-009` | 套餐、额度、Entitlement 与成本展示 | 后端有 Build hard cap/ledger；无商业套餐真值 | 先定义动作 entitlement、配额周期、未知结算和超额恢复，UI 只消费服务端决定 | Gate 2/5 / 产品+商业+后端 | 原型价格/额度文案不能落地，可能产生错误承诺 |
| `DEC-FE-010` | 首批正式纵切能力 | 页面原型很广，真实后端集中在 Site Builder 和冻结的买家智能 | 推荐先做“进入独立站管理→资料/素材→Build→进度/取消→开发预览”的一条证据链，再扩域名/发布 | Gate 2 / 产品负责人 | 若继续横铺页面，会重复形成 Mock 完成假象 |
| `DEC-FE-011` | 质量责任与是否保留独立 QA Gate | HTML 提议取消独立 QA 步骤；仓库已有多层独立质量门 | 可取消串行岗位交接，但不可取消独立验证责任；每个纵切强制产品/设计/契约/E2E/安全/发布证据 | Gate 3/4 / 产品+工程 | 缺陷和文档状态会再次由开发自评覆盖 |
| `DEC-FE-012` | OSS/外部服务采用权 | Word 列候选；部分已本地使用，部分许可/商用边界复杂 | 采用 Capability Card + `Learn/Build/Adapt/Integrate/Buy/Avoid/Defer`；每项明确技术、法务、安全和预算 Owner | Gate 7 / 架构+法务+安全+产品 | “开源=可免费嵌入”或重复造轮子两类风险并存 |
| `DEC-FE-013` | 多语种首发范围 | 当前生成只支持 en/de-DE；ar 仅 renderer smoke | 以目标市场、事实质量、审核能力和 SEO 运维共同定语言；不按 UI 下拉项决定 | Gate 2/5 / 产品+运营 | 宽泛多语种承诺、事实错译和发布残缺 |
| `DEC-FE-014` | 发布后成功指标和回顾机制 | Word 有候选指标，当前无统一埋点/基线 | 每个 Capability 在施工前设结果、护栏、反指标、基线、窗口、Owner 和保留/回滚条件 | Gate 2/5 / 产品+数据 | 无法判断“做出来”是否真的解决问题 |

## 2. 尚缺的外部输入

| 输入 ID | 缺失内容 | 获取方式 | 无输入时的安全默认 |
|---|---|---|---|
| `IN-FE-001` | 正式 SaaS 前端仓库、remote、CI、部署环境和当前 Owner | 由 SaaS 团队提供或确认新建 | `/global/frontend` 只作只读原型，不提交修改 |
| `IN-FE-002` | 正式设计文件/链接、设计 Owner、页面/组件版本 | 由设计/产品提供 | 标 `NOT_FOUND_IN_SCANNED_SCOPE`，不把代码截图当设计真值 |
| `IN-FE-003` | Readdy 账户条款版本、创建者、输入素材、输出授权和允许用途 | 资产 Owner+法务核验 | 全部 `VISUAL_REFERENCE_ONLY` |
| `IN-FE-004` | 目标客户分层、关键日常任务、使用频率和当前替代方案的研究证据 | 用户访谈、支持/销售记录、可验证数据 | Word 只作假设，不把竞品功能表当需求证据 |
| `IN-FE-005` | 套餐、额度、付费动作、退款/超额/降级策略 | 商业负责人 | UI 不显示未经批准的价格/额度，不客户端自行判断 entitlement |
| `IN-FE-006` | 角色、审批职责、数据范围、管理员例外和审计要求 | 产品+安全+合规 workshop | 服务端 fail-closed；前端隐藏不作为权限控制 |
| `IN-FE-007` | 生产域名/DNS/证书/托管/区域/SLA | Infra+产品 | 继续称开发预览，不称发布或上线 |
| `IN-FE-008` | 埋点平台、事件规范、隐私/保留和指标 Owner | 数据+隐私 | 不引入新 tracking SDK，不用 Mock 指标做决策 |
| `IN-FE-009` | GoodJob 远端当前 HEAD | Gitee 凭据或可访问镜像 | 结论固定到 `5732e209…`，注明可能过期 |

## 3. 风险登记

| 风险 ID | 严重度 | 风险 | 触发证据 | 当前缓解 | 后续动作 |
|---|---|---|---|---|---|
| `RISK-FE-001` | `CRITICAL` | 旧 Spring 默认秘密仍有效或被复用 | 源码含 DB/admin/JWT fallback | 文档不复制、不登录、不探测 | Owner 立即轮换/封存并做 secret history audit；与文档项目分开处理 |
| `RISK-FE-002` | `HIGH` | 页面数量被误当交付完成 | 原型计划 7 阶段完成，但主要业务均 Mock | 多轴能力矩阵 | Gate 2 只批准端到端纵切，不批准“再铺一批页面” |
| `RISK-FE-003` | `HIGH` | 双身份/双用户 SoR | Spring JWT 与 NestJS JWKS/Workspace 并存 | 登记冲突，禁止接入 | DEC-FE-003 后建立迁移/关闭路径 |
| `RISK-FE-004` | `HIGH` | 原型承诺超出 main 能力 | 域名、发布、分析、询盘等只有 Mock | 当前/目标文案分离 | 每项能力有状态 badge、限制和证据链接 |
| `RISK-FE-005` | `HIGH` | 生产 Release 被开发预览冒充 | main artifact 为本地路径 | 文档标 `INTERNAL_ONLY` | R1-min 合入+跨节点/回收/故障演练后再升级状态 |
| `RISK-FE-006` | `HIGH` | Readdy/模板权利或条款违规 | 136 外链、11 form endpoint、缺 provenance | visual reference only | 资产台账+法律审查；未经放行不训练/RAG/蒸馏/复用 |
| `RISK-FE-007` | `HIGH` | 历史 worktree 误认 main 或被误清理 | 41 worktrees、dirty/unique commits、失联 Mac 路径 | provenance 文档+隔离 worktree | 各任务独立审计；清理需合并、干净、归属和用户授权四门 |
| `RISK-FE-008` | `HIGH` | 取消 QA 后只剩作者自证 | HTML 流程与 GoodJob “全绿”漂移案例 | 保留独立证据责任 | 建 scenario fixture、contract/E2E/a11y/visual/security/release Gate |
| `RISK-FE-009` | `HIGH` | SiteSpec 坏输入或未知组件静默缺内容 | runtime cast；unknown type 返回 null | 已登记为 main 缺口 | 由 R1-min/renderer Gate fail loudly 并加契约测试 |
| `RISK-FE-010` | `MEDIUM` | 文档再次变成多份重复状态 | 05/07/08/13/14 与 current 混合时间 | 来源/冲突总账 | Phase 3 建 document registry；状态集中、其他文档引用 |
| `RISK-FE-011` | `MEDIUM` | OpenAPI 手写数字和示例继续漂移 | 40 vs 56 paths；INTEGRATION 示例过时 | 机器契约为真值 | CI 生成统计/示例或检查 doc fragment |
| `RISK-FE-012` | `MEDIUM` | 多语种把 renderer capability 当生成 capability | ar smoke 与 en/de-DE generation 混淆 | 能力矩阵拆轴 | locale registry 面向产品/前端暴露明确 capability |
| `RISK-FE-013` | `MEDIUM` | 管理员/团队权限伤害组织信任 | 尚无个人/团队数据属性矩阵 | 借鉴 GoodJob 方法 | Phase 2 建对象社会属性和操作/数据范围矩阵 |
| `RISK-FE-014` | `MEDIUM` | OSS 引入形成第二真值或难退出 | Puck/OPA/Langfuse/Activepieces 等均可复制本地职责 | 仅初审，不选型 | Gate 7 强制 Adapter/SoR/Exit Plan/License/Security/Pilot |
| `RISK-FE-015` | `MEDIUM` | 没有发布后学习，功能持续堆叠 | 当前没有指标基线和回顾 Owner | 计划已引入 learning register | 每个 Release Bundle 强制观测窗口与继续/调整/回滚决定 |

## 4. 我的建议顺序

Gate 1 通过后，建议仍不要直接批量写所有页面 PRD，而按以下顺序进入 Phase 2：

1. 先用 3–5 个真实用户角色和 8–12 个最高频任务校准产品域，不从旧导航倒推需求。
2. 建立 Workspace、Company、ICP、Site、SiteVersion、Release、Asset、Knowledge、BuildRun、Claim、Evidence、Conversation、Opportunity 等核心对象的 SoR/状态/权限图。
3. 选择一条可验证纵切：“进入独立站管理→补资料/素材→Build→看进度/取消→修复失败→开发预览”，把产品、UX、前端、API、工作流、E2E 和指南一次走通。
4. 再决定正式前端仓库、设计系统和原型复用比例；避免先迁框架、后发现对象/权限仍未定。
5. 生产发布、域名、询盘与分析各自立能力包，不塞进一个“独立站管理完成”里。
6. 同步建立文档 Registry、Capability Registry、Scenario/Fixture Catalog 和证据索引，使状态能随代码和发布自动更新。

这套顺序的核心不是少做文档，而是让每份文档都能对应一个用户结果、一个事实 Owner、一个实现链和一组可重复证据。
