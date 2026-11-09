import { PrismaClient } from "@prisma/client";
import {
  MeasurementRunInput,
  MeasurementRunResult,
  runMeasurementRollup,
} from "../measurement/run";

export interface MeasurementActivityDeps {
  /** owner 连接（DATABASE_URL）：度量作业是平台级服务写者（ch01 §3.6.9）。 */
  ownerDb: PrismaClient;
}

/** ch01 PR-03：度量聚合活动（单活动完成采集 + 写观测 + 刷 rollup，幂等可重放）。 */
export function createMeasurementActivities({ ownerDb }: MeasurementActivityDeps) {
  return {
    async runMeasurementRollup(
      input: MeasurementRunInput,
    ): Promise<MeasurementRunResult> {
      return runMeasurementRollup(ownerDb, input);
    },
  };
}
