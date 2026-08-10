import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";

import { COPY_SONNET_RECOVERY_RUNTIME_BINDING_OUTPUT_PATH } from "../src/site-builder/eval/copy-sonnet-recovery-contract";
import { writeCopySonnetRecoveryZeroCallPreflightEvidence } from "../src/site-builder/eval/copy-sonnet-recovery-zero-call-preflight-writer";

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`COPY_SONNET_RECOVERY_REQUIRED_ENV_MISSING:${name}`);
  return value;
}

const repositoryRoot = realpathSync(resolve(import.meta.dirname, "../../.."));
const executionHeadCommit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: repositoryRoot,
  encoding: "utf8",
  maxBuffer: 1024 * 1024,
}).trim();
const adminBaseUrl = requiredEnvironment("NEW_API_ADMIN_URL");
const adminUserId = Number(requiredEnvironment("NEW_API_ADMIN_USER_ID"));
if (!Number.isSafeInteger(adminUserId) || adminUserId <= 0) {
  throw new Error("COPY_SONNET_RECOVERY_ADMIN_USER_ID_INVALID");
}

const summary = await writeCopySonnetRecoveryZeroCallPreflightEvidence({
  repositoryRoot,
  secretOutputPath: requiredEnvironment(
    "COPY_SONNET_RECOVERY_SECRET_OUTPUT_PATH",
  ),
  executionHeadCommit,
  runtimeBindingBytes: readFileSync(
    resolve(repositoryRoot, COPY_SONNET_RECOVERY_RUNTIME_BINDING_OUTPUT_PATH),
  ),
  adminBaseUrl,
  gatewayOrigin: adminBaseUrl,
  adminAccessToken: requiredEnvironment("NEW_API_ADMIN_ACCESS_TOKEN"),
  adminUserId,
});

process.stdout.write(`${JSON.stringify(summary)}\n`);
