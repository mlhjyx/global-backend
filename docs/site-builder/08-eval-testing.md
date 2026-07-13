# 评测与测试策略 v1（草稿，待用户确认）

> 落实 [02 §11.8](02-architecture.md)（eval harness）+ 仓库 TDD 硬规矩。两层质量体系：**运行期质量环**（每次 build 内的审核/SEO/审美三评审，02 §4 P4，已设计）管"这一站好不好"；**离线评测基线**（本文件）管"整条管线有没有随改动退化"。借鉴 Mastra"evals 一等公民"思想（03 §10.5）。

## 1. Golden Set（评测集）

- **构成**：8~12 家"标准企业"资料包 = 2~3 家**真实合作工厂**（脱敏，授权方式见 §6.1）+ 合成企业，覆盖两个维度的矩阵：
  - 行业 × 资料完整度：资料齐全 / 只有注册 6 项（demo v0 极限）/ 只有店铺 URL / 图片质量差（考图片管线）。
  - 市场特例：小语种（德/西）、RTL（阿语，考组件库）、多认证（考 factSheet）。
- 每家 = **固定输入**（intake+向导+素材+文档）+ **期望锚点**（factSheet 关键事实清单、必出 section、关键词落位、必过硬门）。
- 存 `apps/api/test/fixtures/golden-companies/`（全部脱敏/合成，过 gitleaks）。

## 2. 评测维度与量化

| 维度 | 指标 | 门槛 |
|---|---|---|
| 管线健壮性 | 全链通过率 / P95 时长 / 单站成本 | 100% / <15min / ≤预算上限（硬门） |
| 事实忠实度 | factSheet 零虚构（锚点比对） | **零容忍硬门** |
| 图片主体保护 | pHash/embedding 校验通过率 | 100% 硬门（03 卡 3） |
| 文案质量 | LLM-as-judge 5 维×20 分（结构/语言原生度/术语一致/CTA/合规） | ≥80，趋势不回退 |
| 视觉 | 审美 rubric 分 / Lighthouse 四项 | ≥85 / Perf≥85 A11y≥90 |
| SEO | 确定性检查表 | 全过（硬门） |

- **Judge 固定化**：LLM-as-judge 用固定模型+固定版本+温度 0（拍板项 §6.2），换 judge 要先跑基线校准——否则分数漂移无法归因。
- 确定性检查（校验器/Lighthouse/锚点比对）优先于模型评审——能机器判的绝不交给模型。

## 3. 回归流程

- **触发**：改 agent prompt / 换模型 / 改组件库或主题 / 改校验器 → 必须跑回归再合并（写进 PR 模板检查项）。
- **分层**：`smoke`（2 家，~分钟级，日常改动）/ `full`（全量 8~12 家，模型或组件库级改动）。
- **执行**：本地 verify 脚本真网关真构建（§5 硬规矩，CI 不跑）；报告（各维分数 vs 基线差值）贴 PR 描述；硬门回退=改动打回。
- **基线更新**：有意的质量提升合并后，重跑 full 落新基线（基线文件随 repo 版本化）。

## 4. 测试分层（TDD 落到本功能）

1. **单测**（vitest，CI 跑）：SiteSpec 校验器（合法/非法/边界 spec 表驱动）、richtext 白名单序列化（注入样本集）、prompt 模板变量转义、配额 reserve-settle、发布门 L1 规则表、CopyBundle 槽位与长度校验、locale/RTL 工具、指针切换幂等。**先写测试再实现**（RED→GREEN→IMPROVE）。
2. **编排单测**：复用 PR #73 的 mock proxyActivities harness——`siteBuilderWorkflow` 的分支覆盖：scope 增量重跑 / 单素材失败不阻断 / 预算超限暂停 / 质量环 ≤3 轮出环 / 同 site 并发去重。
3. **集成**（本地真库）：intake→demo v0 全链、素材状态机（presign→commit→处理→引用对账）、spec PATCH→秒级重渲染、**RLS 隔离证明**（`APP_DATABASE_URL` app_user 跑 + is_superuser guard，复用既有先例）。
4. **E2E verify 脚本**（真实数据无 sandbox）：每里程碑一份 `verify-site-builder-m{N}.mts`——M0=真网关真构建出真预览 URL 并可访问；M1=golden 一家全管线；M2=发布门+域名绑定干跑。
5. **契约测试**：OpenAPI 生成 schema 快照 + [07](07-api-contract-draft.md) 示例作为 contract fixtures，防接口无声漂移（前端依赖面）。

## 5. CI 边界

CI 只跑纯单测+契约快照（仓库规矩，无 DB/网络）；集成/E2E/评测=本地 verify + 里程碑门；gitleaks 覆盖 fixtures（golden set 必须脱敏）。

## 6. 待拍板

1. 真实工厂资料进 golden set 的**授权方式**（2~3 家合作工厂：口头授权+书面记录 or 简单授权书模板）。
2. **Judge 模型固定选型**——建议 gemini-3.1-pro 固定版本、温度 0（与生产文案模型同家但角色分离；备选 claude-sonnet-5 交叉校验）。
