import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEV_FAST_LANE } from "./dev-fast-lane";
import { DEV_FAST_LANE_PROVIDER, RUNTIME_SETTINGS } from "./runtime.module";

const WORKSPACE = "0f0e0d0c-0b0a-4908-8706-050403020100";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("DEV_FAST_LANE provider", () => {
  it("resolves the lane from the injected runtime mode and the process environment", () => {
    // Arrange
    vi.stubEnv("RUNTIME_DEV_FAST_LANE_WORKSPACE_ID", "");
    vi.stubEnv("RUNTIME_DEV_FAST_LANE_TEMPORAL_ADDRESS", "");
    vi.stubEnv("RUNTIME_DEV_FAST_LANE_SCHEMA_DIGEST", "");
    const off = DEV_FAST_LANE_PROVIDER.useFactory({
      mode: "development",
      bindHost: "127.0.0.1",
      port: 3000,
    });
    vi.stubEnv("RUNTIME_DEV_FAST_LANE_WORKSPACE_ID", WORKSPACE);
    vi.stubEnv("RUNTIME_DEV_FAST_LANE_TEMPORAL_ADDRESS", "127.0.0.1:7233");

    // Act
    const on = DEV_FAST_LANE_PROVIDER.useFactory({
      mode: "development",
      bindHost: "127.0.0.1",
      port: 3000,
    });
    const pilot = () =>
      DEV_FAST_LANE_PROVIDER.useFactory({
        mode: "pilot",
        bindHost: "127.0.0.1",
        port: 3000,
      });

    // Assert
    expect(DEV_FAST_LANE_PROVIDER.provide).toBe(DEV_FAST_LANE);
    expect(DEV_FAST_LANE_PROVIDER.inject).toEqual([RUNTIME_SETTINGS]);
    expect(off).toEqual({ enabled: false });
    expect(on).toMatchObject({ enabled: true, workspaceId: WORKSPACE });
    expect(pilot).toThrow(/DEV_FAST_LANE_FORBIDDEN_OUTSIDE_DEVELOPMENT/);
  });

  it("is provided and exported by the global RuntimeModule", async () => {
    // Arrange
    const source = await readFile(
      new URL("./runtime.module.ts", import.meta.url),
      "utf8",
    );

    // Act
    const providers = source.slice(source.indexOf("providers: ["));
    const exportsList = source.slice(source.indexOf("exports: ["));

    // Assert
    expect(providers).toMatch(/providers:\s*\[[\s\S]*?DEV_FAST_LANE_PROVIDER/);
    expect(exportsList).toMatch(/exports:\s*\[[\s\S]*?DEV_FAST_LANE[,\s]/);
  });
});
