import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

async function setup(t, source) {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "identity-bounded-process-"),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = path.join(root, "fixture.mjs");
  await writeFile(script, source);
  return {
    executable: process.execPath,
    argv: [script],
    cwd: root,
    environment: {},
    timeoutMs: 2000,
    maxOutputBytes: 1024,
  };
}
async function api() {
  return import("./governance-organization-identity-bounded-process.mjs");
}

test("bounded runner exists and yields stdout only for a successful quiet child", async (t) => {
  const module = await api();
  assert.equal(typeof module.runBoundedProcess, "function");
  const input = await setup(t, "process.stdout.write('observed\\n');");
  assert.deepEqual(await module.runBoundedProcess(input), {
    status: "PASS",
    evidenceClass: "LOCAL_PROCESS_RESULT_ONLY",
    admissionGranted: false,
    exitCode: 0,
    stdout: "observed\n",
    stderr: "",
  });
});

test("process failure, stderr and spawn failure expose no raw output or cause", async (t) => {
  const { runBoundedProcess } = await api();
  for (const source of [
    "process.stdout.write('fixture-private');process.exit(2)",
    "process.stderr.write('fixture-private');",
  ]) {
    const input = await setup(t, source),
      r = await runBoundedProcess(input);
    assert.equal(r.status, "HOLD");
    assert.equal(JSON.stringify(r).includes("fixture-private"), false);
  }
  const input = await setup(t, "");
  assert.equal(
    (
      await runBoundedProcess({
        ...input,
        executable: path.join(input.cwd, "missing"),
      })
    ).status,
    "HOLD",
  );
});

test("byte budget applies to combined stdout and stderr while reading", async (t) => {
  const { runBoundedProcess } = await api();
  const input = await setup(
    t,
    "process.stdout.write('x'.repeat(700));process.stderr.write('y'.repeat(700));setInterval(()=>{},1000);",
  );
  const r = await runBoundedProcess(input);
  assert.equal(r.code, "PROCESS_OUTPUT_LIMIT");
  assert.deepEqual(Object.keys(r).sort(), ["code", "status"]);
});

test("deadline kills an actual child and its process group", async (t) => {
  const { runBoundedProcess } = await api();
  const input = await setup(
    t,
    "import {spawn} from 'node:child_process';import {writeFileSync} from 'node:fs';const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});writeFileSync('child.pid',String(c.pid));setInterval(()=>{},1000);",
  );
  const start = Date.now();
  const r = await runBoundedProcess({ ...input, timeoutMs: 500 });
  assert.equal(r.code, "PROCESS_TIMEOUT");
  assert.ok(Date.now() - start < 3000);
  const pid = (
    await readFile(path.join(input.cwd, "child.pid"), "utf8")
  ).trim();
  // SIGKILL delivery and the kernel's zombie transition are asynchronous.
  const cleanupDeadline = Date.now() + 1000;
  let terminated = false;
  while (Date.now() < cleanupDeadline) {
    try {
      terminated = /\) Z /u.test(await readFile(`/proc/${pid}/stat`, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") terminated = true;
      else throw error;
    }
    if (terminated) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(
    terminated,
    true,
    "owned descendant must terminate after group SIGKILL",
  );
});

test("invalid bounds and hostile option accessors fail before process creation", async (t) => {
  const { runBoundedProcess } = await api();
  const input = await setup(t, "");
  let reads = 0;
  for (const delta of [
    { timeoutMs: 0 },
    { timeoutMs: 15001 },
    { maxOutputBytes: 0 },
    { maxOutputBytes: 8193 },
    { executable: "node" },
    { argv: ["a\0b"] },
    { extra: true },
  ])
    assert.equal(
      (await runBoundedProcess({ ...input, ...delta })).code,
      "PROCESS_INPUT_INVALID",
    );
  assert.equal((await runBoundedProcess(null)).code, "PROCESS_INPUT_INVALID");
  const hostile = Object.defineProperty({}, "executable", {
    get() {
      reads++;
      throw Error("private");
    },
  });
  assert.equal(
    (await runBoundedProcess(hostile)).code,
    "PROCESS_INPUT_INVALID",
  );
  assert.equal(reads, 0);
});

test("a leader cannot leave descendants holding the result pipes open", async (t) => {
  const { runBoundedProcess } = await api();
  const input = await setup(
    t,
    "import {spawn} from 'node:child_process';spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});process.exit(0);",
  );
  assert.equal(
    (await runBoundedProcess(input)).code,
    "PROCESS_DESCENDANTS_TERMINATED",
  );
});
test("invalid UTF-8 is rejected rather than normalized into a successful observation", async (t) => {
  const { runBoundedProcess } = await api();
  const input = await setup(t, "process.stdout.write(Buffer.from([255]));");
  assert.equal(
    (await runBoundedProcess(input)).code,
    "PROCESS_OUTPUT_ENCODING",
  );
});

test("quiet success rechecks the monotonic deadline even when timeout dispatch is late", async (t) => {
  const { performance } = await import("node:perf_hooks");
  const { runBoundedProcess } = await api();
  const input = await setup(t, "");
  let reads = 0;
  t.mock.method(performance, "now", () => (reads++ < 2 ? 0 : 3000));
  assert.equal((await runBoundedProcess(input)).code, "PROCESS_TIMEOUT");
});
