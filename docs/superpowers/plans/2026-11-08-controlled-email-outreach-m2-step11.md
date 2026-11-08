# M2 步 11 · 能力 3 受控邮件触达（email first）落地设计（2026-11-08）

> 生命周期：`APPROVED`
> 生命周期依据：按 §0.6 任务启动门产出；产品负责人 2026-11-08 已批准 D-11-a~f 按推荐值（D1② 域名/ DNS 稍后提供，11-5 真实验收前到位）；依据协调计划 §0.2 步 11（能力 3：email first；信箱上限/发送窗口/回复即停/退订/DNC）、§18.5 顺序（能力 3 前置=发送域名 + 能力 4/QGO）、§0.7 F2（ActionProposal→Policy→审批→ExecutionAuthorization→ToolBroker）、§16.3 与 OWNER-DECISION 系列（合规口径）。主会话起草（2026-11-08）。
> 前置依赖：步 10（QGO/SAO，p5 实施中——外联对象=SAO 接受的商机联系人）；M2.0 审批与授权机制（已上线）；A2 SMTP 探测已上线（自有域发送身份已具备）。**硬前置：D1② 发送域名 + SPF/DKIM/DMARC（产品负责人提供）**。

## 1. 背景与目标

- 计划明令：**能力 3 是受控触达**——不做群发器。v0 只做 email、只对「人工接受的商机（SAO）」的联系人、小批量、全程人审。
- 合规底线（§18 / UWG §7 / CAN-SPAM，已批口径）：**德国（及 EU 同类法域）B2B 冷邮件默认违法（需事先同意）——自动化对 DE 一律不发送，除非存在显式同意记录（opt-in）；美国按 CAN-SPAM（明示身份/地址/一键退订，opt-out 尊重）。** 法域闸门在发送前强制执行（fail-closed）。

### 目标（步 11 验收口径：小批量真实发送闭环）

1. 一封信的完整链路：SAO → 选联系人（有邮箱证据）→ LLM 起草（grounded）→ 人工审批（L2）→ ExecutionAuthorization（动作边界=本批收件人）→ SMTP 发送 → 发送台账（append-only）。
2. 受控机制全部生效：**每信箱每日/每周上限、发送时间窗（按收件人时区）、回复即停（序列立刻暂停）、退订即永久压制、DNC/禁联名单发送前检查**、法域闸门。
3. 发送质量闸：退信/投诉率观测入指标（超阈值自动停信箱）。

## 2. 承重假设（可证伪）

| # | 假设 | 若被证伪 |
| --- | --- | --- |
| A1 | v0 用**自有 SMTP 直发**（专用发送域名，SPF/DKIM/DMARC 齐备；信箱=域名下若干地址），不接 ESP/第三方发送平台 | 若域名声誉/warmup 不可控，改接 ESP（发送工具接口不变） |
| A2 | 对象=SAO（已人工接受的商机）的联系人；联系人必须已有邮箱证据（来源可溯：Impressum/官网/验证状态）且非 RISKY-only | 若产品要求对 Lead 级发送，需重新审批合规口径（不推荐） |
| A3 | 序列 v0=**单步（1 封首触）+ 回复分类后人工决定下一步**；不做自动化多步 follow-up（回复即停天然成立） | 多步序列留 步 13（S2 触达技能）评估 |
| A4 | 撤销通道公共化：退订=公共 tokenized 端点（无登录、一次性链接）+ Reply-To 处理；DNC 表租户级（gain-saas）+ 全局抑制（engine）双层 | 若需 List-Unsubscribe 头（Gmail/Yahoo 2024 批量发件人要求），v0 即带 mailto+URL 双头，不依赖批量身份（小批量也带上） |
| A5 | CampaignPlan 契约扩展：motions 增加 `outreach`（草案版 v1，双校验器并存一个发布周期；v0 计划继续有效） | 若不扩契约，外联批以 SAO 集合直接建批（不经 CampaignPlan），但审计链差一截，不推荐 |

## 3. 合规闸门（先于一切发送路径）

- **法域矩阵（v0）**：`DE/AT` → `CONSENT_REQUIRED`（无 explicit consent 记录一律拒绝，错误码 `JURISDICTION_CONSENT_REQUIRED`）；`US` → 允许（opt-out 模型，邮件含身份/物理地址/退订）；其它国家 → `REVIEW_REQUIRED`（默认不发，运营逐国启用）。
- **同意台账**（gain-saas `outreach_consent`）：`workspace_id/contact_ref/channel=email/status(OPT_IN|OPT_OUT|UNKNOWN)/source/lawful_basis/evidence/created_at`；OPT_OUT 永久压制（跨 campaign）。
- **DNC/禁联名单**（gain-saas 既有 C2 功能位）：发送前逐收件人检查；engine 侧再查一次全局抑制表（defense-in-depth）。
- **退订**：每封邮件 `List-Unsubscribe`（URL+mailto）+ 正文一键链接；点击即写 `OPT_OUT` + 同步 engine 抑制；处理延迟 ≤ 立即（端点同步写库）。

## 4. 运行时拓扑与数据模型

```
gain-saas（控制面）                          backend（执行）
  SAO ─► 选联系人(证据邮箱) ─► LLM 起草 ─► 审批(L2)
        └ outreach_batch/revision           └ ExecutionAuthorization(scope=收件人集)
  同意台账 / DNC / 退订端点(public)  ◄──────── 发送回执 / 回复事件 / 抑制查询
```

- **engine 新表**（additive）：`outreach_mailbox`（ops 配置：地址/显示名/日上限/周上限/窗口时区/状态 ACTIVE|PAUSED）、`outreach_send`（append-only：batch/contact/mailbox/message_id/状态 SENT|BOUNCED|COMPLAINED/成本/授权引用）、`outreach_reply`（IMAP 轮询入：收到回复 → 事件 → 序列暂停）。
- **gain-saas 新表**：`outreach_batch`（campaign?/sao 集合/草稿集/审批状态机复用 M2.0 形态）、`outreach_consent`、`outreach_dnc`（或复用 C2 既有模型）。
- **契约**：CampaignPlan v1（motions+=`outreach`：`{type:'outreach', saoIds:[], messageIntent, caps}`；双校验器并存，见 M2.0 §4.3 版本化条款）。
- **发送工具**：`smtp.send`（ToolBroker 工具，egress 白名单=目标 MX；参数=信封/正文/头；幂等键=send id；速率=信箱上限驱动）。

## 5. 审批与授权（复用 M2.0 机制，不发明新轮子）

- 草稿集 → `outreach_batch` 提交审批（approve/decline 同权、超时=拒绝、范围变化重审——直接复用 campaign_approval 状态机，batch 为一个 revision 形态）。
- 审批通过 → 签发 ExecutionAuthorization（scope=`{actions:[{type:'outreach.send', batchId, recipientCount}]}`，TTL 短、单批一次性）；发送服务逐封校验授权+收件人在 scope 内。
- 影子期口径（M2.1 的 `CAMPAIGN_EXECUTION_SHADOW`）：**步 11 v0 不走影子**——发送即真实动作，但规模小（见 D-11-d 初值）且全程人审；影子开关对 outreach 单独定义（`OUTREACH_SEND_ENABLED` 默认 off，运维/产品显式开启才可发）。

## 6. 受控参数（初值，env 可调）

- 每信箱：日上限 30、周上限 120（warmup 阶梯：第 1–2 周 10/日，3–4 周 20/日，之后 30/日）；发送窗口=收件人当地 09:00–17:00 工作日；同域名收件人每小时 ≤5。
- 批次上限：单批 ≤50 收件人（v0 小批量验收用 3–5 人）。
- 阈值停发：硬退信率 >5% 或投诉 >0.1% → 自动暂停该信箱（ops 告警）。

## 7. 幂等、重试与审计

- 发送幂等：`outreach_send` 幂等键（batch, contact, step=1）；SMTP 重试不重发（message_id 校验）。
- 回复即停：`outreach_reply` 命中后该联系人的所有进行中批次立即移除并落轨迹（reply 即最强信号，亦为步 12 归因输入）。
- 审计：审批/授权/发送/退订/回复全链事件 + trace；发件内容存档（发送台账指向草稿版本，内容不可变）。

## 8. 负向测试（必含）

1. DE 收件人无 consent → `JURISDICTION_CONSENT_REQUIRED`（不触 SMTP）；
2. OPT_OUT 后任何批次再发 → 拒绝；3. 未审批批次发送 → 拒绝；4. 授权 scope 外收件人 → 拒绝；5. 超信箱上限/窗口外 → 拒发或顺延（按设计：拒绝入队）；6. 退订端点 token 无效/复用 → 404/幂等；7. 回复后批次继续发 → 阻断（reply-stop）；8. 跨租户批次/联系人 → 404。

## 9. 验收（小批量真实发送闭环，需 D1② 域名）

- E2E-M2.11：测试收件人 3–5 个（含 1 个 US、1 个 DE-带 consent、1 个 DE-无 consent 负向）：起草→审批→发 DE-consent 与 US→台账 SENT；DE-无 consent 被闸门拒；模拟回复→序列停；点退订→OPT_OUT 生效→再发被拒。SPF/DKIM/DMARC 校验通过（Gmail 原文头）。

## 10. D1② 输入清单（发给产品负责人）

1. **发送域名**（如 `mail.<公司域>` 或独立域）；2. DNS 管理权（我们将给出 SPF/DKIM/DMARC 记录值，需你添加）；3. 是否已 warmup/新域（决定阶梯初值）；4. 投诉/滥用处理邮箱（进邮件页脚）；5. 公司物理地址与署名（CAN-SPAM 必填）。

## 11. 决策点（请逐项确认）

| # | 决策 | 推荐 |
| --- | --- | --- |
| D-11-a | DE/AT 冷邮件一律不发（explicit consent 才发）；US 走 opt-out 模型；其它国家默认 REVIEW_REQUIRED | 接受（UWG §7 红线） |
| D-11-b | v0 自有 SMTP 直发 + List-Unsubscribe 双头；不接 ESP | 接受 |
| D-11-c | 对象仅 SAO 联系人且邮箱有证据非 RISKY-only | 接受 |
| D-11-d | 受控初值：10→20→30/日阶梯、单批≤50、窗口 9–17 当地工作日、退信>5% 自动停 | 接受 |
| D-11-e | 序列 v0=单步首触，回复分类后人工决定；多步序列留步 13 | 接受 |
| D-11-f | CampaignPlan v1 增 outreach motion（双校验器并存）；OUTREACH_SEND_ENABLED 默认 off | 接受 |

## 12. 给产品负责人的说明

- **得到什么**：给「已接受的商机」发第一封真正的外贸开发信——从起草到发送全程人审、每封信可溯源、每个法域的红线由系统强制执行（DE 没同意就不发），退订与回复立即生效。这是获客闭环里「触达」段的最小可运转版本。
- **没改什么**：不做群发、不做多步自动序列、不接 LinkedIn/WhatsApp；审批与授权复用现有机制。
- **风险与回退**：唯一对外动作 = 小批量邮件，开关默认关（`OUTREACH_SEND_ENABLED=off`），风险可控；回退=关开关。
- **建议**：批准 D-11-a~f 按推荐值；**同时提供 D1② 五件输入**（域名/DNS/是否新域/投诉邮箱/署名地址）。施工：11-1 合规底座→11-2 信箱+发送工具→11-3 审批流→11-4 回复/退订→11-5 真实发送验收（拿到域名后）。
