import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";

const container = process.env.TASK6B_RESOLVER_PG_CONTAINER;
const port = process.env.TASK6B_RESOLVER_PG_PORT;
const expectedContainer = "codex-task6b-identity-authority-pg-20260830-a";
const expectedPort = "55441";
const expectedImageDigest =
  "pgvector/pgvector@sha256:1d533553fefe4f12e5d80c7b80622ba0c382abb5758856f52983d8789179f0fb";
const resolverCommand =
  "public.resolve_organization_identity_for_raw_v1(text,text)";

// These are independently literal inputs/outputs for the future SQL helpers.
// They deliberately do not import TypeScript authority, blocker, suppression, or planner code.
const PARITY_VECTORS = Object.freeze({
  authority: Object.freeze([
    Object.freeze({
      producerMutation: "directory adds a registry-looking identifier",
      providerKey: "directory",
      domain: "acme.example",
      expectedKeys: Object.freeze(["domain:GLOBAL:acme.example"]),
    }),
    Object.freeze({
      producerMutation: "registry preserves punctuation or relabels its identifier",
      providerKey: "registry",
      identifier: "de-12/34",
      expectedKeys: Object.freeze([
        "domain:GLOBAL:acme.example",
        "registry-id:DE:DE1234",
      ]),
    }),
    Object.freeze({
      producerMutation: "TED suffix conflicts with a claimed country",
      providerKey: "ted",
      identifier: "DE291499156",
      expectedJurisdiction: "DE",
    }),
    Object.freeze({
      producerMutation: "FDA widens its one-to-thirty-two digit range",
      providerKey: "openfda",
      accepted: Object.freeze(["1", "12345678901234567890123456789012"]),
      rejected: "123456789012345678901234567890123",
    }),
  ]),
  blocker: Object.freeze([
    Object.freeze({
      producerMutation: "domain priority yields to a provider identifier",
      input: "www.acme.example",
      expected: "d:acme.example",
    }),
    Object.freeze({
      producerMutation: "legal suffix removal changes the fallback name key",
      input: "Acme GmbH",
      expected: "n:acme:de",
    }),
    Object.freeze({
      producerMutation: "Unicode, punctuation, or country case alters the fallback key",
      input: "Äcme, S.A.",
      expected: "n:äcme sa:de",
    }),
    Object.freeze({
      producerMutation: "an empty normalized name becomes a matching blocker",
      input: " GmbH ",
      expected: "n::de",
    }),
    Object.freeze({
      producerMutation: "a provider identifier is reused as the v2 fallback blocker",
      input: "id:registry-id:DE1234",
      expected: null,
    }),
  ]),
  suppression: Object.freeze([
    Object.freeze({ raw: "example.com", expected: "example.com" }),
    Object.freeze({
      raw: " HTTPS://WWW.Example.COM./directory ",
      expected: "example.com",
    }),
    Object.freeze({ raw: "127.0.0.1", expected: null }),
    Object.freeze({ raw: "https://[2001:db8::1]/", expected: null }),
    Object.freeze({ raw: "not a canonical domain", expected: null }),
    Object.freeze({ raw: "  Äcme\tGmbH  ", expected: "äcme gmbh" }),
  ]),
  planner: Object.freeze([
    Object.freeze({ kind: "bind_existing", matchRule: "identity_v2" }),
    Object.freeze({ kind: "lazy_upgrade", matchRule: "identity_v2" }),
    Object.freeze({ kind: "create_new", matchRule: "domain_exact" }),
    Object.freeze({ kind: "conflict", matchRule: "identity_conflict" }),
    Object.freeze({
      inputHash: "fdec8431ae3ef26d21a04ca54ada98068f7b4402fc696d1e917b0b3cd802cfd0",
      conflictFingerprint:
        "a1becc5d8cefb096ea5abb746a5c121d73b14761112fa1552077f376609ebd03",
    }),
  ]),
});

function requireReceiptTopology() {
  assert.equal(container, expectedContainer);
  assert.equal(port, expectedPort);
}

function dockerPsql(sql) {
  requireReceiptTopology();
  const result = spawnSync(
    "docker",
    [
      "exec",
      "-i",
      container,
      "psql",
      "-U",
      "global",
      "-d",
      "postgres",
      "--no-psqlrc",
      "-X",
      "-qAt",
      "-v",
      "ON_ERROR_STOP=1",
    ],
    { encoding: "utf8", input: sql, maxBuffer: 1024 * 1024 },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

describe("Organization Identity TypeScript to SQL literal parity", () => {
  it("uses only the receipt-bound disposable PostgreSQL topology", () => {
    requireReceiptTopology();
    const inspection = spawnSync(
      "docker",
      [
        "inspect",
        "--format",
        "{{json .State.Running}}|{{json .NetworkSettings.Ports}}|{{json .Config.Image}}",
        container,
      ],
      { encoding: "utf8", maxBuffer: 1024 * 1024 },
    );
    assert.equal(inspection.status, 0, `${inspection.stdout}\n${inspection.stderr}`);
    const [running, ports, image] = inspection.stdout.trim().split("|");
    assert.equal(running, "true");
    assert.equal(ports, '{"5432/tcp":[{"HostIp":"127.0.0.1","HostPort":"55441"}]}');
    assert.equal(image, '"pgvector/pgvector:pg16"');
    assert.match(
      dockerPsql("SELECT current_database() || '|' || current_user;"),
      /^postgres\|global$/u,
    );
    assert.equal(
      spawnSync(
        "docker",
        ["image", "inspect", "--format", "{{range .RepoDigests}}{{println .}}{{end}}", "pgvector/pgvector:pg16"],
        { encoding: "utf8", maxBuffer: 1024 * 1024 },
      ).stdout.trim(),
      expectedImageDigest,
    );
  });

  it("requires the two-ID SQL command before exercising the frozen literal parity vectors", () => {
    // Once A3 supplies this catalog entry, the next assertions are an actual PostgreSQL call boundary:
    // the command receives only workspace/raw IDs and must derive authority, blocker, suppression,
    // planner ordering, hashes, and conflict receipts from database facts rather than caller JSON.
    assert.ok(PARITY_VECTORS.authority.length > 0);
    assert.ok(PARITY_VECTORS.blocker.length > 0);
    assert.ok(PARITY_VECTORS.suppression.length > 0);
    assert.ok(PARITY_VECTORS.planner.length > 0);
    const catalogResult = dockerPsql(
      `SELECT to_regprocedure('${resolverCommand}')::text;`,
    );
    assert.equal(catalogResult, resolverCommand);
  });
});
