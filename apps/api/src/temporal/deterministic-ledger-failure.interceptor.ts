// 活动边界的确定性账本错误拦截器（B2，审计 F5）。
//
// 三个 worker（customer / platform / dev fast lane）共用：活动抛出的错误里，命中
// deterministic-ledger-failure 分类器的转成 nonRetryable 后抛出，其余原样透传。
// 这样 Temporal 不会把重试预算烧在「同一 operation_key 必撞同一行」的错误上——
// 未收尾的 run 交给 B3 看门狗、孤儿预留交给 B4 清收器。
import type {
  ActivityExecuteInput,
  ActivityInboundInterceptor,
  ActivityInterceptorsFactory,
  Next,
  WorkerInterceptors,
} from '@temporalio/worker';

import { classifyDeterministicLedgerFailure } from './deterministic-ledger-failure';

export class DeterministicLedgerFailureInterceptor implements ActivityInboundInterceptor {
  async execute(
    input: ActivityExecuteInput,
    next: Next<ActivityInboundInterceptor, 'execute'>,
  ): Promise<unknown> {
    try {
      return await next(input);
    } catch (error) {
      const failure = classifyDeterministicLedgerFailure(error);
      throw failure ?? error;
    }
  }
}

const factory: ActivityInterceptorsFactory = () => ({
  inbound: [new DeterministicLedgerFailureInterceptor()],
});

/** 挂到 `Worker.create({ interceptors })` 的 activity 拦截器链。 */
export const DETERMINISTIC_LEDGER_FAILURE_INTERCEPTORS: WorkerInterceptors = Object.freeze({
  activity: [factory],
});
