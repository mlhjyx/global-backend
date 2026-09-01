import { spawn } from "node:child_process";
import { mkdtemp, open, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const rendererRoot = path.resolve(import.meta.dirname, "..");
const dependencyRoot = path.join(rendererRoot, "node_modules");
const wrapperPath = path.join(
  rendererRoot,
  "scripts",
  "run-with-temporary-cache.mjs",
);
const siteSpecPath = path.join(
  rendererRoot,
  "product-assets",
  "component-catalog-v1",
  "minimal-hero-spec.json",
);

async function reservePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address === "object");
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function waitFor(predicate, message) {
  const deadline = Date.now() + 20_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(message, { cause: lastError });
}

async function listDevCaches() {
  return new Set(
    (await readdir(dependencyRoot)).filter((name) =>
      name.startsWith(".site-renderer-dev-cache-"),
    ),
  );
}

async function listSourceBuildCaches() {
  return new Set(
    (await readdir(tmpdir())).filter((name) =>
      name.startsWith("global-site-renderer-source-cache-"),
    ),
  );
}

function startDevServer(port) {
  let diagnostics = "";
  const child = spawn(
    process.execPath,
    [wrapperPath, "dev", "--host", "127.0.0.1", "--port", String(port)],
    {
      cwd: rendererRoot,
      env: {
        ...process.env,
        SITE_ORIGIN: `http://127.0.0.1:${port}`,
        SITESPEC_PATH: siteSpecPath,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk) => {
      diagnostics = `${diagnostics}${chunk}`.slice(-8_192);
    });
  }
  return { child, diagnostics: () => diagnostics };
}

async function waitForReady(port, diagnostics) {
  await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/`);
    if (!response.ok) throw new Error(`HTTP_${response.status}`);
    return true;
  }, `dev server ${port} did not become ready: ${diagnostics()}`);
}

async function fetchLiveSource(port, sourcePath) {
  const response = await fetch(
    `http://127.0.0.1:${port}/@fs/${sourcePath}?direct&t=${Date.now()}`,
  );
  if (!response.ok) throw new Error(`SOURCE_HTTP_${response.status}`);
  return response.text();
}

async function stopDevServer(server) {
  if (server.child.exitCode !== null || server.child.signalCode !== null) {
    return { code: server.child.exitCode, signal: server.child.signalCode };
  }
  const exited = new Promise((resolve) =>
    server.child.once("exit", (code, signal) => resolve({ code, signal })),
  );
  server.child.kill("SIGTERM");
  return exited;
}

test("concurrent source dev servers own isolated caches and clean independently", async () => {
  const baseline = await listDevCaches();
  const [firstPort, secondPort] = await Promise.all([
    reservePort(),
    reservePort(),
  ]);
  assert.notEqual(firstPort, secondPort);
  const first = startDevServer(firstPort);
  let second;
  let firstExit;
  let secondExit;
  const liveProbeRoot = await mkdtemp(
    path.join(rendererRoot, "src", "testing", ".renderer-live-probe-"),
  );
  const liveProbePath = path.join(liveProbeRoot, "probe.css");
  const liveProbe = await open(liveProbePath, "wx", 0o600);
  let expectedProbe = `/* renderer-live-source-initial-${process.pid} */\n`;
  await liveProbe.writeFile(expectedProbe);
  await liveProbe.sync();
  try {
    await waitForReady(firstPort, first.diagnostics);
    assert.match(await fetchLiveSource(firstPort, liveProbePath), /initial/);
    expectedProbe = `/* renderer-live-source-updated-${process.pid} */\n`;
    await liveProbe.truncate(0);
    await liveProbe.write(expectedProbe, 0, "utf8");
    await liveProbe.sync();
    await waitFor(
      async () =>
        (await fetchLiveSource(firstPort, liveProbePath)).includes("updated"),
      "the dev server did not observe a live source edit",
    );
    const afterFirst = await listDevCaches();
    const firstCaches = afterFirst.difference(baseline);
    assert.equal(firstCaches.size, 1);

    second = startDevServer(secondPort);
    await waitForReady(secondPort, second.diagnostics);
    const afterSecond = await listDevCaches();
    const allNewCaches = afterSecond.difference(baseline);
    assert.equal(allNewCaches.size, 2);
    const secondCaches = allNewCaches.difference(firstCaches);
    assert.equal(secondCaches.size, 1);

    secondExit = await stopDevServer(second);
    assert.deepEqual(secondExit, { code: 0, signal: null });
    assert.doesNotMatch(
      second.diagnostics(),
      /SITE_RENDERER_SOURCE_PROCESS_FAILED/,
    );
    await waitFor(async () => {
      const current = await listDevCaches();
      return (
        firstCaches.isSubsetOf(current) && secondCaches.isDisjointFrom(current)
      );
    }, "stopping the second server did not remove only its cache");
    await waitForReady(firstPort, first.diagnostics);
  } finally {
    try {
      if (second && !secondExit) secondExit = await stopDevServer(second);
      firstExit = await stopDevServer(first);
    } finally {
      await liveProbe.close();
      await rm(liveProbeRoot, { recursive: true });
    }
  }
  assert.deepEqual(firstExit, { code: 0, signal: null });
  assert.doesNotMatch(
    first.diagnostics(),
    /SITE_RENDERER_SOURCE_PROCESS_FAILED/,
  );
  await waitFor(
    async () => (await listDevCaches()).difference(baseline).size === 0,
    "source dev caches remained after both servers stopped",
  );
});

test("early source dev cancellation leaves no owned cache", async () => {
  const baseline = await listDevCaches();
  const port = await reservePort();
  const server = startDevServer(port);
  const exited = new Promise((resolve) =>
    server.child.once("exit", (code, signal) => resolve({ code, signal })),
  );
  server.child.kill("SIGTERM");
  const result = await exited;
  assert.ok(
    (result.code === 0 && result.signal === null) ||
      (result.code === null && result.signal === "SIGTERM"),
  );
  await waitFor(
    async () => (await listDevCaches()).difference(baseline).size === 0,
    "an early-cancelled source dev cache was not cleaned",
  );
});

test("a cancelled source build never reports success or leaves its cache", async () => {
  const baseline = await listSourceBuildCaches();
  const cancellationLoad = await mkdtemp(
    path.join(rendererRoot, "src", "testing", ".renderer-cancel-load-"),
  );
  await Promise.all(
    Array.from({ length: 200 }, (_, index) =>
      writeFile(path.join(cancellationLoad, `${index}.txt`), "owned-test-data"),
    ),
  );
  const outputRoot = await mkdtemp(
    path.join(dependencyRoot, ".site-renderer-cancelled-output-"),
  );
  const child = spawn(process.execPath, [wrapperPath, "build"], {
    cwd: rendererRoot,
    env: {
      ...process.env,
      OUT_DIR: outputRoot,
      SITE_ORIGIN: "http://127.0.0.1:4325",
      SITESPEC_PATH: siteSpecPath,
    },
    stdio: "ignore",
  });
  const exited = new Promise((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal })),
  );
  let repeatedSignal;
  try {
    await waitFor(async () => {
      const created = (await listSourceBuildCaches()).difference(baseline);
      if (created.size !== 1) return false;
      return true;
    }, "the cancellable source build did not create one private cache");
    repeatedSignal = setInterval(() => child.kill("SIGTERM"), 1);
    child.kill("SIGTERM");
    const result = await exited;
    assert.ok(
      (result.code === 143 && result.signal === null) ||
        (result.code === null && result.signal === "SIGTERM"),
    );
  } finally {
    if (repeatedSignal) clearInterval(repeatedSignal);
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
    await rm(outputRoot, { recursive: true });
    await rm(cancellationLoad, { recursive: true });
  }
  assert.equal((await listSourceBuildCaches()).difference(baseline).size, 0);
});
