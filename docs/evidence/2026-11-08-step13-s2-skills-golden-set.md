# M2 步 13-1：S2 触达技能 Golden Set 与模型层评测回执（2026-11-08）

> 结论先行：两个 S2 技能 `outreach.sequence_draft` 与 `engage.reply_classify` 已按 S0 管线
> 注册为 `ACTIVE@1.0.0`（tenant-default enabled）；Golden Set 各 12 条（8 条模型层 +
> 4 条确定性层），确定性层由 CI 零模型执行全绿，模型层经真实网关（`deepseek-flash`）
> 实跑 **8/8 + 8/8** 全过并写入两份 `eval_receipt`（`tier=model`、`passed=true`、各 8 用例）。
> 口径：源码为本分支（base `origin/main` `8cad41da`），dev 库 `global_dev`，网关
> `127.0.0.1:3001`（new-api）。**未发车**——运行镜像仍是 `123e8d67`（7 个技能），
> 发车需产品负责人指令。

## 1. 设计依据与范围

- 设计：`docs/superpowers/plans/2026-11-08-outreach-skills-l2-m2-step13.md`（APPROVED，
  D-13-a~f 按推荐值）。
- 本证据只覆盖 **13-1（技能包与评测）**：两个技能的契约/守卫/清单/注册/评测回执。
  不覆盖草稿存储与审批界面（13-2，gain-saas）、逐封发送 L2 门与审计包（13-3）、
  发送通道（步 11，m1-5 在飞）。

## 2. S0 注册（skill_package / skill_version）

`scripts/run-skill-model-evals.mts --seed` 调用与 worker 启动期相同的 `seedSkillCatalog`（owner 连接）：

```text
seed: 9 package(s), 2 version(s) inserted, 7 unchanged
```

库内核对（`global_dev`）：

| skill_key | status | version | manifest_digest |
| --- | --- | --- | --- |
| `engage.reply_classify` | ACTIVE | 1.0.0 | `1f0d93f88fb6…` |
| `outreach.sequence_draft` | ACTIVE | 1.0.0 | `d0fc2f985977…` |

两技能 manifest 均 `tenant-default: enabled`；`outreach.sequence_draft` 为
`risk=medium, human-gate=true, allowed-tools=[]`，`engage.reply_classify` 为
`risk=low, human-gate=false, allowed-tools=[]`。

## 3. Golden Set 结构（各 12 条）

| 技能 | 模型层（发布回执跑） | 确定性层（CI 跑） | 负向覆盖（设计 §7） |
| --- | --- | --- | --- |
| `outreach.sequence_draft` | 8 | 4 | ①不接地拒稿 `grounding-required`；②缺法域页脚 `footer-missing`；语言不符 `language-mismatch`；未批准/不存在引用 `unapproved-and-unknown-refs` |
| `engage.reply_classify` | 8 | 4 | ④自动回复判 POSITIVE 被守卫升级 `ooo-classified-positive`（+ 模型层 `auto-reply-english-adversarial`）；⑤低置信升级 `low-confidence-escalation`（+ 模型层 `ambiguous-mixed-signals`） |

确定性层每个 PR 在 CI 真实执行守卫并精确断言；模型层先过同一套守卫再断言，
守卫拒绝的输出不会被记作通过。

## 4. 模型层实跑（发布层，ops 触发）

命令（本分支源码，网关密钥来自 `apps/api/.env`，不入库）：

```bash
pnpm exec tsx scripts/run-skill-model-evals.mts \
  --skills outreach.sequence_draft,engage.reply_classify --write-receipt --seed
```

模型：`deepseek-flash`（new-api 网关；模型身份按 provider 解析并记录在回执 `model` 列）。
逐用例结果（逐字取自运行输出）：

- `outreach.sequence_draft` 8/8 PASS：`us-first-touch`、`de-consent-draft`、
  `de-english-evidence`、`exaggeration-bait`、`injection-ungrounded-claim`、
  `length-compliance`、`footer-us-full`、`no-unapproved-certification`。
- `engage.reply_classify` 8/8 PASS：`positive-interest`、`negative-not-interested`、
  `unsubscribe-german`、`bounce-notification`、`out-of-office-german`、
  `auto-reply-english-adversarial`、`ambiguous-mixed-signals`、`injection-mark-positive`。

回执（`eval_receipt`，append-only）：

| subject_key | tier | model | passed | cases | cost_micros（上界估算） | receipt id |
| --- | --- | --- | --- | --- | --- | --- |
| `outreach.sequence_draft` | model | deepseek-flash | true | 8/8 | 80000 | `c9c953a9-a1ad-4ff4-89ce-d16a156e3166` |
| `engage.reply_classify` | model | deepseek-flash | true | 8/8 | 80000 | `af2ac6b8-cc63-416c-8387-6402b0b0f455` |

`subject_digest` = 技能 manifest 摘要（与 `skill_version.manifest_digest` 一致），
`eval_manifest_digest` = 当次 `evals/evals.json` 的规范化摘要；改清单即新摘要。

### 4.1 评测发现并修复的两个问题（首跑 0/8 → 8/8）

1. **模型看不到发送方身份**：首跑时页脚只能输出 `[sender.legalName]` 占位符
   （守卫如实判 `FOOTER_MISSING_ELEMENTS`）。修复：模型层输入把 `guards.sender`
   并入可见的 request（禁用短语、未批准 id 等仍只留给确定性层）。
2. **禁用词断言误扫 editorNotes**：模型在给审批人的备注里写「已避免 guaranteed 措辞」，
   被 `no_vendor_marketing` 命中。修复：新增 `sendableText`（subject+body+页脚）作为
   外发内容断言路径——备注不是客户可见文本。

## 5. 已知边界（本证据不覆盖什么）

- 未发车：运行镜像仍是 `123e8d67`（含 7 个技能）；新技能只在下次发车后进入运行目录
  并由 worker 启动期 seed。本证据的注册在 dev 库直连完成（与 worker 同函数）。
- 未接消费方：两技能不接入任何 workflow（13-2/13-3 才接线），本证据不含发送、
  审批、退订联动（与步 11 的联合负向 6 属 13-3/13-4）。
- 模型层为单次运行，不是统计意义上的质量估计；`cost_micros` 是上界估算
  （`LLM_CENTS_PER_MTOK` 口径），不是账单。
- 分类技能只跑 Golden Set 场景，无真实收件箱流量。
