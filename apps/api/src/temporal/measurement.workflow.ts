import { ApplicationFailure, proxyActivities } from "@temporalio/workflow";
import type { createMeasurementActivities } from "./measurement.activities";
import type { MeasurementRunInput } from "../measurement/run";

type MeasurementActivities = ReturnType<typeof createMeasurementActivities>;

const activities = proxyActivities<MeasurementActivities>({
  startToCloseTimeout: "15 minutes",
  retry: {
    initialInterval: "10 seconds",
    backoffCoefficient: 2,
    maximumInterval: "2 minutes",
    maximumAttempts: 3,
  },
});

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * ch01 PR-03：度量聚合工作流。
 *
 * 输入 { day: 'YYYY-MM-DD' }（UTC 日）。活动一次性完成：首批核心指标采集 →
 * metric_observation（append-only，computation_hash 幂等）→ 日/周 rollup 刷新。
 * 同一输入可安全重放；历史回填由 apps/api/scripts/measurement-rollup.mts 逐日调用
 * 同一活动实现（回填与实时一致）。
 */
export async function measurementRollupWorkflow(input: MeasurementRunInput) {
  if (!input || !DAY_PATTERN.test(input.day ?? "")) {
    throw ApplicationFailure.nonRetryable(
      "invalid measurement rollup day",
      "MEASUREMENT_DAY_INVALID",
    );
  }
  return activities.runMeasurementRollup({ day: input.day });
}
