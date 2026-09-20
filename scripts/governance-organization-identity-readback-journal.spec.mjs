import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdtemp,
  rm,
  readdir,
  readFile,
  writeFile,
  chmod,
  symlink,
  link,
  rename,
  mkdir,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "identity-journal-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return {
    root,
    requestId: "readback-test-001",
    requestSha256: "a".repeat(64),
  };
}
const api = () =>
  import("./governance-organization-identity-readback-journal.mjs");
const observation = { headSha: "b".repeat(40), protected: true };

test("separate processes race for exactly one claim and process exit cannot unlock it", async (t) => {
  const input = await fixture(t);
  const url = pathToFileURL(
    path.resolve(
      "scripts/governance-organization-identity-readback-journal.mjs",
    ),
  ).href;
  const source = `import {claimReadbackRequest} from ${JSON.stringify(url)};console.log(JSON.stringify(claimReadbackRequest(JSON.parse(process.argv[1]))));`;
  const invoke = () =>
    promisify(execFile)(
      process.execPath,
      ["--input-type=module", "-e", source, JSON.stringify(input)],
      { env: {}, timeout: 3000, maxBuffer: 4096 },
    );
  const results = await Promise.all([invoke(), invoke()]);
  const outcomes = results.map((r) => JSON.parse(r.stdout));
  assert.equal(outcomes.filter((r) => r.status === "CLAIMED").length, 1);
  assert.equal(
    outcomes.filter((r) => r.code === "JOURNAL_REQUEST_ALREADY_CLAIMED").length,
    1,
  );
  const { claimReadbackRequest, readReadbackRequest } = await api();
  assert.equal(
    claimReadbackRequest(input).code,
    "JOURNAL_REQUEST_ALREADY_CLAIMED",
  );
  assert.equal(readReadbackRequest(input).code, "JOURNAL_RESULT_UNAVAILABLE");
});

test("missing roots, unsafe result modes and canonical-but-wrong result bindings fail closed", async (t) => {
  const input = await fixture(t);
  const {
    claimReadbackRequest,
    completeReadbackRequest,
    readReadbackRequest,
    abandonReadbackRequest,
  } = await api();
  assert.equal(
    claimReadbackRequest({ ...input, root: input.root + "/missing" }).code,
    "JOURNAL_ROOT_UNSAFE",
  );
  assert.equal(readReadbackRequest(null).code, "JOURNAL_INPUT_INVALID");
  assert.equal(abandonReadbackRequest({}).code, "JOURNAL_CLAIM_INVALID");
  completeReadbackRequest(claimReadbackRequest(input), observation);
  const result = path.join(
    input.root,
    (await readdir(input.root)).find((n) => n.endsWith(".result.json")),
  );
  await chmod(result, 0o644);
  assert.equal(readReadbackRequest(input).status, "HOLD");
  await chmod(result, 0o600);
  const { canonicalJsonBytes } =
    await import("./governance-organization-identity-controller-contracts.mjs");
  const value = JSON.parse(await readFile(result, "utf8"));
  value.claimSha256 = "c".repeat(64);
  await writeFile(result, canonicalJsonBytes(value));
  assert.equal(readReadbackRequest(input).code, "JOURNAL_RESULT_INVALID");
});

test("preexisting result and changed claim cannot be overwritten by completion", async (t) => {
  const { claimReadbackRequest, completeReadbackRequest } = await api();
  for (const tamperClaim of [false, true]) {
    const input = await fixture(t),
      claim = claimReadbackRequest(input);
    const name = (await readdir(input.root))[0];
    const target = path.join(
      input.root,
      tamperClaim ? name : name.replace(".claim.json", ".result.json"),
    );
    const bytes = Buffer.from('{"incomplete":true}\n');
    await writeFile(target, bytes, { mode: 0o600 });
    const r = completeReadbackRequest(claim, observation);
    assert.equal(
      r.code,
      tamperClaim ? "JOURNAL_CLAIM_DRIFT" : "JOURNAL_RESULT_WRITE_FAILED",
    );
    assert.deepEqual(await readFile(target), bytes);
  }
});

test("exclusive claim, final write and readback bind exact request without granting authority", async (t) => {
  const { claimReadbackRequest, completeReadbackRequest, readReadbackRequest } =
    await api();
  const input = await fixture(t);
  const claim = claimReadbackRequest(input);
  assert.equal(claim.status, "CLAIMED");
  assert.equal(
    claimReadbackRequest(input).code,
    "JOURNAL_REQUEST_ALREADY_CLAIMED",
  );
  assert.equal(readReadbackRequest(input).code, "JOURNAL_RESULT_UNAVAILABLE");
  assert.equal(completeReadbackRequest(claim, observation).status, "RECORDED");
  assert.deepEqual(readReadbackRequest(input), {
    status: "PASS",
    evidenceClass: "LOCAL_JOURNAL_ONLY",
    admissionGranted: false,
    requestId: input.requestId,
    requestSha256: input.requestSha256,
    observation,
  });
  assert.equal(
    claimReadbackRequest(input).code,
    "JOURNAL_REQUEST_ALREADY_CLAIMED",
  );
  assert.equal(
    completeReadbackRequest(claim, observation).code,
    "JOURNAL_CLAIM_INVALID",
  );
  const names = await readdir(input.root);
  assert.equal(names.length, 2);
  for (const name of names)
    assert.equal(
      (await readFile(path.join(input.root, name), "utf8")).includes("token"),
      false,
    );
});

test("abandoned claim is durable HOLD and cannot be replayed or fabricated", async (t) => {
  const {
    claimReadbackRequest,
    abandonReadbackRequest,
    completeReadbackRequest,
    readReadbackRequest,
  } = await api();
  const input = await fixture(t);
  const claim = claimReadbackRequest(input);
  assert.equal(abandonReadbackRequest(claim).status, "ABANDONED");
  assert.equal(
    completeReadbackRequest(claim, observation).code,
    "JOURNAL_CLAIM_INVALID",
  );
  assert.equal(
    completeReadbackRequest({ ...claim }, observation).code,
    "JOURNAL_CLAIM_INVALID",
  );
  assert.equal(
    claimReadbackRequest(input).code,
    "JOURNAL_REQUEST_ALREADY_CLAIMED",
  );
  assert.equal(readReadbackRequest(input).code, "JOURNAL_RESULT_UNAVAILABLE");
});

test("malformed requests and unsafe roots are refused before records are created", async (t) => {
  const { claimReadbackRequest } = await api();
  const input = await fixture(t);
  for (const delta of [
    { requestId: "../escape" },
    { requestSha256: "bad" },
    { extra: true },
    { root: input.root + "/.." },
  ])
    assert.equal(claimReadbackRequest({ ...input, ...delta }).status, "HOLD");
  assert.equal(claimReadbackRequest(null).status, "HOLD");
  await chmod(input.root, 0o777);
  assert.equal(claimReadbackRequest(input).code, "JOURNAL_ROOT_UNSAFE");
  assert.deepEqual(await readdir(input.root), []);
  await chmod(input.root, 0o700);
  const alias = input.root + "-alias";
  await symlink(input.root, alias);
  t.after(() => rm(alias, { force: true }));
  assert.equal(
    claimReadbackRequest({ ...input, root: alias }).code,
    "JOURNAL_ROOT_UNSAFE",
  );
});

test("request mismatch, tampering, symlinks and hardlinks do not become valid readbacks", async (t) => {
  const { claimReadbackRequest, completeReadbackRequest, readReadbackRequest } =
    await api();
  const input = await fixture(t);
  assert.equal(
    completeReadbackRequest(claimReadbackRequest(input), observation).status,
    "RECORDED",
  );
  assert.equal(
    readReadbackRequest({ ...input, requestSha256: "c".repeat(64) }).status,
    "HOLD",
  );
  const result = (await readdir(input.root)).find((n) =>
    n.endsWith(".result.json"),
  );
  const resultPath = path.join(input.root, result);
  const bytes = await readFile(resultPath);
  await writeFile(resultPath, "{");
  assert.equal(readReadbackRequest(input).status, "HOLD");
  await writeFile(resultPath, bytes);
  const second = path.join(input.root, "hardlink");
  await link(resultPath, second);
  assert.equal(readReadbackRequest(input).status, "HOLD");
  await rm(second);
  await rm(resultPath);
  await symlink("/dev/null", resultPath);
  assert.equal(readReadbackRequest(input).status, "HOLD");
});

test("invalid completion leaves claimed request on HOLD and never persists arbitrary payload", async (t) => {
  const { claimReadbackRequest, completeReadbackRequest, readReadbackRequest } =
    await api();
  const input = await fixture(t);
  const claim = claimReadbackRequest(input);
  assert.equal(
    completeReadbackRequest(claim, {
      ...observation,
      unexpectedPayload: "fixture-private",
    }).code,
    "JOURNAL_OBSERVATION_INVALID",
  );
  assert.equal(
    completeReadbackRequest(claim, observation).code,
    "JOURNAL_CLAIM_INVALID",
  );
  assert.equal(readReadbackRequest(input).status, "HOLD");
  const files = await readdir(input.root);
  assert.equal(files.length, 1);
  assert.equal(
    (await readFile(path.join(input.root, files[0]), "utf8")).includes(
      "fixture-private",
    ),
    false,
  );
});

test("root replacement between claim and completion cannot redirect writes", async (t) => {
  const { claimReadbackRequest, completeReadbackRequest } = await api();
  const input = await fixture(t);
  const claim = claimReadbackRequest(input),
    old = input.root + "-old";
  await rename(input.root, old);
  t.after(() => rm(old, { recursive: true, force: true }));
  await mkdir(input.root, { mode: 0o700 });
  assert.equal(
    completeReadbackRequest(claim, observation).code,
    "JOURNAL_ROOT_DRIFT",
  );
  assert.deepEqual(await readdir(input.root), []);
  assert.equal((await readdir(old)).length, 1);
});
