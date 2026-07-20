# Phase 1 全量来源登记

> 文档 ID：AUD-FE-P1-001
> 状态：`COMPLETE_FOR_GATE_1`
> 统计口径：2026-07-20；Git 基线为 `c3f0cca80e228f08f35c89776f759748dac78ce2`

## 1. 登记规则

每项来源至少记录：稳定 ID、精确位置或 URL、载体、版本/提交/哈希、权威等级、当前读取状态、能够证明什么、不能证明什么、冲突和后续去向。目录级登记只适用于同一生成规则下的机器证据集合；其内部必须另有逐文件 manifest，不能用一个数字掩盖未知内容。

权威顺序沿用仓库现行规则：`AGENTS.md` 与产品边界、as-built 架构、ADR、当前状态、路线图优先；main 代码/机器契约/测试/本次运行证据证明实现；Word、研究稿、原型、历史分支和外部项目只作输入或 provenance。

## 2. 已知来源面

| 来源面 | 当前发现 | 权威性 | 读取状态 | 备注 |
|---|---:|---|---|---|
| Git 基线 Markdown | 66 份 / 13,758 行 | 混合 | `FULL_READ` | 逐文件 manifest 见 §4；不含本阶段新增的计划和 Gate 1 产物 |
| 仓内 Word | 5 份 | 历史/待批准输入 | `FULL_READ` | 已完成正文、表格、SHA-256、附注、链接和媒体清点 |
| 主工作区 HTML | 1 份 / 412 行 | 用户本地输入 | `FULL_READ` | `/global/backend/docs/agile-iteration-flowchart.html`，未跟踪；只读，不修改 |
| 模型路由 JSON 证据 | 92 份 | 机器证据/历史诊断混合 | `MACHINE_INVENTORIED` | 必须按 evidence bundle 的 active/historical 语义读取，不能把全部 JSON 都当当前成功证据 |
| 基线 main 代码、契约、迁移、测试、verify 脚本 | 逐链路登记 | 实现事实 | `CODE_VERIFIED` | 见 `implementation-evidence-matrix.md`；只认基线 main，不以历史 worktree 代替 |
| SaaS 前端目录 `/global/frontend` | 149 个文件 | 无版本 provenance 的本地实现/原型 | `FULL_READ+CODE_VERIFIED` | 排除 `node_modules` 和 Maven `target`；目录自身及三个子项目均无 Git 元数据 |
| 主工作区 `template/` | 10 个 Vite 项目目录 | 用户本地设计/代码输入 | `MACHINE_INVENTORIED+SAMPLED_FULL_READ` | 未跟踪用户资产，只读；不得整理、移动或删除 |
| Git worktree/分支/任务记忆 | 41 个 Git worktree 登记项 | provenance | `CODE_VERIFIED` | 见 `worktree-provenance.md`；含项目内、legacy、工具托管和 4 个已失联 Mac 路径 |
| GoodJob | Gitee 精确快照 | 外部竞品/工作方式输入 | `FULL_READ+RUNTIME_VERIFIED` | 快照 `5732e209…`；Gitee 刷新受认证阻挡，不能断言远端最新 |
| 其他竞品/OSS/官方资料 | 按候选组登记 | 外部输入 | `REGISTERED_AND_SCOPED` | 已核验项与待深审项见 `external-benchmark-and-oss-audit.md`；待深审项不得视为选型 |

## 3. Word 结构与完整性登记

OOXML 全程在本机只读解析；没有上传到外部服务。`Pages/Words` 等 Office 应用属性在部分 python-docx 文件中明显未更新，因此只作为文件元数据，不作为内容完整性计数。

| 来源 ID | 文件 | SHA-256 | 段落 / 表格 / 单元格 | 媒体与附注 | 当前读取状态 |
|---|---|---|---:|---|---|
| `SRC-WORD-001` | `docs/出海企业AI全球客户开发与增长执行平台_产品总体PRD_v3.0_完整评审稿.docx` | `b3759d906f3d9bb51246549d406a3abd252048e7a5393dc1f3b183853613ed76` | 1792 / 102 / 3885 | 0 媒体；无脚注/尾注/批注 | `FULL_READ` |
| `SRC-WORD-002` | `docs/出海企业AI全球客户开发与增长执行平台_产品总纲与产品手册_v3.0_完整评审稿.docx` | `5fcf59f05413e3a212b301651ee68c950a6306ebd7492eb31f685d7d2f8a3d6b` | 1492 / 55 / 1726 | 0 媒体；无脚注/尾注/批注 | `FULL_READ` |
| `SRC-WORD-003` | `docs/出海企业AI增长平台_总产品手册与PRD_v2.0_完整产品母本.docx` | `7c174c5d67ac553aca8e42bf571adcc4d2ad7b0ceffceacd1ff54df882f30ad7` | 2209 / 153 / 4021 | 0 媒体；无脚注/尾注/批注；17 个字段 | `FULL_READ` |
| `SRC-WORD-004` | `docs/platform/全球客户开发与增长执行平台_顶层产品与系统架构设计_v1.0.docx` | `e3e267437340b266a81f9cb92202ce021c58e4ead28a1baf9f5c2c55865956f7` | 267 / 40 / 852 | 8 张架构图已逐张读取；无脚注/尾注/批注 | `FULL_READ` |
| `SRC-WORD-005` | `docs/platform/全球客户开发与增长执行平台_v3.0文档体系重构与实施治理方案_v1.0.docx` | `68e66a8371a7a4b7e5ee497b751fe8b91db81ea310939b17e75f6aea27394bb0` | 124 / 15 / 317 | 1 张事实源分层图已读取；无脚注/尾注/批注 | `FULL_READ` |

五份 Word 都没有外部超链接关系。两份平台 Word 的图片替代文本仅为 `Image: imageN.png`，不足以构成可访问的语义说明；后续若迁移图示，需要在正式设计资产中补稳定 ID、文字等价物、Owner 和版本。

## 4. Git 基线 Markdown manifest

以下 66 份文件均已全文读取。它们按“权威/活文档/研究/历史/证据/模板”分别解释，不因为 `FULL_READ` 自动成为同级真值。

```text
.codex/README.md
.github/pull_request_template.md
AGENTS.md
CLAUDE.md
CONTRIBUTING.md
README.md
docs/adr/registry.md
docs/architecture/current.md
docs/backend/{ci-merge-automation,compose-project-migration,discovery-sources,oss-registry,vocab-taxonomy,worktree-management}.md
docs/evidence/model-routing/model1-brand-profile-20260719-v20/README.md
docs/implementation-records/{deletion-art17-residual-window,openfda-provider-spec,patent-cache-codex-p93-fixes,site-builder-m1d-copy,storage-compliance-spec,ted-provider-spec,temporal-workflow-testing,trade-fair-intelligence}.md
docs/product-scope.md
docs/research/{api-management,buyer-intelligence-v3,discovery-architecture,discovery-eval-round2,discovery-eval,platform-top-level-design-v1,positioning-and-acquisition-backlog}.md
docs/roadmap/{changelog,decision-maker-cross-source-identity-design,decision-maker-multi-source-spec,decision-maker-p0.4-mainchain-wiring-design,decision-maker-p1-companies-house-design,decision-maker-p1-google-patents-inventor-design,decision-maker-p1-inpi-rne-dirigeant-design,decision-maker-p1-patent-cache-design,release-plan,sam-sources-sought-p4-design,sanctions-screening-design}.md
docs/site-builder/00-decisions-and-coordination.md
docs/site-builder/01-prd.md
docs/site-builder/02-architecture.md
docs/site-builder/03-agents.md
docs/site-builder/04-sitespec-contract.md
docs/site-builder/05-deployment-hosting.md
docs/site-builder/06-security-abuse.md
docs/site-builder/07-api-contract-draft.md
docs/site-builder/08-eval-testing.md
docs/site-builder/09-m1-implementation-design.md
docs/site-builder/10-model-selection-study.md
docs/site-builder/11-readdy-component-source-study.md
docs/site-builder/12-site-builder-design-intelligence-and-cc-implementation-v3.1.md
docs/site-builder/12-site-builder-design-intelligence-and-cc-implementation-v3.2.md
docs/site-builder/13-design-domain-model.md
docs/site-builder/14-media-foundation-mf0.md
docs/site-builder/DQ-1-shared-sitespec-contract.md
docs/site-builder/handoffs/r1-min-execution-brief.md
docs/status/{current,pilot-readiness-gap-report}.md
docs/templates/前端技术方案模板.md
infra/systemd/README.md
packages/contracts/{INTEGRATION,README}.md
packages/contracts/events/WEBHOOK.md
```

其中 v3.1/v3.2、旧 Word、研究稿和旧 `CLAUDE.md` 都含有与当前 main 时间不一致的内容；其 superseded/dated banner 有效，但位置和篇幅仍容易误导新人。Phase 1 只登记，不移动或归档。

## 5. 产品 Word 的内容去向

| 来源 | 可保留输入 | 不可直接继承 | 后续去向 |
|---|---|---|---|
| v3 总体 PRD | 用户/JTBD、端到端旅程、13+ 页面、状态/恢复、权限、Evidence、成本、政策、a11y/i18n、服务运营 | 2026-07-05 待评审导航、范围、技术和 OSS 选择；未包含后续固定的“独立站管理一级区域” | Phase 2 产品基线、Phase 4 全局 UX、Phase 5 能力包 |
| v3 总纲/手册 | 产品叙事、角色、工作方式、能力说明、管理员/运营视角 | “已有/目标”混合的陈述和未经代码核验的能力 | 产品门户、使用指南与 Capability Brief 输入 |
| v2 产品母本 | 较完整的业务对象、场景和早期路线 provenance | 已被 v3 取代的 SAO 北极星、QGO 内外部定位、GEO/AEO 和旧 Agent 分工 | 仅作历史决策输入，不复活为当前边界 |
| 顶层架构 v1 | 系统分层、SaaS/能力服务/数据与外部集成视角 | Next.js、同仓/同库、具体导航和目标态组件不能覆盖 current architecture | Phase 2/6 方案比较输入 |
| 文档治理 v1 | D01–D22、RACI、Gate 0–3、DoR/DoD、traceability、source-target coverage、OSS card、evidence registry | 一次性大搬迁或用文档数量代替事实治理 | 已吸收到批准计划与 Phase 1 Gate 方法 |

## 6. 本地前端与设计源登记

| 来源 ID | 路径 | 规模 | 读取/核验结果 | 未来身份 |
|---|---|---:|---|---|
| `SRC-FE-001` | `/global/frontend/project-12080666` | 96 个 source 文件 / 约 19,120 行 | Router、Layout、API、全部业务页面和 Mock 已审；无测试/Git/正式 OpenAPI client | SaaS 视觉/交互原型输入，不是发布真值 |
| `SRC-FE-002` | `/global/frontend/admin-frontend` | 5 个 source 文件 / 约 529 行 | 登录+用户列表；无测试/Git | 管理端原型输入，ownership 待定 |
| `SRC-FE-003` | `/global/frontend/backend` | 约 994 行 Java/YAML | 身份/用户/admin 服务已审；与 JWKS/Workspace 边界冲突并含默认秘密风险 | 旧服务来源，安全与 SoR 待裁决 |
| `SRC-DES-001..010` | `/global/backend/template/project-*` | 10 个 Vite 项目；合计约 39,423 source 行 | 文件/依赖/外链/页面结构机器清点，代表样本全文审读；136 个 Readdy URL、11 个 Readdy form endpoint、3 个 `.env` | `VISUAL_REFERENCE_ONLY`，须权利/许可审计 |
| `SRC-DES-011` | `/global/backend/docs/agile-iteration-flowchart.html` | 412 行 | 全文读取；主张取消独立 QA 步骤 | 用户工作流输入，与现行质量门冲突，待裁决 |
| `SRC-DES-012` | `/global/backend/.playwright-cli/` | 本地运行资产 | 只登记存在性和来源类型 | 用户现场；不作为受控视觉基线 |

约定范围内未发现 Figma/Sketch/XD/Penpot 文件或链接、Storybook、Design Token 包、正式组件库文档、设计评审记录和可验证部署 URL，结论为 `NOT_FOUND_IN_SCANNED_SCOPE`，不等于其他设备或外部账号不存在。

## 7. 代码与机器证据登记

| 来源 ID | 路径组 | 证明范围 | 核验结果 |
|---|---|---|---|
| `SRC-CODE-SB` | `apps/api/src/site-builder/` | HTTP、Profile/Asset/KB/Build、Claim/Cost/preview | 逐链路核验，详见实现证据矩阵 |
| `SRC-CODE-WF` | `apps/api/src/temporal/*site-builder*`、`refurbish.workflow.ts`、KB/cleanup workflows | 长任务、重试、取消、补偿、恢复 | 逐链路核验 |
| `SRC-CODE-RENDER` | `apps/site-renderer/` | SiteSpec 静态消费和 10 组件 | 全部 source/test 读取；发现运行时 schema 与 unknown component 缺口 |
| `SRC-CONTRACT` | `packages/contracts/` | OpenAPI、SiteSpec、Copy、Evidence、Media、Inquiry、events | 导出 OpenAPI 计为 56 paths/64 operations；Site Builder 12 operations |
| `SRC-DATA` | `packages/db/prisma/` | Site/Version/Build/Asset/Claim/Evidence/Copy/预算账本 | 模型、迁移和完整性测试核验 |
| `SRC-VERIFY` | `apps/api/scripts/verify-site-builder-*.mts` | 历史真服务/真机检查入口 | 逐脚本登记；存在不等于本阶段已重跑 |
| `SRC-MODEL-EVIDENCE` | `docs/evidence/model-routing/` | active/historical 模型路由证据 | 92 JSON 机器清点；active bundle 语义核验 |

## 8. 外部来源登记

GoodJob 的精确快照、测试结果、可吸收方法，以及 Diátaxis、Backstage TechDocs、Storybook、Playwright、Astro、Puck、Readdy、Temporal、OPA、Langfuse、Activepieces、Chatwoot、Docling、Crawl4AI、Remotion 的官方资料，均登记在 `external-benchmark-and-oss-audit.md`。Word 中其余 OSS 名称已进入待官方深审队列，未冒充已选型。

## 9. 不能据当前登记推出的结论

- “文档写已完成”不能证明 SaaS 页面真实接入、可运行或发布。
- `/global/frontend` 有源码不能证明它是当前正式仓库、当前部署版本或已有后端契约对接。
- Word 中的导航、Next.js、同库/同仓、OSS 和 Release 方案不能直接升级为批准决策。
- 历史分支领先 main 或拥有独有提交不能证明其内容应合并；squash 后 ancestor 关系也不能单独证明内容丢失。
- 竞品或 OSS 有某项功能不能自动生成我们的导航、产品范围或采用结论。
