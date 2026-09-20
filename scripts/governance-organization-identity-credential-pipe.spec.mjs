import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm, open } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
const moduleUrl = pathToFileURL(
  path.resolve("scripts/governance-organization-identity-credential-pipe.mjs"),
).href;
async function invoke(t, input, { keepOpen = false, nonblocking = true } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "identity-fd-fixture-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = path.join(root, "child.mjs");
  await writeFile(
    script,
    `import {readCredentialPipe} from ${JSON.stringify(moduleUrl)};import {createHash} from 'node:crypto';const r=await readCredentialPipe({fd:Number(process.argv[2]),timeoutMs:200});if(r.status==='PASS'){const digest=createHash('sha256').update(r.bytes).digest('hex');r.bytes.fill(0);console.log(JSON.stringify({status:r.status,digest}));}else console.log(JSON.stringify(r));`,
  );
  return new Promise((resolve, reject) => {
    const producer = `import os,sys,subprocess,base64
r,w=os.pipe()
os.set_blocking(r,sys.argv[5]=='blocking')
p=subprocess.Popen([sys.argv[1],sys.argv[2],str(r)],pass_fds=(r,),stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
os.close(r)
os.write(w,base64.b64decode(sys.argv[3]))
if sys.argv[4]=='close':os.close(w)
out,err=p.communicate(timeout=3)
if sys.argv[4]!='close':os.close(w)
sys.stdout.buffer.write(out)
sys.stderr.buffer.write(err)
sys.exit(p.returncode)
`;
    const child = spawn(
      "/usr/bin/python3",
      [
        "-c",
        producer,
        process.execPath,
        script,
        Buffer.from(input).toString("base64"),
        keepOpen ? "keep" : "close",
        nonblocking ? "nonblocking" : "blocking",
      ],
      { detached: true, env: {}, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "",
      stderr = "";
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
      reject(Error("fixture deadline"));
    }, 4000);
    child.stdout.on("data", (b) => {
      stdout += b.toString();
    });
    child.stderr.on("data", (b) => (stderr += b.toString()));
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(Error(stderr));
      else resolve(JSON.parse(stdout));
    });
  });
}
test("credential pipe reader exists and consumes a real inherited anonymous pipe", async (t) => {
  const api =
    await import("./governance-organization-identity-credential-pipe.mjs");
  assert.equal(typeof api.readCredentialPipe, "function");
  const input = "fixture_opaque_credential";
  const r = await invoke(t, input);
  assert.equal(r.status, "PASS");
  assert.equal(r.digest, createHash("sha256").update(input).digest("hex"));
  assert.equal(JSON.stringify(r).includes(input), false);
});
test("empty, invalid and oversized pipe contents yield only fixed errors", async (t) => {
  for (const input of ["", "fixture-private\n", "x".repeat(8193)]) {
    const r = await invoke(t, input);
    assert.equal(r.status, "HOLD");
    assert.deepEqual(Object.keys(r).sort(), ["code", "status"]);
    assert.equal(JSON.stringify(r).includes("fixture-private"), false);
  }
});
test("a pipe that never reaches EOF is rejected within its deadline", async (t) => {
  const r = await invoke(t, "fixture_private", { keepOpen: true });
  assert.equal(r.code, "CREDENTIAL_PIPE_TIMEOUT");
});
test("invalid or absent FDs are rejected without reading ordinary files", async () => {
  const { readCredentialPipe } =
    await import("./governance-organization-identity-credential-pipe.mjs");
  for (const value of [
    { fd: 0, timeoutMs: 10 },
    { fd: 999999, timeoutMs: 10 },
    { fd: 3, timeoutMs: 5001 },
    null,
  ])
    assert.equal((await readCredentialPipe(value)).status, "HOLD");
});

test("ordinary files and blocking pipes fail before credential consumption", async (t) => {
  const { readCredentialPipe } =
    await import("./governance-organization-identity-credential-pipe.mjs");
  const root = await mkdtemp(path.join(os.tmpdir(), "identity-fd-file-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const p = path.join(root, "fixture");
  await writeFile(p, "fixture");
  const handle = await open(p, "r");
  try {
    assert.equal(
      (await readCredentialPipe({ fd: handle.fd, timeoutMs: 100 })).code,
      "CREDENTIAL_PIPE_REQUIRED",
    );
    const bytes = Buffer.alloc(7);
    await handle.read(bytes, 0, 7, null);
    assert.equal(bytes.toString(), "fixture");
  } finally {
    await handle.close();
  }
  assert.equal(
    (await invoke(t, "fixture", { nonblocking: false })).code,
    "CREDENTIAL_PIPE_NONBLOCK_REQUIRED",
  );
});
test("the exact 8192 byte boundary is accepted and non-ASCII is rejected", async (t) => {
  assert.equal((await invoke(t, "x".repeat(8192))).status, "PASS");
  assert.equal((await invoke(t, "é")).code, "CREDENTIAL_PIPE_VALUE_INVALID");
});
