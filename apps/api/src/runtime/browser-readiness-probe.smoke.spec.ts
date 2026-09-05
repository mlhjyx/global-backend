import { describe, expect, it } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createBrowserReadinessProbe } from "./browser-readiness-probe";

async function processes() {
  const ids = (await readdir("/proc")).filter((id) => /^\d+$/.test(id));
  let zombies = 0;
  for (const id of ids) {
    try {
      const raw = await readFile(`/proc/${id}/stat`, "utf8");
      if (raw.slice(raw.lastIndexOf(")") + 2).startsWith("Z ")) zombies++;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return { count: ids.length, zombies };
}

// Match managed runtime: disposable --init --network none and production Chromium.
describe.runIf(process.env.BROWSER_PROBE_REAL_TEST === "1")(
  "real Chromium readiness lifecycle",
  () => {
    it("renders ten data documents without accumulating browser state", async () => {
      const probe = createBrowserReadinessProbe();
      const before = (await readdir(tmpdir())).sort();
      const beforeProcesses = await processes();
      for (let i = 0; i < 10; i++) await probe("/usr/bin/chromium");
      const after = (await readdir(tmpdir())).sort();
      expect(after).toEqual(before);
      expect(await processes()).toEqual(beforeProcesses);
    }, 90_000);
  },
);
