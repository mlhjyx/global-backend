import { afterEach, describe, expect, it, vi } from "vitest";
import { loadProductExport } from "./load-product-export";
import { getE2eTargetMode, requireIntegratedOrSelfcheck } from "./mode-gate-temporal";

afterEach(() => vi.unstubAllEnvs());

describe("precision-intel acceptance modes", () => {
  it("defaults an unset or empty mode to strict product checks", () => {
    expect(getE2eTargetMode({})).toBe("integrated");
    expect(getE2eTargetMode({ E2E_TARGET_MODE: "  " })).toBe("integrated");
  });

  it("rejects unrecognized mode values without echoing them", () => {
    expect(() => getE2eTargetMode({ E2E_TARGET_MODE: "fixture-invalid-value" }))
      .toThrow("E2E_TARGET_MODE_INVALID: expected 'integrated' or 'harness-selfcheck'.");
  });

  it("runs only the synthetic contract check in selfcheck mode", async () => {
    vi.stubEnv("E2E_TARGET_MODE", "harness-selfcheck");
    const integratedCheck = vi.fn(() => "product path");
    const selfcheckContract = vi.fn(() => "fixture contract");

    await expect(requireIntegratedOrSelfcheck({
      featureId: "F1", caseId: "mode-selfcheck", integratedCheck, selfcheckContract,
    })).resolves.toBe("fixture contract");
    expect(integratedCheck).not.toHaveBeenCalled();
    expect(selfcheckContract).toHaveBeenCalledExactlyOnceWith();
  });

  it("propagates product failures in integrated mode", async () => {
    vi.stubEnv("E2E_TARGET_MODE", "integrated");
    const selfcheckContract = vi.fn();
    const error = new Error("synthetic product failure");

    await expect(requireIntegratedOrSelfcheck({
      featureId: "F1", caseId: "mode-integrated",
      integratedCheck: () => { throw error; }, selfcheckContract,
    })).rejects.toBe(error);
    expect(selfcheckContract).not.toHaveBeenCalled();
  });

  it("reports the missing implementation path when a companion module has not landed", async () => {
    await expect(loadProductExport("Fixture", "src/fixture-not-installed.ts", "operation"))
      .rejects.toThrow("Fixture requires the implementation at apps/api/src/fixture-not-installed.ts");
  });
});
