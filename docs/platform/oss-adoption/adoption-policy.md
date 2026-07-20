# OSS 与外部能力采用政策

> 文档 ID：`OSS-FE-001`
> 层级：`L2 / Normative adoption policy`
> 生命周期：`CURRENT`
> 评审状态：`APPROVED_AT_GATE_7`
> Owner：`OWN-SEC-COMMERCIAL`
> 批准来源：`DEC-FE-P7-001..012`；逐项许可、安全、Owner、生产和退出门继续 fail-closed

## 1. 决策字典

| 决策 | 允许 | 禁止 |
|---|---|---|
| `LEARN` | 吸收产品、UX、测试或工程方法，保留来源 | 复制代码/资产、引依赖、运行服务、宣传为集成 |
| `BUILD` | 自建我方主真值、Contract、Adapter 或必要替代实现 | 以“自建”为由跳过威胁模型、运维和退出设计 |
| `ADAPT` | 在明确许可下隔离改造，保持我方 schema/权限/状态 | Fork 后直接成为主库；无长期维护 Owner 的永久分叉 |
| `INTEGRATE` | 通过我方 Adapter/ACL 使用外部能力 | 业务代码依赖其内部表/SDK/状态机；暴露未认证管理面 |
| `BUY` | 购买服务/API/商业许可并签数据与退出条款 | 用采购合同替代最小化、权限、可观测性和可替换性 |
| `AVOID` | 明确禁止特定用途或项目 | 用“仅内部”绕过条款、权利、安全或数据边界 |
| `DEFER` | 保留候选和重开触发条件 | 把候选偷偷加入 lockfile、镜像、设计源或生产路线 |

每张 Card 只有一个主决策；允许补充“可学习的方法”或“触发后重新比较”，但不能以复合措辞掩盖当前是否可引入。

## 2. 七道准入门

```text
G0 用户能力与非目标
→ G1 官方来源、版本与 License/条款
→ G2 SoR、Adapter/ACL 与失败语义
→ G3 Security/Privacy/Data rights/Supply chain
→ G4 Contract/Failure/Upgrade/Exit Test Plan
→ G5 实际 Owner、成本、容量、运维与回滚
→ G6 Spike/Pilot/Production Release evidence
```

- 任一门未知时，默认 `DEFER/HOLD`；已有开发运行事实则记 `INTEGRATE / DEV_AS_BUILT_HARDEN`，不能倒写成“未采用”逃避整改。
- License 结论只对精确提交、发行版、镜像 digest 或条款日期有效。`latest`、默认分支 HEAD 和本地 lockfile 是三种不同证据。
- AGPL、GPL、source-available、双许可、企业目录、模型/媒体/字体资产必须逐层拆开；根许可证不能代表整套部署权利。

## 3. Adapter 与主真值规则

| 问题 | 硬规则 |
|---|---|
| 业务依赖 | 只依赖我方 `Contract`；厂商 SDK 限于 Adapter 内部 |
| 主数据 | Company/Claim/Site/Campaign/Opportunity/Identity 等主真值不迁入 OSS 数据库 |
| 身份与权限 | SaaS token/Workspace/allowed actions 为权威；OSS 内置角色最多是下游投影 |
| 异步执行 | ACK、accepted、delivered、business outcome 分开；外部队列不替代业务状态和补偿 |
| 数据副本 | 有目的、最小字段、租户隔离、保留/删除、导出和可重建说明 |
| 前端 | 不 iframe/拼接供应商管理台冒充统一 SaaS；用户只看我方对象和诚实状态 |
| 退出 | 替代实现、数据导出、双跑/切换、回滚窗口、删除回执和残余风险必须预先写明 |

## 4. Security 与数据清单

每项至少判断：

1. 信任边界、入/出网、SSRF、redirect、浏览器/文档/媒体 sandbox；
2. 密钥/vault、token scope、轮换、日志与 Prompt/Trace 脱敏；
3. Workspace 隔离、RLS/副本隔离、个人数据、跨境、保留和删除；
4. 包、镜像、插件、节点、模型、浏览器、字体和素材供应链；
5. 渠道 ToS、robots、自动化政策、速率、滥用与账号封禁；
6. 管理面是否仅内网、是否有默认凭据、是否需要 SSO/audit；
7. License notice、source offer、修改公开、商标和商业许可义务。

## 5. 最小 Test Plan

| 层 | 必测 |
|---|---|
| Capability probe | 必要能力真实存在；版本/套餐差异 fail-closed |
| Contract | 正常、空、malformed、超时、429/5xx、取消、部分成功、ACK unknown |
| Isolation | Workspace/权限/数据范围/密钥/日志无串租户或泄露 |
| Adversarial | SSRF、恶意文件/HTML、prompt injection、webhook 重放、插件/节点篡改 |
| Upgrade | 固定旧 Fixture/历史回放；schema/API/行为漂移可检测 |
| Exit | 替代实现双跑、导出校验、切回、删除/残余副本证明 |
| Operations | 容量、成本、告警、备份恢复、kill switch、runbook 和实际 assignee |

Card 的 Test Plan 是未来验收合同，不是 `TEST_PASSED`。只有精确环境、版本、日期、结果和 Evidence Owner 齐全才允许升级。

## 6. 重开与复审

- 新产品纵切需要某能力、现有基线达不到 SLO/成本/质量、上游重大许可证/所有权变化、CVE/供应链事件或退出演练失败时重开 Card。
- `INTEGRATE` 项至少按月检查可漂移镜像/条款，按季度执行升级与退出演练设计复核；生产节奏由真实 Ops Owner 签发。
- 替换项目不复用旧 Card ID；旧 Card 标 successor 和迁移证据，保证为什么换、数据如何退和谁批准可追踪。
