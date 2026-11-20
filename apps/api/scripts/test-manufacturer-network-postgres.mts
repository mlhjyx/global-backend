import {
  fixtureImageId,
  assertFixtureOwnership,
  assertFixtureVersion,
  MINIO_FIXTURE_LABEL,
} from "./manufacturer-minio-fixture.mjs";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  rmdirSync,
  readFileSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  S3Client,
  CreateBucketCommand,
  PutBucketVersioningCommand,
  PutBucketEncryptionCommand,
  PutBucketLifecycleConfigurationCommand,
  GetBucketVersioningCommand,
  GetBucketEncryptionCommand,
  GetBucketLifecycleConfigurationCommand,
} from "@aws-sdk/client-s3";

// Task-owned disposable resources only. Never accepts a shared DB URL or service
// name; exact generated names are retained until this process's cleanup runs.
const root = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const id = randomBytes(4).toString("hex");
const imageTaskId = randomBytes(16).toString("hex");
const pg = `manufacturer-network-pg-${id}`;
const minio = `manufacturer-network-minio-${id}`;
const secret = randomBytes(24).toString("hex");
const kmsKey = `manufacturer-test:${randomBytes(32).toString("base64")}`;
const localEnv = {
  ...process.env,
  DOCKER_CONTEXT: "default",
  APP_DATABASE_URL: "",
};
const directory = mkdtempSync(join(tmpdir(), "manufacturer-network-"));
const created: string[] = [];
let sourceImageId: string | undefined;
const buildContext = join(directory, "empty-context");
const iidFile = join(directory, "minio.iid");
function run(command: string, args: string[], env = localEnv, capture = false) {
  const result = spawnSync(command, args, {
    cwd: root,
    env,
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    encoding: "utf8",
  });
  if (result.status !== 0)
    throw new Error(
      `MANUFACTURER_TEST_COMMAND_FAILED:${command}:${result.status}`,
    );
  return result.stdout?.trim() ?? "";
}
function port(name: string, containerPort: number) {
  const output = run(
    "docker",
    ["port", name, `${containerPort}/tcp`],
    localEnv,
    true,
  );
  const match = /^127\.0\.0\.1:(\d+)$/u.exec(output);
  if (!match || match[1] === "15433")
    throw new Error("MANUFACTURER_TEST_PORT_INVALID");
  return match[1];
}
async function main() {
  mkdirSync(buildContext, { mode: 0o700 });
  run("docker", [
    "build",
    "--platform",
    "linux/amd64",
    "--pull=false",
    "--file",
    join(root, "infra/testing/manufacturer-minio.Dockerfile"),
    "--label",
    `${MINIO_FIXTURE_LABEL}=${imageTaskId}`,
    "--iidfile",
    iidFile,
    buildContext,
  ]);
  const candidate = fixtureImageId(readFileSync(iidFile, "utf8"));
  const metadata = run(
    "docker",
    [
      "image",
      "inspect",
      candidate,
      "--format",
      '{"id":{{json .Id}},"os":{{json .Os}},"architecture":{{json .Architecture}},"task":{{json (index .Config.Labels "global.manufacturer-fixture")}}}',
    ],
    localEnv,
    true,
  );
  assertFixtureOwnership(metadata, candidate, imageTaskId);
  sourceImageId = candidate;
  console.log(`manufacturer fixture source-built image ${sourceImageId}`);
  run(
    "docker",
    [
      "run",
      "--pull=never",
      "-d",
      "--rm",
      "--name",
      pg,
      "-p",
      "127.0.0.1::5432",
      "--tmpfs",
      "/var/lib/postgresql/data:rw,nosuid,size=1g",
      "-e",
      "POSTGRES_USER=global",
      "-e",
      `POSTGRES_PASSWORD=${secret}`,
      "-e",
      "POSTGRES_DB=global_test",
      "pgvector/pgvector@sha256:ccc6e83d6e35e931dc7c5def2022729d5a6c370318d099181995567ff1fb4d6b",
    ],
    localEnv,
    true,
  );
  created.push(pg);
  run(
    "docker",
    [
      "run",
      "--pull=never",
      "-d",
      "--rm",
      "--name",
      minio,
      "-p",
      "127.0.0.1::9000",
      "-e",
      "MINIO_ROOT_USER=manufacturer-test",
      "-e",
      `MINIO_ROOT_PASSWORD=${secret}`,
      "-e",
      `MINIO_KMS_SECRET_KEY=${kmsKey}`,
      sourceImageId,
      "server",
      "/data",
    ],
    localEnv,
    true,
  );
  created.push(minio);
  const version = run(
    "docker",
    ["exec", minio, "minio", "--version"],
    localEnv,
    true,
  );
  assertFixtureVersion(version);
  console.log(version);
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    const probe = spawnSync(
      "docker",
      [
        "exec",
        pg,
        "pg_isready",
        "-h",
        "127.0.0.1",
        "-U",
        "global",
        "-d",
        "global_test",
      ],
      { env: localEnv, stdio: "ignore" },
    );
    if (probe.status === 0) {
      ready = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (!ready) throw new Error("MANUFACTURER_TEST_PG_NOT_READY");
  const databaseUrl = `postgresql://global:${secret}@127.0.0.1:${port(pg, 5432)}/global_test`;
  const appUrl = `postgresql://app_user:app_pw@127.0.0.1:${port(pg, 5432)}/global_test`;
  run(
    "pnpm",
    ["--filter", "@global/db", "exec", "prisma", "migrate", "deploy"],
    { ...localEnv, DATABASE_URL: databaseUrl },
  );
  const endpoint = `http://127.0.0.1:${port(minio, 9000)}`;
  const bucket = `manufacturer-network-${id}`;
  const client = new S3Client({
    endpoint,
    region: "us-east-1",
    forcePathStyle: true,
    credentials: { accessKeyId: "manufacturer-test", secretAccessKey: secret },
    maxAttempts: 1,
  });
  try {
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
    await client.send(
      new PutBucketVersioningCommand({
        Bucket: bucket,
        VersioningConfiguration: { Status: "Enabled" },
      }),
    );
    await client.send(
      new PutBucketEncryptionCommand({
        Bucket: bucket,
        ServerSideEncryptionConfiguration: {
          Rules: [
            { ApplyServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } },
          ],
        },
      }),
    );
    await client.send(
      new PutBucketLifecycleConfigurationCommand({
        Bucket: bucket,
        LifecycleConfiguration: JSON.parse(
          readFileSync(
            join(root, "infra/minio/generic-operation-artifact-lifecycle.json"),
            "utf8",
          ),
        ),
      }),
    );
    const [versioning, encryption, lifecycle] = await Promise.all([
      client.send(new GetBucketVersioningCommand({ Bucket: bucket })),
      client.send(new GetBucketEncryptionCommand({ Bucket: bucket })),
      client.send(
        new GetBucketLifecycleConfigurationCommand({ Bucket: bucket }),
      ),
    ]);
    const personal = lifecycle.Rules?.find(
      (rule) => rule.ID === "generic-operation-artifact-personal-data-ttl",
    );
    if (
      versioning.Status !== "Enabled" ||
      encryption.ServerSideEncryptionConfiguration?.Rules?.[0]
        ?.ApplyServerSideEncryptionByDefault?.SSEAlgorithm !== "AES256" ||
      personal?.Status !== "Enabled" ||
      personal.Expiration?.Days !== 1 ||
      personal.NoncurrentVersionExpiration?.NoncurrentDays !== 1 ||
      personal.Filter?.Tag?.Key !== "artifact-privacy" ||
      personal.Filter.Tag.Value !== "PERSONAL_DATA"
    )
      throw new Error("MANUFACTURER_TEST_STORAGE_CONFIGURATION_INVALID");
    console.log(
      "manufacturer fixture storage: versioning Enabled, encryption AES256, PERSONAL_DATA lifecycle 1 day",
    );
  } finally {
    client.destroy();
  }
  const configFile = join(directory, "s3.json");
  writeFileSync(
    configFile,
    JSON.stringify({
      endpoint,
      bucket,
      accessKeyId: "manufacturer-test",
      secretAccessKey: secret,
    }),
    { mode: 0o600 },
  );
  run(
    "pnpm",
    [
      "--filter",
      "@global/api",
      "exec",
      "vitest",
      "run",
      "src/discovery/manufacturer-network.postgres.spec.ts",
      ...process.argv.slice(2),
    ],
    {
      ...localEnv,
      MANUFACTURER_TEST_DATABASE_URL: databaseUrl,
      MANUFACTURER_TEST_APP_DATABASE_URL: appUrl,
      MANUFACTURER_TEST_S3_CONFIG_FILE: configFile,
    },
  );
}
try {
  await main();
} finally {
  for (const name of created.reverse()) {
    try {
      run("docker", ["stop", name], localEnv, true);
    } catch {
      console.error(`MANUFACTURER_TEST_CLEANUP_FAILED:${name}`);
      process.exitCode = 1;
    }
  }
  if (sourceImageId) {
    try {
      run("docker", ["image", "rm", sourceImageId], localEnv, true);
    } catch {
      console.error("MANUFACTURER_TEST_IMAGE_CLEANUP_FAILED");
      process.exitCode = 1;
    }
  }
  rmSync(iidFile, { force: true });
  if (existsSync(buildContext)) rmdirSync(buildContext);
  rmSync(join(directory, "s3.json"), { force: true });
  rmdirSync(directory);
}
