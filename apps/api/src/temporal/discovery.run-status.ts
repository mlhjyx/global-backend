/**
 * Discover run 收尾状态判定（纯函数，抽出便于单测——不引入 @temporalio/workflow 运行时）。
 *
 * 语义（收口②）：预算截断的 run **绝不假 DONE**。任一源打穿 run 预算（executeQuery 上报
 * budgetTruncated）或 fit 判定预算耗尽（skippedForBudget>0）都意味着漏了活儿 → 至少 PARTIAL，
 * 让 backlog sweep 兜底重跑。全源失败才 FAILED。
 * G3 5.2：富集阶段因禁令类拒绝（主体 HOLD/tombstone/SUPPRESSED/失效）按公司跳过的，
 * 同样意味着漏了活儿 → 至少 PARTIAL；它不会把全失败的 run 抬成 PARTIAL。
 */
export function resolveRunStatus(args: {
  failures: number;
  totalQueries: number;
  budgetTruncated: boolean;
  skippedSubjects?: number;
}): 'DONE' | 'PARTIAL' | 'FAILED' {
  const { failures, totalQueries, budgetTruncated } = args;
  const skipped = (args.skippedSubjects ?? 0) > 0;
  if (failures === 0 && !budgetTruncated && !skipped) return 'DONE';
  return failures < totalQueries ? 'PARTIAL' : 'FAILED';
}
