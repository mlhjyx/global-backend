# Phase 1 冲突登记

> 文档 ID：AUD-FE-P1-004
> 状态：`COMPLETE_FOR_GATE_1`
> 原则：这里只登记冲突与影响，不在 Phase 1 静默拍板产品、导航、技术栈或 ownership

| 冲突 ID | 主题 | 证据 A | 证据 B | 当前裁决/影响 | 后续动作 |
|---|---|---|---|---|---|
| `CON-FE-001` | SaaS 前端目录是否为空 | `/global/frontend/README.md` 写“仅占位” | 同目录实际有 149 个非构建产物文件，含主 React 应用、管理端和 Spring Boot 服务 | README 已过期；源码存在，但版本与正式性仍未知 | 完成逐文件实现审计并查找部署/仓库 provenance |
| `CON-FE-002` | 前端实现的版本真值 | `/global/frontend` 与三个子项目均没有 Git 元数据 | `project_plan.md` 将 7 个阶段写为已完成 | 只能判定为本地实现/原型，不能证明提交、评审、发布或当前部署 | 查找来源任务、压缩包/生成器元数据、运行环境和外部仓库线索 |
| `CON-FE-003` | 身份与业务后端边界 | 当前权威链规定 SaaS 拥有身份和 UI，本仓只验 SaaS token，禁止平行身份系统 | `/global/frontend/backend` 自带 Spring Security、JWT、用户表和 MySQL | 可能是旧原型或独立 SaaS 服务草案；未核清前不得接入或称为目标实现 | 审计端点、数据模型和调用方；由产品/架构拍板唯一身份 SoR 与仓库 ownership |
| `CON-FE-004` | “阶段已完成”的含义 | `project_plan.md` 把页面阶段全部标为完成 | 主应用明确声明 MVP 使用 Mock，源码含 `src/mocks/`，并列出 Supabase/Firebase/Stripe 依赖 | 当前最多证明页面原型覆盖，不能证明真实契约、权限、状态、恢复、验收或发布完成 | 以页面→数据→API→测试→运行多轴矩阵重新判定 |
| `CON-FE-005` | 顶层导航 | 平台 Word 建议“今日/研究/战役/内容/互动/增长”六项 | 主原型计划列“今日/战役/客户/内容/互动/洞察”等，并已出现独立站管理代码 | Word 是待批准输入，原型也不是批准 IA；当前不存在可直接继承的单一导航真值 | Gate 1 只呈现差异；导航在 Phase 2 由产品负责人拍板 |
| `CON-FE-006` | 前端技术栈 | 平台 Word 目标容器写 Next.js App Shell | 本地主应用与管理端均为 Vite + React 19 | 目标建议与现有原型不同；Phase 1 不做框架迁移决策 | 后续结合部署、SEO/BFF、团队能力和现有资产形成选项 |
| `CON-FE-007` | 本地用户资料与现行文档 | 主工作区删除了 `docs/templates/前端技术方案模板.md`，另有未跟踪 `template/`、HTML 和 Playwright 产物 | 隔离 worktree 的 Git 基线仍含模板文件 | 主工作区是用户现场，不能以 worktree 内容覆盖、清理或反向解释用户意图 | 仅登记和只读审计；任何迁移/删除需单独授权 |
| `CON-FE-008` | 兼容入口真值 | `CLAUDE.md` 保留旧模型、环境和阶段叙述 | `AGENTS.md` 明确其仅为兼容入口，冲突以权威链为准 | `CLAUDE.md` 不能作为当前状态源 | 在来源登记中标为兼容/过期风险，不在 Phase 1 修改它 |
| `CON-FE-009` | “独立站管理”的产品层级 | 产品负责人已明确“独立站管理”是统一 SaaS 的一级产品区域 | 主原型 `Sidebar.tsx` 将其放在分隔线下的 secondary navigation | 原型 IA 不符合已固定产品事实，不能直接继承 | Phase 2 重新设计统一 IA；Phase 1 只登记当前实现和影响 |
| `CON-FE-010` | 身份实现的安全基线 | 权威架构要求 JWKS、Workspace、服务端权限、RLS 和秘密治理 | 本地 Spring 原型使用 HMAC 自签 token、单用户 `role`、MySQL/JPA `ddl-auto:update`，源码还包含可用默认凭据/管理员种子/JWT fallback | 既有实现不能作为生产身份基线；暴露值不得进入审计文档 | 禁止探测或使用凭据；由 Owner 确认有效性并轮换/封存，后续另立安全整改计划 |
| `CON-FE-011` | 前端接口真值 | 本仓后端以 code-first OpenAPI、JWKS 和 Workspace 契约为当前接入基线 | 主原型只定义 `localhost:8080/api` 的登录、注册、资料和改密请求，未使用本仓 OpenAPI 或 Site Builder API | 页面覆盖不代表后端接入；Site Builder 当前是纯原型数据面 | 在实现证据矩阵逐页标记 Mock/旧 API/真实 API，后续再定迁移方案 |
| `CON-FE-012` | OpenAPI 路径数量 | `docs/architecture/current.md` 仍写 code-first JSON 为 40 paths | 本次直接读取 `packages/contracts/openapi/openapi.json` 得到 56 paths / 64 operations | 数量型文档已漂移；机器契约仍是接口真值 | 后续 truth-sync 改为机器生成统计或删除易漂移手抄数字 |
| `CON-FE-013` | 构建接入说明 | `packages/contracts/INTEGRATION.md` 的示例仍主要表达整站和较窄 locale | 当前 Controller/DTO 已支持 site/page/section、pages、en/de-DE 与两个 preset | 前端若按旧说明实现会漏掉局部构建和严格枚举 | Phase 4/6 生成前端接入参考；由 contract test 约束文档示例 |
| `CON-FE-014` | 原型的独立站能力承诺 | SaaS 原型展示发布、域名/SSL、分析、询盘、SEO/诊断、博客和四种风格 | main OpenAPI 只有 intake/site/profile/asset/KB/build/cancel；Inquiry 明确 `disabled_until_m2` | 大量页面是目标态或 Mock，不能进入“当前可用”文案 | Phase 2 按用户价值重排；Phase 5 为每项建立独立能力包与阶段状态 |
| `CON-FE-015` | 公开站发布形态 | Word/原型和部分历史文档描述版本化 Release、发布与回滚 | main 仍以本地 `.preview/sites` 为产物；R1-min 候选在未合并 worktree | 当前只能叫开发预览；不具备生产跨节点/对象存储发布证明 | 等 R1-min 独立任务经 PR/验证合入后再 truth-sync |
| `CON-FE-016` | 未知组件处理 | 当前 `Section.astro` 注释和代码对 unknown component 静默 `null` | R1-min 目标要求 unknown component fail loudly，避免缺内容仍发布 | main 与下一质量门冲突；当前渲染可能静默缺块 | 由 R1-min 施工任务解决；Phase 1 不改 renderer |
| `CON-FE-017` | SiteSpec 运行时校验 | 契约文档描述发布前多重 schema/质量门 | `loadSpec()` 仅 `JSON.parse(...) as SiteSpec`，注释把 Zod 留作 follow-up | TypeScript 类型不能防运行时坏 JSON；可能晚失败或错误定位不足 | 纳入 R1-min/后续 renderer gate 评审，不在 docs-only 阶段修代码 |
| `CON-FE-018` | Refurbish 质量步骤 | 文档/目标流程把 quality loop 视为关键步骤 | main workflow 的 `quality_loop` 终态为 `skipped_m1f`/`skipped` | 生成成功不能解释为质量循环已执行 | 所有 UI/指南必须显示真实 skipped/degraded；M1-f 单独 Gate |
| `CON-FE-019` | 多语种范围 | 原型/Word 对多语种有宽泛承诺，renderer test 还含 `ar` | 当前文案生成冻结为 `en`、`de-DE`；`ar` 只验证 RTL 渲染 | “可渲染”和“可生成事实受限文案”不能混写 | 建立 locale capability registry；Phase 2/5 拍板市场/语言顺序 |
| `CON-FE-020` | 研发流程中的 QA | 未跟踪 HTML 流程图明确取消独立 QA 步骤，以开发自测后上线 | 现行仓库要求 CI、安全、契约门、自动审查、真服务/对抗验证并保留产品/设计验收 | “取消独立岗位/阶段”不等于取消独立质量责任；直接采用会削弱证据链 | 后续将质量责任嵌入每个纵切并明确独立验收/发布 Gate，产品负责人拍板流程 |
| `CON-FE-021` | 活文档的混合时间 | `status/current`、主线摘要已更新到 M1-d/R4-A2/R4-B | 05/07/08/13/14 及 v3.2 部分段落仍保留“待实现/未落地/目标”旧状态 | 新人逐篇阅读会得到互相矛盾的当前状态 | Phase 3 建 doc register/last_verified_commit；truth-sync 只改事实 owner，不复制状态 |
| `CON-FE-022` | 模板来源与使用权 | 本地 `template/` 和 SaaS 原型含大量 Readdy 生成痕迹，页面可运行 | 没有逐资产来源、账号条款版本、License、Owner 和允许用途记录；官方条款限制某些反向工程/竞争性 AI 用途 | 不能直接做训练集、RAG、组件蒸馏或商用模板库 | 全部标 `VISUAL_REFERENCE_ONLY`；法务/权利评审后按资产逐项放行 |
| `CON-FE-023` | 历史分支是否等于当前实现 | R1-min-release、template-distillation、R4-A2 等 worktree 含独有提交/改动 | main 只包含已经合入的精确提交；部分 legacy worktree 还很脏 | 分支存在不能升级能力状态，也不能仅靠 ancestor 关系判断遗漏 | 以 `worktree-provenance.md` 为审计入口；合并/清理由各自任务与授权处理 |

## 已知开放项而非事实冲突

以下事项没有两份相反真值，而是缺失决策：正式前端仓库/Owner、身份 SoR、目标导航、Workspace 权限、商业套餐、生产域名、设计工具、模板权利和跨仓 API ownership。它们进入 `open-decisions-and-risks.md`，不得由冲突表作者静默裁决。
