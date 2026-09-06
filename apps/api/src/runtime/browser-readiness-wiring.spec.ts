import { afterEach, describe, expect, it, vi } from "vitest";
import childProcess, { type SpawnOptions } from "node:child_process";
import { access, rm } from "node:fs/promises";
import { dirname } from "node:path";
import {
  checkBrowserReadiness,
  inspectPlatformBudgetAuthorityReadiness,
} from "./managed-dependency-readiness";
import { RuntimeReadinessContributorRegistry } from "./runtime-readiness-registry";
import {
  platformAutomationReadinessFactName,
  type PlatformAutomationExternalReadinessFact,
} from "../platform-authority/platform-automation-readiness";
import { PLATFORM_EXECUTION_TECHNICAL_CONTRACT_V1 } from "../platform-authority/platform-execution-contract";
import { PLATFORM_TECHNICAL_QUOTE_AUTHENTICATION_READINESS_CONTRIBUTOR } from "../platform-authority/platform-technical-quote-service-auth";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: () => {
      throw new Error("Legacy browser launch is not permitted by this test");
    },
  };
});

const spawn = childProcess.spawn.bind(childProcess);
const roots = new Set<string>();

afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots) await rm(root, { recursive: true, force: true });
  roots.clear();
});

function installChild(document: string) {
  // Only replace the browser executable. Keep default wiring, lifecycle,
  // process waiting, filesystem isolation and readiness result production-real.
  vi.spyOn(childProcess, "spawn").mockImplementation(
    (_command, args, options) => {
      const profile = (args as string[])
        .find((arg) => arg.startsWith("--user-data-dir="))
        ?.slice("--user-data-dir=".length);
      if (!profile) throw new Error("Missing isolated profile");
      roots.add(dirname(profile));
      return spawn(
        process.execPath,
        [
          "-e",
          `
      require('node:fs').writeFileSync(process.env.TMPDIR+'/probe-state','state');
      process.stdout.write(${JSON.stringify(document)});
    `,
        ],
        options as SpawnOptions,
      );
    },
  );
}

describe("default browser readiness lifecycle integration", () => {
  it("reports ready only after the isolated child state is cleaned", async () => {
    installChild("<title>runtime-readiness</title>");
    await expect(checkBrowserReadiness({})).resolves.toEqual({ status: "ok" });
    expect(roots.size).toBe(1);
    for (const root of roots)
      await expect(access(root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an invalid rendered document and still removes its state", async () => {
    installChild("<title>private unexpected result</title>");
    await expect(
      checkBrowserReadiness({ CHROME_PATH: "/usr/bin/google-chrome" }),
    ).resolves.toEqual({
      status: "failed",
      code: "BROWSER_RUNTIME_UNAVAILABLE",
    });
    expect(roots.size).toBe(1);
    for (const root of roots)
      await expect(access(root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects unapproved executable paths before creating browser state", async () => {
    installChild("<title>runtime-readiness</title>");
    await expect(
      checkBrowserReadiness({ CHROME_PATH: "/tmp/untrusted-browser" }),
    ).resolves.toEqual({
      status: "failed",
      code: "BROWSER_RUNTIME_CONFIG_INVALID",
    });
    expect(roots.size).toBe(0);
  });

  it("keeps the isolated browser probe and exact platform rows in one managed module", async () => {
    installChild("<title>runtime-readiness</title>");
    await expect(checkBrowserReadiness({})).resolves.toEqual({ status: "ok" });

    const registry = new RuntimeReadinessContributorRegistry();
    registry.register(
      PLATFORM_TECHNICAL_QUOTE_AUTHENTICATION_READINESS_CONTRIBUTOR,
      () => ({ status: "ok" }),
    );
    for (const row of PLATFORM_EXECUTION_TECHNICAL_CONTRACT_V1.rows) {
      for (const fact of [
        "temporal_proof",
        "issuer",
        "revocation_delivery",
      ] satisfies readonly PlatformAutomationExternalReadinessFact[]) {
        registry.register(
          platformAutomationReadinessFactName(fact, row.scheduleId),
          () => ({ status: "ok" }),
        );
      }
    }
    const authority = {
      inspectPlatformWriterCapability: vi.fn(async () => ({
        status: "available" as const,
      })),
    };

    const report = await inspectPlatformBudgetAuthorityReadiness(
      authority,
      registry,
    );

    expect(
      report.rows.map((row) => [row.identity.scheduleId, row.state]),
    ).toEqual([
      ["acq-sweep", "BLOCKED"],
      ["patents-cache-refresh", "INTENTIONALLY_DISABLED_NO_EGRESS"],
      ["intent-sweep", "BLOCKED"],
      ["sanctions-refresh", "BLOCKED"],
    ]);
    expect(authority.inspectPlatformWriterCapability).toHaveBeenCalledTimes(3);
    expect(roots.size).toBe(1);
    for (const root of roots)
      await expect(access(root)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
