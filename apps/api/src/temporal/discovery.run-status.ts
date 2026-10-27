/**
 * Discover run 收尾状态判定（纯函数，抽出便于单测——不引入 @temporalio/workflow 运行时）。
 *
 * 语义（收口②）：预算截断的 run **绝不假 DONE**。任一源打穿 run 预算（executeQuery 上报
 * budgetTruncated）或 fit 判定预算耗尽（skippedForBudget>0）都意味着漏了活儿 → 至少 PARTIAL，
 * 让 backlog sweep 兜底重跑。全源失败才 FAILED。
 * G3 5.2：富集阶段因禁令类拒绝（主体 HOLD/tombstone/SUPPRESSED/失效）按公司跳过的，
 * 同样意味着漏了活儿 → 至少 PARTIAL；它不会把全失败的 run 抬成 PARTIAL。
 * Fit 判定按公司吸收的模型失败（判不出）同样至少 PARTIAL，绝不静默漏判假 DONE。它不单独
 * 判 FAILED：计数只覆盖活动的最后一次尝试，重试时已有结论的公司不再重判，「这次一家都没判出」
 * 不等于「这个 run 没有结论」，而 FAILED 会让已存的结论不进评分。
 * BI-30：数据源在规划后被停用而跳过的查询也是漏了活儿 → 至少 PARTIAL；跳过不是失败，全部查询
 * 都被跳过时同样是 PARTIAL，不让 run 失败。
 * 公司抽取因模型调用失败（网关已结算、无结果）而跳过的域名或名录页，同样是漏了活儿 → 至少
 * PARTIAL，与 fit 的未判定同理，不单独判 FAILED。
 * 尽力而为的阶段（官网画像、信号、监控）因操作无法重放而跳过的公司，同样至少 PARTIAL；
 * 连续两家无法重放时阶段照旧失败，不在这里判。信号源所在站点自己断开连接、公司少了这一个源的，
 * 同样至少 PARTIAL（公司仍算已富集，只是漏了一个源）。
 * 准入租约没有余量而提前停下的阶段（查询、画像、fit、富集、监控）留下的查询或公司，同样至少
 * PARTIAL，不单独判 FAILED：run 带着已有结果收尾，评分照跑。例外在工作流里判：查询阶段因租约提前
 * 停下、且一条记录都没收到时判 FAILED（这次 run 什么都没找到）。
 */
export function resolveRunStatus(args: {
  /**
   * Queries that ended with a zero receipt because a provider was lost to an unreplayable
   * operation. A query activity that fails outright stops the run before this is called;
   * histories recorded before the query-stop patch count such a query here too.
   */
  failures: number;
  totalQueries: number;
  budgetTruncated: boolean;
  skippedSubjects?: number;
  /** Companies whose fit judgment failed in the activity's last attempt: absorbed model failures. */
  fitUnjudged?: number;
  /** Plan queries that ran on no provider because their source was off (BI-30). */
  skippedQueries?: number;
  /** Company extractions skipped after a failed model call. */
  droppedExtractions?: number;
  /** Companies the best-effort stages skipped because an operation could not be replayed. */
  unreplayableSkips?: number;
  /** Signal companies that lost a source to a dropped connection (their site reset the socket). */
  transportFailedSkips?: number;
  /**
   * The website-profile stage ended on an error the workflow absorbed, leaving the companies after
   * it unprofiled: fit then judged them without that evidence.
   */
  profileStageFailed?: boolean;
  /** Queries and companies the stages left because the run's admission lease had no room for them. */
  leaseSkips?: number;
}): 'DONE' | 'PARTIAL' | 'FAILED' {
  const { failures, totalQueries, budgetTruncated } = args;
  const skipped = (args.skippedSubjects ?? 0) > 0;
  const unjudged = (args.fitUnjudged ?? 0) > 0;
  const queriesSkipped = (args.skippedQueries ?? 0) > 0;
  const extractionsDropped = (args.droppedExtractions ?? 0) > 0;
  const unreplayableSkipped = (args.unreplayableSkips ?? 0) > 0;
  const transportFailedSkipped = (args.transportFailedSkips ?? 0) > 0;
  const profileStageFailed = args.profileStageFailed === true;
  const leaseSkipped = (args.leaseSkips ?? 0) > 0;
  if (
    failures === 0 &&
    !budgetTruncated &&
    !skipped &&
    !unjudged &&
    !queriesSkipped &&
    !extractionsDropped &&
    !unreplayableSkipped &&
    !transportFailedSkipped &&
    !profileStageFailed &&
    !leaseSkipped
  ) {
    return 'DONE';
  }
  return failures < totalQueries ? 'PARTIAL' : 'FAILED';
}
