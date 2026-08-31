import { spawnSync } from "node:child_process";

const specs = [
  "test/governed-subject-relation-append-attest-catalog.rls.spec.mjs",
  "test/governed-subject-relation-append-attest-lifecycle.rls.spec.mjs",
];

for (const spec of specs) {
  const result = spawnSync(process.execPath, ["--test", spec], {
    cwd: new URL("..", import.meta.url),
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
