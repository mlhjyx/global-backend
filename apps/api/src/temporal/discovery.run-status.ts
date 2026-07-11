/**
 * Discover run 收尾状态判定（纯函数，抽出便于单测——不引入 @temporalio/workflow 运行时）。
 *
 * 语义（收口②）：预算截断的 run **绝不假 DONE**。任一源打穿 run 预算（executeQuery 上报
 * budgetTruncated）或 fit 判定预算耗尽（skippedForBudget>0）都意味着漏了活儿 → 至少 PARTIAL，
 * 让 backlog sweep 兜底重跑。全源失败才 FAILED。
 */
export function resolveRunStatus(args: {
  failures: number;
  totalQueries: number;
  budgetTruncated: boolean;
}): 'DONE' | 'PARTIAL' | 'FAILED' {
  const { failures, totalQueries, budgetTruncated } = args;
  if (failures === 0 && !budgetTruncated) return 'DONE';
  return failures < totalQueries ? 'PARTIAL' : 'FAILED';
}
