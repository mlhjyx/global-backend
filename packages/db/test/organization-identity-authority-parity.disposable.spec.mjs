import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const receiptPath = process.env.TASK6B_A1_RECEIPT_PATH;
const receiptPathExpected =
  "/global/backend/.codex/worktrees/root-worktree-remote-closeout-plan/.superpowers/sdd/2026-08-30-organization-identity-command-expansion/task-A1-disposable-setup-receipt.md";
const receiptHash =
  "4596418fc39fc8b7ce8a6cd9b299e936f5e1e215512e4d1356ad5b95aeb9839c";
const topology = Object.freeze({
  container: "codex-task6b-identity-authority-pg-20260830-a",
  containerId: "9ea3ae5bc1c34a074452e32d8d75c02c57e1cf1a84857fbe6c210a961776b915",
  network: "codex-task6b-identity-authority-net-20260830-a",
  networkId: "14e022a6f17fd723013d2f73ba879927df097c2c3d383adee3381adda689153a",
  volume: "164e3d2bdb7eb4abd0c433ea69076572281db2acd95eb33b0e3d5c288a6fa1e1",
  image: "pgvector/pgvector@sha256:1d533553fefe4f12e5d80c7b80622ba0c382abb5758856f52983d8789179f0fb",
  labels: "{\"com.openai.codex.artifact\":\"identity-authority\",\"com.openai.codex.task\":\"organization-identity-command-expansion\"}",
});
const signature = Object.freeze({
  authority: "public.organization_identity_authority_from_raw_v1(text,jsonb)",
  blocker: "public.organization_identity_blocker_from_raw_v1(jsonb)",
  suppression: "public.organization_identity_canonical_suppression_value_v1(text,text)",
  planner: "public.organization_identity_plan_from_snapshot_v1(jsonb)",
  command: "public.resolve_organization_identity_for_raw_v1(text,text)",
});
const catalogIdentity = Object.freeze({
  [signature.authority]: "public|organization_identity_authority_from_raw_v1|text, jsonb",
  [signature.blocker]: "public|organization_identity_blocker_from_raw_v1|jsonb",
  [signature.suppression]: "public|organization_identity_canonical_suppression_value_v1|text, text",
  [signature.planner]: "public|organization_identity_plan_from_snapshot_v1|jsonb",
  [signature.command]: "public|resolve_organization_identity_for_raw_v1|text, text",
});

function docker(args, input = "") {
  const result = spawnSync("docker", args, { encoding: "utf8", input, maxBuffer: 4 * 1024 * 1024 });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}
function sql(statement, rejects) {
  const result = spawnSync("docker", ["exec", "-i", topology.container, "psql", "-U", "global", "-d", "postgres", "--no-psqlrc", "-X", "-qAt", "-v", "ON_ERROR_STOP=1"], { encoding: "utf8", input: statement, maxBuffer: 4 * 1024 * 1024 });
  const output = `${result.stdout}\n${result.stderr}`.trim();
  if (rejects) { assert.notEqual(result.status, 0, output); assert.match(output, rejects); return; }
  assert.equal(result.status, 0, output);
  return result.stdout.trim();
}
function exactHelper(vector) {
  const [schema, name, argumentsText] = catalogIdentity[vector.signature].split("|");
  assert.equal(
    sql(`SELECT coalesce((SELECT n.nspname||'|'||p.proname||'|'||pg_get_function_identity_arguments(p.oid) FROM pg_proc AS p JOIN pg_namespace AS n ON n.oid=p.pronamespace WHERE n.nspname='${schema}' AND p.proname='${name}' AND pg_get_function_identity_arguments(p.oid)='${argumentsText}'),'<ABSENT>');`),
    catalogIdentity[vector.signature],
    `${vector.name}: exact helper OID/namespace/name/identity arguments are absent`,
  );
}
function value(vector) {
  it(vector.name, () => {
    // Production mutation caught: vector.mutation.
    exactHelper(vector);
    assert.equal(sql(vector.call), vector.expected);
  });
}
function rejected(vector) {
  it(vector.name, () => {
    // Production mutation caught: vector.mutation.
    exactHelper(vector);
    sql(vector.call, vector.error);
  });
}
function receipt() {
  assert.equal(receiptPath, receiptPathExpected, "TASK6B_A1_RECEIPT_PATH must name the frozen A1 receipt");
  const content = readFileSync(receiptPath, "utf8");
  assert.equal(createHash("sha256").update(content).digest("hex"), receiptHash);
  for (const value of [topology.container, topology.containerId, topology.network, topology.networkId, topology.volume, topology.image]) assert.ok(content.includes(value));
  assert.ok(content.includes("com.openai.codex.artifact=identity-authority"));
  assert.ok(content.includes("com.openai.codex.task=organization-identity-command-expansion"));
}

const cases = Object.freeze({
  authority: Object.freeze([
    { name: "domain-only producer", mutation: "directory manufactures a registry identifier", signature: signature.authority, call: `SELECT (public.organization_identity_authority_from_raw_v1('directory','{"externalId":"directory:acme.example","name":"Acme GmbH","domain":"acme.example","country":"DE","attributes":{"source_kind":"directory","source_directory":"registry.example","detail_url":"https://registry.example/company/1","source_class":"industry_data"},"provenance":{"sourceUrl":"https://registry.example/companies/1","fetchedAt":"2026-08-25T12:00:00.000Z","contentHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","parserVersion":"registry/v1"}}'::jsonb)='[{"providerKey":"directory","scheme":"domain","jurisdiction":"GLOBAL","normalizedValue":"acme.example","validatorVersion":"domain-v1","normalizerVersion":"organization-identity-authority/v1","key":"domain:GLOBAL:acme.example"}]'::jsonb)::text;`, expected: "true" },
    { name: "registry-id literal authority", mutation: "registry punctuation/case reaches the persisted key", signature: signature.authority, call: `SELECT public.organization_identity_authority_from_raw_v1('registry','{"externalId":"company-1","name":"Acme GmbH","domain":"acme.example","country":"DE","attributes":{"products":["pump"],"employee_band":"50-100"},"provenance":{"sourceUrl":"https://registry.example/companies/1","fetchedAt":"2026-08-25T12:00:00.000Z","contentHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","parserVersion":"registry/v1"},"identifier":{"scheme":"registry-id","value":"de-12/34"}}'::jsonb)->1->>'key';`, expected: "registry-id:DE:DE1234" },
    { name: "valid LEI checksum", mutation: "LEI checksum gate is bypassed", signature: signature.authority, call: `SELECT public.organization_identity_authority_from_raw_v1('registry','{"externalId":"company-1","name":"Acme GmbH","domain":"acme.example","country":"DE","attributes":{"products":["pump"],"employee_band":"50-100"},"provenance":{"sourceUrl":"https://registry.example/companies/1","fetchedAt":"2026-08-25T12:00:00.000Z","contentHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","parserVersion":"registry/v1"},"identifier":{"scheme":"lei","value":"529900T8BM49AURSDO55"}}'::jsonb)->1->>'key';`, expected: "lei:GLOBAL:529900T8BM49AURSDO55" },
    { name: "TED suffix-only no-country", mutation: "TED suffix jurisdiction is discarded without country", signature: signature.authority, call: `SELECT public.organization_identity_authority_from_raw_v1('ted','{"externalId":"ted:1:0","name":"Acme GmbH","domain":"acme.example","attributes":{"ted":{"publication_number":"1","publication_date":"2026-08-25","notice_type":"award","winner_identifier":"de291499156"}},"license":"CC BY 4.0","provenance":{"sourceUrl":"https://ted.europa.eu/en/notice/-/detail/1","fetchedAt":"2026-08-25T12:00:00.000Z","contentHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","parserVersion":"registry/v1"},"identifier":{"scheme":"ted-natid:de","value":"de291499156"}}'::jsonb)->1->>'key';`, expected: "ted-natid:DE:DE291499156" },
    { name: "FDA one digit", mutation: "FDA lower bound is rejected", signature: signature.authority, call: `SELECT public.organization_identity_authority_from_raw_v1('openfda','{"externalId":"openfda:1","name":"Acme GmbH","domain":"acme.example","country":"DE","attributes":{"fda":{"registration_number":"1","product_codes":["LLZ"]},"products":["LLZ"]},"license":"CC0-1.0","provenance":{"sourceUrl":"https://api.fda.gov/device/registrationlisting.json","fetchedAt":"2026-08-25T12:00:00.000Z","contentHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","parserVersion":"registry/v1"},"identifier":{"scheme":"fda-reg","value":"1"}}'::jsonb)->1->>'key';`, expected: "fda-reg:US:1" },
    { name: "FDA thirty-two digits", mutation: "FDA upper bound is rejected", signature: signature.authority, call: `SELECT public.organization_identity_authority_from_raw_v1('openfda','{"externalId":"openfda:12345678901234567890123456789012","name":"Acme GmbH","domain":"acme.example","country":"DE","attributes":{"fda":{"registration_number":"12345678901234567890123456789012","product_codes":["LLZ"]},"products":["LLZ"]},"license":"CC0-1.0","provenance":{"sourceUrl":"https://api.fda.gov/device/registrationlisting.json","fetchedAt":"2026-08-25T12:00:00.000Z","contentHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","parserVersion":"registry/v1"},"identifier":{"scheme":"fda-reg","value":"12345678901234567890123456789012"}}'::jsonb)->1->>'key';`, expected: "fda-reg:US:12345678901234567890123456789012" },
  ]),
  authorityReject: Object.freeze([
    { name: "TED suffix-country conflict", mutation: "conflicting TED country is accepted", signature: signature.authority, call: `SELECT public.organization_identity_authority_from_raw_v1('ted','{"country":"FR","identifier":{"scheme":"ted-natid:de","value":"de291499156"}}'::jsonb);`, error: /IDENTITY_IDENTIFIER_INVALID/u },
    { name: "FDA thirty-three digits", mutation: "FDA upper numeric bound widens", signature: signature.authority, call: `SELECT public.organization_identity_authority_from_raw_v1('openfda','{"identifier":{"scheme":"fda-reg","value":"123456789012345678901234567890123"}}'::jsonb);`, error: /IDENTITY_IDENTIFIER_INVALID/u },
    { name: "TED exact eighty-byte input", mutation: "UTF-8 byte boundary rejects valid input", signature: signature.authority, call: `SELECT public.organization_identity_authority_from_raw_v1('ted','{"country":"DE","identifier":{"scheme":"ted-natid:de","value":"ÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄ"}}'::jsonb);`, error: /IDENTITY_IDENTIFIER_INVALID/u },
    { name: "TED eighty-one-byte input", mutation: "UTF-8 byte boundary accepts invalid input", signature: signature.authority, call: `SELECT public.organization_identity_authority_from_raw_v1('ted','{"country":"DE","identifier":{"scheme":"ted-natid:de","value":"ÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄA"}}'::jsonb);`, error: /IDENTITY_IDENTIFIER_INVALID/u },
    { name: "missing scheme", mutation: "missing scheme becomes authority", signature: signature.authority, call: `SELECT public.organization_identity_authority_from_raw_v1('registry','{"identifier":{"value":"DE1234"}}'::jsonb);`, error: /IDENTITY_IDENTIFIER_INVALID/u },
    { name: "extra field", mutation: "extra structured identifier field is ignored", signature: signature.authority, call: `SELECT public.organization_identity_authority_from_raw_v1('registry','{"identifier":{"scheme":"registry-id","value":"DE1234","extra":"x"}}'::jsonb);`, error: /IDENTITY_IDENTIFIER_INVALID/u },
    { name: "relabelled scheme", mutation: "identifier changes namespace", signature: signature.authority, call: `SELECT public.organization_identity_authority_from_raw_v1('registry','{"identifier":{"scheme":"ted-natid","value":"DE1234"}}'::jsonb);`, error: /IDENTITY_IDENTIFIER_NOT_AUTHORIZED/u },
    { name: "wrong provider validator jurisdiction or key", mutation: "authority provenance fields are forged", signature: signature.authority, call: `SELECT public.organization_identity_authority_from_raw_v1('directory','{"identifier":{"scheme":"registry-id","value":"DE1234","validatorVersion":"registry-id-v999","jurisdiction":"GLOBAL","key":"registry-id:GLOBAL:DE1234"}}'::jsonb);`, error: /IDENTITY_IDENTIFIER_NOT_AUTHORIZED/u },
  ]),
  blocker: Object.freeze([
    { name: "domain priority excludes provider ID", mutation: "provider identifier becomes a v2 fallback blocker", signature: signature.blocker, call: `SELECT (public.organization_identity_blocker_from_raw_v1('{"name":"Acme GmbH","domain":"www.acme.example","country":"DE","identifier":{"scheme":"registry-id","value":"DE1234"}}'::jsonb)='{"blockerKey":"d:acme.example","matchRule":"domain_exact"}'::jsonb)::text;`, expected: "true" },
    { name: "explicit country legal suffix unicode punctuation", mutation: "fallback normalization changes", signature: signature.blocker, call: `SELECT (public.organization_identity_blocker_from_raw_v1('{"name":"Äcme, S.A.","country":"DE"}'::jsonb)='{"blockerKey":"n:äcme sa:de","matchRule":"name_country"}'::jsonb)::text;`, expected: "true" },
    { name: "empty normalized name holds", mutation: "empty normalized name is matchable", signature: signature.blocker, call: `SELECT (public.organization_identity_blocker_from_raw_v1('{"name":" GmbH ","country":"DE"}'::jsonb)='{"kind":"HOLD","reason":"IDENTITY_BLOCKER_EMPTY_NORMALIZED_NAME"}'::jsonb)::text;`, expected: "true" },
  ]),
  suppression: Object.freeze([
    { name: "protocol www path trailing dot", mutation: "URL presentation bypasses stored value", signature: signature.suppression, call: `SELECT public.organization_identity_canonical_suppression_value_v1('domain',' HTTPS://WWW.Example.COM./directory ');`, expected: "example.com" },
    { name: "invalid IP and overlong fail closed", mutation: "invalid/IP/overlong domain becomes key", signature: signature.suppression, call: `SELECT coalesce(public.organization_identity_canonical_suppression_value_v1('domain','127.0.0.1'),'<NULL>');`, expected: "<NULL>" },
    { name: "NFC whitespace canonical company name", mutation: "Unicode write/read diverges", signature: signature.suppression, call: `SELECT public.organization_identity_canonical_suppression_value_v1('company_name','  Äcme	GmbH  ');`, expected: "äcme gmbh" },
    { name: "legacy noncanonical stored value fails closed", mutation: "legacy raw domain is considered a match", signature: signature.suppression, call: `SELECT coalesce(public.organization_identity_canonical_suppression_value_v1('domain','not a canonical domain'),'<NULL>');`, expected: "<NULL>" },
  ]),
  planner: Object.freeze([
    { name: "create new full snapshot and literal hash", mutation: "unbound authority loses identity_v2", signature: signature.planner, call: `SELECT public.organization_identity_plan_from_snapshot_v1('{"raw":{"rawRecordId":"11111111-1111-4111-8111-111111111111","providerKey":"registry","payloadHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","ingestVersion":"raw-source/v1"},"resolverVersion":"organization-identity-resolver/v1","blocker":{"blockerKey":"d:acme.example","matchRule":"domain_exact","legacyCandidateCompanyId":null},"authorityIdentifiers":[{"providerKey":"registry","scheme":"registry-id","jurisdiction":"DE","normalizedValue":"DE1234","validatorVersion":"registry-id-v1","normalizerVersion":"organization-identity-authority/v1","key":"registry-id:DE:DE1234"}],"existingBindings":[],"rootMappings":[]}'::jsonb)->>'inputHash';`, expected: "be8c1309ff19260a4b93dca3716d398535a5277067362c91ee01e368cc28aa94" },
    { name: "one-hop multiple root permutation with duplicate bindings", mutation: "SQL row order changes root/receipt", signature: signature.planner, call: `SELECT public.organization_identity_plan_from_snapshot_v1('{"raw":{"rawRecordId":"11111111-1111-4111-8111-111111111111","providerKey":"registry","payloadHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","ingestVersion":"raw-source/v1"},"resolverVersion":"organization-identity-resolver/v1","blocker":{"blockerKey":"d:acme.example","matchRule":"domain_exact","legacyCandidateCompanyId":null},"authorityIdentifiers":[{"providerKey":"registry","scheme":"registry-id","jurisdiction":"DE","normalizedValue":"DE1234","validatorVersion":"registry-id-v1","normalizerVersion":"organization-identity-authority/v1","key":"registry-id:DE:DE1234"},{"providerKey":"registry","scheme":"registry-id","jurisdiction":"DE","normalizedValue":"DE9999","validatorVersion":"registry-id-v1","normalizerVersion":"organization-identity-authority/v1","key":"registry-id:DE:DE9999"}],"existingBindings":[{"identifierKey":"registry-id:DE:DE9999","companyId":"33333333-3333-4333-8333-333333333333"},{"identifierKey":"registry-id:DE:DE1234","companyId":"22222222-2222-4222-8222-222222222222"},{"identifierKey":"registry-id:DE:DE9999","companyId":"33333333-3333-4333-8333-333333333333"}],"rootMappings":[{"sourceCompanyId":"33333333-3333-4333-8333-333333333333","rootCompanyId":"55555555-5555-4555-8555-555555555555"},{"sourceCompanyId":"22222222-2222-4222-8222-222222222222","rootCompanyId":"44444444-4444-4444-8444-444444444444"}]}'::jsonb)->>'conflictFingerprint';`, expected: "a1becc5d8cefb096ea5abb746a5c121d73b14761112fa1552077f376609ebd03" },
    { name: "alias chain rejects", mutation: "A-to-B-to-C mapping is followed", signature: signature.planner, call: `SELECT public.organization_identity_plan_from_snapshot_v1('{"raw":{"rawRecordId":"11111111-1111-4111-8111-111111111111","providerKey":"registry","payloadHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","ingestVersion":"raw-source/v1"},"resolverVersion":"organization-identity-resolver/v1","blocker":{"blockerKey":"d:acme.example","matchRule":"domain_exact","legacyCandidateCompanyId":null},"authorityIdentifiers":[],"existingBindings":[],"rootMappings":[{"sourceCompanyId":"22222222-2222-4222-8222-222222222222","rootCompanyId":"33333333-3333-4333-8333-333333333333"},{"sourceCompanyId":"33333333-3333-4333-8333-333333333333","rootCompanyId":"44444444-4444-4444-8444-444444444444"}]}'::jsonb);`, error: /IDENTITY_RESOLUTION_INPUT_INVALID/u },
  ]),
});

describe("Organization Identity literal TypeScript-SQL parity", () => {
  it("loads and verifies the frozen A1 receipt plus exact disposable topology", () => {
    receipt();
    assert.equal(docker(["inspect", "--format", "{{.Id}}|{{json .State.Running}}|{{json .NetworkSettings.Ports}}|{{json .Config.Labels}}|{{.Image}}", topology.container]), `${topology.containerId}|true|{"5432/tcp":[{"HostIp":"127.0.0.1","HostPort":"55441"}]}|${topology.labels}|sha256:1d533553fefe4f12e5d80c7b80622ba0c382abb5758856f52983d8789179f0fb`);
    assert.equal(docker(["network", "inspect", "--format", "{{.Id}}|{{.Driver}}|{{len .Containers}}|{{json .Labels}}", topology.network]), `${topology.networkId}|bridge|1|${topology.labels}`);
    const bridgeMembers = JSON.parse(docker(["network", "inspect", "--format", "{{json .Containers}}", topology.network]));
    assert.deepEqual(Object.keys(bridgeMembers), [topology.containerId]);
    assert.equal(bridgeMembers[topology.containerId].Name, topology.container);
    assert.equal(docker(["volume", "inspect", "--format", "{{.Name}}|{{.Driver}}|{{json .Labels}}", topology.volume]), `${topology.volume}|local|{"com.docker.volume.anonymous":""}`);
    const mounts = JSON.parse(docker(["inspect", "--format", "{{json .Mounts}}", topology.container]));
    assert.deepEqual(
      mounts.filter((mount) => mount.Name === topology.volume).map((mount) => ({ Destination: mount.Destination, RW: mount.RW })),
      [{ Destination: "/var/lib/postgresql/data", RW: true }],
    );
    assert.equal(docker(["image", "inspect", "--format", "{{range .RepoDigests}}{{println .}}{{end}}", "pgvector/pgvector:pg16"]), topology.image);
    assert.equal(sql("SELECT current_database() || '|' || current_user;"), "postgres|global");
  });
  describe("authority cases", () => { for (const vector of cases.authority) value(vector); for (const vector of cases.authorityReject) rejected(vector); });
  describe("blocker cases", () => { for (const vector of cases.blocker) value(vector); });
  describe("suppression cases", () => { for (const vector of cases.suppression) value(vector); });
  describe("planner cases", () => { for (const vector of cases.planner) "error" in vector ? rejected(vector) : value(vector); });
  it("two-ID command malformed text", () => {
    exactHelper({ name: "two-ID command", signature: signature.command });
    sql("SELECT public.resolve_organization_identity_for_raw_v1('not-a-uuid','also-not-a-uuid');", /IDENTITY_RESOLUTION_INPUT_INVALID/u);
  });
});
