# Gate 1 评审包：SaaS 前端来源与实现审计

> 文档 ID：AUD-FE-P1-009
> 状态：`READY_FOR_REVIEW_WITH_POST_BASELINE_DELTA`
> 批准边界：不是 `APPROVED`
> 审计基线：`main@c3f0cca80e228f08f35c89776f759748dac78ce2`
> 评审日期：2026-07-20
> 决策请求：产品负责人确认 Gate 1 是否通过；未明确批准前，Codex 停止在 Phase 1

## 1. 结论先行

Phase 1 已把散落的文档、Word、前后端代码、原型、模板、历史 worktree、GoodJob 和 OSS 输入整理为一套可追溯审计包。最重要的结论是：

1. **我们不是没有 SaaS 前端，而是有一套覆盖很广但无 Git provenance、Mock 主导、未接当前 OpenAPI、无自动测试且 type-check/lint 不通过的本地原型。**
2. **“独立站管理”是统一 SaaS 的一级产品区域；Astro 公开站只是该区域的版本化输出，不是第二个 SaaS 前端。** 冻结基线后端在 intake、Profile、Asset/KB、Build、成本、取消、Claim/Copy 和开发预览上已深入落地，但正式 SaaS 控制面和 Publish/Domain/Inquiry/Analytics 仍缺。
3. **页面、后端和用户可用性的成熟度严重不对称。** 原型展示了域名、发布、分析、询盘、SEO、博客等目标能力；冻结基线的 Site Builder OpenAPI 只有 12 个操作，询盘明确禁用。审计期间 #157 已将 R1-min immutable Releases 合入实时 `origin/main`，但该 post-baseline 技术事件不等于正式 SaaS 页面、域名发布或生产部署已经可用。
4. **现有文档治理强于 GoodJob，但用户视角的功能工作簿、页面入口、权限社会属性、人工兜底、使用指南和下一动作仍不足。** 建议吸收这些方法，同时保留我们的权威链、稳定 ID、证据门和 superseded 治理。
5. **当前最大的风险不是文档数量少，而是“完成”一词跨产品、UX、前端、API、后端、质量和部署混用。** 中央多轴能力矩阵已经建立，后续任何能力必须沿证据链升级状态。

## 2. Gate 1 交付物

| 交付物 | 文件 | 状态 |
|---|---|---|
| 来源总账 | [source-register.md](source-register.md) | `COMPLETE_FOR_GATE_1` |
| 逐来源明细 | [source-detail-register.md](source-detail-register.md) | `COMPLETE_FOR_GATE_1` |
| 实现证据矩阵 | [implementation-evidence-matrix.md](implementation-evidence-matrix.md) | `COMPLETE_FOR_GATE_1` |
| 产品能力多轴状态 | [capability-status-matrix.md](capability-status-matrix.md) | `COMPLETE_FOR_GATE_1` |
| 冲突台账 | [conflict-register.md](conflict-register.md) | `COMPLETE_FOR_GATE_1` |
| SaaS 前端/设计源定位 | [frontend-design-source-audit.md](frontend-design-source-audit.md) | `COMPLETE_FOR_GATE_1` |
| worktree provenance | [worktree-provenance.md](worktree-provenance.md) | `COMPLETE_FOR_GATE_1` |
| GoodJob/OSS 初审 | [external-benchmark-and-oss-audit.md](external-benchmark-and-oss-audit.md) | `COMPLETE_FOR_GATE_1` |
| 待决策、缺失输入和风险 | [open-decisions-and-risks.md](open-decisions-and-risks.md) | `COMPLETE_FOR_GATE_1` |
| 覆盖率与限制 | [audit-coverage-and-limitations.md](audit-coverage-and-limitations.md) | `COMPLETE_FOR_GATE_1` |
| 阶段入口 | [README.md](README.md) | `READY_FOR_REVIEW` |

## 3. Gate 1 退出条件核对

| 退出条件 | 证据 | 结果 |
|---|---|---|
| 所有已知材料已登记 | 67 份基线 Markdown、5 份 Word、1 份 HTML、92 JSON、本地前后端、10 模板、41 worktree、GoodJob 和 OSS 组均在来源总账 | 满足 |
| Markdown/Word/HTML 完整读取 | 逐文件 manifest、Word 段落/表格/媒体/附注/链接统计 | 满足 |
| `AS_BUILT` 有最低证据 | Site Builder 从 API→Service→Prisma→Temporal→Renderer→Test 建矩阵 | 满足；用户可用/生产态未越级 |
| main、PR、分支和 worktree 不混写 | 冻结 `c3f0cca` 与实时 `676c6cd` 分开；#157 squash merge、远端 heads、0 个开放 PR 和 legacy dirty 状态分别记录 | 满足 |
| 定位真实 SaaS 前端 | `/global/frontend` 三套代码均审计；边界、规模、接口、质量和风险明确 | 满足 |
| 定位设计事实源 | 正式 Figma/Token/Storybook 等在扫描范围内 `NOT_FOUND`；现有原型/模板已分级 | 满足 |
| 冲突和缺失决策公开 | 24 条冲突、14 项承重决策、9 项缺失输入、15 项风险 | 满足 |
| 不越权进入 Phase 2–8 | 未创建正式 `docs/frontend/`、PRD、UX 或前端技术方案；未改产品代码 | 满足 |
| 非破坏性验证 | 后端/契约/renderer 绿；前端 build 与质量失败如实记录 | 满足 |

## 4. 运行证据摘要

- Backend：Prisma generate PASS；Contracts build PASS；API build PASS；193 test files / 3,307 tests PASS；renderer 3/3 PASS。
- OpenAPI：3.0.0、版本 0.1.0，56 paths / 64 operations；Site Builder 11 paths / 12 operations。Spectral 为 0 error / 15 warning。
- SaaS 主原型：临时干净安装后 Vite build PASS；type-check FAIL（4 个 Site Builder Mock 字段错误）；lint FAIL（1 error、1 warning）；主 JS 835.27 kB，触发 chunk 警告。
- 管理端：临时干净安装后 Vite build PASS；没有 type-check/lint/test scripts。
- 旧 Spring 服务：源码/配置审计完成；因无 Maven Wrapper 且当前环境无 Maven，本次未编译，历史 `target/` 不作为证据。
- GoodJob 精确快照：普通 backend/frontend self-test PASS；Playwright 47 项中 38 passed / 9 failed。其状态文档仍写 5 项，证明自述已漂移。

以上代码/测试数字对冻结基线 `c3f0cca` 负责。其后 #157 的合并提交与三组成功检查属于 `POST_BASELINE_EVENT_VERIFIED`；没有混入为“已在本 worktree 重跑”。详见 [审计覆盖率与限制](audit-coverage-and-limitations.md)。

所有前端检查都在 `/tmp` 副本完成；没有修改 `/global/frontend`。本阶段也没有使用源码中的旧默认凭据、连接服务或执行会改变业务数据的 verify 脚本。

## 5. Gate 1 后建议批准的范围

如果 Gate 1 通过，建议只授权 **Phase 2：产品体验与 IA 基线**，不要同时授权 Phase 3–8。Phase 2 的重点不是继续铺页面，而是完成：

1. 目标用户、关键任务、现有替代做法和待验证假设；
2. 全 SaaS 产品域、一级入口和跨模块对象图；
3. Workspace、Company、ICP、Site、SiteVersion、Release、Asset、Knowledge、BuildRun、Claim、Evidence、Conversation、Opportunity 等对象 SoR/生命周期；
4. 团队/个人/审批/公开数据属性与操作/数据范围矩阵；
5. 页面/能力目录和完整状态；
6. 第一条端到端纵切：“独立站管理→资料/素材→Build→进度/取消→恢复→开发预览”；
7. 每项优先能力的用户结果指标、护栏、反指标、数据口径和回顾条件；
8. 导航/ownership/身份/发布/询盘等开放决策的 2–3 个选项、推荐与影响。

Gate 2 仍应单独停下，由产品负责人拍板 IA、对象归属、权限、用户承诺和首批纵切，再进入文档底座、全局 UX、正式前端技术方案和能力实施。

## 6. 本次不请求批准的事项

- 不请求直接修改 `/global/frontend` 或迁移框架。
- 不请求采用 Puck、Storybook、Backstage、OPA、Langfuse、Activepieces、Chatwoot 等依赖。
- 不请求复用 Readdy 代码/图片或对模板做训练、RAG、蒸馏。
- 不请求对已经合并的 #157 做新的产品承诺，也不请求合并 template-distillation 或 legacy R4-A2 worktree。
- 不请求移动/归档旧 Word、v3.1/v3.2 或主工作区用户文件。
- 不请求创建 PR、推送或合并 main。

## 7. 评审决策

请产品负责人明确选择：

- `Gate 1 通过，授权 Phase 2`；或
- `Gate 1 有条件通过`，列出必须先补的 finding；或
- `Gate 1 不通过`，说明需要重新审计的来源/结论。

在收到明确选择前，本目标保持 active，但工作停在 Gate 1，不进入正式 PRD、UX、设计系统、前端技术方案或产品代码施工。
