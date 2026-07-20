# SaaS 前端与设计来源定位审计

> 文档 ID：AUD-FE-P1-005
> 状态：`COMPLETE_FOR_GATE_1`
> 结论级别：当前为来源定位，不是前端技术方案或 IA 决策

## 1. 当前定位结论

真实本地 SaaS 前端源码位于 `/global/frontend`，不是 `/global/backend/apps/site-renderer`。后者是 Astro 公开独立站渲染器；前者才包含 SaaS 工作台页面。两者职责必须在后续文档中分开表达，同时“独立站管理”仍属于统一 SaaS 的一级产品区域，Astro 站点只是其版本化公开输出。

`/global/frontend` 目前没有 Git 元数据，因此只能称为“本地实现/原型来源”，不能称为当前正式仓库或发布真值。顶层 README 仍写目录仅占位，已经与实际内容冲突。

## 2. 发现的代码面

| 路径 | 技术形态 | 已发现内容 | 当前证据级别 |
|---|---|---|---|
| `/global/frontend/project-12080666` | Vite 8、React 19、TypeScript、Tailwind、React Router | 96 个 source 文件、约 19,120 行；22 个 route entry；统一工作台和全业务页；大量 `src/mocks` | 全目录实现审计完成；本地原型，不是正式仓库/发布真值 |
| `/global/frontend/admin-frontend` | Vite 8、React 19 | 5 个 source 文件、约 529 行；登录和用户列表 Dashboard | 全目录实现审计完成；管理端产品边界/Owner 未定义 |
| `/global/frontend/backend` | Spring Boot 3.3、Java 17、Spring Security/JPA、JWT、MySQL | 约 994 行 Java/YAML；注册、登录、用户、管理员服务 | 全目录实现审计完成；与当前身份边界冲突且有秘密治理风险 |
| `/global/backend/apps/site-renderer` | Astro | SiteSpec 到公开静态站构建 | main 代码面，后续单列实现证据；不是 SaaS App Shell |
| `/global/backend/template/project-*` | 10 个 Vite/React 项目 | 合计约 39,423 source 行，覆盖行业站、电商、后台等方向 | 机器清点+代表样本审读；未跟踪、只读，不归并、不清理 |

主应用包同时声明 Firebase、Supabase、Stripe 和 Recharts，但依赖存在不等于功能已接入。全目录搜索未发现与当前 NestJS OpenAPI 对应的生成客户端、Site Builder 请求或服务端 Workspace context；主要业务数据来自 `src/mocks`。构建工具还注入 `__READDY_*` 元数据，结合图片 URL 可确认这是一套 Readdy 生成/迭代原型来源。

## 3. 当前能确认的产品覆盖

`project_plan.md` 描述了首页、目标向导、战役、客户发现、内容、互动、洞察、知识、竞品、集成、团队和设置等页面，并把七个阶段标为完成；源码目录还包含 `opportunities`、`publish`、`anomaly` 和 `site-builder`。这证明原型的页面覆盖比顶层 README 所述更完整，也证明此前只看后端文档会漏掉关键前端输入。

但当前不能确认：真实登录/Workspace、后端 OpenAPI 客户端、RLS/角色可见性、长任务状态、错误恢复、Entitlement、审计、埋点、可访问性、E2E、生产构建和部署。上述能力必须在代码与运行检查后分别赋状态，不能因页面可见就统一写成“已完成”。

已核实的接口现状更窄：主 React 的 `src/api/index.ts` 只连接本地 8080 端口上的登录、注册、用户资料和改密接口，使用 `localStorage` 保存 bearer token；没有生成的 OpenAPI Client，也没有 Site Builder API。router 没有发现认证/Workspace route guard。Sidebar 把“独立站管理”置于 secondary navigation，与已固定的一级产品区域事实冲突。

本地 Spring 服务同时存在独立用户表、单一字符串角色、自签 HMAC JWT、MySQL 和 `ddl-auto:update`，并在源码配置/初始化器中暴露默认数据库凭据、管理员种子密码和 JWT fallback secret。审计文档不会复制这些值，也不会尝试连接或登录；该实现应按旧原型/高风险来源处理，不能作为生产身份或权限基线，且需要由凭据 Owner 判断是否仍有效并轮换或封存。

## 4. 设计来源现状

已发现的设计输入包括：主原型 `project_plan.md` 的深紫科技风描述、Tailwind/CSS 变量、Layout/Sidebar/TopBar 和页面组件、十个本地 Vite 模板，以及主工作区 Playwright/HTML 本地资产。全盘搜索未发现经过版本控制的 Figma/Sketch/XD/Penpot 文件或链接、Design Token 包、Storybook、组件库文档、交互原型索引、设计评审记录或正式部署地址，结论为 `NOT_FOUND_IN_SCANNED_SCOPE`。这不等于它们不存在于外部账号或其他设备；若后续提供，必须补 source ID、Owner、版本和对应页面/能力。

两份平台 Word 含 9 张架构/治理图，但图片替代文本只是文件名，不是可访问的设计资产说明；它们属于产品/架构输入，不是 SaaS 页面设计源。

十个模板至少包含 136 个 Readdy 图片 URL、11 个 Readdy 表单端点和 3 个 `.env` 文件。审计只记录存在性，不复制环境内容。因为缺少逐资产来源、账户条款版本、Owner、允许用途和验收，全部先标 `VISUAL_REFERENCE_ONLY`；尤其不能未经权利评审就作为训练数据、RAG、自动组件蒸馏或商用模板库。

## 5. 设计资产分级

| 等级 | 当前资产 | 允许用途 | 禁止推导 |
|---|---|---|---|
| `PRODUCT_INPUT` | Word 的用户/旅程/状态/权限内容 | Phase 2 讨论与冲突比较 | 不代表 IA/需求已批准 |
| `VISUAL_REFERENCE_ONLY` | 主 SaaS 原型、10 个 Readdy 模板 | 提取布局问题、信息密度、视觉方向和场景清单 | 不直接复用代码/图片，不作训练/RAG，不宣称可商用 |
| `ENGINEERING_AS_BUILT` | Astro renderer 与后端 main | 描述真实契约、组件和内部预览 | 不代表 SaaS UX 已设计或生产发布 |
| `USER_WORKFLOW_INPUT` | 未跟踪 HTML 流程图、Playwright 本地产物 | 讨论研发流程和可能的回归输入 | 不代表当前正式流程或质量基线 |
| `MISSING_FORMAL_SOURCE` | Figma/Design Token/Storybook/评审记录 | Gate 1 暴露缺口 | 不由 Codex擅自选工具或创建外部项目 |

## 6. 对正式前端文档的影响

后续不能只写一个“前端技术方案”。至少需要三层：

1. **产品体验层**：统一 SaaS IA、用户旅程、页面/能力目录、权限、完整状态和文案。
2. **设计系统层**：tokens、组件状态、响应式、a11y、国际化、视觉回归、设计源 ID 和资产权利。
3. **工程接入层**：正式仓库/Owner、App Shell、JWKS/Workspace、OpenAPI client、query/cache、长任务、错误恢复、可观测、测试、部署和回滚。

独立站管理还要增加公开产物层：SiteSpec/Copy/Asset/Claim/Release、Renderer、Preview、Publish、Domain 和 visitor/inquiry 边界。公开站是 SaaS 管理能力的输出，不能再被写成并列的“第二前端”。

## 7. Gate 1 定位结论

1. 已找到真实本地 SaaS 页面源码，但它是无 Git provenance、Mock 主导、未接当前后端且无自动测试的原型。
2. 已找到管理端和 Spring 服务，但其产品边界、身份 SoR、安全基线和 ownership 均未批准。
3. 已找到丰富视觉参考，但没有正式设计事实源，也没有足够权利证据支持代码/资产复用。
4. 已找到可工作的 Astro renderer，但它只负责公开静态产物；生产 Release 和正式 SaaS 控制面仍是缺口。
5. 因此 Phase 2/4 应先定产品 IA、对象/权限、正式仓库和设计证据链，再决定框架迁移或复用比例；不能继续用页面数量代表交付进度。

## 8. 本次非破坏性构建证据

为避免污染无 Git 的用户目录，本次把主应用和管理端复制到 `/tmp`，在副本执行 `npm ci` 和构建：

- 主应用 Vite build 成功，但主 JS chunk 为 835.27 kB（gzip 213.42 kB）并触发超过 500 kB 警告；没有 route-level code splitting 证据。
- 主应用 TypeScript 检查失败 4 项，均为 Site Builder `SettingsTab` 读取 Mock SEO 对象中不存在的字段。
- 主应用 ESLint 失败：1 个 `RequestInit` no-undef，另有 1 个 Hook dependency warning；因为脚本设置 `--max-warnings 0`，当前 lint gate 不通过。
- 管理端 Vite build 成功，但 package 没有 type-check、lint 或 test script。
- 原目录现有 `node_modules/.bin` 和 Linux native optional dependency 不完整；临时重装后 build 可运行。这是迁移/依赖安装 provenance 缺失的直接证据。
- 旧 Spring 服务没有 Maven Wrapper，当前环境也没有可用 `mvn`，因此本阶段只做源码/配置审计，没有把历史 `target/` 产物或旧编译结果当成本次构建证据。

Phase 1 不修这些源码问题。它们进入正式前端接管前的最小健康门：可复现安装、type-check、lint、bundle budget、unit/component/E2E、a11y、visual regression 和部署证据。
