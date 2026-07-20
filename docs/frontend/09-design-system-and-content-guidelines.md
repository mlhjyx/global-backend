# 设计系统与内容规范

> 文档 ID：`FE-GLOBAL-010`
> 层级：`L2 / Normative target`
> 生命周期：`CURRENT`
> 评审状态：`APPROVED_AT_GATE_4`
> 内容 Owner：`OWN-DESIGN`
> 设计资产：[design-asset-register.md](../design/design-asset-register.md)
> 微文案：[content-and-microcopy-catalog.md](../design/content-and-microcopy-catalog.md)

## 1. 当前边界

没有找到正式设计 Owner、Figma/其他事实源、Token、Storybook、批准组件库或可商用视觉资产。本文件因此只定义设计系统的语义结构、组件交付合同和质量门；不选择颜色、字体、圆角、阴影、UI 库、设计工具或生产数值。

本地 Mock、Readdy、模板和竞品只能帮助识别问题/模式，不得复制为品牌、组件或训练资产；权利未关闭前保持 `VISUAL_REFERENCE_ONLY`。

## 2. 设计方向

产品面向高频 B2B 工作，默认方向是：可信、克制、结构清楚、信息密度可调、状态优先、证据可查、操作可恢复。品牌表达不应压过对象、风险和下一步。

### 应有

- 清晰的层级、对齐、表格/列表扫描和稳定对象上下文；
- 用 semantic color + text + icon 表达状态，颜色不单独承义；
- 高风险动作、AI 不确定性、Evidence、成本和降级有明确而一致的视觉权重；
- 日常密集视图与首次引导通过 density/progressive disclosure 共存；
- 组件行为和状态比一次页面“好看”更优先。

### 避免

- 大面积渐变、玻璃拟态、装饰性 Hero、漂浮卡片、无意义 glow；
- 每个模块使用不同的色义、间距、错误样式、审批卡或 AI 头像；
- 默认把所有内容塞进卡片，牺牲表格、比较和批量操作效率；
- 用成功绿色掩盖 partial/degraded/unknown，或用灰色表示所有不同原因；
- 为模仿竞品而复用未知 License 的图标、图片、版式或生成资产。

## 3. Semantic Token 架构

| Token family | 语义层 | 例子（仅命名，不是数值） |
|---|---|---|
| Color | primitive → role → component | `color.fg.default`、`color.status.warning`、`button.danger.bg` |
| Typography | family/scale → text role | `type.body.md`、`type.label.sm`、`type.data.mono` |
| Spacing/size | base scale → layout/component | `space.3`、`control.height.md`、`layout.gutter` |
| Radius/border/elevation | semantic surface hierarchy | `surface.panel`、`border.focus`、`elevation.overlay` |
| Motion | duration/easing → intent | `motion.feedback`、`motion.panel`；支持 reduced motion |
| Density | compact/default/comfortable | 表格、表单、导航一致切换，不按页面硬写 |
| Breakpoint/container | content behavior | 数值待真实内容/设备测试，不按设备品牌命名 |
| Layer/z-index | named layer | base/sticky/nav/popover/dialog/toast；禁任意大数字 |
| Data visualization | categorical/sequential/status | 可区分、可打印、有文本/表格替代 |

Token 必须在一个受控源中有稳定名称、值、theme/mode、版本、Owner、变更记录和弃用期；设计与代码通过同一发布版本同步。primitive 不直接进入业务页面，组件消费 semantic role。暗色、高对比或品牌主题是否支持由后续 Decision 决定，不能现在只复制一组十六进制值。

## 4. 组件分层

```text
Foundations
→ primitives（button/input/text/link/icon）
→ composites（field/search/table/tabs/dialog/combobox）
→ product patterns（object header/task/approval/evidence/error/cost）
→ page compositions
```

模块只能在 product pattern 之上增加领域语义。若 Site 和 Campaign 都需要“长任务”，应复用 Task pattern 并传入领域步骤，不分别造 BuildSpinner/CampaignSpinner。

## 5. 组件交付合同

每个受控组件/模式必须记录：

| 字段 | 最低要求 |
|---|---|
| ID/name/purpose | 稳定 `DSC-FE-*` ID，明确解决的问题和非用途 |
| anatomy/slots | 内容结构、必填/可选区域 |
| variants/density | 语义差异，不以任意颜色命名 |
| states | default/hover/focus/disabled/busy/error/partial/degraded/stale 等适用项 |
| behavior | 键盘、焦点、关闭/返回、异步、滚动、空态 |
| content | label/help/error/confirmation 长度与 i18n 规则 |
| responsive | reflow、优先级、overflow、触摸目标 |
| a11y | native semantics、name/description、ARIA、announcements、contrast |
| tokens | 只引用 semantic token，不在组件内散落魔法值 |
| tracking | Capability/Page/Scenario/Copy/Asset IDs |
| ownership | design/frontend/QA Owner、source、version、status、deprecation |

真实组件库未决定前，这个合同可用于比较候选 UI 库和估算迁移成本，但不能声称已有实现。

## 6. 必须统一的产品模式

| Pattern ID | 模式 | 唯一规范来源 |
|---|---|---|
| `DSP-FE-001` | Workspace/Object context | [Shell](05-navigation-and-workspace-shell.md) |
| `DSP-FE-002` | capability unavailable/denied | [权限](06-permissions-and-data-visibility.md) |
| `DSP-FE-003` | page/section async state | [状态](07-state-error-degradation-and-recovery.md) |
| `DSP-FE-004` | long task + cost + cancel | [状态](07-state-error-degradation-and-recovery.md) |
| `DSP-FE-005` | Evidence drawer/card | [AI/Evidence](08-ai-approval-evidence-and-human-control.md) |
| `DSP-FE-006` | candidate review/approval/execution | [AI/Evidence](08-ai-approval-evidence-and-human-control.md) |
| `DSP-FE-007` | destructive/high-impact confirmation | 权限 + AI/Approval |
| `DSP-FE-008` | conflict/diff/recovery | 状态 + 对象版本合同 |
| `DSP-FE-009` | help/correlation/support | Shell + 状态 |
| `DSP-FE-010` | data table/filter/bulk action | 本文件 + a11y/performance；模块补领域列 |

## 7. 图标、图片和数据可视化

- 图标来源、License、版本和用途进入设计资产登记；功能图标有可访问名称或与文本组合，装饰图标隐藏。
- 用户 Asset 与产品 UI 资产分开；上传内容不能直接成为设计系统素材。
- 图表同时提供清晰标题、单位、时间范围、数据新鲜度、定义和可访问的摘要/表格；颜色不是唯一编码。
- AI 生成图像需记录模型/版本、Prompt 使用边界、权利/人物/商标审核和人工批准；未经策略批准不进入公共 Fixture 或品牌资产。

## 8. 内容风格

用用户能行动的普通语言：具体、简短、诚实、非营销、非责备。首选“对象 + 状态/影响 + 下一步”，避免“糟糕，出错了”“魔法生成”“一键增长”“100% 准确”“生产就绪”等无证据表述。

| 场景 | 规则 |
|---|---|
| Label | 名词或明确动作；同一对象全产品同名 |
| Button | 动词 + 对象/范围，如“取消本次构建”而非“确定” |
| Help | 解释用户决定所需的信息，不复制字段名 |
| Empty | 说明为何为空、是否正常、第一步是什么 |
| Error | 发生什么、影响、保留、下一步、支持 ID |
| Approval | 决定对象、版本、范围、Evidence 和不可逆影响 |
| AI | 标事实/推断/建议/草稿、未知项、成本和审查责任 |
| Status | 使用受控术语，不把 partial/degraded/stale 写成 success |

## 9. 微文案与本地化合同

所有跨模块关键文案使用 `COPY-FE-*` ID，记录 source locale、message intent、变量、plural/context、限制、a11y announcement、translation/review status、Owner、Capability/Scenario。禁止字符串拼接和在代码中写无法追踪的关键错误/批准文案。

翻译必须基于意图和上下文，而非逐词；按钮、标题、屏幕阅读器文本和邮件/通知分别测试。UI locale 与 Site content locale 分离，不能因用户选中文 UI 就改变公开站生成语言。

## 10. 设计评审与版本

设计资产只有同时进入 [资产登记](../design/design-asset-register.md)、有受控 source/version/Owner/rights、覆盖关键状态/响应式/a11y、关联 Capability/Page/Scenario，并有 finding 处置记录，才可标 `DESIGNED`。截图、导出代码、Markdown 表格或 AI 自评单独均不够。
