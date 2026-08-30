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
  containerId:
    "9ea3ae5bc1c34a074452e32d8d75c02c57e1cf1a84857fbe6c210a961776b915",
  network: "codex-task6b-identity-authority-net-20260830-a",
  networkId: "14e022a6f17fd723013d2f73ba879927df097c2c3d383adee3381adda689153a",
  volume: "164e3d2bdb7eb4abd0c433ea69076572281db2acd95eb33b0e3d5c288a6fa1e1",
  image:
    "pgvector/pgvector@sha256:1d533553fefe4f12e5d80c7b80622ba0c382abb5758856f52983d8789179f0fb",
  labels:
    '{"com.openai.codex.artifact":"identity-authority","com.openai.codex.task":"organization-identity-command-expansion"}',
});
const signature = Object.freeze({
  authority: "public.organization_identity_authority_from_raw_v1(text,jsonb)",
  blocker: "public.organization_identity_blocker_from_raw_v1(jsonb)",
  suppression:
    "public.organization_identity_canonical_suppression_value_v1(text,text)",
  planner: "public.organization_identity_plan_from_snapshot_v1(jsonb)",
  command: "public.resolve_organization_identity_for_raw_v1(text,text)",
});
const catalogIdentity = Object.freeze({
  [signature.authority]:
    "public|organization_identity_authority_from_raw_v1|text, jsonb",
  [signature.blocker]: "public|organization_identity_blocker_from_raw_v1|jsonb",
  [signature.suppression]:
    "public|organization_identity_canonical_suppression_value_v1|text, text",
  [signature.planner]:
    "public|organization_identity_plan_from_snapshot_v1|jsonb",
  [signature.command]:
    "public|resolve_organization_identity_for_raw_v1|text, text",
});

function docker(args, input = "") {
  const result = spawnSync("docker", args, {
    encoding: "utf8",
    input,
    maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

function psql(statement) {
  return spawnSync(
    "docker",
    [
      "exec",
      "-i",
      topology.container,
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
    { encoding: "utf8", input: statement, maxBuffer: 4 * 1024 * 1024 },
  );
}

function sql(statement) {
  const result = psql(statement);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`.trim());
  return result.stdout.trim();
}

function exactMachineError(
  statement,
  expected,
  transactionPrefix = "",
  transactionSuffix = "",
) {
  const result = psql(`${transactionPrefix}
DO $task_a2_error_capture$
DECLARE
  captured_state text;
  captured_message text;
BEGIN
  BEGIN
    ${statement}
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'TASK_A2_EXPECTED_ERROR_NOT_RAISED';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS
      captured_state = RETURNED_SQLSTATE,
      captured_message = MESSAGE_TEXT;
    RAISE NOTICE 'TASK_A2_ERROR|%|%', captured_state, captured_message;
  END;
END
$task_a2_error_capture$;
${transactionSuffix}`);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`.trim());
  const notices = result.stderr
    .trim()
    .split("\n")
    .filter((line) => line.startsWith("NOTICE:  TASK_A2_ERROR|"));
  assert.deepEqual(notices, [`NOTICE:  TASK_A2_ERROR|${expected}`]);
}

function exactHelper(name, helperSignature) {
  const [schema, functionName, argumentsText] =
    catalogIdentity[helperSignature].split("|");
  assert.equal(
    sql(`SELECT coalesce((
      SELECT n.nspname||'|'||p.proname||'|'||pg_get_function_identity_arguments(p.oid)
      FROM pg_proc AS p
      JOIN pg_namespace AS n ON n.oid=p.pronamespace
      WHERE n.nspname='${schema}'
        AND p.proname='${functionName}'
        AND pg_get_function_identity_arguments(p.oid)='${argumentsText}'
    ),'<ABSENT>');`),
    catalogIdentity[helperSignature],
    `${name}: exact helper OID/namespace/name/identity arguments are absent`,
  );
}

function valueCase(vector) {
  it(vector.name, () => {
    exactHelper(vector.name, vector.signature);
    assert.equal(sql(vector.call), vector.expected);
  });
}

function errorCase(vector) {
  it(vector.name, () => {
    exactHelper(vector.name, vector.signature);
    exactMachineError(vector.statement, vector.expectedError);
  });
}

function receipt() {
  assert.equal(
    receiptPath,
    receiptPathExpected,
    "TASK6B_A1_RECEIPT_PATH must name the frozen A1 receipt",
  );
  const content = readFileSync(receiptPath, "utf8");
  assert.equal(createHash("sha256").update(content).digest("hex"), receiptHash);
  for (const value of [
    topology.container,
    topology.containerId,
    topology.network,
    topology.networkId,
    topology.volume,
    topology.image,
  ]) {
    assert.ok(content.includes(value));
  }
  assert.ok(content.includes("com.openai.codex.artifact=identity-authority"));
  assert.ok(
    content.includes(
      "com.openai.codex.task=organization-identity-command-expansion",
    ),
  );
}

const authorityCases = Object.freeze([
  {
    name: "directory remains domain-only",
    signature: signature.authority,
    call: `SELECT (public.organization_identity_authority_from_raw_v1('directory','{"externalId":"directory:acme.example","name":"Acme GmbH","domain":"acme.example","country":"DE","attributes":{"source_kind":"directory","source_directory":"registry.example","detail_url":"https://registry.example/company/1","source_class":"industry_data"},"provenance":{"sourceUrl":"https://registry.example/companies/1","fetchedAt":"2026-08-25T12:00:00.000Z","contentHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","parserVersion":"registry/v1"}}'::jsonb)='[{"providerKey":"directory","scheme":"domain","jurisdiction":"GLOBAL","normalizedValue":"acme.example","validatorVersion":"domain-v1","normalizerVersion":"organization-identity-authority/v1","key":"domain:GLOBAL:acme.example"}]'::jsonb)::text;`,
    expected: "true",
  },
  {
    name: "Wikidata remains domain-only",
    signature: signature.authority,
    call: `SELECT (public.organization_identity_authority_from_raw_v1('wikidata','{"externalId":"wikidata:Q1","name":"Acme GmbH","domain":"acme.example","country":"DE","attributes":{"wikidata_qid":"Q1","latitude":1,"longitude":2,"source_class":"company_registry"},"license":"CC0-1.0","provenance":{"sourceUrl":"https://www.wikidata.org/wiki/Q1","fetchedAt":"2026-08-25T12:00:00.000Z","contentHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","parserVersion":"registry/v1"}}'::jsonb)='[{"providerKey":"wikidata","scheme":"domain","jurisdiction":"GLOBAL","normalizedValue":"acme.example","validatorVersion":"domain-v1","normalizerVersion":"organization-identity-authority/v1","key":"domain:GLOBAL:acme.example"}]'::jsonb)::text;`,
    expected: "true",
  },
  {
    name: "OpenStreetMap remains domain-only",
    signature: signature.authority,
    call: `SELECT (public.organization_identity_authority_from_raw_v1('openstreetmap','{"externalId":"osm:node/1","name":"Acme GmbH","domain":"acme.example","country":"DE","attributes":{"osm_id":"node/1","latitude":52.5,"longitude":13.4,"source_class":"industry_data"},"license":"ODbL-1.0","provenance":{"sourceUrl":"https://www.openstreetmap.org/node/1","fetchedAt":"2026-08-25T12:00:00.000Z","contentHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","parserVersion":"registry/v1"}}'::jsonb)='[{"providerKey":"openstreetmap","scheme":"domain","jurisdiction":"GLOBAL","normalizedValue":"acme.example","validatorVersion":"domain-v1","normalizerVersion":"organization-identity-authority/v1","key":"domain:GLOBAL:acme.example"}]'::jsonb)::text;`,
    expected: "true",
  },
  {
    name: "trade fair remains domain-only",
    signature: signature.authority,
    call: `SELECT (public.organization_identity_authority_from_raw_v1('trade_fair','{"externalId":"fair-1:company-1","name":"Acme GmbH","domain":"acme.example","country":"DE","attributes":{"stand":"A42","products":["pump"],"source_fair":"fair-1","source_class":"industry_data"},"provenance":{"sourceUrl":"https://registry.example/companies/1","fetchedAt":"2026-08-25T12:00:00.000Z","contentHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","parserVersion":"registry/v1"}}'::jsonb)='[{"providerKey":"trade_fair","scheme":"domain","jurisdiction":"GLOBAL","normalizedValue":"acme.example","validatorVersion":"domain-v1","normalizerVersion":"organization-identity-authority/v1","key":"domain:GLOBAL:acme.example"}]'::jsonb)::text;`,
    expected: "true",
  },
  {
    name: "public web remains domain-only",
    signature: signature.authority,
    call: `SELECT (public.organization_identity_authority_from_raw_v1('public_web','{"externalId":"acme.example","name":"Acme GmbH","domain":"acme.example","country":"DE","attributes":{"products":["pump"],"keywords":["industrial"],"extraction_confidence":0.9,"extraction_evidence_digest":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","source_class":"public_intelligence"},"provenance":{"sourceUrl":"https://acme.example/company","fetchedAt":"2026-08-25T12:00:00.000Z","contentHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","parserVersion":"registry/v1"}}'::jsonb)='[{"providerKey":"public_web","scheme":"domain","jurisdiction":"GLOBAL","normalizedValue":"acme.example","validatorVersion":"domain-v1","normalizerVersion":"organization-identity-authority/v1","key":"domain:GLOBAL:acme.example"}]'::jsonb)::text;`,
    expected: "true",
  },
  {
    name: "registry identifier returns the complete literal authority",
    signature: signature.authority,
    call: `SELECT (public.organization_identity_authority_from_raw_v1('registry','{"externalId":"company-1","name":"Acme GmbH","domain":"acme.example","country":"DE","attributes":{"products":["pump"],"employee_band":"50-100"},"provenance":{"sourceUrl":"https://registry.example/companies/1","fetchedAt":"2026-08-25T12:00:00.000Z","contentHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","parserVersion":"registry/v1"},"identifier":{"scheme":"registry-id","value":"de-12/34"}}'::jsonb)='[{"providerKey":"registry","scheme":"domain","jurisdiction":"GLOBAL","normalizedValue":"acme.example","validatorVersion":"domain-v1","normalizerVersion":"organization-identity-authority/v1","key":"domain:GLOBAL:acme.example"},{"providerKey":"registry","scheme":"registry-id","jurisdiction":"DE","normalizedValue":"DE1234","validatorVersion":"registry-id-v1","normalizerVersion":"organization-identity-authority/v1","key":"registry-id:DE:DE1234"}]'::jsonb)::text;`,
    expected: "true",
  },
  {
    name: "checksum-valid LEI returns GLOBAL authority",
    signature: signature.authority,
    call: `SELECT (public.organization_identity_authority_from_raw_v1('registry','{"externalId":"company-1","name":"Acme GmbH","domain":"acme.example","country":"DE","attributes":{"products":["pump"],"employee_band":"50-100"},"provenance":{"sourceUrl":"https://registry.example/companies/1","fetchedAt":"2026-08-25T12:00:00.000Z","contentHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","parserVersion":"registry/v1"},"identifier":{"scheme":"lei","value":"529900T8BM49AURSDO55"}}'::jsonb)='[{"providerKey":"registry","scheme":"domain","jurisdiction":"GLOBAL","normalizedValue":"acme.example","validatorVersion":"domain-v1","normalizerVersion":"organization-identity-authority/v1","key":"domain:GLOBAL:acme.example"},{"providerKey":"registry","scheme":"lei","jurisdiction":"GLOBAL","normalizedValue":"529900T8BM49AURSDO55","validatorVersion":"lei-v1","normalizerVersion":"organization-identity-authority/v1","key":"lei:GLOBAL:529900T8BM49AURSDO55"}]'::jsonb)::text;`,
    expected: "true",
  },
  {
    name: "TED suffix supplies jurisdiction without country",
    signature: signature.authority,
    call: `SELECT (public.organization_identity_authority_from_raw_v1('ted','{"externalId":"ted:1:0","name":"Acme GmbH","domain":"acme.example","attributes":{"ted":{"publication_number":"1","publication_date":"2026-08-25","notice_type":"award","winner_identifier":"de291499156"}},"license":"CC BY 4.0","provenance":{"sourceUrl":"https://ted.europa.eu/en/notice/-/detail/1","fetchedAt":"2026-08-25T12:00:00.000Z","contentHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","parserVersion":"registry/v1"},"identifier":{"scheme":"ted-natid:de","value":"de291499156"}}'::jsonb)='[{"providerKey":"ted","scheme":"domain","jurisdiction":"GLOBAL","normalizedValue":"acme.example","validatorVersion":"domain-v1","normalizerVersion":"organization-identity-authority/v1","key":"domain:GLOBAL:acme.example"},{"providerKey":"ted","scheme":"ted-natid","jurisdiction":"DE","normalizedValue":"DE291499156","validatorVersion":"ted-natid-v1","normalizerVersion":"organization-identity-authority/v1","key":"ted-natid:DE:DE291499156"}]'::jsonb)::text;`,
    expected: "true",
  },
  {
    name: "FDA accepts its one-digit lower bound",
    signature: signature.authority,
    call: `SELECT (public.organization_identity_authority_from_raw_v1('openfda','{"externalId":"openfda:1","name":"Acme GmbH","domain":"acme.example","country":"DE","attributes":{"fda":{"registration_number":"1","product_codes":["LLZ"]},"products":["LLZ"]},"license":"CC0-1.0","provenance":{"sourceUrl":"https://api.fda.gov/device/registrationlisting.json","fetchedAt":"2026-08-25T12:00:00.000Z","contentHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","parserVersion":"registry/v1"},"identifier":{"scheme":"fda-reg","value":"1"}}'::jsonb)='[{"providerKey":"openfda","scheme":"domain","jurisdiction":"GLOBAL","normalizedValue":"acme.example","validatorVersion":"domain-v1","normalizerVersion":"organization-identity-authority/v1","key":"domain:GLOBAL:acme.example"},{"providerKey":"openfda","scheme":"fda-reg","jurisdiction":"US","normalizedValue":"1","validatorVersion":"fda-reg-v1","normalizerVersion":"organization-identity-authority/v1","key":"fda-reg:US:1"}]'::jsonb)::text;`,
    expected: "true",
  },
  {
    name: "FDA accepts its thirty-two-digit upper bound",
    signature: signature.authority,
    call: `SELECT (public.organization_identity_authority_from_raw_v1('openfda','{"externalId":"openfda:12345678901234567890123456789012","name":"Acme GmbH","domain":"acme.example","country":"DE","attributes":{"fda":{"registration_number":"12345678901234567890123456789012","product_codes":["LLZ"]},"products":["LLZ"]},"license":"CC0-1.0","provenance":{"sourceUrl":"https://api.fda.gov/device/registrationlisting.json","fetchedAt":"2026-08-25T12:00:00.000Z","contentHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","parserVersion":"registry/v1"},"identifier":{"scheme":"fda-reg","value":"12345678901234567890123456789012"}}'::jsonb)='[{"providerKey":"openfda","scheme":"domain","jurisdiction":"GLOBAL","normalizedValue":"acme.example","validatorVersion":"domain-v1","normalizerVersion":"organization-identity-authority/v1","key":"domain:GLOBAL:acme.example"},{"providerKey":"openfda","scheme":"fda-reg","jurisdiction":"US","normalizedValue":"12345678901234567890123456789012","validatorVersion":"fda-reg-v1","normalizerVersion":"organization-identity-authority/v1","key":"fda-reg:US:12345678901234567890123456789012"}]'::jsonb)::text;`,
    expected: "true",
  },
  {
    name: "TED accepts an eighty-byte identifier and returns full authority",
    signature: signature.authority,
    call: `SELECT (public.organization_identity_authority_from_raw_v1('ted','{"externalId":"ted:1:0","name":"Acme GmbH","domain":"acme.example","country":"DE","attributes":{"ted":{"publication_number":"1","publication_date":"2026-08-25","notice_type":"award","winner_identifier":"ÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄ"}},"license":"CC BY 4.0","provenance":{"sourceUrl":"https://ted.europa.eu/en/notice/-/detail/1","fetchedAt":"2026-08-25T12:00:00.000Z","contentHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","parserVersion":"registry/v1"},"identifier":{"scheme":"ted-natid:de","value":"ÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄ"}}'::jsonb)='[{"providerKey":"ted","scheme":"domain","jurisdiction":"GLOBAL","normalizedValue":"acme.example","validatorVersion":"domain-v1","normalizerVersion":"organization-identity-authority/v1","key":"domain:GLOBAL:acme.example"},{"providerKey":"ted","scheme":"ted-natid","jurisdiction":"DE","normalizedValue":"ÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄ","validatorVersion":"ted-natid-v1","normalizerVersion":"organization-identity-authority/v1","key":"ted-natid:DE:ÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄ"}]'::jsonb)::text;`,
    expected: "true",
  },
]);

const authorityErrorCases = Object.freeze([
  {
    name: "invalid LEI checksum is rejected exactly",
    signature: signature.authority,
    statement: `PERFORM public.organization_identity_authority_from_raw_v1('registry','{"externalId":"company-1","name":"Acme GmbH","domain":"acme.example","country":"DE","attributes":{"products":["pump"],"employee_band":"50-100"},"provenance":{"sourceUrl":"https://registry.example/companies/1","fetchedAt":"2026-08-25T12:00:00.000Z","contentHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","parserVersion":"registry/v1"},"identifier":{"scheme":"lei","value":"529900T8BM49AURSDO54"}}'::jsonb);`,
    expectedError: "P0001|IDENTITY_IDENTIFIER_INVALID",
  },
  {
    name: "TED suffix-country conflict is rejected exactly",
    signature: signature.authority,
    statement: `PERFORM public.organization_identity_authority_from_raw_v1('ted','{"externalId":"ted:1:0","name":"Acme GmbH","domain":"acme.example","country":"FR","attributes":{"ted":{"publication_number":"1","publication_date":"2026-08-25","notice_type":"award","winner_identifier":"de291499156"}},"license":"CC BY 4.0","provenance":{"sourceUrl":"https://ted.europa.eu/en/notice/-/detail/1","fetchedAt":"2026-08-25T12:00:00.000Z","contentHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","parserVersion":"registry/v1"},"identifier":{"scheme":"ted-natid:de","value":"de291499156"}}'::jsonb);`,
    expectedError: "P0001|IDENTITY_IDENTIFIER_INVALID",
  },
  {
    name: "FDA thirty-three-digit identifier is rejected exactly",
    signature: signature.authority,
    statement: `PERFORM public.organization_identity_authority_from_raw_v1('openfda','{"externalId":"openfda:123456789012345678901234567890123","name":"Acme GmbH","domain":"acme.example","country":"DE","attributes":{"fda":{"registration_number":"123456789012345678901234567890123","product_codes":["LLZ"]},"products":["LLZ"]},"license":"CC0-1.0","provenance":{"sourceUrl":"https://api.fda.gov/device/registrationlisting.json","fetchedAt":"2026-08-25T12:00:00.000Z","contentHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","parserVersion":"registry/v1"},"identifier":{"scheme":"fda-reg","value":"123456789012345678901234567890123"}}'::jsonb);`,
    expectedError: "P0001|IDENTITY_IDENTIFIER_INVALID",
  },
  {
    name: "otherwise-identical TED eighty-one-byte identifier is rejected exactly",
    signature: signature.authority,
    statement: `PERFORM public.organization_identity_authority_from_raw_v1('ted','{"externalId":"ted:1:0","name":"Acme GmbH","domain":"acme.example","country":"DE","attributes":{"ted":{"publication_number":"1","publication_date":"2026-08-25","notice_type":"award","winner_identifier":"ÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄA"}},"license":"CC BY 4.0","provenance":{"sourceUrl":"https://ted.europa.eu/en/notice/-/detail/1","fetchedAt":"2026-08-25T12:00:00.000Z","contentHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","parserVersion":"registry/v1"},"identifier":{"scheme":"ted-natid:de","value":"ÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄA"}}'::jsonb);`,
    expectedError: "P0001|IDENTITY_IDENTIFIER_INVALID",
  },
  {
    name: "missing identifier scheme is rejected exactly",
    signature: signature.authority,
    statement: `PERFORM public.organization_identity_authority_from_raw_v1('registry','{"externalId":"company-1","name":"Acme GmbH","domain":"acme.example","country":"DE","attributes":{"products":["pump"],"employee_band":"50-100"},"provenance":{"sourceUrl":"https://registry.example/companies/1","fetchedAt":"2026-08-25T12:00:00.000Z","contentHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","parserVersion":"registry/v1"},"identifier":{"value":"DE1234"}}'::jsonb);`,
    expectedError: "P0001|IDENTITY_IDENTIFIER_INVALID",
  },
  {
    name: "extra identifier field is rejected exactly",
    signature: signature.authority,
    statement: `PERFORM public.organization_identity_authority_from_raw_v1('registry','{"externalId":"company-1","name":"Acme GmbH","domain":"acme.example","country":"DE","attributes":{"products":["pump"],"employee_band":"50-100"},"provenance":{"sourceUrl":"https://registry.example/companies/1","fetchedAt":"2026-08-25T12:00:00.000Z","contentHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","parserVersion":"registry/v1"},"identifier":{"scheme":"registry-id","value":"DE1234","extra":"x"}}'::jsonb);`,
    expectedError: "P0001|IDENTITY_IDENTIFIER_INVALID",
  },
  {
    name: "relabelled identifier scheme is rejected exactly",
    signature: signature.authority,
    statement: `PERFORM public.organization_identity_authority_from_raw_v1('registry','{"externalId":"company-1","name":"Acme GmbH","domain":"acme.example","country":"DE","attributes":{"products":["pump"],"employee_band":"50-100"},"provenance":{"sourceUrl":"https://registry.example/companies/1","fetchedAt":"2026-08-25T12:00:00.000Z","contentHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","parserVersion":"registry/v1"},"identifier":{"scheme":"ted-natid:de","value":"DE1234"}}'::jsonb);`,
    expectedError: "P0001|IDENTITY_IDENTIFIER_NOT_AUTHORIZED",
  },
  {
    name: "wrong identifier provider is rejected exactly",
    signature: signature.authority,
    statement: `PERFORM public.organization_identity_authority_from_raw_v1('directory','{"externalId":"directory:acme.example","name":"Acme GmbH","domain":"acme.example","country":"DE","attributes":{"source_kind":"directory","source_directory":"registry.example","detail_url":"https://registry.example/company/1","source_class":"industry_data"},"provenance":{"sourceUrl":"https://registry.example/companies/1","fetchedAt":"2026-08-25T12:00:00.000Z","contentHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","parserVersion":"registry/v1"},"identifier":{"scheme":"registry-id","value":"DE1234"}}'::jsonb);`,
    expectedError: "P0001|IDENTITY_IDENTIFIER_NOT_AUTHORIZED",
  },
  {
    name: "wrong identifier validator version is rejected exactly",
    signature: signature.authority,
    statement: `PERFORM public.organization_identity_authority_from_raw_v1('registry','{"externalId":"company-1","name":"Acme GmbH","domain":"acme.example","country":"DE","attributes":{"products":["pump"],"employee_band":"50-100"},"provenance":{"sourceUrl":"https://registry.example/companies/1","fetchedAt":"2026-08-25T12:00:00.000Z","contentHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","parserVersion":"registry/v1"},"identifier":{"scheme":"registry-id","value":"DE1234","validatorVersion":"registry-id-v999"}}'::jsonb);`,
    expectedError: "P0001|IDENTITY_IDENTIFIER_INVALID",
  },
  {
    name: "wrong identifier jurisdiction is rejected exactly",
    signature: signature.authority,
    statement: `PERFORM public.organization_identity_authority_from_raw_v1('openfda','{"externalId":"openfda:1","name":"Acme GmbH","domain":"acme.example","country":"DE","attributes":{"fda":{"registration_number":"1","product_codes":["LLZ"]},"products":["LLZ"]},"license":"CC0-1.0","provenance":{"sourceUrl":"https://api.fda.gov/device/registrationlisting.json","fetchedAt":"2026-08-25T12:00:00.000Z","contentHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","parserVersion":"registry/v1"},"identifier":{"scheme":"fda-reg","value":"1","jurisdiction":"GLOBAL"}}'::jsonb);`,
    expectedError: "P0001|IDENTITY_IDENTIFIER_INVALID",
  },
  {
    name: "wrong identifier key is rejected exactly",
    signature: signature.authority,
    statement: `PERFORM public.organization_identity_authority_from_raw_v1('registry','{"externalId":"company-1","name":"Acme GmbH","domain":"acme.example","country":"DE","attributes":{"products":["pump"],"employee_band":"50-100"},"provenance":{"sourceUrl":"https://registry.example/companies/1","fetchedAt":"2026-08-25T12:00:00.000Z","contentHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","parserVersion":"registry/v1"},"identifier":{"scheme":"registry-id","value":"DE1234","key":"registry-id:DE:OTHER"}}'::jsonb);`,
    expectedError: "P0001|IDENTITY_IDENTIFIER_INVALID",
  },
]);

const blockerCases = Object.freeze([
  {
    name: "domain blocker has priority over the name",
    signature: signature.blocker,
    call: `SELECT (public.organization_identity_blocker_from_raw_v1('{"name":"Different GmbH","domain":"www.acme.example","country":"DE"}'::jsonb)='{"blockerKey":"d:acme.example","matchRule":"domain_exact"}'::jsonb)::text;`,
    expected: "true",
  },
  {
    name: "legal suffix removal is isolated",
    signature: signature.blocker,
    call: `SELECT (public.organization_identity_blocker_from_raw_v1('{"name":"Acme GmbH","country":"DE"}'::jsonb)='{"blockerKey":"n:acme:de","matchRule":"name_country"}'::jsonb)::text;`,
    expected: "true",
  },
  {
    name: "Unicode company-name normalization is isolated",
    signature: signature.blocker,
    call: `SELECT (public.organization_identity_blocker_from_raw_v1('{"name":"Äcme Pumps","country":"DE"}'::jsonb)='{"blockerKey":"n:äcme pumps:de","matchRule":"name_country"}'::jsonb)::text;`,
    expected: "true",
  },
  {
    name: "punctuation normalization is isolated",
    signature: signature.blocker,
    call: `SELECT (public.organization_identity_blocker_from_raw_v1('{"name":"Acme, Pump-Works","country":"DE"}'::jsonb)='{"blockerKey":"n:acme pump works:de","matchRule":"name_country"}'::jsonb)::text;`,
    expected: "true",
  },
  {
    name: "country case normalization is isolated",
    signature: signature.blocker,
    call: `SELECT (public.organization_identity_blocker_from_raw_v1('{"name":"Acme Pumps","country":"DE"}'::jsonb)='{"blockerKey":"n:acme pumps:de","matchRule":"name_country"}'::jsonb)::text;`,
    expected: "true",
  },
  {
    name: "empty normalized company name returns a literal HOLD",
    signature: signature.blocker,
    call: `SELECT (public.organization_identity_blocker_from_raw_v1('{"name":" GmbH ","country":"DE"}'::jsonb)='{"kind":"HOLD","reason":"IDENTITY_BLOCKER_EMPTY_NORMALIZED_NAME"}'::jsonb)::text;`,
    expected: "true",
  },
  {
    name: "provider identifier is excluded from the v2 fallback blocker",
    signature: signature.blocker,
    call: `SELECT (public.organization_identity_blocker_from_raw_v1('{"name":"Acme GmbH","country":"DE","identifier":{"scheme":"registry-id","value":"DE1234"}}'::jsonb)='{"blockerKey":"n:acme:de","matchRule":"name_country"}'::jsonb)::text;`,
    expected: "true",
  },
]);

const suppressionCases = Object.freeze([
  {
    name: "canonical ASCII domain remains unchanged",
    signature: signature.suppression,
    call: `SELECT public.organization_identity_canonical_suppression_value_v1('domain','example.com');`,
    expected: "example.com",
  },
  {
    name: "HTTPS protocol presentation is removed",
    signature: signature.suppression,
    call: `SELECT public.organization_identity_canonical_suppression_value_v1('domain','HTTPS://Example.COM');`,
    expected: "example.com",
  },
  {
    name: "www presentation is removed",
    signature: signature.suppression,
    call: `SELECT public.organization_identity_canonical_suppression_value_v1('domain','www.Example.COM');`,
    expected: "example.com",
  },
  {
    name: "path presentation is removed",
    signature: signature.suppression,
    call: `SELECT public.organization_identity_canonical_suppression_value_v1('domain','Example.COM/directory');`,
    expected: "example.com",
  },
  {
    name: "trailing domain dot is removed",
    signature: signature.suppression,
    call: `SELECT public.organization_identity_canonical_suppression_value_v1('domain','Example.COM.');`,
    expected: "example.com",
  },
  {
    name: "malformed domain fails closed",
    signature: signature.suppression,
    call: `SELECT coalesce(public.organization_identity_canonical_suppression_value_v1('domain','999.999.999.999'),'<NULL>');`,
    expected: "<NULL>",
  },
  {
    name: "IPv4 address fails closed",
    signature: signature.suppression,
    call: `SELECT coalesce(public.organization_identity_canonical_suppression_value_v1('domain','127.0.0.1'),'<NULL>');`,
    expected: "<NULL>",
  },
  {
    name: "IPv6 address fails closed",
    signature: signature.suppression,
    call: `SELECT coalesce(public.organization_identity_canonical_suppression_value_v1('domain','https://[2001:db8::1]/'),'<NULL>');`,
    expected: "<NULL>",
  },
  {
    name: "overlong domain label fails closed",
    signature: signature.suppression,
    call: `SELECT coalesce(public.organization_identity_canonical_suppression_value_v1('domain','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.example.com'),'<NULL>');`,
    expected: "<NULL>",
  },
  {
    name: "decomposed company name is normalized to NFC",
    signature: signature.suppression,
    call: `SELECT public.organization_identity_canonical_suppression_value_v1('company_name','Äcme GmbH');`,
    expected: "äcme gmbh",
  },
  {
    name: "company-name whitespace is canonicalized",
    signature: signature.suppression,
    call: `SELECT public.organization_identity_canonical_suppression_value_v1('company_name','  ACME\t GmbH  ');`,
    expected: "acme gmbh",
  },
  {
    name: "stored domain presentation matches the canonical candidate",
    signature: signature.suppression,
    call: `WITH stored(value) AS (VALUES (' HTTPS://WWW.EXAMPLE.COM/path ')), candidate(value) AS (VALUES ('example.com')) SELECT EXISTS (SELECT 1 FROM stored CROSS JOIN candidate WHERE public.organization_identity_canonical_suppression_value_v1('domain',stored.value)=public.organization_identity_canonical_suppression_value_v1('domain',candidate.value))::text;`,
    expected: "true",
  },
  {
    name: "stored company-name presentation matches the canonical candidate",
    signature: signature.suppression,
    call: `WITH stored(value) AS (VALUES ('  ACME   GmbH ')), candidate(value) AS (VALUES ('Acme GmbH')) SELECT EXISTS (SELECT 1 FROM stored CROSS JOIN candidate WHERE public.organization_identity_canonical_suppression_value_v1('company_name',stored.value)=public.organization_identity_canonical_suppression_value_v1('company_name',candidate.value))::text;`,
    expected: "true",
  },
  {
    name: "legacy noncanonical stored company domain never matches",
    signature: signature.suppression,
    call: `WITH stored(value) AS (VALUES ('not a canonical domain')), candidate(value) AS (VALUES ('example.com')) SELECT EXISTS (SELECT 1 FROM stored CROSS JOIN candidate WHERE public.organization_identity_canonical_suppression_value_v1('domain',stored.value) IS NOT NULL AND public.organization_identity_canonical_suppression_value_v1('domain',stored.value)=public.organization_identity_canonical_suppression_value_v1('domain',candidate.value))::text;`,
    expected: "false",
  },
]);

const plannerCases = Object.freeze([
  {
    name: "create-new plan returns its complete literal result",
    signature: signature.planner,
    call: `SELECT (public.organization_identity_plan_from_snapshot_v1('{"raw":{"rawRecordId":"11111111-1111-4111-8111-111111111111","providerKey":"registry","payloadHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","ingestVersion":"raw-source/v1"},"resolverVersion":"organization-identity-resolver/v1","blocker":{"blockerKey":"d:acme.example","matchRule":"domain_exact","legacyCandidateCompanyId":null},"authorityIdentifiers":[{"providerKey":"registry","scheme":"registry-id","jurisdiction":"DE","normalizedValue":"DE1234","validatorVersion":"registry-id-v1","normalizerVersion":"organization-identity-authority/v1","key":"registry-id:DE:DE1234"}],"existingBindings":[],"rootMappings":[]}'::jsonb)='{"kind":"create_new","matchRule":"identity_v2","identifiers":[{"providerKey":"registry","scheme":"registry-id","jurisdiction":"DE","normalizedValue":"DE1234","validatorVersion":"registry-id-v1","normalizerVersion":"organization-identity-authority/v1","key":"registry-id:DE:DE1234"}],"inputHash":"be8c1309ff19260a4b93dca3716d398535a5277067362c91ee01e368cc28aa94"}'::jsonb)::text;`,
    expected: "true",
  },
  {
    name: "lazy-upgrade plan returns its complete literal result",
    signature: signature.planner,
    call: `SELECT (public.organization_identity_plan_from_snapshot_v1('{"raw":{"rawRecordId":"11111111-1111-4111-8111-111111111111","providerKey":"registry","payloadHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","ingestVersion":"raw-source/v1"},"resolverVersion":"organization-identity-resolver/v1","blocker":{"blockerKey":"d:acme.example","matchRule":"domain_exact","legacyCandidateCompanyId":"22222222-2222-4222-8222-222222222222"},"authorityIdentifiers":[],"existingBindings":[],"rootMappings":[]}'::jsonb)='{"kind":"lazy_upgrade","companyId":"22222222-2222-4222-8222-222222222222","matchRule":"domain_exact","identifiers":[],"inputHash":"6952f0036ae5d335e55f536735844bc3e4a73ad3a138c60be5d5efb0db0a8a29"}'::jsonb)::text;`,
    expected: "true",
  },
  {
    name: "direct bind-existing plan returns its complete literal result",
    signature: signature.planner,
    call: `SELECT (public.organization_identity_plan_from_snapshot_v1('{"raw":{"rawRecordId":"11111111-1111-4111-8111-111111111111","providerKey":"registry","payloadHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","ingestVersion":"raw-source/v1"},"resolverVersion":"organization-identity-resolver/v1","blocker":{"blockerKey":"d:acme.example","matchRule":"domain_exact","legacyCandidateCompanyId":null},"authorityIdentifiers":[{"providerKey":"registry","scheme":"registry-id","jurisdiction":"DE","normalizedValue":"DE1234","validatorVersion":"registry-id-v1","normalizerVersion":"organization-identity-authority/v1","key":"registry-id:DE:DE1234"}],"existingBindings":[{"identifierKey":"registry-id:DE:DE1234","companyId":"22222222-2222-4222-8222-222222222222"}],"rootMappings":[]}'::jsonb)='{"kind":"bind_existing","companyId":"22222222-2222-4222-8222-222222222222","matchRule":"identity_v2","identifiers":[{"providerKey":"registry","scheme":"registry-id","jurisdiction":"DE","normalizedValue":"DE1234","validatorVersion":"registry-id-v1","normalizerVersion":"organization-identity-authority/v1","key":"registry-id:DE:DE1234"}],"inputHash":"36b672e096bb2ec860787ea225e1a728da1b9449d16708fce577ae9e79ea2006"}'::jsonb)::text;`,
    expected: "true",
  },
  {
    name: "one-hop bind-existing plan returns the mapped root and complete result",
    signature: signature.planner,
    call: `SELECT (public.organization_identity_plan_from_snapshot_v1('{"raw":{"rawRecordId":"11111111-1111-4111-8111-111111111111","providerKey":"registry","payloadHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","ingestVersion":"raw-source/v1"},"resolverVersion":"organization-identity-resolver/v1","blocker":{"blockerKey":"d:acme.example","matchRule":"domain_exact","legacyCandidateCompanyId":null},"authorityIdentifiers":[{"providerKey":"registry","scheme":"registry-id","jurisdiction":"DE","normalizedValue":"DE1234","validatorVersion":"registry-id-v1","normalizerVersion":"organization-identity-authority/v1","key":"registry-id:DE:DE1234"}],"existingBindings":[{"identifierKey":"registry-id:DE:DE1234","companyId":"22222222-2222-4222-8222-222222222222"}],"rootMappings":[{"sourceCompanyId":"22222222-2222-4222-8222-222222222222","rootCompanyId":"44444444-4444-4444-8444-444444444444"}]}'::jsonb)='{"kind":"bind_existing","companyId":"44444444-4444-4444-8444-444444444444","matchRule":"identity_v2","identifiers":[{"providerKey":"registry","scheme":"registry-id","jurisdiction":"DE","normalizedValue":"DE1234","validatorVersion":"registry-id-v1","normalizerVersion":"organization-identity-authority/v1","key":"registry-id:DE:DE1234"}],"inputHash":"d8abe41e3201d05746f69cb4e444826451b9d8ff14d8e64eb8ea1077c7967b67"}'::jsonb)::text;`,
    expected: "true",
  },
  {
    name: "blocker-disagreement plan returns its complete literal conflict",
    signature: signature.planner,
    call: `SELECT (public.organization_identity_plan_from_snapshot_v1('{"raw":{"rawRecordId":"11111111-1111-4111-8111-111111111111","providerKey":"registry","payloadHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","ingestVersion":"raw-source/v1"},"resolverVersion":"organization-identity-resolver/v1","blocker":{"blockerKey":"d:acme.example","matchRule":"domain_exact","legacyCandidateCompanyId":"33333333-3333-4333-8333-333333333333"},"authorityIdentifiers":[{"providerKey":"registry","scheme":"registry-id","jurisdiction":"DE","normalizedValue":"DE1234","validatorVersion":"registry-id-v1","normalizerVersion":"organization-identity-authority/v1","key":"registry-id:DE:DE1234"}],"existingBindings":[{"identifierKey":"registry-id:DE:DE1234","companyId":"22222222-2222-4222-8222-222222222222"}],"rootMappings":[]}'::jsonb)='{"kind":"conflict","matchRule":"identity_conflict","conflictType":"blocking_key_disagreement","companyIds":["22222222-2222-4222-8222-222222222222","33333333-3333-4333-8333-333333333333"],"identifierKeys":["registry-id:DE:DE1234"],"inputHash":"ebb725ebe12e75778bbee94b60ab062587734263da02842050c4e85fce7136f0","conflictFingerprint":"3d875a6549bdb9afe1dae5d9f3127554e194a1417a7c272ef79498dea303040d"}'::jsonb)::text;`,
    expected: "true",
  },
  {
    name: "new Raw occurrence changes only the literal input hash of the disagreement",
    signature: signature.planner,
    call: `SELECT (public.organization_identity_plan_from_snapshot_v1('{"raw":{"rawRecordId":"55555555-5555-4555-8555-555555555555","providerKey":"registry","payloadHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","ingestVersion":"raw-source/v1"},"resolverVersion":"organization-identity-resolver/v1","blocker":{"blockerKey":"d:acme.example","matchRule":"domain_exact","legacyCandidateCompanyId":"33333333-3333-4333-8333-333333333333"},"authorityIdentifiers":[{"providerKey":"registry","scheme":"registry-id","jurisdiction":"DE","normalizedValue":"DE1234","validatorVersion":"registry-id-v1","normalizerVersion":"organization-identity-authority/v1","key":"registry-id:DE:DE1234"}],"existingBindings":[{"identifierKey":"registry-id:DE:DE1234","companyId":"22222222-2222-4222-8222-222222222222"}],"rootMappings":[]}'::jsonb)='{"kind":"conflict","matchRule":"identity_conflict","conflictType":"blocking_key_disagreement","companyIds":["22222222-2222-4222-8222-222222222222","33333333-3333-4333-8333-333333333333"],"identifierKeys":["registry-id:DE:DE1234"],"inputHash":"837d6648633c20db5001be083b831d433b1c54bacd5a67c8cf159f641cc8baa1","conflictFingerprint":"3d875a6549bdb9afe1dae5d9f3127554e194a1417a7c272ef79498dea303040d"}'::jsonb)::text;`,
    expected: "true",
  },
  {
    name: "random duplicate authority and binding order with two one-hop roots returns the full literal conflict",
    signature: signature.planner,
    call: `SELECT (public.organization_identity_plan_from_snapshot_v1('{"raw":{"rawRecordId":"11111111-1111-4111-8111-111111111111","providerKey":"registry","payloadHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","ingestVersion":"raw-source/v1"},"resolverVersion":"organization-identity-resolver/v1","blocker":{"blockerKey":"d:acme.example","matchRule":"domain_exact","legacyCandidateCompanyId":null},"authorityIdentifiers":[{"providerKey":"registry","scheme":"registry-id","jurisdiction":"DE","normalizedValue":"DE9999","validatorVersion":"registry-id-v1","normalizerVersion":"organization-identity-authority/v1","key":"registry-id:DE:DE9999"},{"providerKey":"registry","scheme":"registry-id","jurisdiction":"DE","normalizedValue":"DE9999","validatorVersion":"registry-id-v1","normalizerVersion":"organization-identity-authority/v1","key":"registry-id:DE:DE9999"},{"providerKey":"registry","scheme":"registry-id","jurisdiction":"DE","normalizedValue":"DE1234","validatorVersion":"registry-id-v1","normalizerVersion":"organization-identity-authority/v1","key":"registry-id:DE:DE1234"}],"existingBindings":[{"identifierKey":"registry-id:DE:DE9999","companyId":"33333333-3333-4333-8333-333333333333"},{"identifierKey":"registry-id:DE:DE9999","companyId":"33333333-3333-4333-8333-333333333333"},{"identifierKey":"registry-id:DE:DE1234","companyId":"22222222-2222-4222-8222-222222222222"}],"rootMappings":[{"sourceCompanyId":"33333333-3333-4333-8333-333333333333","rootCompanyId":"55555555-5555-4555-8555-555555555555"},{"sourceCompanyId":"22222222-2222-4222-8222-222222222222","rootCompanyId":"44444444-4444-4444-8444-444444444444"}]}'::jsonb)='{"kind":"conflict","matchRule":"identity_conflict","conflictType":"identifier_split","companyIds":["44444444-4444-4444-8444-444444444444","55555555-5555-4555-8555-555555555555"],"identifierKeys":["registry-id:DE:DE1234","registry-id:DE:DE9999"],"inputHash":"0e586afcfa62c7679a530d1d9439fc58f072117b3933a43e75701b293294bad2","conflictFingerprint":"c104982be03334fde490c1345c27888aaa72595b1d8ae97665c129ee2ccbc6bc"}'::jsonb)::text;`,
    expected: "true",
  },
  {
    name: "reversed duplicate authority binding and root order returns the identical full literal conflict",
    signature: signature.planner,
    call: `SELECT (public.organization_identity_plan_from_snapshot_v1('{"raw":{"rawRecordId":"11111111-1111-4111-8111-111111111111","providerKey":"registry","payloadHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","ingestVersion":"raw-source/v1"},"resolverVersion":"organization-identity-resolver/v1","blocker":{"blockerKey":"d:acme.example","matchRule":"domain_exact","legacyCandidateCompanyId":null},"authorityIdentifiers":[{"providerKey":"registry","scheme":"registry-id","jurisdiction":"DE","normalizedValue":"DE1234","validatorVersion":"registry-id-v1","normalizerVersion":"organization-identity-authority/v1","key":"registry-id:DE:DE1234"},{"providerKey":"registry","scheme":"registry-id","jurisdiction":"DE","normalizedValue":"DE9999","validatorVersion":"registry-id-v1","normalizerVersion":"organization-identity-authority/v1","key":"registry-id:DE:DE9999"},{"providerKey":"registry","scheme":"registry-id","jurisdiction":"DE","normalizedValue":"DE9999","validatorVersion":"registry-id-v1","normalizerVersion":"organization-identity-authority/v1","key":"registry-id:DE:DE9999"}],"existingBindings":[{"identifierKey":"registry-id:DE:DE1234","companyId":"22222222-2222-4222-8222-222222222222"},{"identifierKey":"registry-id:DE:DE9999","companyId":"33333333-3333-4333-8333-333333333333"},{"identifierKey":"registry-id:DE:DE9999","companyId":"33333333-3333-4333-8333-333333333333"}],"rootMappings":[{"sourceCompanyId":"22222222-2222-4222-8222-222222222222","rootCompanyId":"44444444-4444-4444-8444-444444444444"},{"sourceCompanyId":"33333333-3333-4333-8333-333333333333","rootCompanyId":"55555555-5555-4555-8555-555555555555"}]}'::jsonb)='{"kind":"conflict","matchRule":"identity_conflict","conflictType":"identifier_split","companyIds":["44444444-4444-4444-8444-444444444444","55555555-5555-4555-8555-555555555555"],"identifierKeys":["registry-id:DE:DE1234","registry-id:DE:DE9999"],"inputHash":"0e586afcfa62c7679a530d1d9439fc58f072117b3933a43e75701b293294bad2","conflictFingerprint":"c104982be03334fde490c1345c27888aaa72595b1d8ae97665c129ee2ccbc6bc"}'::jsonb)::text;`,
    expected: "true",
  },
]);

const plannerErrorCases = Object.freeze([
  {
    name: "alias chain is rejected with the exact planner code",
    signature: signature.planner,
    statement: `PERFORM public.organization_identity_plan_from_snapshot_v1('{"raw":{"rawRecordId":"11111111-1111-4111-8111-111111111111","providerKey":"registry","payloadHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","ingestVersion":"raw-source/v1"},"resolverVersion":"organization-identity-resolver/v1","blocker":{"blockerKey":"d:acme.example","matchRule":"domain_exact","legacyCandidateCompanyId":null},"authorityIdentifiers":[],"existingBindings":[],"rootMappings":[{"sourceCompanyId":"22222222-2222-4222-8222-222222222222","rootCompanyId":"33333333-3333-4333-8333-333333333333"},{"sourceCompanyId":"33333333-3333-4333-8333-333333333333","rootCompanyId":"44444444-4444-4444-8444-444444444444"}]}'::jsonb);`,
    expectedError: "P0001|IDENTITY_RESOLUTION_INPUT_INVALID",
  },
]);

describe("Organization Identity literal TypeScript-SQL parity", () => {
  it("loads and verifies the frozen A1 receipt plus exact disposable topology", () => {
    receipt();
    assert.equal(
      docker([
        "inspect",
        "--format",
        "{{.Id}}|{{json .State.Running}}|{{json .NetworkSettings.Ports}}|{{json .Config.Labels}}|{{.Image}}",
        topology.container,
      ]),
      `${topology.containerId}|true|{"5432/tcp":[{"HostIp":"127.0.0.1","HostPort":"55441"}]}|${topology.labels}|sha256:1d533553fefe4f12e5d80c7b80622ba0c382abb5758856f52983d8789179f0fb`,
    );
    assert.equal(
      docker([
        "network",
        "inspect",
        "--format",
        "{{.Id}}|{{.Driver}}|{{len .Containers}}|{{json .Labels}}",
        topology.network,
      ]),
      `${topology.networkId}|bridge|1|${topology.labels}`,
    );
    const bridgeMembers = JSON.parse(
      docker([
        "network",
        "inspect",
        "--format",
        "{{json .Containers}}",
        topology.network,
      ]),
    );
    assert.deepEqual(Object.keys(bridgeMembers), [topology.containerId]);
    assert.equal(bridgeMembers[topology.containerId].Name, topology.container);
    assert.equal(
      docker([
        "volume",
        "inspect",
        "--format",
        "{{.Name}}|{{.Driver}}|{{json .Labels}}",
        topology.volume,
      ]),
      `${topology.volume}|local|{"com.docker.volume.anonymous":""}`,
    );
    const mounts = JSON.parse(
      docker(["inspect", "--format", "{{json .Mounts}}", topology.container]),
    );
    assert.deepEqual(
      mounts
        .filter((mount) => mount.Name === topology.volume)
        .map((mount) => ({ Destination: mount.Destination, RW: mount.RW })),
      [{ Destination: "/var/lib/postgresql/data", RW: true }],
    );
    assert.equal(
      docker([
        "image",
        "inspect",
        "--format",
        "{{range .RepoDigests}}{{println .}}{{end}}",
        "pgvector/pgvector:pg16",
      ]),
      topology.image,
    );
    assert.equal(
      sql("SELECT current_database() || '|' || current_user;"),
      "postgres|global",
    );
  });

  describe("authority matrix", () => {
    for (const vector of authorityCases) valueCase(vector);
    for (const vector of authorityErrorCases) errorCase(vector);
  });

  describe("blocker matrix", () => {
    for (const vector of blockerCases) valueCase(vector);
  });

  describe("suppression matrix", () => {
    for (const vector of suppressionCases) valueCase(vector);
  });

  describe("planner matrix", () => {
    for (const vector of plannerCases) valueCase(vector);
    for (const vector of plannerErrorCases) errorCase(vector);
  });

  describe("two-ID command matrix", () => {
    it("persists the exact registry-bound result from transaction-arranged workspace and Raw facts", () => {
      exactHelper("valid two-ID command", signature.command);
      assert.equal(
        sql(`BEGIN;
          INSERT INTO workspace(id,name,updated_at)
          VALUES ('71000000-0000-4000-8000-000000000001','Task A2 command',now());
          INSERT INTO canonical_company(id,workspace_id,name,domain,country,status,dedupe_key,version,created_at,updated_at)
          VALUES ('73000000-0000-4000-8000-000000000001','71000000-0000-4000-8000-000000000001','Bound Root','bound-root.example','DE','NEW','d:bound-root.example',1,now(),now());
          INSERT INTO raw_source_record(id,workspace_id,provider_key,source_class,payload,source_url,fetched_at,content_hash,parser_version,ingest_key,payload_hash,payload_bytes,ingest_version,ingest_status,retention_days,expires_at,source_policy_snapshot,created_at)
          VALUES ('72000000-0000-4000-8000-000000000001','71000000-0000-4000-8000-000000000001','registry','company_registry','{"externalId":"company-1","name":"Acme GmbH","domain":"a2-valid.example","country":"DE","attributes":{"products":["pump"],"employee_band":"50-100"},"provenance":{"sourceUrl":"https://registry.example/companies/1","fetchedAt":"2026-08-25T12:00:00.000Z","contentHash":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","parserVersion":"registry/v1"},"identifier":{"scheme":"registry-id","value":"de-12/34"}}'::jsonb,'https://registry.example/companies/1',now(),'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb','registry/v1','task-a2:valid','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',1,'raw-source/v2','ACCEPTED',30,now()+interval '30 days','{}'::jsonb,now());
          INSERT INTO organization_identifier(workspace_id,company_id,scheme,jurisdiction,normalized_value,authority_provider_key,raw_record_id,confidence,normalizer_version,validator_version,provenance,status)
          VALUES ('71000000-0000-4000-8000-000000000001','73000000-0000-4000-8000-000000000001','registry-id','DE','DE1234','registry','72000000-0000-4000-8000-000000000001',1,'organization-identity-authority/v1','registry-id-v1','{"schemaVersion":"organization-identifier-provenance/v1","rawRecordId":"72000000-0000-4000-8000-000000000001","providerKey":"registry"}'::jsonb,'ACTIVE');
          SET SESSION AUTHORIZATION app_user;
          SET LOCAL app.current_workspace_id = '71000000-0000-4000-8000-000000000001';
          SELECT to_jsonb(result)::text AS command_result
          FROM public.resolve_organization_identity_for_raw_v1('71000000-0000-4000-8000-000000000001','72000000-0000-4000-8000-000000000001') AS result
          \\gset task_a2_registry_
          WITH command_result AS (
            SELECT :'task_a2_registry_command_result'::jsonb AS value
          ), link_readback AS (
            SELECT
              count(*)::integer AS row_count,
              coalesce(
                jsonb_agg(
                  jsonb_build_object(
                    'workspace_id', workspace_id,
                    'raw_record_id', raw_record_id,
                    'canonical_type', canonical_type,
                    'canonical_id', canonical_id,
                    'match_rule', match_rule,
                    'confidence', confidence,
                    'status', status,
                    'resolver_version', resolver_version,
                    'input_hash', input_hash,
                    'conflict_id', conflict_id
                  ) ORDER BY canonical_id
                ),
                '[]'::jsonb
              ) AS rows
            FROM identity_link
            WHERE workspace_id='71000000-0000-4000-8000-000000000001'
              AND raw_record_id='72000000-0000-4000-8000-000000000001'
          ), identifier_readback AS (
            SELECT
              count(*)::integer AS row_count,
              coalesce(
                jsonb_agg(
                  scheme||':'||jurisdiction||':'||normalized_value
                  ORDER BY scheme, jurisdiction, normalized_value
                ),
                '[]'::jsonb
              ) AS keys,
              coalesce(
                jsonb_agg(DISTINCT company_id::text),
                '[]'::jsonb
              ) AS company_ids,
              coalesce(
                jsonb_agg(DISTINCT raw_record_id::text),
                '[]'::jsonb
              ) AS raw_record_ids,
              coalesce(
                jsonb_agg(
                  jsonb_build_object(
                    'workspace_id', workspace_id,
                    'company_id', company_id,
                    'scheme', scheme,
                    'identifier_key', scheme||':'||jurisdiction||':'||normalized_value,
                    'jurisdiction', jurisdiction,
                    'normalized_value', normalized_value,
                    'authority_provider_key', authority_provider_key,
                    'raw_record_id', raw_record_id,
                    'conflict_id', conflict_id,
                    'confidence', confidence,
                    'normalizer_version', normalizer_version,
                    'validator_version', validator_version,
                    'provenance', provenance,
                    'status', status,
                    'revoked_at', revoked_at
                  ) ORDER BY scheme, jurisdiction, normalized_value
                ),
                '[]'::jsonb
              ) AS rows
            FROM organization_identifier
            WHERE workspace_id='71000000-0000-4000-8000-000000000001'
              AND raw_record_id='72000000-0000-4000-8000-000000000001'
          ), party_readback AS (
            SELECT count(*)::integer AS row_count
            FROM organization_identity_conflict_party
            WHERE workspace_id='71000000-0000-4000-8000-000000000001'
          )
          SELECT (jsonb_build_object(
            'returned', command_result.value,
            'persisted', jsonb_build_object(
              'identity_link_count', link_readback.row_count,
              'identity_links', link_readback.rows,
              'identifier_count', identifier_readback.row_count,
              'identifier_keys', identifier_readback.keys,
              'identifiers', identifier_readback.rows
            ),
            'mechanical_consistency', jsonb_build_object(
              'company_matches_identity_link',
                command_result.value->>'company_id' = link_readback.rows->0->>'canonical_id',
              'company_matches_identifiers',
                identifier_readback.company_ids = jsonb_build_array(command_result.value->>'company_id'),
              'conflict_matches_identity_link',
                command_result.value->'conflict_id' IS NOT DISTINCT FROM link_readback.rows->0->'conflict_id',
              'identifier_count_matches',
                (command_result.value->>'identifier_count')::integer = identifier_readback.row_count,
              'input_hash_matches_identity_link',
                command_result.value->>'input_hash' = link_readback.rows->0->>'input_hash',
              'match_rule_matches_identity_link',
                command_result.value->>'match_rule' = link_readback.rows->0->>'match_rule',
              'party_count_matches',
                (command_result.value->>'party_count')::integer = party_readback.row_count,
              'raw_matches_identity_link',
                command_result.value->>'raw_record_id' = link_readback.rows->0->>'raw_record_id',
              'raw_matches_identifiers',
                identifier_readback.raw_record_ids = jsonb_build_array(command_result.value->>'raw_record_id')
            )
          )='{"returned":{"outcome_kind":"bound","raw_record_id":"72000000-0000-4000-8000-000000000001","company_id":"73000000-0000-4000-8000-000000000001","conflict_id":null,"match_rule":"identity_v2","input_hash":"e2d767b2b0e679b1f039709da028010b595ddff946115d8531e654f3fa98eb14","conflict_fingerprint":null,"replayed":false,"company_created":false,"identifier_count":2,"party_count":0},"persisted":{"identity_link_count":1,"identity_links":[{"workspace_id":"71000000-0000-4000-8000-000000000001","raw_record_id":"72000000-0000-4000-8000-000000000001","canonical_type":"company","canonical_id":"73000000-0000-4000-8000-000000000001","match_rule":"identity_v2","confidence":1,"status":"ACTIVE","resolver_version":"organization-identity-resolver/v1","input_hash":"e2d767b2b0e679b1f039709da028010b595ddff946115d8531e654f3fa98eb14","conflict_id":null}],"identifier_count":2,"identifier_keys":["domain:GLOBAL:a2-valid.example","registry-id:DE:DE1234"],"identifiers":[{"workspace_id":"71000000-0000-4000-8000-000000000001","company_id":"73000000-0000-4000-8000-000000000001","scheme":"domain","identifier_key":"domain:GLOBAL:a2-valid.example","jurisdiction":"GLOBAL","normalized_value":"a2-valid.example","authority_provider_key":"registry","raw_record_id":"72000000-0000-4000-8000-000000000001","conflict_id":null,"confidence":1,"normalizer_version":"organization-identity-authority/v1","validator_version":"domain-v1","provenance":{"schemaVersion":"organization-identifier-provenance/v1","rawRecordId":"72000000-0000-4000-8000-000000000001","providerKey":"registry"},"status":"ACTIVE","revoked_at":null},{"workspace_id":"71000000-0000-4000-8000-000000000001","company_id":"73000000-0000-4000-8000-000000000001","scheme":"registry-id","identifier_key":"registry-id:DE:DE1234","jurisdiction":"DE","normalized_value":"DE1234","authority_provider_key":"registry","raw_record_id":"72000000-0000-4000-8000-000000000001","conflict_id":null,"confidence":1,"normalizer_version":"organization-identity-authority/v1","validator_version":"registry-id-v1","provenance":{"schemaVersion":"organization-identifier-provenance/v1","rawRecordId":"72000000-0000-4000-8000-000000000001","providerKey":"registry"},"status":"ACTIVE","revoked_at":null}]},"mechanical_consistency":{"company_matches_identity_link":true,"company_matches_identifiers":true,"conflict_matches_identity_link":true,"identifier_count_matches":true,"input_hash_matches_identity_link":true,"match_rule_matches_identity_link":true,"party_count_matches":true,"raw_matches_identity_link":true,"raw_matches_identifiers":true}}'::jsonb)::text
          FROM command_result, link_readback, identifier_readback, party_readback;
          RESET SESSION AUTHORIZATION;
          ROLLBACK;`),
        "true",
      );
    });

    it("persists a different directory-bound result with one literal authority", () => {
      exactHelper("second valid two-ID command", signature.command);
      assert.equal(
        sql(`BEGIN;
          INSERT INTO workspace(id,name,updated_at)
          VALUES ('71000000-0000-4000-8000-000000000002','Task A2 second command',now());
          INSERT INTO canonical_company(id,workspace_id,name,domain,country,status,dedupe_key,version,created_at,updated_at)
          VALUES ('73000000-0000-4000-8000-000000000002','71000000-0000-4000-8000-000000000002','Secondary Root','secondary-root.example','DE','NEW','d:secondary-root.example',1,now(),now());
          INSERT INTO raw_source_record(id,workspace_id,provider_key,source_class,payload,source_url,fetched_at,content_hash,parser_version,ingest_key,payload_hash,payload_bytes,ingest_version,ingest_status,retention_days,expires_at,source_policy_snapshot,created_at)
          VALUES ('72000000-0000-4000-8000-000000000002','71000000-0000-4000-8000-000000000002','directory','industry_data','{"externalId":"directory:a2-secondary.example","name":"Secondary GmbH","domain":"a2-secondary.example","country":"DE","attributes":{"source_kind":"directory","source_directory":"registry.example","detail_url":"https://registry.example/company/2","source_class":"industry_data"},"provenance":{"sourceUrl":"https://registry.example/companies/2","fetchedAt":"2026-08-26T12:00:00.000Z","contentHash":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","parserVersion":"registry/v1"}}'::jsonb,'https://registry.example/companies/2',now(),'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd','registry/v1','task-a2:second-valid','cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',1,'raw-source/v2','ACCEPTED',30,now()+interval '30 days','{}'::jsonb,now());
          INSERT INTO organization_identifier(workspace_id,company_id,scheme,jurisdiction,normalized_value,authority_provider_key,raw_record_id,confidence,normalizer_version,validator_version,provenance,status)
          VALUES ('71000000-0000-4000-8000-000000000002','73000000-0000-4000-8000-000000000002','domain','GLOBAL','a2-secondary.example','directory','72000000-0000-4000-8000-000000000002',1,'organization-identity-authority/v1','domain-v1','{"schemaVersion":"organization-identifier-provenance/v1","rawRecordId":"72000000-0000-4000-8000-000000000002","providerKey":"directory"}'::jsonb,'ACTIVE');
          SET SESSION AUTHORIZATION app_user;
          SET LOCAL app.current_workspace_id = '71000000-0000-4000-8000-000000000002';
          SELECT to_jsonb(result)::text AS command_result
          FROM public.resolve_organization_identity_for_raw_v1('71000000-0000-4000-8000-000000000002','72000000-0000-4000-8000-000000000002') AS result
          \\gset task_a2_directory_
          WITH command_result AS (
            SELECT :'task_a2_directory_command_result'::jsonb AS value
          ), link_readback AS (
            SELECT
              count(*)::integer AS row_count,
              coalesce(
                jsonb_agg(
                  jsonb_build_object(
                    'workspace_id', workspace_id,
                    'raw_record_id', raw_record_id,
                    'canonical_type', canonical_type,
                    'canonical_id', canonical_id,
                    'match_rule', match_rule,
                    'confidence', confidence,
                    'status', status,
                    'resolver_version', resolver_version,
                    'input_hash', input_hash,
                    'conflict_id', conflict_id
                  ) ORDER BY canonical_id
                ),
                '[]'::jsonb
              ) AS rows
            FROM identity_link
            WHERE workspace_id='71000000-0000-4000-8000-000000000002'
              AND raw_record_id='72000000-0000-4000-8000-000000000002'
          ), identifier_readback AS (
            SELECT
              count(*)::integer AS row_count,
              coalesce(
                jsonb_agg(
                  scheme||':'||jurisdiction||':'||normalized_value
                  ORDER BY scheme, jurisdiction, normalized_value
                ),
                '[]'::jsonb
              ) AS keys,
              coalesce(
                jsonb_agg(DISTINCT company_id::text),
                '[]'::jsonb
              ) AS company_ids,
              coalesce(
                jsonb_agg(DISTINCT raw_record_id::text),
                '[]'::jsonb
              ) AS raw_record_ids,
              coalesce(
                jsonb_agg(
                  jsonb_build_object(
                    'workspace_id', workspace_id,
                    'company_id', company_id,
                    'scheme', scheme,
                    'identifier_key', scheme||':'||jurisdiction||':'||normalized_value,
                    'jurisdiction', jurisdiction,
                    'normalized_value', normalized_value,
                    'authority_provider_key', authority_provider_key,
                    'raw_record_id', raw_record_id,
                    'conflict_id', conflict_id,
                    'confidence', confidence,
                    'normalizer_version', normalizer_version,
                    'validator_version', validator_version,
                    'provenance', provenance,
                    'status', status,
                    'revoked_at', revoked_at
                  ) ORDER BY scheme, jurisdiction, normalized_value
                ),
                '[]'::jsonb
              ) AS rows
            FROM organization_identifier
            WHERE workspace_id='71000000-0000-4000-8000-000000000002'
              AND raw_record_id='72000000-0000-4000-8000-000000000002'
          ), party_readback AS (
            SELECT count(*)::integer AS row_count
            FROM organization_identity_conflict_party
            WHERE workspace_id='71000000-0000-4000-8000-000000000002'
          )
          SELECT (jsonb_build_object(
            'returned', command_result.value,
            'persisted', jsonb_build_object(
              'identity_link_count', link_readback.row_count,
              'identity_links', link_readback.rows,
              'identifier_count', identifier_readback.row_count,
              'identifier_keys', identifier_readback.keys,
              'identifiers', identifier_readback.rows
            ),
            'mechanical_consistency', jsonb_build_object(
              'company_matches_identity_link',
                command_result.value->>'company_id' = link_readback.rows->0->>'canonical_id',
              'company_matches_identifiers',
                identifier_readback.company_ids = jsonb_build_array(command_result.value->>'company_id'),
              'conflict_matches_identity_link',
                command_result.value->'conflict_id' IS NOT DISTINCT FROM link_readback.rows->0->'conflict_id',
              'identifier_count_matches',
                (command_result.value->>'identifier_count')::integer = identifier_readback.row_count,
              'input_hash_matches_identity_link',
                command_result.value->>'input_hash' = link_readback.rows->0->>'input_hash',
              'match_rule_matches_identity_link',
                command_result.value->>'match_rule' = link_readback.rows->0->>'match_rule',
              'party_count_matches',
                (command_result.value->>'party_count')::integer = party_readback.row_count,
              'raw_matches_identity_link',
                command_result.value->>'raw_record_id' = link_readback.rows->0->>'raw_record_id',
              'raw_matches_identifiers',
                identifier_readback.raw_record_ids = jsonb_build_array(command_result.value->>'raw_record_id')
            )
          )='{"returned":{"outcome_kind":"bound","raw_record_id":"72000000-0000-4000-8000-000000000002","company_id":"73000000-0000-4000-8000-000000000002","conflict_id":null,"match_rule":"identity_v2","input_hash":"1b1116123797795d5a9d955af10dcf94dff616c557f7d89882c70c3ee44a9393","conflict_fingerprint":null,"replayed":false,"company_created":false,"identifier_count":1,"party_count":0},"persisted":{"identity_link_count":1,"identity_links":[{"workspace_id":"71000000-0000-4000-8000-000000000002","raw_record_id":"72000000-0000-4000-8000-000000000002","canonical_type":"company","canonical_id":"73000000-0000-4000-8000-000000000002","match_rule":"identity_v2","confidence":1,"status":"ACTIVE","resolver_version":"organization-identity-resolver/v1","input_hash":"1b1116123797795d5a9d955af10dcf94dff616c557f7d89882c70c3ee44a9393","conflict_id":null}],"identifier_count":1,"identifier_keys":["domain:GLOBAL:a2-secondary.example"],"identifiers":[{"workspace_id":"71000000-0000-4000-8000-000000000002","company_id":"73000000-0000-4000-8000-000000000002","scheme":"domain","identifier_key":"domain:GLOBAL:a2-secondary.example","jurisdiction":"GLOBAL","normalized_value":"a2-secondary.example","authority_provider_key":"directory","raw_record_id":"72000000-0000-4000-8000-000000000002","conflict_id":null,"confidence":1,"normalizer_version":"organization-identity-authority/v1","validator_version":"domain-v1","provenance":{"schemaVersion":"organization-identifier-provenance/v1","rawRecordId":"72000000-0000-4000-8000-000000000002","providerKey":"directory"},"status":"ACTIVE","revoked_at":null}]},"mechanical_consistency":{"company_matches_identity_link":true,"company_matches_identifiers":true,"conflict_matches_identity_link":true,"identifier_count_matches":true,"input_hash_matches_identity_link":true,"match_rule_matches_identity_link":true,"party_count_matches":true,"raw_matches_identity_link":true,"raw_matches_identifiers":true}}'::jsonb)::text
          FROM command_result, link_readback, identifier_readback, party_readback;
          RESET SESSION AUTHORIZATION;
          ROLLBACK;`),
        "true",
      );
    });

    it("rejects a malformed Raw ID with the exact machine code and value", () => {
      exactHelper("malformed two-ID command", signature.command);
      exactMachineError(
        `PERFORM public.resolve_organization_identity_for_raw_v1('71000000-0000-4000-8000-000000000001','not-a-uuid');`,
        "P0001|IDENTITY_RESOLUTION_INPUT_INVALID",
        `BEGIN;
         SET SESSION AUTHORIZATION app_user;
         SET LOCAL app.current_workspace_id = '71000000-0000-4000-8000-000000000001';`,
        `RESET SESSION AUTHORIZATION;
         ROLLBACK;`,
      );
    });
  });
});
