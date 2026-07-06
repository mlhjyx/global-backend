# 客户发现评测 · 第二轮（ICP 资格门生效后）

> 承接 `discovery-eval.md`：第一轮发现真实性满分、相关性 68%。本轮验证「ICP 资格门」修复效果。

## 资格门逐家判定（gemini-2.5-pro，四门：材质/角色/工艺/商业模式）

对第一轮的 19 家真实公司重跑资格门：

| verdict | 数量 | 公司 |
|---|---|---|
| **match** | 10 | Bart, ERNST, IRION, Metall Advancement, Mayer, NEW STANDARD, Metallbau Nick, Pinnacle, SPALECK, TZR |
| **weak** | 4 | BURGER（相邻工艺）, Norck（中介平台）, Oberg（工艺子集）, Petersen（无激光钣金） |
| **mismatch** | 5 | Carolina CoverTech（织物）, Elcan（粉体）, Gold Chain（塑料注塑）, HSG Laser（竞品）, **Schröder Group（竞品）** |

**关键验证**：
- 第一轮评委（实访官网）标出的 6 家问题公司（4 mismatch + 2 weak）**全部被资格门正确拦截**。
- 资格门还**多抓出 Schröder Group 是竞品**——它是折弯机/钣金机床制造商（与 TRUMPF 同类设备），第一轮人工评委反而误判为 match(0.95)。资格门的角色门比人工更严、更准。

## 端到端队列（真实公司，评分后）

| 队列 | 数量 | 对应 fit |
|---|---|---|
| **recommended** | 10 | match |
| **needs_review** | 4 | weak |
| **rejected** | 5 | mismatch |

召回（挖掘）与资格判定分离后，销售拿到的 recommended 队列 100% 是资格门确认的目标客户；竞品与品类不符者被隔离到 rejected。

## 设计说明：为何资格门覆盖确定性规则

本轮暴露并处理了「词表归一」欠账的即时影响：TRUMPF 的 ICP 规则值是中文（`industry: 制造业`），而 canonical 公司属性是英文（`metal fabrication`），确定性规则引擎因语言不一致把 match 公司误判 no_match→rejected。**当资格门判过（fitVerdict 非空）时，以资格门为权威 Fit 信号**（LLM 四门交叉核验，跨语言鲁棒），覆盖确定性规则。

> 待「规范词表归一」落地（ICP 规则值 ↔ 数据源属性的语言/词表映射）后，确定性规则将与资格门一致，此覆盖退化为一致性校验。这是 P3 真源化的第一欠账。

## 结论

「真实测试 → 发现问题 → 解决问题」闭环完成：真实挖掘（真实性满分）→ 对抗评测（揪出相关性缺口）→ 资格门修复（四门拦截竞品/品类/中介）→ 复测确认（recommended 队列纯净）。
