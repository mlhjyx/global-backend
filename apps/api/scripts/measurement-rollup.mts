/**
 * ch01 PR-03：度量聚合运行/回填命令（owner 连接，平台级服务写者）。
 *
 * 运行当日（UTC 昨天，即最近一个完整日）：
 *   node --import tsx apps/api/scripts/measurement-rollup.mts
 * 指定单日：
 *   node --import tsx apps/api/scripts/measurement-rollup.mts --day 2026-11-08
 * 回填最近 N 天（截至 UTC 昨天，逐日调用同一实现）：
 *   node --import tsx apps/api/scripts/measurement-rollup.mts --backfill-days 180
 *
 * 幂等：同一 (metric, version, stratum, window, counts) 重复运行不会重复插入
 * （metric_observation_identity_key）；rollup 按主键 upsert。回填与实时一致。
 */
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import {
  parseMeasurementDay,
  runMeasurementRollup,
} from "../src/measurement/run";

function argumentValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

function utcYesterday(): string {
  return new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function dayList(): string[] {
  const day = argumentValue("--day");
  const backfill = argumentValue("--backfill-days");
  if (day && backfill) {
    throw new Error("use either --day or --backfill-days, not both");
  }
  if (day) {
    parseMeasurementDay(day);
    return [day];
  }
  if (backfill) {
    const days = Number(backfill);
    if (!Number.isInteger(days) || days < 1 || days > 366) {
      throw new Error(`--backfill-days must be an integer in [1, 366], got ${backfill}`);
    }
    const result: string[] = [];
    const today = new Date();
    for (let offset = 1; offset <= days; offset += 1) {
      result.push(
        new Date(today.getTime() - offset * 24 * 60 * 60 * 1000)
          .toISOString()
          .slice(0, 10),
      );
    }
    return result;
  }
  return [utcYesterday()];
}

const db = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
try {
  for (const day of dayList()) {
    const result = await runMeasurementRollup(db, { day });
    console.log(JSON.stringify(result));
  }
} finally {
  await db.$disconnect();
}
