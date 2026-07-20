# 文档与质量方法 Capability Cards

> 文档 ID：`OSS-FE-008`
> 状态：`READY_FOR_GATE_7_REVIEW`
> 边界：方法采用不等于部署平台；工具存在不等于质量证据通过

## `ADP-FE-027` Diátaxis

| 字段 | 结论 |
|---|---|
| 用户能力 / 非目标 | 区分 Tutorial、How-to、Reference、Explanation；不替代权威层、Owner、状态和 Evidence |
| 当前等价与证据 | 已进入文档计划和门户设计；尚无完整真实 UI 用户指南 |
| 主决策 | `LEARN / CURRENT_METHOD` |
| License / 权利 | 采用公开方法与引用；不镜像整站内容，具体内容版权以官方站点为准 |
| Adapter / SoR | 无运行时；文档 metadata/type 与门户阅读路线是内部落点 |
| Security / 数据 | 无业务数据；示例/截图仍须脱敏和权利登记 |
| Test / Release Gate | Phase 8 用角色阅读任务验证分类是否能让读者完成任务，不用作者自评 |
| Owner / Exit | `OWN-DOC-GOV`；若方法不适配可保留文档类型元数据并调整阅读路线，无数据迁移 |

## `ADP-FE-028` Backstage TechDocs

| 字段 | 结论 |
|---|---|
| 用户能力 / 非目标 | 学习 docs-like-code、就近维护、目录发现；不部署新的内部开发门户或复制服务目录真值 |
| 当前等价与证据 | 当前 Git 文档门户/Registry 已能承重；没有 Backstage 实例、Owner 或平台需求证据 |
| 主决策 | `LEARN / NO_RUNTIME` |
| License / 权利 | Backstage 核心 Apache-2.0；插件/托管服务另审 |
| Adapter / SoR | 无运行时；未来如重开，Git 文档/Registry 为源，门户只索引投影 |
| Security / 数据 | 插件供应链、SSO、catalog 权限、内部文档暴露、构建 secrets 和外部链接 |
| Test / Release Gate | 只有多仓/多人发现成本达到阈值才重开；测权限、索引 stale、构建、搜索、退出和运维成本 |
| Owner / Exit | `OWN-DOC-GOV`/平台工程；Git 文档始终可独立阅读，删除门户不丢知识真值 |

## `ADP-FE-029` Storybook

| 字段 | 结论 |
|---|---|
| 用户能力 / 非目标 | 候选组件状态、Fixture、交互/a11y/视觉证据工作台；不成为正式设计源或 Release evidence 唯一来源 |
| 当前等价与证据 | 正式 SaaS 前端/组件库不存在，本地原型未发现 Storybook |
| 主决策 | `DEFER / FORMAL_FE_REPO_TRIGGER`；方法 `LEARN` |
| License / 权利 | MIT；addons、截图服务和托管平台另审 |
| Adapter / SoR | story 绑定 `COMP/PAGE/SCN/FX` ID；设计资产和业务状态仍由各 Registry/Contract 承重 |
| Security / 数据 | 禁真实客户数据/secret；公开部署需访问控制；addon/浏览器供应链和截图保留 |
| Test / Release Gate | 正式组件库确定后比较；关键状态 story completeness、interaction、a11y、visual baseline、i18n/RTL 和 CI 稳定性 |
| Owner / Exit | `OWN-SAAS-FE`；Fixture/组件测试可迁到普通 test runner，不把 stories 作为唯一规范；QA Owner 独立验收证据 |

## `ADP-FE-030` Playwright

| 字段 | 结论 |
|---|---|
| 用户能力 / 非目标 | 浏览器 E2E、视觉和自动 a11y 检查方法；不以自动扫描替代人工 WCAG/可用性和运营验收 |
| 当前等价与证据 | 主后端工作区有历史 Playwright 资产，正式 SaaS 前端无受控 E2E/baseline |
| 主决策 | `LEARN / CURRENT_QUALITY_METHOD`；工具接入 `DEFER / FORMAL_FE_REPO_TRIGGER` |
| License / 权利 | Apache-2.0；浏览器二进制、云测试/截图存储另审 |
| Adapter / SoR | Scenario/Fixture ID 驱动页面任务；Release Bundle 引用运行证据而非反向由测试定义产品 |
| Security / 数据 | 测试账号/secret、截图/trace/视频 PII、环境隔离、浏览器供应链和 destructive test guard |
| Test / Release Gate | 正式 repo 后建立 happy+failure+recovery、权限、a11y、visual、mobile、network fault；flake/重试不得掩盖失败 |
| Owner / Exit | `OWN-QA-EVIDENCE`；Scenario/Fixture 可迁到其他 browser runner，证据格式保持工具中立；前端 Owner 负责 runner 接入 |

## `ADP-FE-031` GoodJob

| 字段 | 结论 |
|---|---|
| 用户能力 / 非目标 | 学习功能工作簿、权限社会属性、下一动作、使用/FAQ 分众表达；不复制功能范围、代码、测试状态或文档平铺 |
| 当前等价与证据 | 固定快照 `5732e209…` 已审；方法已进入 Capability Pack/Scenario/Registry |
| 主决策 | `LEARN / CURRENT_METHOD` |
| License / 权利 | 外部项目快照仅作研究引用；代码/资产/依赖复用未获批准，具体许可证不用于推导我们的产品 |
| Adapter / SoR | 无运行时；只保留来源引用和内部原创规范结果 |
| Security / 数据 | 不导入其数据库、凭据、用户数据或失败测试产物；不把自评“全绿”当 Evidence |
| Test / Release Gate | Phase 8 以真实读者任务验证工作簿可读性，同时检查重复、过期、冲突和 superseded 关系 |
| Owner / Exit | `OWN-DOC-GOV`；内部规范独立存在，外部项目不可访问时不影响使用；产品 Owner 验证方法是否改善功能表达 |

## 组合决定

Diátaxis、GoodJob 和 TechDocs 的方法已经可继续使用，但不部署 Backstage。Storybook 与 Playwright 的工具接入等待正式前端仓库；Phase 8 可以先实现工具无关的 lint、阅读路线和证据模板。
