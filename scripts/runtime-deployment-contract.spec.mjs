import assert from 'node:assert/strict';
import { access, chmod, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);

const repositoryFile = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('MinIO is pinned and provisioned by one idempotent deployment job', async () => {
  const [compose, bootstrap, cleanupAdapter, lifecycle, artifactLifecycle] = await Promise.all([
    repositoryFile('docker-compose.yml'),
    repositoryFile('infra/minio/bootstrap.sh'),
    repositoryFile('apps/api/src/durable-results/artifact/personal-artifact-cleanup.store.ts'),
    repositoryFile('infra/minio/site-builder-lifecycle.json'),
    repositoryFile('infra/minio/generic-operation-artifact-lifecycle.json'),
  ]);
  assert.match(compose, /minio:\n\s+image: quay\.io\/minio\/minio:RELEASE\./);
  assert.match(compose, /minio-bootstrap:/);
  assert.match(compose, /condition: service_healthy/);
  assert.match(compose, /restart: ["']no["']/);
  assert.match(bootstrap, /mc mb --ignore-existing/);
  assert.match(bootstrap, /mc ilm rule import/);
  assert.match(bootstrap, /mc ilm rule export/);
  assert.deepEqual(JSON.parse(lifecycle), {
    Rules: [
      {
        Expiration: { Days: 1 },
        ID: 'global-variant-attempt-ttl',
        Status: 'Enabled',
        Filter: {
          Tag: { Key: 'global-lifecycle', Value: 'variant-attempt' },
        },
      },
    ],
  });
  assert.deepEqual(JSON.parse(artifactLifecycle), {
    Rules: [
      {
        Expiration: { Days: 1, ExpiredObjectAllVersions: true },
        NoncurrentVersionExpiration: { NoncurrentDays: 1 },
        ID: 'generic-operation-artifact-staging-ttl',
        Status: 'Enabled',
        Filter: { Prefix: 'generic-operation-results/v1/staging/' },
      },
      {
        Expiration: { Days: 30, ExpiredObjectAllVersions: true },
        NoncurrentVersionExpiration: { NoncurrentDays: 30 },
        ID: 'generic-operation-artifact-public-organization-ttl',
        Status: 'Enabled',
        Filter: {
          Tag: {
            Key: 'artifact-privacy',
            Value: 'PUBLIC_ORGANIZATION',
          },
        },
      },
      {
        Expiration: { Days: 7, ExpiredObjectAllVersions: true },
        NoncurrentVersionExpiration: { NoncurrentDays: 7 },
        ID: 'generic-operation-artifact-confidential-tenant-ttl',
        Status: 'Enabled',
        Filter: {
          Tag: {
            Key: 'artifact-privacy',
            Value: 'CONFIDENTIAL_TENANT',
          },
        },
      },
      {
        Expiration: { Days: 1, ExpiredObjectAllVersions: true },
        NoncurrentVersionExpiration: { NoncurrentDays: 1 },
        ID: 'generic-operation-artifact-personal-data-ttl',
        Status: 'Enabled',
        Filter: {
          Tag: { Key: 'artifact-privacy', Value: 'PERSONAL_DATA' },
        },
      },
      {
        Expiration: { ExpiredObjectDeleteMarker: true },
        ID: 'generic-operation-artifact-staging-delete-markers',
        Status: 'Enabled',
        Filter: { Prefix: 'generic-operation-results/v1/staging/' },
      },
      {
        Expiration: { ExpiredObjectDeleteMarker: true },
        ID: 'generic-operation-artifact-final-delete-markers',
        Status: 'Enabled',
        Filter: { Prefix: 'generic-operation-results/v1/final/' },
      },
      {
        Expiration: { ExpiredObjectDeleteMarker: true },
        NoncurrentVersionExpiration: { NoncurrentDays: 1 },
        ID: 'generic-operation-artifact-readiness-cleanup',
        Status: 'Enabled',
        Filter: { Prefix: 'generic-operation-results/v1/readiness/' },
      },
    ],
  });
  assert.match(bootstrap, /GENERIC_OPERATION_ARTIFACT_S3_BUCKET/);
  assert.match(bootstrap, /mc version enable/);
  assert.match(bootstrap, /mc encrypt set SSE-S3/);
  assert.match(bootstrap, /generic-operation-artifact-lifecycle\.json/);
  assert.match(bootstrap, /mc admin policy create/);
  assert.match(bootstrap, /s3:ExistingObjectTag\/artifact-privacy/);
  assert.match(bootstrap, /s3:PutObjectTagging/);
  assert.match(bootstrap, /s3:AbortMultipartUpload/);
  assert.match(bootstrap, /s3:DeleteObjectVersion/);
  assert.match(bootstrap, /MINIO_ROOT_USER.*GENERIC_OPERATION_ARTIFACT_S3_ACCESS_KEY/s);
  assert.match(bootstrap, /mc admin user info .* --json/);
  assert.match(bootstrap, /"policyName"/);
  assert.match(bootstrap, /"memberOf"/);
  assert.doesNotMatch(bootstrap, /"Action": \["s3:GetObject", "s3:GetObjectVersion"\]/);
  assert.match(bootstrap, /GENERIC_OPERATION_ARTIFACT_PERSONAL_READ_ACCESS_KEY/);
  assert.match(bootstrap, /GENERIC_OPERATION_ARTIFACT_CLEANUP_S3_ACCESS_KEY/);
  assert.match(bootstrap, /generic-operation-artifact-personal-cleanup/);
  assert.match(bootstrap, /generic-operation-results\/v1\/final\/personal-data\/\*/);
  assert.match(bootstrap, /"s3:GetObjectVersion"/);
  assert.match(bootstrap, /"s3:GetObjectVersionTagging"/);
  assert.match(bootstrap, /"s3:GetObjectTagging"/);
  assert.match(bootstrap, /"s3:DeleteObjectVersion"/);
  const cleanupPolicy = bootstrap.slice(bootstrap.indexOf('cat > "$cleanup_policy"'), bootstrap.indexOf('cat > "$personal_policy"'));
  assert.doesNotMatch(cleanupPolicy, /DeleteObjectVersion[\s\S]*ExistingObjectTag/u);
  // Erasure lists every version of one personal-data key (the version ledger can
  // miss a refresh copy). The grant matches one full content-addressed key and
  // nothing shorter: a wildcard prefix would let the cleanup credential, which
  // already reads versions, enumerate and bulk-read every PERSONAL_DATA object.
  const exactPersonalKeyPattern = `generic-operation-results/v1/final/personal-data/sha256/??/${'?'.repeat(64)}`;
  // MinIO lets a plain StringLike condition pass when ANY value of a repeated
  // query parameter matches, while ListObjectVersions lists by the first value.
  // ForAllValues requires every prefix value to match; Null=false rejects a
  // request without one (ForAllValues is true for an empty set).
  const listGrant = cleanupPolicy.match(LIST_VERSIONS_GRANT);
  assert.equal(listGrant?.[1], exactPersonalKeyPattern);
  assert.doesNotMatch(cleanupPolicy, /"StringLike": \{\s*"s3:prefix"/u);
  assert.equal(cleanupPolicy.match(/s3:ListBucketVersions/gu)?.length, 1);
  // Exactly the ForAllValues pattern and its Null guard name s3:prefix.
  assert.equal(cleanupPolicy.match(/"s3:prefix"/gu)?.length, 2);
  assert.doesNotMatch(cleanupPolicy, /"s3:ListBucket"/u);
  assert.match(cleanupAdapter, /ListObjectVersionsCommand/);
  assert.match(cleanupAdapter, /GetObjectTaggingCommand/);
  assert.match(cleanupAdapter, /Value !== 'PERSONAL_DATA'/);
  const runtimePolicy = bootstrap.slice(bootstrap.indexOf('cat > "$runtime_policy"'), bootstrap.indexOf('cat > "$cleanup_policy"'));
  // The runtime readiness probe lists versions under readiness/ only; the same
  // repeated-parameter rule applies.
  assert.equal(runtimePolicy.match(LIST_VERSIONS_GRANT)?.[1], 'generic-operation-results/v1/readiness/*');
  assert.doesNotMatch(runtimePolicy, /"StringLike": \{\s*"s3:prefix"/u);
  for (const [prefix, privacyClass] of [
    ['public-organization', 'PUBLIC_ORGANIZATION'],
    ['confidential-tenant', 'CONFIDENTIAL_TENANT'],
    ['personal-data', 'PERSONAL_DATA'],
  ]) {
    for (const action of ['s3:PutObject', 's3:PutObjectTagging']) {
      expectPolicyMapping(runtimePolicy, action, prefix, privacyClass);
    }
  }
  assert.match(bootstrap, /"s3:GetBucketLocation"/);
  assert.match(compose, /GENERIC_OPERATION_ARTIFACT_CLEANUP_S3_ACCESS_KEY/);
  assert.match(compose, /GENERIC_OPERATION_ARTIFACT_CLEANUP_S3_SECRET_KEY/);
});

const LIST_VERSIONS_GRANT =
  /"Action": \["s3:ListBucketVersions"\],\s*"Resource": \["arn:aws:s3:::\$GENERIC_OPERATION_ARTIFACT_S3_BUCKET"\],\s*"Condition": \{\s*"ForAllValues:StringLike": \{\s*"s3:prefix": "([^"]*)"\s*\},\s*"Null": \{\s*"s3:prefix": "false"\s*\}\s*\}/u;

function expectPolicyMapping(policy, action, prefix, privacyClass) {
  const actionOffset = policy.indexOf(`"Action": ["${action}"]`);
  assert.notEqual(actionOffset, -1);
  const mapping = policy.slice(actionOffset);
  const prefixOffset = mapping.indexOf(`generic-operation-results/v1/final/${prefix}/*`);
  assert.notEqual(prefixOffset, -1);
  const statement = mapping.slice(prefixOffset, prefixOffset + 700);
  assert.match(statement, new RegExp(`"s3:RequestObjectTag/artifact-privacy": "${privacyClass}"`));
}

// The mc calls and policy documents MinIO would receive, captured by running
// bootstrap.sh against a fake mc instead of parsing its text: shell can write
// or rewrite a policy file in too many ways for a parser to follow. The run
// follows the minio-bootstrap container where it is cheap to: compose
// defaults, HOSTNAME and HOME set, PATH holding only the tools the pinned mc
// image ships (cat, tr, id, mktemp, paste), stdin closed, and both dash and
// bash invoked as sh (the image's /bin/sh is bash). /config/ and /tmp/ are
// redirected into the sandbox as whole path words. The fake answers exactly the calls of a
// provisioning run and records every other call as rejected, so even
// `mc ... || true` cannot hide a new command.
// Threat model: this guards against an accidental or reviewed-looking change,
// not a deliberate bypass (an absolute /usr/bin/mc path, `command -p`, or a
// branch on a file that exists only in the image would still escape it;
// closing that needs the capture to run inside the pinned mc image).
const FAKE_MC = `#!/bin/sh
printf '%s\\n' "$*" >> "$MC_STATE/calls"
reject() { printf '%s\\n' "$*" >> "$MC_STATE/rejected"; exit 97; }
case "$*" in
  'alias set deployment '*|'mb --ignore-existing deployment/'*|'version enable deployment/'*|'encrypt set SSE-S3 deployment/'*|'admin user add deployment '*) exit 0 ;;
  'ls deployment')
    if [ "$MC_REDEPLOY" = 1 ]; then printf '%s\\n' "[2026-10-19 00:00:00 UTC]     0B $MC_ARTIFACT_BUCKET/"; fi
    exit 0 ;;
  'ls --recursive --versions deployment/'*) [ "$MC_REDEPLOY" = 1 ] || reject "$@"; exit 0 ;;
  'ilm rule import deployment/'*) /usr/bin/cat > "$MC_STATE/ilm-$(printf '%s' "$4" | /usr/bin/tr '/' '_')"; exit 0 ;;
  'ilm rule export deployment/'*) /usr/bin/cat "$MC_STATE/ilm-$(printf '%s' "$4" | /usr/bin/tr '/' '_')"; exit 0 ;;
  'version info deployment/'*) echo 'versioning is enabled'; exit 0 ;;
  'encrypt info deployment/'*) echo 'auto encryption: sse-s3'; exit 0 ;;
  'admin policy create deployment '*)
    [ "$#" -eq 6 ] || reject "$@"
    count=$(( $(/usr/bin/cat "$MC_STATE/count" 2>/dev/null || echo 0) + 1 ))
    echo "$count" > "$MC_STATE/count"
    /usr/bin/cp "$6" "$MC_STATE/policy-$count-$5.json"; exit 0 ;;
  'admin policy attach deployment '*' --user '*)
    [ "$#" -eq 7 ] || reject "$@"
    printf '%s %s\\n' "$7" "$5" >> "$MC_STATE/attached"; exit 0 ;;
  'admin user info deployment '*' --json')
    policy=$(/usr/bin/awk -v user="$5" '$1 == user { print $2 }' "$MC_STATE/attached" | /usr/bin/paste -sd, -)
    printf '{"accessKey":"%s","policyName":"%s","userStatus":"enabled"}\\n' "$5" "$policy"; exit 0 ;;
esac
reject "$@"
`;

const IMAGE_TOOLS = ['cat', 'tr', 'id', 'mktemp', 'paste'];

// The compose defaults where docker-compose.yml has one; the artifact variables have none.
const PROVISIONING_ENV = {
  HOSTNAME: 'minio-bootstrap',
  HOME: '/root',
  MINIO_ENDPOINT: 'http://minio:9000',
  MINIO_ROOT_USER: 'global',
  MINIO_ROOT_PASSWORD: 'global-minio-dev',
  S3_BUCKET: 'global-site-builder',
  GENERIC_OPERATION_ARTIFACT_S3_BUCKET: 'operation-artifacts-test',
  GENERIC_OPERATION_ARTIFACT_S3_ACCESS_KEY: 'runtime-writer',
  GENERIC_OPERATION_ARTIFACT_S3_SECRET_KEY: 'runtime-password-123',
  GENERIC_OPERATION_ARTIFACT_PERSONAL_READ_ACCESS_KEY: 'personal-reader',
  GENERIC_OPERATION_ARTIFACT_PERSONAL_READ_SECRET_KEY: 'personal-password-123',
  GENERIC_OPERATION_ARTIFACT_CLEANUP_S3_ACCESS_KEY: 'cleanup-writer',
  GENERIC_OPERATION_ARTIFACT_CLEANUP_S3_SECRET_KEY: 'cleanup-password-123',
};

async function provisionWithFakeMc(bootstrapSource, { shell, redeploy }) {
  const directory = await mkdtemp(join(tmpdir(), 'artifact-policy-capture-'));
  try {
    const state = join(directory, 'state');
    const bin = join(directory, 'bin');
    await execFileAsync('/usr/bin/mkdir', [state, bin]);
    await writeFile(join(bin, 'mc'), FAKE_MC, 'utf8');
    await chmod(join(bin, 'mc'), 0o700);
    for (const tool of IMAGE_TOOLS) await symlink(`/usr/bin/${tool}`, join(bin, tool));
    // /config and /tmp as whole path words, with or without a trailing slash.
    const configDirectory = fileURLToPath(new URL('../infra/minio', import.meta.url));
    const script = bootstrapSource.replace(/\/(config|tmp)\b/gu, (_match, root) =>
      root === 'config' ? configDirectory : directory,
    );
    await writeFile(join(directory, 'bootstrap.sh'), script, 'utf8');
    const run = execFileAsync(shell, [join(directory, 'bootstrap.sh')], {
      argv0: 'sh',
      timeout: 60_000,
      env: {
        ...PROVISIONING_ENV,
        PATH: bin,
        MC_STATE: state,
        MC_REDEPLOY: redeploy ? '1' : '0',
        MC_ARTIFACT_BUCKET: PROVISIONING_ENV.GENERIC_OPERATION_ARTIFACT_S3_BUCKET,
      },
    });
    // The container's stdin is /dev/null: a read must see end of file, not hang.
    run.child.stdin.end();
    const { stdout, stderr } = await run;
    const read = async (name) => readFile(join(state, name), 'utf8').catch((error) => (error.code === 'ENOENT' ? '' : Promise.reject(error)));
    const rejected = await read('rejected');
    const calls = (await read('calls')).trim().split('\n');
    const created = (await execFileAsync('/usr/bin/ls', [state])).stdout.split('\n').filter((name) => name.startsWith('policy-'));
    const policies = {};
    for (const file of created) {
      const name = file.replace(/^policy-\d+-/u, '').replace(/\.json$/u, '');
      assert.equal(Object.hasOwn(policies, name), false, `${name} is created once`);
      const text = await readFile(join(state, file), 'utf8');
      try {
        policies[name] = JSON.parse(text);
      } catch (error) {
        throw new Error(`${name} is not one JSON document: ${error.message}`);
      }
    }
    return { stdout, stderr, rejected, calls, policies, directory };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

// Actions that accept the s3:prefix condition key in MinIO (IAMActionConditionKeyMap).
const PREFIX_ACTIONS = ['s3:ListBucket', 's3:ListBucketVersions'];
const PREFIX_OPERATORS = new Set(['ForAllValues:StringLike', 'Null']);

// MinIO matches Action with * and ? wildcards, so "*", "s3:*" or "s3:L*" grant listing too.
function grantsListing(actions) {
  return actions.some((action) => {
    const escaped = action.replace(/[.+^${}()|[\]\\]/gu, '\\$&').replaceAll('*', '.*').replaceAll('?', '.');
    const pattern = new RegExp(`^${escaped}$`, 'u');
    return PREFIX_ACTIONS.some((listAction) => pattern.test(listAction));
  });
}

// Every rule the policies must keep, as a list of violations. MinIO lets an
// unqualified operator (StringLike, StringEquals, StringNotLike) or ForAnyValue
// pass when ANY value of a repeated prefix parameter matches, while
// ListObjectVersions lists by the first value. ForAllValues:StringLike and
// ForAllValues:StringEquals with Null=false are both safe; this contract admits
// only the shape bootstrap.sh uses (Allow, Action, Resource; one
// ForAllValues:StringLike pattern; Null "false") and fails closed on the rest.
function prefixConditionViolations(policies) {
  const violations = [];
  for (const [name, policy] of Object.entries(policies)) {
    for (const [index, statement] of policy.Statement.entries()) {
      const where = `${name} statement ${index}`;
      const shape = Object.keys(statement).filter((key) => !['Effect', 'Action', 'Resource', 'Condition'].includes(key));
      if (statement.Effect !== 'Allow' || statement.Action === undefined || shape.length > 0) {
        violations.push(
          `${where}: unsupported statement shape (Effect ${statement.Effect}, ${statement.Action === undefined ? 'no Action' : 'Action'}, extra keys: ${shape.join(', ') || 'none'})`,
        );
        continue;
      }
      const lists = grantsListing([statement.Action].flat());
      const condition = statement.Condition ?? {};
      let namesPrefix = false;
      for (const [operator, keys] of Object.entries(condition)) {
        if (!Object.hasOwn(keys, 's3:prefix')) continue;
        namesPrefix = true;
        if (!PREFIX_OPERATORS.has(operator)) violations.push(`${where}: s3:prefix under ${operator}`);
        if (operator === 'Null' && keys['s3:prefix'] !== 'false') violations.push(`${where}: Null s3:prefix is not "false"`);
      }
      if (lists) {
        if (typeof condition['ForAllValues:StringLike']?.['s3:prefix'] !== 'string') {
          violations.push(`${where}: list grant needs one ForAllValues:StringLike s3:prefix pattern`);
        }
        if (condition.Null?.['s3:prefix'] !== 'false') violations.push(`${where}: list grant needs Null s3:prefix "false"`);
      }
      if (namesPrefix && !lists) violations.push(`${where}: s3:prefix on a statement that lists nothing`);
    }
  }
  return violations;
}

function expectedMcCalls(directory, redeploy) {
  const env = PROVISIONING_ENV;
  const artifact = `deployment/${env.GENERIC_OPERATION_ARTIFACT_S3_BUCKET}`;
  const users = [
    ['generic-operation-artifact-runtime', 'runtime', env.GENERIC_OPERATION_ARTIFACT_S3_ACCESS_KEY, env.GENERIC_OPERATION_ARTIFACT_S3_SECRET_KEY],
    ['generic-operation-artifact-personal-read', 'personal-read', env.GENERIC_OPERATION_ARTIFACT_PERSONAL_READ_ACCESS_KEY, env.GENERIC_OPERATION_ARTIFACT_PERSONAL_READ_SECRET_KEY],
    ['generic-operation-artifact-personal-cleanup', 'personal-cleanup', env.GENERIC_OPERATION_ARTIFACT_CLEANUP_S3_ACCESS_KEY, env.GENERIC_OPERATION_ARTIFACT_CLEANUP_S3_SECRET_KEY],
  ];
  return [
    `alias set deployment ${env.MINIO_ENDPOINT} ${env.MINIO_ROOT_USER} ${env.MINIO_ROOT_PASSWORD}`,
    'ls deployment',
    ...(redeploy ? [`ls --recursive --versions ${artifact}/generic-operation-results/v1/sha256/`] : []),
    `mb --ignore-existing deployment/${env.S3_BUCKET}`,
    `ilm rule import deployment/${env.S3_BUCKET}`,
    `mb --ignore-existing ${artifact}`,
    `version enable ${artifact}`,
    `encrypt set SSE-S3 ${artifact}`,
    `ilm rule import ${artifact}`,
    `ilm rule export deployment/${env.S3_BUCKET}`,
    `ilm rule export ${artifact}`,
    `version info ${artifact}`,
    `encrypt info ${artifact}`,
    ...users.map(([name, file]) => `admin policy create deployment ${name} ${directory}/generic-operation-artifact-${file}-policy.json`),
    ...users.map(([, , user, secret]) => `admin user add deployment ${user} ${secret}`),
    ...users.map(([name, , user]) => `admin policy attach deployment ${name} --user ${user}`),
    ...users.map(([, , user]) => `admin user info deployment ${user} --json`),
  ];
}

const SHELLS = ['/bin/sh', '/bin/bash'];

test('provisioning gives MinIO exactly the reviewed calls and policies, first deploy and redeploy, under dash and bash', async () => {
  const bootstrap = await repositoryFile('infra/minio/bootstrap.sh');
  let reference;
  for (const shell of SHELLS) {
    for (const redeploy of [false, true]) {
      const label = `${shell} ${redeploy ? 'redeploy' : 'first deploy'}`;
      const { stdout, stderr, rejected, calls, policies, directory } = await provisionWithFakeMc(bootstrap, { shell, redeploy });
      assert.equal(rejected, '', `${label}: mc rejected a call`);
      assert.equal(stderr, '', `${label}: bootstrap wrote to stderr`);
      assert.match(stdout, /"status":"OBJECT_STORAGE_PROVISIONED"/u, label);
      // Every mc call in order, unfiltered: a new command, flag or branch changes this list.
      assert.deepEqual(calls, expectedMcCalls(directory, redeploy), label);
      if (reference) assert.deepEqual(policies, reference, `${label}: same policies as the first run`);
      else reference = policies;
    }
  }

  const named = {
    runtime_policy: reference['generic-operation-artifact-runtime'],
    personal_policy: reference['generic-operation-artifact-personal-read'],
    cleanup_policy: reference['generic-operation-artifact-personal-cleanup'],
  };
  assert.deepEqual(Object.keys(reference).sort(), [
    'generic-operation-artifact-personal-cleanup',
    'generic-operation-artifact-personal-read',
    'generic-operation-artifact-runtime',
  ]);
  // MinIO decodes policy keys case-insensitively and keeps the last duplicate,
  // so a "statement" key would replace "Statement": only these two may exist.
  for (const [name, policy] of Object.entries(named)) {
    assert.deepEqual(Object.keys(policy).sort(), ['Statement', 'Version'], name);
    assert.ok(Array.isArray(policy.Statement), name);
  }
  assert.deepEqual(prefixConditionViolations(named), []);
  const listGrants = (policy) => policy.Statement.filter((statement) => grantsListing([statement.Action].flat()));
  const listGrant = (pattern) => ({
    Effect: 'Allow',
    Action: ['s3:ListBucketVersions'],
    Resource: ['arn:aws:s3:::operation-artifacts-test'],
    Condition: { 'ForAllValues:StringLike': { 's3:prefix': pattern }, Null: { 's3:prefix': 'false' } },
  });
  assert.deepEqual(listGrants(named.runtime_policy), [listGrant('generic-operation-results/v1/readiness/*')]);
  assert.deepEqual(listGrants(named.cleanup_policy), [
    listGrant(`generic-operation-results/v1/final/personal-data/sha256/??/${'?'.repeat(64)}`),
  ]);
  assert.deepEqual(listGrants(named.personal_policy), []);
  assert.doesNotMatch(JSON.stringify(named.personal_policy), /s3:prefix/u);
});

test('the s3:prefix whitelist reports exactly what is wrong with each statement', () => {
  const at = 'p statement 0';
  const check = (statement) => prefixConditionViolations({ p: { Statement: [statement] } });
  const grant = (condition, Action = ['s3:ListBucketVersions']) => ({
    Effect: 'Allow',
    Action,
    Resource: ['arn:aws:s3:::bucket'],
    ...(condition ? { Condition: condition } : {}),
  });
  const safe = { 'ForAllValues:StringLike': { 's3:prefix': 'readiness/*' }, Null: { 's3:prefix': 'false' } };
  const needsPattern = `${at}: list grant needs one ForAllValues:StringLike s3:prefix pattern`;
  const needsNull = `${at}: list grant needs Null s3:prefix "false"`;

  assert.deepEqual(check(grant(safe)), []);
  for (const operator of ['StringLike', 'StringEquals', 'StringNotLike', 'ForAnyValue:StringLike', 'ForAllValues:StringEquals']) {
    assert.deepEqual(
      check(grant({ [operator]: { 's3:prefix': 'readiness/*' }, Null: { 's3:prefix': 'false' } })),
      [`${at}: s3:prefix under ${operator}`, needsPattern],
      operator,
    );
  }
  assert.deepEqual(check(grant({ Null: { 's3:prefix': 'false' } })), [needsPattern]);
  assert.deepEqual(check(grant({ 'ForAllValues:StringLike': { 's3:prefix': 'readiness/*' } })), [needsNull]);
  assert.deepEqual(check(grant({ ...safe, Null: { 's3:prefix': 'true' } })), [`${at}: Null s3:prefix is not "false"`, needsNull]);
  assert.deepEqual(check(grant({ ...safe, 'ForAllValues:StringLike': { 's3:prefix': ['a/*', 'b/*'] } })), [needsPattern]);
  // Wildcards grant listing in MinIO, so an unconditioned one is a list grant without its guards.
  for (const Action of [['s3:*'], '*', ['s3:L*'], ['s3:*Versions'], ['s3:ListBucket'], ['s3:GetObject', 's3:List*']]) {
    assert.deepEqual(check(grant(undefined, Action)), [needsPattern, needsNull], JSON.stringify(Action));
  }
  // Listing actions that cannot carry s3:prefix are not list grants here.
  assert.deepEqual(check(grant(undefined, ['s3:ListBucketMultipartUploads', 's3:ListMultipartUploadParts'])), []);
  assert.deepEqual(check(grant({ 'ForAllValues:StringLike': { 's3:prefix': 'x/*' } }, ['s3:GetObject'])), [
    `${at}: s3:prefix on a statement that lists nothing`,
  ]);
  assert.deepEqual(check({ ...grant(safe), Effect: 'Deny' }), [
    `${at}: unsupported statement shape (Effect Deny, Action, extra keys: none)`,
  ]);
  const { Action: _action, ...withoutAction } = grant(undefined);
  assert.deepEqual(check({ ...withoutAction, NotAction: ['s3:GetObject'] }), [
    `${at}: unsupported statement shape (Effect Allow, no Action, extra keys: NotAction)`,
  ]);
});

test('MinIO bootstrap rejects merged principals before the first mc mutation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'artifact-bootstrap-contract-'));
  const marker = join(directory, 'mc-called');
  const fakeMc = join(directory, 'mc');
  await writeFile(fakeMc, '#!/bin/sh\n: > "$MC_MARKER"\nexit 0\n', 'utf8');
  await chmod(fakeMc, 0o700);
  try {
    await assert.rejects(
      execFileAsync('/bin/sh', ['infra/minio/bootstrap.sh'], {
        cwd: new URL('..', import.meta.url),
        env: {
          PATH: directory,
          MC_MARKER: marker,
          MINIO_ENDPOINT: 'http://minio:9000',
          MINIO_ROOT_USER: 'same-principal',
          MINIO_ROOT_PASSWORD: 'root-password-123',
          S3_BUCKET: 'site-assets-test',
          GENERIC_OPERATION_ARTIFACT_S3_BUCKET: 'operation-artifacts-test',
          GENERIC_OPERATION_ARTIFACT_S3_ACCESS_KEY: 'same-principal',
          GENERIC_OPERATION_ARTIFACT_S3_SECRET_KEY: 'runtime-password-123',
          GENERIC_OPERATION_ARTIFACT_PERSONAL_READ_ACCESS_KEY: 'personal-reader',
          GENERIC_OPERATION_ARTIFACT_PERSONAL_READ_SECRET_KEY: 'personal-password-123',
          GENERIC_OPERATION_ARTIFACT_CLEANUP_S3_ACCESS_KEY: 'cleanup-writer',
          GENERIC_OPERATION_ARTIFACT_CLEANUP_S3_SECRET_KEY: 'cleanup-password-123',
        },
      }),
      /artifact storage principals must be distinct/,
    );
    await assert.rejects(access(marker, fsConstants.F_OK), { code: 'ENOENT' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('MinIO bootstrap rejects any predecessor-layout version before provisioning mutation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'artifact-layout-preflight-'));
  const calls = join(directory, 'mc-calls');
  const fakeMc = join(directory, 'mc');
  await writeFile(
    fakeMc,
    `#!/bin/sh
printf '%s\\n' "$*" >> "$MC_CALLS"
case "$*" in
  'alias set '*) exit 0 ;;
  'ls deployment') printf '%s\\n' '[date] 0B operation-artifacts-test/'; exit 0 ;;
  'ls --recursive --versions '*) printf '%s\\n' '[old-version] DELETE sha256/aa/example'; exit 0 ;;
  *) exit 0 ;;
esac
`,
    'utf8',
  );
  await chmod(fakeMc, 0o700);
  try {
    await assert.rejects(
      execFileAsync('/bin/sh', ['infra/minio/bootstrap.sh'], {
        cwd: new URL('..', import.meta.url),
        env: {
          PATH: directory,
          MC_CALLS: calls,
          MINIO_ENDPOINT: 'http://minio:9000',
          MINIO_ROOT_USER: 'root-principal',
          MINIO_ROOT_PASSWORD: 'root-password-123',
          S3_BUCKET: 'site-assets-test',
          GENERIC_OPERATION_ARTIFACT_S3_BUCKET: 'operation-artifacts-test',
          GENERIC_OPERATION_ARTIFACT_S3_ACCESS_KEY: 'runtime-principal',
          GENERIC_OPERATION_ARTIFACT_S3_SECRET_KEY: 'runtime-password-123',
          GENERIC_OPERATION_ARTIFACT_PERSONAL_READ_ACCESS_KEY: 'personal-reader',
          GENERIC_OPERATION_ARTIFACT_PERSONAL_READ_SECRET_KEY: 'personal-password-123',
          GENERIC_OPERATION_ARTIFACT_CLEANUP_S3_ACCESS_KEY: 'cleanup-writer',
          GENERIC_OPERATION_ARTIFACT_CLEANUP_S3_SECRET_KEY: 'cleanup-password-123',
        },
      }),
      /GENERIC_OPERATION_ARTIFACT_LAYOUT_MIGRATION_REQUIRED/,
    );
    const observed = await readFile(calls, 'utf8');
    assert.match(observed, /ls --recursive --versions/);
    assert.doesNotMatch(observed, /(^|\n)mb /);
    assert.doesNotMatch(observed, /(^|\n)ilm /);
    assert.doesNotMatch(observed, /(^|\n)admin /);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('MinIO bootstrap treats bucket or version inventory failure as unavailable before mutation', async () => {
  for (const failureMode of ['bucket-inventory', 'version-inventory']) {
    const directory = await mkdtemp(join(tmpdir(), `artifact-layout-${failureMode}-`));
    const calls = join(directory, 'mc-calls');
    const fakeMc = join(directory, 'mc');
    await writeFile(
      fakeMc,
      `#!/bin/sh
printf '%s\\n' "$*" >> "$MC_CALLS"
case "$*" in
  'alias set '*) exit 0 ;;
  'ls deployment')
    if [ "$FAILURE_MODE" = bucket-inventory ]; then exit 7; fi
    printf '%s\\n' '[date] 0B operation-artifacts-test/'
    exit 0
    ;;
  'ls --recursive --versions '*)
    if [ "$FAILURE_MODE" = version-inventory ]; then exit 8; fi
    exit 0
    ;;
  *) exit 0 ;;
esac
`,
      'utf8',
    );
    await chmod(fakeMc, 0o700);
    try {
      await assert.rejects(
        execFileAsync('/bin/sh', ['infra/minio/bootstrap.sh'], {
          cwd: new URL('..', import.meta.url),
          env: minioBootstrapEnv(directory, calls, failureMode),
        }),
        /GENERIC_OPERATION_ARTIFACT_STORAGE_PREFLIGHT_UNAVAILABLE/,
      );
      const observed = await readFile(calls, 'utf8');
      assert.doesNotMatch(observed, /(^|\n)mb /);
      assert.doesNotMatch(observed, /(^|\n)ilm /);
      assert.doesNotMatch(observed, /(^|\n)encrypt /);
      assert.doesNotMatch(observed, /(^|\n)version /);
      assert.doesNotMatch(observed, /(^|\n)admin /);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

function minioBootstrapEnv(directory, calls, failureMode) {
  return {
    PATH: directory,
    MC_CALLS: calls,
    FAILURE_MODE: failureMode,
    MINIO_ENDPOINT: 'http://minio:9000',
    MINIO_ROOT_USER: 'root-principal',
    MINIO_ROOT_PASSWORD: 'root-password-123',
    S3_BUCKET: 'site-assets-test',
    GENERIC_OPERATION_ARTIFACT_S3_BUCKET: 'operation-artifacts-test',
    GENERIC_OPERATION_ARTIFACT_S3_ACCESS_KEY: 'runtime-principal',
    GENERIC_OPERATION_ARTIFACT_S3_SECRET_KEY: 'runtime-password-123',
    GENERIC_OPERATION_ARTIFACT_PERSONAL_READ_ACCESS_KEY: 'personal-reader',
    GENERIC_OPERATION_ARTIFACT_PERSONAL_READ_SECRET_KEY: 'personal-password-123',
    GENERIC_OPERATION_ARTIFACT_CLEANUP_S3_ACCESS_KEY: 'cleanup-writer',
    GENERIC_OPERATION_ARTIFACT_CLEANUP_S3_SECRET_KEY: 'cleanup-password-123',
  };
}

test('development API and Worker use one immutable image reference and wait for storage provisioning', async () => {
  const compose = await repositoryFile('infra/backend-runtime.compose.yml');
  const immutableImageUses = compose.match(/image: \$\{GLOBAL_BACKEND_IMAGE:\?/g) ?? [];
  assert.equal(immutableImageUses.length, 1);
  assert.match(compose, /NODE_ENV: production/);
  assert.match(compose, /RUNTIME_IMAGE_REFERENCE: \$\{GLOBAL_BACKEND_IMAGE\}/);
  assert.doesNotMatch(compose, /GLOBAL_BACKEND_IMAGE_DIGEST/);
  assert.match(compose, /api:\n[\s\S]*command: \["api"\]/);
  assert.match(compose, /worker:\n[\s\S]*command: \["customer-worker"\]/);
  assert.match(compose, /platform-worker:\n[\s\S]*command: \["platform-worker"\]/);
  assert.match(compose, /minio-bootstrap:\n\s+condition: service_completed_successfully/g);
  for (const name of [
    'GENERIC_OPERATION_ARTIFACT_S3_ENDPOINT',
    'GENERIC_OPERATION_ARTIFACT_S3_BUCKET',
    'GENERIC_OPERATION_ARTIFACT_S3_REGION',
    'GENERIC_OPERATION_ARTIFACT_S3_ACCESS_KEY',
    'GENERIC_OPERATION_ARTIFACT_S3_SECRET_KEY',
    'GENERIC_OPERATION_ARTIFACT_S3_FORCE_PATH_STYLE',
  ]) {
    assert.match(compose, new RegExp(`${name}: \\$\\{${name}`));
  }
  for (const name of ['GENERIC_OPERATION_ARTIFACT_CLEANUP_S3_ACCESS_KEY', 'GENERIC_OPERATION_ARTIFACT_CLEANUP_S3_SECRET_KEY']) {
    const apiService = compose.slice(compose.indexOf('\n  api:'), compose.indexOf('\n  worker:'));
    const workerService = compose.slice(compose.indexOf('\n  worker:'));
    assert.match(workerService, new RegExp(`${name}: \\$\\{${name}`));
    assert.doesNotMatch(apiService, new RegExp(`${name}:`));
  }
  for (const name of ['MINIO_ROOT_USER', 'MINIO_ROOT_PASSWORD', 'MINIO_KMS_SECRET_KEY', 'GENERIC_OPERATION_ARTIFACT_PERSONAL_READ_ACCESS_KEY', 'GENERIC_OPERATION_ARTIFACT_PERSONAL_READ_SECRET_KEY']) {
    assert.doesNotMatch(compose, new RegExp(`${name}:`));
  }
  const apiService = compose.slice(compose.indexOf('\n  api:'), compose.indexOf('\n  worker:'));
  const workerService = compose.slice(compose.indexOf('\n  worker:'), compose.indexOf('\n  platform-worker:'));
  const serviceEnvFiles = (section) => [...section.matchAll(/^\s+- (\.secrets\/[A-Za-z0-9._-]+\.env)$/gm)].map((match) => match[1]);
  assert.deepEqual(serviceEnvFiles(apiService), ['.secrets/backend-runtime.env', '.secrets/backend-api-runtime.env']);
  assert.deepEqual(serviceEnvFiles(workerService), ['.secrets/backend-runtime.env', '.secrets/backend-worker-runtime.env']);
  const platformService = compose.slice(compose.indexOf('\n  platform-worker:'));
  assert.deepEqual(serviceEnvFiles(platformService), ['.secrets/backend-platform-worker-runtime.env']);
  assert.doesNotMatch(platformService, /site-build-settlement|backend-worker-runtime\.env|GENERIC_OPERATION_ARTIFACT_CLEANUP/);
  assert.doesNotMatch(compose, /GENERIC_OPERATION_ARTIFACT_S3_SECRET_KEY:\s+[^$\n]/);
  assert.doesNotMatch(compose, /build:/);
  assert.doesNotMatch(compose, /node dist\//);
  assert.match(compose, /x-backend-runtime:[\s\S]*\n  init: true\n/);
  assert.equal(compose.match(/\n  init: true\n/g)?.length, 1);
  assert.match(compose, /pids_limit: 256/);
  assert.match(compose, /mem_limit: \$\{GLOBAL_BACKEND_MEMORY_LIMIT:-4g\}/);
  assert.match(compose, /cpus: \$\{GLOBAL_BACKEND_CPU_LIMIT:-2\.0\}/);
  assert.match(compose, /nofile:\n\s+soft: 1024\n\s+hard: 1024/);
});

test('the development fast lane switch reaches only the API service and defaults to off', async () => {
  const compose = await repositoryFile('infra/backend-runtime.compose.yml');
  const sharedEnvironment = compose.slice(
    compose.indexOf('x-backend-environment:'),
    compose.indexOf('x-backend-runtime:'),
  );
  const apiService = compose.slice(compose.indexOf('\n  api:'), compose.indexOf('\n  worker:'));
  const workerServices = compose.slice(compose.indexOf('\n  worker:'));
  for (const name of ['RUNTIME_DEV_FAST_LANE_WORKSPACE_ID', 'RUNTIME_DEV_FAST_LANE_TEMPORAL_ADDRESS']) {
    assert.match(apiService, new RegExp(`^      ${name}: \\$\\{${name}:-\\}$`, 'm'));
    assert.doesNotMatch(sharedEnvironment, new RegExp(name));
    assert.doesNotMatch(workerServices, new RegExp(name));
  }
  // Only the source-built lane worker reads the expected schema digest.
  assert.doesNotMatch(compose, /RUNTIME_DEV_FAST_LANE_SCHEMA_DIGEST/);
});

test('runtime lease principals are provisioned without embedded credentials and split by process', async () => {
  const [compose, provision, verify] = await Promise.all([
    repositoryFile('infra/backend-runtime.compose.yml'),
    repositoryFile('infra/postgres/provision-runtime-lease-principals.sh'),
    repositoryFile('infra/postgres/verify-runtime-lease-principal-permissions.sh'),
  ]);
  assert.match(compose, /backend-api-runtime\.env/);
  assert.match(compose, /backend-worker-runtime\.env/);
  assert.match(provision, /RUNTIME_API_LEASE_PASSWORD/);
  assert.match(provision, /\\getenv api_password RUNTIME_API_LEASE_PASSWORD/);
  assert.match(provision, /PGPASSWORD/);
  assert.match(provision, /runtime_connection="\$\(node/);
  assert.match(provision, /\|\|[\s\S]*exit 1/);
  assert.doesNotMatch(provision, /--set\s+api_password=/);
  assert.doesNotMatch(provision, /--set\s+worker_password=/);
  assert.doesNotMatch(provision, /--set\s+platform_worker_password=/);
  assert.doesNotMatch(provision, /--set\s+relay_password=/);
  assert.doesNotMatch(provision, /psql\s+"\$\{RUNTIME_LEASE_PROVISION_DATABASE_URL\}"/);
  assert.match(provision, /REVOKE runtime_api, runtime_worker, runtime_platform_worker, runtime_outbox_relay/);
  assert.match(provision, /GRANT runtime_api TO/);
  assert.match(provision, /GRANT runtime_worker TO/);
  assert.match(provision, /GRANT runtime_platform_worker TO/);
  assert.match(provision, /GRANT runtime_outbox_relay TO/);
  assert.doesNotMatch(provision, /PASSWORD\s+'[^']+'/i);
  assert.match(verify, /register_api_runtime_process_lease/);
  assert.match(verify, /register_worker_runtime_process_lease/);
  assert.match(verify, /register_outbox_relay_runtime_process_lease/);
  assert.match(verify, /terminalize_api_runtime_process_lease/);
  assert.match(verify, /terminalize_worker_runtime_process_lease/);
  assert.match(verify, /terminalize_outbox_relay_runtime_process_lease/);
  assert.match(verify, /psql_denied/);
});

test('every keyring reader inherits the dedicated read-only secret directory', async () => {
  const compose = await repositoryFile('infra/backend-runtime.compose.yml');
  const common = compose.slice(compose.indexOf('x-backend-runtime:'), compose.indexOf('\nservices:'));
  assert.match(common, /volumes:[\s\S]*type: bind/);
  assert.match(common, /source: \$\{SITE_BUILD_SETTLEMENT_SECRET_DIRECTORY:-\.\/\.secrets\/site-build-settlement\}/);
  assert.match(common, /target: \/run\/secrets\/site-build-settlement/);
  assert.match(common, /read_only: true[\s\S]*bind:\n\s+create_host_path: false/);
  assert.match(compose, /SITE_BUILD_SETTLEMENT_DERIVATION_KEYRING_FILE: \/run\/secrets\/site-build-settlement\/derivation\.keyring/);
  const services = compose.slice(compose.indexOf('\nservices:'));
  assert.equal(services.match(/<<: \*backend-runtime/g)?.length, 3);
  const customerServices = services.slice(0, services.indexOf('\n  platform-worker:'));
  assert.equal(customerServices.match(/target: \/run\/secrets\/site-build-settlement/g)?.length, 2);
  const platformService = services.slice(services.indexOf('\n  platform-worker:'));
  assert.doesNotMatch(platformService, /site-build-settlement/);
  assert.doesNotMatch(common, /source: \.\/?\.secrets\s*$/m);
});

test('platform writer principal provisioning is exclusive, fail-closed, and secret-safe', async () => {
  const [provision, verify] = await Promise.all([
    repositoryFile('infra/postgres/provision-execution-budget-platform-writer.sh'),
    repositoryFile('infra/postgres/verify-execution-budget-platform-writer.sh'),
  ]);
  for (const script of [provision, verify]) {
    assert.match(script, /^#!\/usr\/bin\/env bash\nset -euo pipefail/m);
    assert.doesNotMatch(script, /set -x/);
    assert.doesNotMatch(script, /DROP ROLE/);
    assert.doesNotMatch(script, /\bDATABASE_URL\b|\bAPP_DATABASE_URL\b/);
  }
  assert.match(provision, /EXECUTION_BUDGET_PLATFORM_WRITER_PROVISION_DATABASE_URL/);
  assert.match(provision, /EXECUTION_BUDGET_PLATFORM_WRITER_LOGIN/);
  assert.match(provision, /EXECUTION_BUDGET_PLATFORM_WRITER_PASSWORD/);
  assert.match(provision, /\\getenv platform_writer_password/);
  assert.match(provision, /execution_budget_platform_writer/);
  assert.match(provision, /pg_shdepend/);
  assert.match(provision, /membership\.admin_option/);
  assert.match(provision, /membership\.roleid = principal\.oid/);
  assert.match(provision, /pg_auth_members[\s\S]*group_role\.rolname = 'execution_budget_platform_writer'/);
  assert.doesNotMatch(provision, /pg_has_role\(/);
  assert.match(verify, /EXECUTION_BUDGET_PLATFORM_WRITER_DATABASE_URL/);
  assert.match(verify, /EXECUTION_BUDGET_PLATFORM_WRITER_PROVISION_DATABASE_URL/);
  assert.match(verify, /new URL\(value\)/);
  assert.match(verify, /parse_url ADMIN/);
  assert.match(verify, /parse_url WRITER/);
  assert.doesNotMatch(verify, /psql "\$\{EXECUTION_BUDGET_PLATFORM_WRITER_(?:PROVISION_)?DATABASE_URL\}"/);
  assert.match(verify, /inspect_platform_execution_authority_freshness_v1/);
  assert.match(verify, /ingest_and_admit_platform_execution_budget_run_v2/);
  assert.doesNotMatch(verify, /SELECT \* FROM ingest_platform_execution_authority/);
  assert.match(verify, /ingest_and_admit_platform_execution_budget_run_v2/);
  assert.doesNotMatch(verify, /revoke_platform_execution_authority_v1\(UUID, TEXT, TIMESTAMPTZ\)/);
  assert.match(verify, /execution_budget_authority/);
  assert.match(verify, /SET LOCAL ROLE execution_budget_platform_writer/);
  assert.match(verify, /has_table_privilege\(session_user,'execution_budget_authority','INSERT'\)/);
  assert.match(verify, /INSERT INTO execution_budget_authority\(scope_key,authority_kind/);
});

test('provider-wire writer provisioning is dedicated, dual-role scoped, and secret-safe', async () => {
  const [provision, verify, disposable] = await Promise.all([
    repositoryFile('infra/postgres/provision-site-build-provider-wire-writer.sh'),
    repositoryFile('infra/postgres/verify-site-build-provider-wire-writer.sh'),
    repositoryFile('infra/postgres/verify-site-build-provider-wire-writer-disposable.sh'),
  ]);
  for (const script of [provision, verify, disposable]) {
    assert.match(script, /^#!\/usr\/bin\/env bash\nset -euo pipefail/m);
    assert.doesNotMatch(script, /set -x/);
    assert.doesNotMatch(script, /PASSWORD\s+'[^']+'/i);
  }
  assert.doesNotMatch(provision, /\bDATABASE_URL\b|\bAPP_DATABASE_URL\b/);
  assert.doesNotMatch(disposable, /\bDATABASE_URL\b|\bAPP_DATABASE_URL\b/);
  assert.match(provision, /SITE_BUILD_PROVIDER_WIRE_PROVISION_DATABASE_URL/);
  assert.match(provision, /SITE_BUILD_PROVIDER_WIRE_LOGIN/);
  assert.match(provision, /SITE_BUILD_PROVIDER_WIRE_PASSWORD/);
  assert.match(provision, /\\getenv provider_wire_password/);
  assert.match(provision, /GRANT app_user, runtime_worker TO/);
  assert.match(provision, /pg_shdepend/);
  assert.match(verify, /SITE_BUILD_PROVIDER_WIRE_DATABASE_URL/);
  assert.match(verify, /APP_DATABASE_URL/);
  assert.match(verify, /parse_url APP APP_DATABASE_URL/);
  assert.match(verify, /SITE_BUILD_PROVIDER_WIRE_EXPECTED_MIGRATION_REVISION/);
  assert.match(verify, /EXISTS \([\s\S]*migration_name = :'expected_migration'/);
  assert.doesNotMatch(verify, /psql "\$\{APP_DATABASE_URL\}"/);
  assert.match(verify, /pg_auth_members/);
  assert.match(verify, /membership\.admin_option/);
  assert.match(verify, /membership\.inherit_option/);
  assert.match(verify, /reserve_site_build_model_spend_v1/);
  assert.match(verify, /finalize_site_build_provider_wire_not_dispatched_v1/);
  for (const functionName of [
    'reserve_site_build_model_spend_v1',
    'allocate_site_build_provider_wire_v1',
    'begin_site_build_provider_wire_v1',
    'claim_site_build_provider_readback_probe_v1',
    'record_site_build_provider_readback_probe_v1',
    'record_site_build_provider_wire_receipt_v1',
    'finalize_site_build_provider_wire_v1',
    'finalize_site_build_provider_wire_from_receipt_v1',
    'finalize_site_build_provider_wire_not_dispatched_v1',
  ]) {
    assert.ok(verify.match(new RegExp(functionName, 'g'))?.length >= 2, `${functionName} must be checked for writer grant and cross-role denial`);
  }
  assert.match(verify, /runtime_api/);
  assert.match(verify, /runtime_outbox_relay/);
  assert.match(disposable, /SITE_BUILD_PROVIDER_WIRE_DISPOSABLE_TEST/);
  assert.match(disposable, /GRANT runtime_api/);
  assert.match(disposable, /REVOKE runtime_api/);
  assert.match(disposable, /DRIFT_NOT_REJECTED/);
  assert.match(disposable, /ADMIN_OPTION_DRIFT_NOT_REJECTED/);
  assert.match(disposable, /INHERIT_OPTION_DRIFT_NOT_REJECTED/);
});

test('disposable platform writer drift harness keeps every database URL out of argv and records cleanup inverses', async () => {
  const harness = await repositoryFile('infra/postgres/verify-execution-budget-platform-writer-disposable-drift.sh');
  assert.match(harness, /parse ADMIN/);
  assert.match(harness, /parse WRITER/);
  assert.match(harness, /parse APP/);
  assert.match(harness, /new URL\(v\)/);
  assert.doesNotMatch(harness, /psql "\$/);
  assert.match(harness, /ledger=\(\)/);
  assert.match(harness, /DISPOSABLE_CLEANUP_FAILED/);
  assert.match(harness, /trap 'cleanup \|\| exit 1' EXIT/);
  assert.match(harness, /DRIFT_RESTORE_FAILED/);
  assert.match(harness, /unset "ledger\[/);
  assert.match(harness, /FAILURE_INJECT_AFTER_DRIFT/);
  assert.match(harness, /DROP ROLE task3_nested/);
  assert.match(harness, /PLATFORM_WRITER_FAILURE_INJECTED:superuser/);
  assert.match(harness, /REVOKE EXECUTE ON FUNCTION acknowledge_platform_egress_v1/);
  assert.match(harness, /REVOKE EXECUTE ON FUNCTION inspect_platform_execution_authority_freshness_v1/);
  assert.match(harness, /SET SESSION AUTHORIZATION runtime_api/);
});

test('disposable platform writer provisioning safety exercises identity reuse against PostgreSQL', async () => {
  const harness = await repositoryFile('infra/postgres/verify-execution-budget-platform-writer-provision-safety-disposable.sh');
  assert.match(harness, /EXECUTION_BUDGET_PLATFORM_WRITER_DISPOSABLE_TEST/);
  assert.match(harness, /assert_rejected_before_password_change/);
  assert.match(harness, /SUPERUSER BYPASSRLS CREATEDB CREATEROLE REPLICATION/);
  assert.match(harness, /OWNERSHIP/);
  assert.match(harness, /UNEXPECTED_MEMBERSHIP/);
  assert.match(harness, /OUTBOUND_MEMBERSHIP/);
  assert.match(harness, /DIRECT_ACL/);
  assert.match(harness, /DEFAULT_ACL/);
  assert.match(harness, /authenticate_probe/);
  assert.match(harness, /DROP ROLE/);
  assert.doesNotMatch(harness, /psql "\$/);
});

test('legacy systemd units delegate to the immutable compose runtime instead of mutable checkout dist', async () => {
  const [api, worker, readme, compose, main, temporalWorker] = await Promise.all([
    repositoryFile('infra/systemd/global-api.service'),
    repositoryFile('infra/systemd/global-worker.service'),
    repositoryFile('infra/systemd/README.md'),
    repositoryFile('infra/backend-runtime.compose.yml'),
    repositoryFile('apps/api/src/main.ts'),
    repositoryFile('apps/api/src/temporal/worker.ts'),
  ]);
  for (const unit of [api, worker]) {
    assert.doesNotMatch(unit, /node\s+dist\//);
    assert.match(unit, /docker compose/);
    assert.match(unit, /backend-runtime\.compose\.yml/);
    assert.equal(unit.match(/--env-file \/global\/backend\/\.secrets\/minio-bootstrap\.env/g)?.length, 3);
    assert.equal(unit.match(/--env-file \/global\/backend\/\.secrets\/backend-runtime\.env/g)?.length, 3);
    assert.doesNotMatch(unit, /EnvironmentFile=.*minio-bootstrap\.env/);
    for (const directive of ['ExecStartPre', 'ExecStart', 'ExecStop']) {
      const line = unit.split('\n').find((candidate) => candidate.startsWith(`${directive}=`));
      assert.ok(line);
      assert.match(line, /docker compose --env-file \/global\/backend\/\.secrets\/minio-bootstrap\.env --env-file \/global\/backend\/\.secrets\/backend-runtime\.env/);
    }
    assert.match(unit, /^TimeoutStopSec=120s$/m);
  }
  assert.match(compose, /^\s+stop_grace_period: 90s$/m);
  assert.match(main, /app\.enableShutdownHooks\(\['SIGTERM', 'SIGINT'\]\)/);
  assert.match(temporalWorker, /Runtime\.install\(\{ shutdownSignals: \[\] \}\)/);
  assert.match(temporalWorker, /startWorkerProcessSignalCoordinator/);
  assert.ok(temporalWorker.indexOf('Runtime.install({ shutdownSignals: [] })') < temporalWorker.indexOf('startWorkerProcessSignalCoordinator({'));
  assert.match(temporalWorker, /await connection\.close\(\)\.catch\(\(\) => undefined\)/);
  assert.match(readme, /docker compose \\\n+  --env-file \/global\/backend\/\.secrets\/minio-bootstrap\.env \\\n+  --env-file \/global\/backend\/\.secrets\/backend-runtime\.env/);
  assert.match(readme, /http:\/\/127\.0\.0\.1:3000\/api\/v1\/health\/build/);
  assert.match(readme, /http:\/\/127\.0\.0\.1:3000\/api\/v1\/health\/ready/);
});

test('GrowthOS reaches the loopback backend only through an explicit Unix socket relay', async () => {
  const [socket, service, readme] = await Promise.all([
    repositoryFile('infra/systemd/global-backend-growthos-relay.socket'),
    repositoryFile('infra/systemd/global-backend-growthos-relay.service'),
    repositoryFile('infra/systemd/README.md'),
  ]);
  assert.match(socket, /ListenStream=\/run\/global-backend-growthos\/backend\.sock/);
  assert.deepEqual(
    [...socket.matchAll(/^ListenStream=(.+)$/gm)].map((match) => match[1]),
    ['/run/global-backend-growthos/backend.sock'],
  );
  assert.match(socket, /SocketGroup=global-backend-growthos/);
  assert.match(socket, /SocketMode=0660/);
  assert.match(socket, /DirectoryMode=0711/);
  assert.match(socket, /RemoveOnStop=true/);
  assert.match(service, /Requires=global-api\.service/);
  assert.match(service, /After=global-api\.service/);
  assert.match(service, /ExecStart=\/usr\/lib\/systemd\/systemd-socket-proxyd 127\.0\.0\.1:3000/);
  assert.match(service, /RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6/);
  assert.doesNotMatch(service, /0\.0\.0\.0|172\.|host\.docker\.internal/);
  assert.match(readme, /global-backend-growthos-relay\.socket/);
  assert.match(readme, /global-backend-growthos/);
  assert.match(readme, /AF_UNIX/);
});

function assertGhcrPublicationContract(workflow) {
  assert.match(workflow, /^name: Publish immutable runtime image$/m);
  assert.match(workflow, /^on:\n  workflow_dispatch:\s*$/m);
  assert.doesNotMatch(workflow, /^  (push|pull_request|schedule):/m);
  assert.match(workflow, /^permissions:\n  contents: read\n  packages: write\n  id-token: write\n  attestations: write$/m);
  assert.doesNotMatch(workflow, /^    permissions:/m);
  assert.match(workflow, /if: github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /environment: runtime-image-publication/);
  assert.match(workflow, /timeout-minutes: 60/);
  assert.match(workflow, /uses: actions\/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7/);
  assert.match(workflow, /uses: actions\/attest@1e69f48acb82d1966a394da916b4c1698aa569d6 # v4\.2\.2/);
  assert.equal(workflow.match(/uses: actions\/attest@1e69f48acb82d1966a394da916b4c1698aa569d6 # v4\.2\.2/g)?.length, 2);
  assert.match(workflow, /fetch-depth: 0/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /IMAGE_NAME: ghcr\.io\/mlhjyx\/global-backend/);
  assert.match(workflow, /SUBJECT_SHA: \$\{\{ github\.sha \}\}/);
  assert.match(workflow, /git rev-parse origin\/main/);
  assert.equal(workflow.match(/test "\$\{SUBJECT_SHA\}" = "\$\{MAIN_SHA\}"/g)?.length, 2);
  const publishStep = workflow.indexOf('      - id: publish');
  const secondMainCheck = workflow.lastIndexOf('test "${SUBJECT_SHA}" = "${MAIN_SHA}"');
  const push = workflow.indexOf('docker push "${IMAGE_TAG}"', publishStep);
  assert.ok(publishStep > 0 && secondMainCheck > publishStep && push > secondMainCheck);
  const configAttestation = workflow.indexOf('name: Attest the local image config before publication');
  assert.ok(configAttestation > 0 && configAttestation < push);
  assert.match(workflow, /docker login ghcr\.io[\s\S]*--password-stdin/);
  assert.match(workflow, /id: existing/);
  assert.match(workflow, /node scripts\/ghcr-runtime-publication\.mjs resolve[\s\S]*--github-output "\$\{GITHUB_OUTPUT\}"/);
  assert.match(workflow, /if: steps\.existing\.outputs\.exists != 'true'/);
  assert.match(workflow, /--build-arg "BUILD_SHA=\$\{SUBJECT_SHA\}"/);
  // resolve 只接受单清单（拒绝 index，见 ghcr-runtime-publication.spec.mjs）；containerd
  // 存储下必须关掉 buildx 内嵌 provenance/SBOM 清单，否则推送的标签会指向 OCI index。
  assert.match(workflow, /--provenance=false/);
  assert.match(workflow, /--sbom=false/);
  assert.match(workflow, /--build-arg "BUILT_AT=\$\{BUILT_AT\}"/);
  assert.match(workflow, /docker push "\$\{IMAGE_TAG\}"/);
  assert.doesNotMatch(workflow, /PUSH_OUTPUT|digest: \(sha256:/);
  assert.match(workflow, /LOCAL_IMAGE_ID/);
  assert.match(workflow, /docker save/);
  assert.match(workflow, /manifest\.json/);
  assert.match(workflow, /sha256sum/);
  assert.equal(workflow.match(/node scripts\/docker-image-config-path\.mjs/g)?.length, 3);
  // 身份校验与 Docker 存储驱动无关（2026-11-01 runner 切到 containerd 存储后 .Id 变为
  // manifest 摘要）：构建侧自校验归档内 Config 条目，发布侧比对拉回镜像的 config 字节哈希。
  assert.match(workflow, /printf 'config_digest=%s\\n' "\$\{CONFIG_DIGEST\}" >> "\$\{GITHUB_OUTPUT\}"/);
  assert.match(workflow, /docker save --output "\$\{PULLED_ARCHIVE\}" "\$\{IMAGE_REFERENCE\}"/);
  assert.match(workflow, /test "sha256:\$\(sha256sum "\$\{PULLED_CONFIG\}" \| cut -d ' ' -f 1\)" = "\$\{LOCAL_CONFIG_DIGEST\}"/);
  assert.match(workflow, /docker pull "\$\{IMAGE_REFERENCE\}"/);
  assert.equal(workflow.match(/runtime-image-verifier\.mjs \/app/g)?.length, 2);
  assert.equal(workflow.match(/gh attestation verify/g)?.length, 3);
  assert.equal(workflow.match(/--bundle-from-oci/g)?.length, 2);
  assert.match(workflow, /steps\.existing_provenance\.outputs\.registry_attested != 'true'/);
  assert.match(workflow, /subject-path: \$\{\{ steps\.build\.outputs\.config_path \}\}/);
  assert.match(workflow, /subject-digest: \$\{\{ steps\.existing\.outputs\.image_digest \|\| steps\.publish\.outputs\.image_digest \}\}/);
  for (const flag of [
    '--repo "${GITHUB_REPOSITORY}"',
    '--signer-workflow "${GITHUB_REPOSITORY}/.github/workflows/publish-runtime-image.yml"',
    '--signer-digest "${SUBJECT_SHA}"',
    '--source-ref refs/heads/main',
    '--source-digest "${SUBJECT_SHA}"',
    '--deny-self-hosted-runners',
  ]) {
    assert.equal(workflow.split(flag).length - 1, 3, `missing attestation flag ${flag}`);
  }
  assert.match(workflow, /org\.opencontainers\.image\.revision/);
  assert.match(workflow, /Config\.User/);
  assert.match(workflow, /Config\.Entrypoint/);
  assert.doesNotMatch(workflow, /(?:^|[:\s])latest(?:$|[\s"'])/m);
  assert.doesNotMatch(workflow, /secrets\.(?!GITHUB_TOKEN)/);
}

test('GHCR publication is manual, exact-main only, publish-once, digest read back, and minimally privileged', async () => {
  const workflow = await repositoryFile('.github/workflows/publish-runtime-image.yml');
  assertGhcrPublicationContract(workflow);
});

test('GHCR publication contract rejects removed main recheck and job-level permission widening', async () => {
  const workflow = await repositoryFile('.github/workflows/publish-runtime-image.yml');
  const equality = 'test "${SUBJECT_SHA}" = "${MAIN_SHA}"';
  const secondEqualityIndex = workflow.lastIndexOf(equality);
  const withoutSecondMainCheck = workflow.slice(0, secondEqualityIndex) + 'true # removed exact-main comparison' + workflow.slice(secondEqualityIndex + equality.length);
  assert.throws(() => assertGhcrPublicationContract(withoutSecondMainCheck));

  const widenedJobPermissions = workflow.replace('  publish:\n', '  publish:\n    permissions:\n      actions: write\n');
  assert.throws(() => assertGhcrPublicationContract(widenedJobPermissions));

  const withoutProvenanceVerification = workflow.replace('gh attestation verify', 'true # removed provenance verification');
  assert.throws(() => assertGhcrPublicationContract(withoutProvenanceVerification));

  const withoutPrepushConfigAttestation = workflow.replace('name: Attest the local image config before publication', 'name: Removed local config attestation');
  assert.throws(() => assertGhcrPublicationContract(withoutPrepushConfigAttestation));
});
