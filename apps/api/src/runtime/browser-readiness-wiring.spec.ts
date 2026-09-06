import { afterEach, describe, expect, it, vi } from "vitest";
import childProcess, { type SpawnOptions } from "node:child_process";
import { access, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { checkBrowserReadiness } from "./managed-dependency-readiness";

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
});
