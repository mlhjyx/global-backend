import { beforeEach, describe, expect, it, vi } from "vitest";

const temporal = vi.hoisted(() => ({
  activity: vi.fn(),
}));

vi.mock("@temporalio/workflow", () => ({
  proxyActivities: () => ({
    runMeasurementRollup: temporal.activity,
  }),
  ApplicationFailure: class MockApplicationFailure extends Error {
    type: string;
    constructor(message: string, type: string) {
      super(message);
      this.type = type;
    }
    static nonRetryable(message: string, type: string) {
      return new this(message, type);
    }
  },
}));

import { measurementRollupWorkflow } from "./measurement.workflow";

const RESULT = {
  day: "2026-11-08",
  observationsBuilt: 3,
  observationsInserted: 3,
  rollupDailyRows: 1,
  rollupWeeklyRows: 1,
  skipped: [],
  computedAt: "2026-11-09T01:00:00.000Z",
};

describe("measurementRollupWorkflow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    temporal.activity.mockResolvedValue(RESULT);
  });

  it("delegates the validated day to the rollup activity once", async () => {
    const result = await measurementRollupWorkflow({ day: "2026-11-08" });
    expect(temporal.activity).toHaveBeenCalledTimes(1);
    expect(temporal.activity).toHaveBeenCalledWith({ day: "2026-11-08" });
    expect(result).toEqual(RESULT);
  });

  it("fails non-retryably on an invalid day without calling the activity", async () => {
    await expect(measurementRollupWorkflow({ day: "11/08/2026" })).rejects.toThrow(
      "invalid measurement rollup day",
    );
    expect(temporal.activity).not.toHaveBeenCalled();
  });
});
