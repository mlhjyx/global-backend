import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";

import { COPY_SONNET_RECOVERY_RUNTIME_BINDING_OUTPUT_PATH } from "../src/site-builder/eval/copy-sonnet-recovery-contract";
import { createCopySonnetRecoveryOpenOxPricingTool } from "../src/site-builder/eval/copy-sonnet-recovery-openox-pricing-tool";
import {
  runAfterCopySonnetRecoverySourcePolicyRoleCheck,
  type CopySonnetRecoveryDatabaseRole,
} from "../src/site-builder/eval/copy-sonnet-recovery-preflight-database-role";
import { writeCopySonnetRecoveryZeroCallPreflightEvidence } from "../src/site-builder/eval/copy-sonnet-recovery-zero-call-preflight-writer";
import { ToolBroker } from "../src/tools/tool-broker";
import { sourcePolicyReaderFrom } from "../src/tools/tool-broker.factory";
import { ToolRegistry } from "../src/tools/tool-registry";

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value)
    throw new Error(`COPY_SONNET_RECOVERY_REQUIRED_ENV_MISSING:${name}`);
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

const sourcePolicyDb = new PrismaClient({
  datasourceUrl: requiredEnvironment("APP_DATABASE_URL"),
});
await sourcePolicyDb.$connect();
try {
  const summary = await runAfterCopySonnetRecoverySourcePolicyRoleCheck(
    () =>
      sourcePolicyDb.$queryRaw<CopySonnetRecoveryDatabaseRole[]>`
        SELECT current_user AS "currentUser",
               rolsuper AS "isSuper",
               rolbypassrls AS "bypassRls"
          FROM pg_roles
         WHERE rolname = current_user`,
    async () => {
      const registry = new ToolRegistry();
      registry.register(createCopySonnetRecoveryOpenOxPricingTool({ fetch }));
      const pricingBroker = new ToolBroker({
        registry,
        sourcePolicyReader: sourcePolicyReaderFrom(sourcePolicyDb),
        traceRecorder: (trace) => {
          process.stderr.write(
            `${JSON.stringify({
              event: "copy_sonnet_recovery_tool_broker_trace",
              toolId: trace.toolId,
              toolVersion: trace.toolVersion,
              status: trace.status,
              reason: trace.reason,
              costCents: trace.costCents,
              latencyMs: trace.latencyMs,
            })}\n`,
          );
        },
      });
      return writeCopySonnetRecoveryZeroCallPreflightEvidence({
        repositoryRoot,
        secretOutputPath: requiredEnvironment(
          "COPY_SONNET_RECOVERY_SECRET_OUTPUT_PATH",
        ),
        executionHeadCommit,
        runtimeBindingBytes: readFileSync(
          resolve(
            repositoryRoot,
            COPY_SONNET_RECOVERY_RUNTIME_BINDING_OUTPUT_PATH,
          ),
        ),
        adminBaseUrl,
        gatewayOrigin: adminBaseUrl,
        adminAccessToken: requiredEnvironment("NEW_API_ADMIN_ACCESS_TOKEN"),
        adminUserId,
        pricingBroker,
      });
    },
  );

  process.stdout.write(`${JSON.stringify(summary)}\n`);
} finally {
  await sourcePolicyDb.$disconnect();
}
