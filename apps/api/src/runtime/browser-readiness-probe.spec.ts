import { afterEach, describe, expect, it, vi } from "vitest";
import childProcess, { type SpawnOptions } from "node:child_process";
import fs from "node:fs/promises";
import { access, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { createBrowserReadinessProbe } from "./browser-readiness-probe";

const originalSpawn = childProcess.spawn.bind(childProcess);
const roots = new Set<string>();
const children: childProcess.ChildProcess[] = [];
const document =
  "<html><head><title>runtime-readiness</title></head><body></body></html>";

function installBrowser(script: string) {
  return vi
    .spyOn(childProcess, "spawn")
    .mockImplementation((command, args, options) => {
      const opts = options as SpawnOptions;
      const profileArg = (args as string[]).find((arg) =>
        arg.startsWith("--user-data-dir="),
      );
      if (!profileArg) throw new Error("Missing private browser profile");
      const profile = profileArg.slice("--user-data-dir=".length);
      roots.add(dirname(profile));
      const child = originalSpawn(
        process.execPath,
        ["-e", script, "--", profile],
        opts,
      );
      children.push(child);
      return child;
    });
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
  }
  for (const root of roots) await rm(root, { recursive: true, force: true });
  roots.clear();
});

describe("Browser readiness temporary-state lifecycle", () => {
  it("isolates and cleans HOME, cache, config, temporary files and the profile", async () => {
    const spy = installBrowser(`
      const fs=require('node:fs');
      for(const key of ['HOME','XDG_CACHE_HOME','XDG_CONFIG_HOME','TMPDIR'])
        fs.writeFileSync(process.env[key]+'/browser-state','state');
      fs.writeFileSync(process.argv[1]+'/Preferences','{}');
      process.stdout.write(${JSON.stringify(document)});
    `);
    await createBrowserReadinessProbe()("/usr/bin/chromium");
    const opts = spy.mock.calls[0][2] as SpawnOptions;
    expect(Object.keys(opts.env!).sort()).toEqual([
      "HOME",
      "LANG",
      "PATH",
      "TMPDIR",
      "XDG_CACHE_HOME",
      "XDG_CONFIG_HOME",
    ]);
    expect(
      new Set(
        ["HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "TMPDIR"].map(
          (key) => opts.env![key],
        ),
      ).size,
    ).toBe(4);
    expect(roots.size).toBe(1);
    for (const root of roots)
      await expect(access(root)).rejects.toMatchObject({ code: "ENOENT" });
    expect(children[0].exitCode).toBe(0);
  });

  it.each([
    [
      "nonzero exit",
      'process.stderr.write("private diagnostic");process.exit(2)',
    ],
    ["wrong title", 'process.stdout.write("<title>unexpected</title>")'],
    [
      "oversized output",
      'process.stdout.write("x".repeat(131073));setInterval(()=>{},1000)',
    ],
    [
      "oversized diagnostics",
      'process.stderr.write("x".repeat(131073));setInterval(()=>{},1000)',
    ],
  ])(
    "closes and cleans on %s without leaking diagnostics",
    async (_label, script) => {
      installBrowser(script);
      await expect(
        createBrowserReadinessProbe()("/usr/bin/chromium"),
      ).rejects.toThrow("BROWSER_RUNTIME_UNAVAILABLE");
      for (const root of roots)
        await expect(access(root)).rejects.toMatchObject({ code: "ENOENT" });
      expect(
        children[0].exitCode !== null || children[0].signalCode !== null,
      ).toBe(true);
    },
  );

  it("reaps a TERM-ignoring child after timeout before removing its state", async () => {
    installBrowser('process.on("SIGTERM",()=>{});setInterval(()=>{},1000)');
    await expect(
      createBrowserReadinessProbe()("/usr/bin/chromium"),
    ).rejects.toThrow("BROWSER_RUNTIME_UNAVAILABLE");
    expect(children[0].signalCode).toBe("SIGKILL");
    for (const root of roots)
      await expect(access(root)).rejects.toMatchObject({ code: "ENOENT" });
  }, 10_000);

  it("reaps descendants that inherit its process group", async () => {
    installBrowser(`
      require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});
      process.stdout.write(${JSON.stringify(document)});
    `);
    await expect(
      createBrowserReadinessProbe()("/usr/bin/chromium"),
    ).rejects.toThrow("BROWSER_RUNTIME_UNAVAILABLE");
    for (const root of roots)
      await expect(access(root)).rejects.toMatchObject({ code: "ENOENT" });
  }, 10_000);

  it("fences new probes if its root identity is replaced", async () => {
    installBrowser(`
      const fs=require('node:fs'),path=require('node:path');const root=path.dirname(process.argv[1]);
      fs.renameSync(root,root+'.moved');fs.mkdirSync(root);process.stdout.write(${JSON.stringify(document)});
    `);
    const probe = createBrowserReadinessProbe();
    await expect(probe("/usr/bin/chromium")).rejects.toThrow(
      "BROWSER_PROBE_CLEANUP_INCOMPLETE",
    );
    for (const root of [...roots]) {
      roots.add(root + ".moved");
      await access(root);
    }
    await expect(probe("/usr/bin/chromium")).rejects.toThrow(
      "BROWSER_PROBE_CLEANUP_INCOMPLETE",
    );
    expect(children.length).toBe(1);
  });

  it("coalesces 32 concurrent callers but never reuses PASS in the next interval", async () => {
    installBrowser(
      `setTimeout(()=>process.stdout.write(${JSON.stringify(document)}),30)`,
    );
    const probe = createBrowserReadinessProbe();
    await Promise.all(
      Array.from({ length: 32 }, () => probe("/usr/bin/chromium")),
    );
    expect(children.length).toBe(1);
    await probe("/usr/bin/chromium");
    expect(children.length).toBe(2);
  });

  it("rejects an unapproved or mismatched executable before starting another child", async () => {
    installBrowser(
      `setTimeout(()=>process.stdout.write(${JSON.stringify(document)}),30)`,
    );
    const probe = createBrowserReadinessProbe();
    await expect(probe("/tmp/downloaded-browser")).rejects.toThrow(
      "BROWSER_RUNTIME_CONFIG_INVALID",
    );
    const pending = probe("/usr/bin/chromium");
    await expect(probe("/usr/bin/google-chrome")).rejects.toThrow(
      "BROWSER_RUNTIME_CONFIG_INVALID",
    );
    await pending;
    expect(children.length).toBe(1);
  });

  it("cleans private state when spawn emits an error without a PID", async () => {
    vi.spyOn(childProcess, "spawn").mockImplementation(
      (_command, _args, options) => {
        roots.add(String(options!.cwd));
        const child = originalSpawn(
          "/definitely-absent-browser",
          [],
          options as SpawnOptions,
        );
        children.push(child);
        return child;
      },
    );
    await expect(
      createBrowserReadinessProbe()("/usr/bin/chromium"),
    ).rejects.toThrow("BROWSER_RUNTIME_UNAVAILABLE");
    for (const root of roots)
      await expect(access(root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("recovers after temporary-root allocation fails without caching a failure", async () => {
    const probe = createBrowserReadinessProbe();
    vi.stubEnv("TMPDIR", "/definitely-absent-probe-parent");
    await expect(probe("/usr/bin/chromium")).rejects.toThrow(
      "BROWSER_RUNTIME_UNAVAILABLE",
    );
    vi.unstubAllEnvs();
    installBrowser(`process.stdout.write(${JSON.stringify(document)})`);
    await probe("/usr/bin/chromium");
  });

  it("keeps its root when process-group termination cannot be confirmed", async () => {
    const kill = process.kill.bind(process);
    installBrowser(`process.stdout.write(${JSON.stringify(document)})`);
    vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (children.some((child) => pid === -child.pid!))
        throw Object.assign(new Error("denied"), { code: "EPERM" });
      return kill(pid, signal);
    });
    const probe = createBrowserReadinessProbe();
    await expect(probe("/usr/bin/chromium")).rejects.toThrow(
      "BROWSER_PROBE_CLEANUP_INCOMPLETE",
    );
    for (const root of roots) await access(root);
    await expect(probe("/usr/bin/chromium")).rejects.toThrow(
      "BROWSER_PROBE_CLEANUP_INCOMPLETE",
    );
  });

  it("checks the remaining group without treating unrelated processes as descendants", async () => {
    const kill = process.kill.bind(process);
    installBrowser(`process.stdout.write(${JSON.stringify(document)})`);
    vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (signal === 0 && children.some((child) => pid === -child.pid!))
        return true;
      return kill(pid, signal);
    });
    await createBrowserReadinessProbe()("/usr/bin/chromium");
    for (const root of roots)
      await expect(access(root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("withholds cleanup when a group observation exceeds its process bound", async () => {
    const kill = process.kill.bind(process);
    const readDirectory = fs.readdir.bind(fs);
    installBrowser(`process.stdout.write(${JSON.stringify(document)})`);
    vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (signal === 0 && children.some((child) => pid === -child.pid!))
        return true;
      return kill(pid, signal);
    });
    vi.spyOn(fs, "readdir").mockImplementation(((
      path: Parameters<typeof fs.readdir>[0],
      options?: unknown,
    ) => {
      if (path === "/proc")
        return Promise.resolve(
          Array.from({ length: 4097 }, (_, i) => String(i + 1)),
        );
      return readDirectory(path, options as never);
    }) as typeof fs.readdir);
    await expect(
      createBrowserReadinessProbe()("/usr/bin/chromium"),
    ).rejects.toThrow("BROWSER_PROBE_CLEANUP_INCOMPLETE");
    for (const root of roots) await access(root);
  });

  it("fences after the newly created root cannot be identified", async () => {
    const launch = installBrowser(
      `process.stdout.write(${JSON.stringify(document)})`,
    );
    vi.spyOn(fs, "lstat").mockImplementationOnce(async (path) => {
      roots.add(String(path));
      throw Object.assign(new Error("identity read failed"), { code: "EIO" });
    });
    const probe = createBrowserReadinessProbe();
    await expect(probe("/usr/bin/chromium")).rejects.toThrow(
      "BROWSER_PROBE_CLEANUP_INCOMPLETE",
    );
    expect(roots.size).toBe(1);
    for (const root of roots) await access(root);
    await expect(probe("/usr/bin/chromium")).rejects.toThrow(
      "BROWSER_PROBE_CLEANUP_INCOMPLETE",
    );
    expect(launch).not.toHaveBeenCalled();
  });

  it("withholds cleanup when an escaped descendant prevents the close event", async () => {
    installBrowser(`
      const child=require('node:child_process').spawn(process.execPath,['-e','setTimeout(()=>{},20000)'],{detached:true,stdio:'inherit'});
      require('node:fs').writeFileSync(process.env.HOME+'/escaped.pid',String(child.pid));
      child.unref();process.exit(0);
    `);
    const probe = createBrowserReadinessProbe();
    try {
      await expect(probe("/usr/bin/chromium")).rejects.toThrow(
        "BROWSER_PROBE_CLEANUP_INCOMPLETE",
      );
      for (const root of roots) await access(root);
      await expect(probe("/usr/bin/chromium")).rejects.toThrow(
        "BROWSER_PROBE_CLEANUP_INCOMPLETE",
      );
      expect(children.length).toBe(1);
    } finally {
      for (const root of roots) {
        const pid = Number(
          await readFile(join(root, "home", "escaped.pid"), "utf8"),
        );
        expect(Number.isInteger(pid) && pid > 1).toBe(true);
        const close = new Promise<void>((resolve) =>
          children[0].once("close", () => resolve()),
        );
        process.kill(pid, "SIGKILL");
        await close;
      }
    }
  }, 12_000);

  it("leaves no private roots after 1000 sequential real child processes", async () => {
    const parent = await mkdtemp(join(tmpdir(), "browser-probe-soak-"));
    roots.add(parent);
    vi.stubEnv("TMPDIR", parent);
    installBrowser(
      `require('node:fs').writeFileSync(process.env.XDG_CACHE_HOME+'/state','cache');process.stdout.write(${JSON.stringify(document)})`,
    );
    const probe = createBrowserReadinessProbe();
    for (let i = 0; i < 1000; i++) await probe("/usr/bin/chromium");
    expect(await readdir(parent)).toEqual([]);
  }, 120_000);
});
