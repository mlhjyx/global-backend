---
date: 2026-10-19
title: Map an authority refusal raised inside reserve to the same contract error as attest
---

- 起因：准入之后，租约、撤销和作用域只在 `attest_authorized_tool_budget_v1` 里检查。它有两个入口：直接调用（`attestAuthorized`，已映射），以及在 `reserve_tool_budget` 内部调用（未映射）。第二个入口的标记以原始 `PrismaClientKnownRequestError` 冒出 `PostgresBudgetStore.reserve`，造成三个后果：
  - 工作流把它记成 `{ errorType: 'PrismaClientKnownRequestError', control: false }`，看起来像数据库故障；
  - 工作流层的尽力而为阶段（画像、signals）会把它吞掉，失败被记到下一个阶段（所有阶段开头都会 attest，所以 run 照样 FAILED，只是阶段记错）；
  - HTTP 返回 500，而不是契约声明的 402 / 403。另外，ICP 查询计划的 TED / FDA 注入用的本地分类器认不出这个错误，会把撤销吞掉、照样落库并返回 201。
  xin 上还没有出现过（13 个 FAILED run 里没有这种 errorType），#666 的重试等待让最后一次尝试跨过租约的可能变大。
- 改动：
  - `execution-budget-authority.repository.ts` 新增 `trustedExecutionBudgetGrantError`。它只认精确的可信标记（P2010、SQLSTATE P0001、消息恰为 `ERROR: <code>`），其余返回 undefined；`mapExecutionBudgetPersistenceError` 改用它，行为不变。
  - `PostgresBudgetStore.reserve` 的 catch 按这个顺序判断：LIFECYCLE 映射照旧；可信授权标记映射成 `ExecutionBudgetGrantError`；ACCOUNT_UNAVAILABLE 照旧；其余数据库错误原样抛出。经 reserve 实际可达的只有 INVALID、EXPIRED、REVOKED、SCOPE_MISMATCH 四个：attest 不抛 REUSED；账户耗尽时，reserve 在 attest 之前就返回 DENIED（`BudgetExceededError`）。SCOPE_MISMATCH 与 `attestAuthorized` 保持一致，同样映射成 403；它只来自主体配置错误或数据完整性错误，在受管运行时里走不到。settle、release、status、close 不在这次范围内。
  - ICP 本地分类器不用改：它按 `EXECUTION_BUDGET_` 前缀判断，映射后的错误能被识别。
- 测试：
  - `budget-store.spec.ts`：6 个标记映射，先 RED 后 GREEN；7 种不得映射的错误必须原样抛出（死锁、INVARIANT 标记、带后缀的标记、别的 SQLSTATE 下的同样文字、其他 Prisma 码、事务超时、普通 Error 带标记文字）；LIFECYCLE 与 ACCOUNT_UNAVAILABLE 照旧。
  - 新增 `reserve-authority-failure.spec.ts`：把 reserve 抛出的错误经 `ensureApplicationFailure`、仓库的失败转换器和工作流解码，`describeDiscoveryRunFailure` 得到 `{ errorType: 'ExecutionBudgetGrantError', control: true }`；换回 main 的 store 会得到 `control: false`。
  - CI 真库 spec：两处原来断言「reserve 抛原始标记」的地方，改为断言映射后的错误；补上撤销后 reserve 得 REVOKED 的用例；账户耗尽之后再 reserve 一次，断言仍是 `BudgetExceededError`，把「reserve 先查耗尽、再 attest」这一 SQL 时序锁住，否则 fit 的 skippedForBudget 会悄悄失效。
- 未做：
  - 同一原因在 errorType 上会有两种写法：10-09 批量收口的 733fbf03 写的是 `EXECUTION_BUDGET_GRANT_EXPIRED`，之后的新失败是 `ExecutionBudgetGrantError`。按 errorType 分组的看板要两个都认。
  - 平台 scope 的 sweep（intent、acquisition）以前会按单个源吞掉这类失败，现在会让整次 sweep 停下。4 个平台 schedule 都暂停着，暂无影响。
  - 收尾窗口与租约感知的软截止另起 PR。
  - provider 层还有几处裸 catch，会在活动内部吞掉控制错误（复审 LOW，既有问题），另起 PR 处理。
  - 既有问题（复审 INFO）：一次 DENIED 之后，后续每个活动开头的 attest 都会报 EXHAUSTED，所以对带授权的 run 来说，「预算截断 → PARTIAL」实际走不到，最终以 FAILED 收尾。这一点和租约感知软截止一起处理。
