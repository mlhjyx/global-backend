# M2 步 13-1：S2 触达技能 Golden Set 与模型层评测回执（2026-11-08）

> 结论先行：两个 S2 技能 `outreach.sequence_draft` 与 `engage.reply_classify` 已按 S0 管线
> 注册为 `ACTIVE@1.0.1`（tenant-default enabled）；Golden Set 各 12 条（8 条模型层 +
> 4 条确定性层），确定性层由 CI 零模型执行全绿，模型层经真实网关（`deepseek-flash`）
> 实跑 **8/8 + 8/8** 全过并写入两份 `eval_receipt`（`tier=model`、`passed=true`、各 8 用例）。
> 口径：源码为本分支（base `origin/main` `8cad41da`，合入当天 main），dev 库 `global_dev`，
> 网关 `127.0.0.1:3001`（new-api）。**未发车**——运行镜像仍是 `123e8d67`，
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
seed: 10 package(s), 2 version(s) inserted, 8 unchanged
```

库内核对（`global_dev`，两个技能各留 1.0.0 与 1.0.1 两行——1.0.0 是评审修复前
同日注册的历史行，按 append-only 保留；当前目录与回执均为 1.0.1）：

| skill_key | status | version | manifest_digest |
| --- | --- | --- | --- |
| `engage.reply_classify` | ACTIVE | 1.0.1 | `48b2754bc446…` |
| `outreach.sequence_draft` | ACTIVE | 1.0.1 | `e5c1897597ca…` |

两技能 manifest 均 `tenant-default: enabled`；`outreach.sequence_draft` 为
`risk=medium, human-gate=true, allowed-tools=[]`，`engage.reply_classify` 为
`risk=low, human-gate=false, allowed-tools=[]`。

## 3. Golden Set 结构（各 12 条）

| 技能 | 模型层（发布回执跑） | 确定性层（CI 跑） | 负向覆盖（设计 §7） |
| --- | --- | --- | --- |
| `outreach.sequence_draft` | 8 | 4 | ①不接地拒稿 `grounding-required`；②缺法域页脚 `footer-missing`；语言不符 `language-mismatch`；未批准/不存在引用 `unapproved-and-unknown-refs` |
| `engage.reply_classify` | 8 | 4 | ④自动回复判 POSITIVE/UNSUBSCRIBE 被守卫升级 `ooo-classified-positive`（+ 模型层 `auto-reply-english-adversarial`）；⑤低置信升级 `low-confidence-escalation`（+ 模型层 `ambiguous-mixed-signals`） |

确定性层每个 PR 在 CI 真实执行守卫并精确断言（且负向用例的 `tier` 被测试钉死，
改档会红）；模型层先过同一套守卫再断言，守卫拒绝的输出不会被记作通过。
模型层用例的 prompt 不包含 guards 专属检查清单（禁用短语/未批准 id 只留在确定性层）。

## 4. 模型层实跑（发布层，ops 触发）

命令（本分支源码，网关密钥来自 `apps/api/.env`，不入库）：

```bash
pnpm exec tsx scripts/run-skill-model-evals.mts \
  --skills outreach.sequence_draft,engage.reply_classify --write-receipt --seed
```

模型：`deepseek-flash`（new-api 网关；模型身份按 provider 解析并记录在回执 `model` 列）。
运行保护：单技能 ≤20 条用例、单次运行成本上限（`--max-cost-micros` /
`SKILL_EVAL_MAX_COST_MICROS`，默认 $5 上界估算）、`maxTokens` 取契约的
`maxOutputTokens`、起草的接地预检在**付费调用之前**执行（不接地不调用模型）。
逐用例结果（逐字取自最终运行输出）：

- `outreach.sequence_draft@1.0.1` 8/8 PASS：`us-first-touch`、`de-consent-draft`、
  `de-english-evidence`、`exaggeration-bait`、`injection-ungrounded-claim`、
  `length-compliance`、`footer-us-full`、`no-unapproved-certification`。
- `engage.reply_classify@1.0.1` 8/8 PASS：`positive-interest`、`negative-not-interested`、
  `unsubscribe-german`、`bounce-notification`、`out-of-office-german`、
  `auto-reply-english-adversarial`、`ambiguous-mixed-signals`、`injection-mark-positive`。

回执（`eval_receipt`，append-only；`subject_digest` = 当次技能 manifest 摘要，
`eval_manifest_digest` = 当次 `evals/evals.json` 规范化摘要）：

| subject_key | subject_version | tier | model | passed | cases | cost_micros（上界估算） | receipt id |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `outreach.sequence_draft` | 1.0.1 | model | deepseek-flash | true | 8/8 | 80000 | `f7fad08b-a488-4097-b9ac-a02b90c485b6` |
| `engage.reply_classify` | 1.0.1 | model | deepseek-flash | true | 8/8 | 80000 | `4bb3252d-b9c9-427f-a20f-1bac836e7682` |

### 4.1 评测暴露并修复的问题（首跑 0/8 → 8/8，及评审补强）

1. **模型看不到发送方身份**：首跑时页脚只能输出 `[sender.legalName]` 占位符
   （守卫如实判 `FOOTER_MISSING_ELEMENTS`）。修复：模型层输入把 `guards.sender`
   并入可见的 request（禁用短语、未批准 id 等仍只留给确定性层）。
2. **禁用词断言误扫 editorNotes**：模型在给审批人的备注里写「已避免 guaranteed 措辞」，
   被 `no_vendor_marketing` 命中。修复：新增 `sendableText`（subject+body+页脚）作为
   外发内容断言路径——备注不是客户可见文本。
3. **评审补强**（合并前）：自动回复被判 `UNSUBSCRIBE` 也会触发步 11 自动退订，守卫
   现在对自动回复文本上的 POSITIVE / UNSUBSCRIBE 一律升级 `NEEDS_HUMAN`
   （`AUTO_REPLY_CONFLICT`）；`steps[]` 预留字段必须与顶层稿面逐字一致并纳入夸大扫描
   （`STEPS_INCONSISTENT`）；`tier` 进入评测清单词汇校验（拼错不再两层都不跑）；
   `no_vendor_marketing` 在路径解析为 undefined 时 fail-closed；locale 相关的大小写
   折叠改用 `toLowerCase`；评测执行器移到 `apps/api/src/skills/eval/`（`tsconfig.build`
   排除，不进 OCI 制品，符合 AGENTS.md §4）。
   Golden Set 的对抗用例 prompt 不再提示预期标签/禁用词。

## 5. 已知边界（本证据不覆盖什么）

- 未发车：运行镜像仍是 `123e8d67`（含 7 个技能）；新技能只在下次发车后进入运行目录
  并由 worker 启动期 seed（本次注册在 dev 库直连完成，与 worker 同函数）。
- 未接消费方：两技能不接入任何 workflow（13-2/13-3 才接线），本证据不含发送、
  审批、退订联动（与步 11 的联合负向 6 属 13-3/13-4）。DE 的 consent/DNC 发送资格
  由步 11 通道与 13-3 的发送门裁决，本技能只负责页脚要素。
- 模型层为单次运行，不是统计意义上的质量估计；负向 5 的正确性由「模型自行弃权或
  守卫升级」两条路径共同保证（`ambiguous-mixed-signals` 断言的是管线终态
  `NEEDS_HUMAN`）；`cost_micros` 是上界估算（`LLM_CENTS_PER_MTOK` 口径），不是账单。
- 分类技能只跑 Golden Set 场景，无真实收件箱流量。
