# Phase 1 实现证据矩阵

> 文档 ID：AUD-FE-P1-002
> 状态：`COMPLETE_FOR_GATE_1`
> 代码基线：`main@c3f0cca80e228f08f35c89776f759748dac78ce2`
> 核验日期：2026-07-20

本矩阵只回答“冻结基线 `c3f0cca` 和本地前端原型实际有什么”。它不把历史分支、Word、原型页面或未来路线升级为已实现能力。`AS_BUILT` 仅表示对应代码面在该提交可验证；若“前端入口”或“生产运行”列为空，仍不能称为用户可用或已上线。审计后 `origin/main` 的 #157 变化见 [覆盖率与限制 §5](audit-coverage-and-limitations.md#5-审计期间发生的远端变化)，未混入本矩阵的运行数字。

## 1. 核验口径

| 证据级别 | 含义 |
|---|---|
| `C` | main 代码或 Prisma 模型可定位 |
| `K` | 导出的 OpenAPI、共享类型或事件契约可定位 |
| `T` | main 有针对性自动测试 |
| `V` | main 有真服务/verify 脚本或本阶段运行结果；脚本存在不等于本次已执行 |
| `F` | 正式 SaaS 前端已接该契约 |
| `D` | 有部署/发布证据，且声明与环境相符 |

“最低实现证据”通常为 `C+K+T`；涉及内部工作流可为 `C+T`。声称用户可用还必须有 `F`，声称已上线还必须有 `D`。

## 2. 独立站管理真实链路

| 能力 | 用户动作/结果 | 契约与入口 | 数据/服务/工作流 | 测试与验证来源 | 当前证据 | 当前判定与缺口 |
|---|---|---|---|---|---|---|
| 建站 intake | 注册资料生成站点档案并触发 demo v0 | `POST /api/v1/site-builder/intake`；`apps/api/src/site-builder/intake.controller.ts` | `IntakeService`、Site/SiteVersion/BuildRun、Temporal demo workflow | `intake.service.spec.ts`、`verify-site-builder-intake-idempotency.mts`、`verify-site-builder-m0.mts` | `C+K+T`，历史 verify 可追溯 | 后端 `AS_BUILT`；SaaS 原型没有接入；正式客户端必须携带幂等键，但 OpenAPI 仍把 header 标成 optional |
| 站点列表/详情 | 查看当前 Workspace 的站点、状态、活动版本和预览 URL | `GET /site-builder/sites`、`GET /sites/{id}` | `SitesService`；Prisma `Site`；`previewUrlFor` | `sites.service.spec.ts`、OpenAPI 导出 | `C+K+T` | 后端 `AS_BUILT`；前端纯 Mock；预览 URL 指向开发预览形态，不等于生产 Release |
| 向导档案 | 读取/分组保存企业资料 | `GET/PATCH /sites/{id}/profile`；ETag/If-Match/baseVersionId | Profile JSON、组级替换、CAS/迁移门 | `profile-controller.spec.ts`、`profile-openapi.spec.ts`、`verify-site-builder-profile-r2.mts` | `C+K+T` | 后端 `AS_BUILT`；冲突、412/428/422 等前端恢复体验尚无正式实现 |
| 素材直传 | 获取预签名 URL、上传后提交 | `POST /sites/{id}/assets/presign`、`POST /assets/{id}/commit` | MinIO/S3、Asset lease/fencing/CAS、Outbox→Temporal cleanup | `assets*.spec.ts`、`asset-delete-openapi.spec.ts`、`verify-site-builder-asset-r2.mts`、`verify-site-builder-cleanup-r2.mts` | `C+K+T` | 后端 `AS_BUILT`；没有 SaaS 上传器、进度、重试、冲突或错误映射实现证据 |
| 素材列表/删除 | 查看处理状态；受引用守卫的软删除 | `GET /sites/{id}/assets`、`DELETE /assets/{id}` | Asset/AssetVariant、Profile/active SiteSpec 引用扫描、异步回收 | `site-spec-asset-reference-scanner.spec.ts`、MF0/cleanup 测试与 verify 脚本 | `C+K+T` | 后端 `AS_BUILT`；用户侧“为什么不能删、在哪里解除引用”流程未实现 |
| KB 摄入与状态 | 文档解析、分块、embedding，并查看资料缺口 | `GET /sites/{id}/kb/status` | Docling、new-api BGE-M3、KB ingest/recovery Temporal workflows | `kb*.spec.ts`、`kb-ingest.workflow.spec.ts`、`kb-recovery.workflow.spec.ts`、`verify-site-builder-kb-r2.mts` | `C+K+T`，历史真服务证据 | 后端 `AS_BUILT`；UI 没有队列、部分失败、重试和缺口修复闭环 |
| 精装修构建 | 整站、单页、单区块构建；选择样式和语言 | `POST /sites/{id}/builds`；scope=`site/page/section`，生成语言=`en/de-DE` | BuildRun、预算、任务 attempt、Temporal refurbish | `build-request-contract.spec.ts`、`builds.service.spec.ts`、`refurbish.workflow.spec.ts` | `C+K+T` | 后端 `AS_BUILT`；原型给出的样式/功能集合与真实枚举不一致；正式前端未接入 |
| 构建进度/成本 | 轮询 phase/progress/steps/costSummary | `GET /builds/{id}`；`site-builder-cost-summary/v1` | BuildStep、BuildBudget、BuildTaskAttempt、BuildSpend | `build-cost-summary-openapi.spec.ts`、ledger/repository tests、R3-B/R4-B verify 脚本 | `C+K+T` | 后端 `AS_BUILT`；当前是轮询，SSE 后置；用户可见成本、未知结算和降级文案未设计 |
| 取消与补偿 | 取消运行中的构建并保留既有站点 | `POST /builds/{id}/cancel` | Build cancel CAS、Temporal cancellation、补偿和 staging 清理 | `builds.service.spec.ts`、`refurbish.workflow.spec.ts`、`site-builder.activities.spec.ts` | `C+K+T` | 后端 `AS_BUILT`；前端没有确认、迟到完成、不可取消、重试等状态体验 |
| Brand Profile | 基于资料/研究生成受约束的品牌档案 | 内部 task route；无独立公开 API | 有界 AI task、EvidenceRef v2、模型路由与预算门 | `brand-profile*.spec.ts`、active evidence bundle、MODEL-1 verify | `C+K+T+V`（内部） | 内部能力 `AS_BUILT`；不是可单独售卖/编辑的 SaaS 页面；研究降级必须诚实呈现 |
| Claim/Evidence bridge | 仅把可发布主张冻结进版本 | `@global/contracts` Evidence；内部 snapshot contract | Claim、Evidence、SiteEvidenceSourceSnapshot、SitePublishableClaimSnapshot(+Item) | evidence/claim snapshot/migration integrity tests、`verify-site-builder-r4-a2.mts` | `C+K+T` | 内部 `AS_BUILT`；没有公开审批 API、角色矩阵或 SaaS 审批界面 |
| 多语种事实受限文案 | 生成 en/de-DE 的 CopyBundleSet，并按 locale 精确渲染 | `site-builder-copy-bundle-set/v1`、locale registry | `SiteCopyBundle`、copy task、copy slot 校验 | copy bundle、locale renderer、migration tests、`verify-site-builder-m1d.mts` | `C+K+T` | main 已实现 M1-d；`ar` 只作 RTL 渲染 smoke，不是生成语种；前端原型语言承诺不可直接继承 |
| SiteSpec/组件渲染 | 用静态契约生成公开站点 | `SiteSpec 1.0.0`；10 个 Astro 组件 | `apps/site-renderer`，Astro 静态构建，两个样式 preset | renderer、spec、link、theme tests；renderer sandbox verify | `C+K+T` | 内部 `AS_BUILT`，但 `loadSpec()` 仍是 JSON 强制类型转换，缺运行时 schema 门；未知组件当前静默跳过 |
| 开发预览 | 构建候选后切换本机 served pointer | Site DTO 暴露 `previewUrl` | `.preview/sites` 本地目录、staging/version/live promotion、DB activeVersion CAS | preview promotion/static/activities tests | `C+K+T` | 仅开发环境 `INTERNAL_ONLY`；不是跨节点、不可变对象存储 Release，也没有生产部署证据 |
| 生产 Release/发布/回滚 | 版本化发布公开站并可跨节点恢复 | 当前 main 无公开 publish/release API | R1-min 为下一主线；相关远端分支尚未并入 main | main 没有与用户承诺相称的验证链 | 不满足 | `APPROVED_NOT_BUILT`/在制，不能写成已实现；不得用历史分支替代 main |
| 询盘表单 | 访客提交询盘并进入 SaaS | 仅有 `InquiryFormDefinitionV1` 和未来事件保留 | `submission.mode="disabled_until_m2"`；无 receiver/persistence/delivery | `inquiry-boundary-contract.spec.ts` | `K+T` | 明确 `DEFERRED`；渲染器展示边界不能被前端原型解释为可收询盘 |
| 域名、SSL、DNS | 绑定域名并验证/续期 | 当前 OpenAPI 无端点 | 当前 main 无相应模型/工作流 | 无 | 不满足 | `PROPOSED`/目标态；原型卡片不构成实现 |
| 站点分析 | 查看访问、转化、页面和来源 | 当前 OpenAPI 无端点 | 当前 main 无站点 analytics 数据链 | 无 | 不满足 | `PROPOSED`；原型数据全部为 Mock |
| SEO/诊断/博客 | 诊断问题、管理博客与 SEO | 当前 OpenAPI 无对应端点 | 当前 main 没有完整服务链 | 无 | 不满足 | 仅原型/Word 输入；不得标记 `AS_BUILT` |

## 3. SaaS 原型接入证据

| 检查面 | 实际发现 | 证据 | 结论 |
|---|---|---|---|
| 路由与页面 | 主应用有 22 个 route entry，覆盖 landing、goal、dashboard、campaign、account、content、publish、opportunity、engagement、insights、site-builder、knowledge、competitor、integration、team、settings 等 | `/global/frontend/project-12080666/src/router/config.tsx` | 页面覆盖广，只能证明本地原型面 |
| 数据来源 | 主要业务页读取 `src/mocks/*.ts`；Site Builder 页面和 209 行数据文件均为本地 Mock | `/global/frontend/project-12080666/src/mocks/`、`src/pages/site-builder/` | 不能证明真实业务闭环 |
| API | 只有登录、注册、资料和改密，固定连接 `http://localhost:8080/api` | `/global/frontend/project-12080666/src/api/index.ts` | 未接 NestJS OpenAPI，也未接 Site Builder 12 个操作 |
| 身份状态 | bearer token 和 user 放在 `localStorage`；未发现 Workspace context 或统一 route guard | API、landing、goal、Sidebar 源码 | 与 JWKS/Workspace/RLS 目标边界不一致 |
| 导航 | “独立站管理”位于 secondary group | `src/components/feature/Sidebar.tsx` | 与产品负责人已固定的一级产品区域事实冲突 |
| 质量 | 未发现单元、组件、E2E、Storybook、a11y 或视觉回归测试配置 | 全目录文件与 package scripts 搜索 | 只能判定 `UNTESTED`，构建通过也不能替代行为验收 |
| 部署 | 没有 Git provenance、环境清单、CI、发布记录或可验证部署地址 | `/global/frontend` 全目录 | 不得标记 `DEPLOYED`/`GA` |

## 4. 旧 Spring 服务证据

`/global/frontend/backend` 是一套独立 Spring Boot 3.3/Java 17/MySQL 身份与用户服务：它签发 HMAC JWT，维护本地用户/管理员并启用 JPA `ddl-auto:update`。这与当前权威边界“身份归 SaaS、本仓只验 SaaS JWKS token”不等价，也没有 Workspace/RLS。源码还含默认凭据/种子/fallback；本审计不复制、不使用这些值。

当前只把它登记为“旧原型或 ownership 未定的本地来源”。在身份 SoR、仓库归属、安全整改与密钥处置得到明确裁决前，不得与 NestJS 后端合并描述，更不能作为生产基线。

## 5. 机器契约漂移

- 导出的 `packages/contracts/openapi/openapi.json` 当前为 OpenAPI 3.0.0、产品版本 0.1.0，共 **56 paths / 64 operations**，其中 Site Builder 为 **11 paths / 12 operations**。
- `docs/architecture/current.md` 仍写 “40 paths”，是数量型陈述漂移；接口真值仍以 code-first 导出物为准。
- `packages/contracts/INTEGRATION.md` 的构建示例落后于当前 page/section scope、`en/de-DE` 和局部 pages 能力。
- intake/build 的正式客户端规范要求稳定幂等键，但 OpenAPI 为兼容旧调用仍标 `required:false`；前端接入规范必须明确两层语义，不能把“可省略”当推荐做法。

## 6. 本阶段运行结果

| 检查 | 结果 | 解释 |
|---|---|---|
| `pnpm --filter @global/db generate` | PASS | 新 worktree 成功生成 Prisma Client |
| `pnpm --filter @global/contracts build` | PASS | 共享契约 TypeScript 构建通过 |
| `pnpm --filter @global/contracts lint` | PASS with 15 warnings | 0 error；15 个 warning 均为 operation tag 未在 global tags 声明，其中 Site Builder 占 12 个 operation |
| `pnpm --filter @global/api build` | PASS | 在 Prisma/Contracts 前置完成后构建通过 |
| `pnpm --filter @global/api test` | PASS | 193 files / 3,307 tests 全通过 |
| `pnpm --filter @global/site-renderer test` | PASS | 1 file / 3 tests 全通过 |
| SaaS 主原型临时副本 `npm ci` | PASS | 385 packages，npm audit 0 vulnerability；不改变用户目录 |
| SaaS 主原型 Vite build | PASS with warning | 120 modules；主 JS 835.27 kB（gzip 213.42 kB），超过 500 kB warning；无代码分割证据 |
| SaaS 主原型 type-check | FAIL | `SettingsTab.tsx` 读取 Mock SEO 对象不存在的 `domainAuthority`、`backlinks`、`indexingStatus`，共 4 个 TS2339 |
| SaaS 主原型 lint | FAIL | `RequestInit` no-undef；`AuthModal` hook 缺 `validateStep2` dependency；max-warnings=0 |
| 管理端临时副本 `npm ci`/Vite build | PASS | 28 packages，audit 0 vulnerability；27 modules；无 type-check/lint/test script |
| 原目录 build 直接尝试 | 环境失败 | 现有 `node_modules/.bin` 是失效的复制脚本且缺 Linux rolldown native binding；临时 `npm ci` 后可构建，证明是迁移/安装状态问题 |

第一次 API/renderer 并行尝试因新 worktree 尚未生成 Prisma Client、renderer 在 Contracts 构建完成前加载而失败；按仓库规定补齐生成顺序后全部通过。两次结果均保留在本次任务记录中，Gate 结论只使用满足前置后的有效结果。

这些检查只证明“main 后端单元/契约构建”和“本地原型可被 Vite 转译”。它们不提供生产部署、正式 SaaS 接入、E2E、浏览器可访问性或真实用户可用证据。
