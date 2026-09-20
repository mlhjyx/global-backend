import { pathToFileURL } from "node:url";

const MAX_BYTES = 64 * 1024;
const ERROR_CODE = "PLATFORM_TEMPORAL_NAMESPACE_DRIFT";

function drift() {
  throw new Error(ERROR_CODE);
}

/** Validate DescribeNamespace JSON, never repair an unknown namespace's state. */
export function validatePlatformNamespace(source) {
  if (typeof source !== "string" || Buffer.byteLength(source) > MAX_BYTES)
    drift();
  let value;
  try {
    value = JSON.parse(source);
  } catch {
    drift();
  }
  const info = value?.namespaceInfo;
  const data = info?.data;
  if (
    !value ||
    Array.isArray(value) ||
    info?.name !== "platform-automation" ||
    !["Registered", "NAMESPACE_STATE_REGISTERED"].includes(info?.state) ||
    info?.description !==
      "Dedicated non-tenant platform automation workflows" ||
    !data ||
    Array.isArray(data) ||
    Object.keys(data).sort().join(",") !==
      "platform_contract,platform_non_tenant" ||
    data.platform_non_tenant !== "true" ||
    data.platform_contract !== "1" ||
    value?.config?.workflowExecutionRetentionTtl !== "604800s" ||
    (value.isGlobalNamespace !== undefined && value.isGlobalNamespace !== false)
  )
    drift();
  return true;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of process.stdin) {
      size += chunk.length;
      if (size > MAX_BYTES) drift();
      chunks.push(chunk);
    }
    const source = new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.concat(chunks),
    );
    validatePlatformNamespace(source);
    process.stdout.write("platform-automation namespace contract verified\n");
  } catch {
    process.stderr.write(`${ERROR_CODE}\n`);
    process.exitCode = 1;
  }
}
