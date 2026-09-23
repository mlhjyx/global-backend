import { pathToFileURL } from "node:url";

const MAX_BYTES = 64 * 1024;
const ERROR_CODE = "PLATFORM_TEMPORAL_NAMESPACE_DRIFT";
const CUSTOMER_ERROR_CODE = "TEMPORAL_CUSTOMER_NAMESPACE_DRIFT";
const UNKNOWN_CONTRACT = "TEMPORAL_NAMESPACE_CONTRACT_UNKNOWN";
const RETENTION = "604800s";

function parseDescribe(source, code) {
  const drift = () => {
    throw new Error(code);
  };
  if (typeof source !== "string" || Buffer.byteLength(source) > MAX_BYTES)
    drift();
  let value;
  try {
    value = JSON.parse(source);
  } catch {
    drift();
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) drift();
  return { value, drift };
}

function registeredLocal(value) {
  return (
    ["Registered", "NAMESPACE_STATE_REGISTERED"].includes(
      value.namespaceInfo?.state,
    ) &&
    value.config?.workflowExecutionRetentionTtl === RETENTION &&
    (value.isGlobalNamespace === undefined || value.isGlobalNamespace === false)
  );
}

/** Validate DescribeNamespace JSON, never repair an unknown namespace's state. */
export function validatePlatformNamespace(source) {
  const { value, drift } = parseDescribe(source, ERROR_CODE);
  const info = value.namespaceInfo;
  const data = info?.data;
  if (
    info?.name !== "platform-automation" ||
    !registeredLocal(value) ||
    info?.description !==
      "Dedicated non-tenant platform automation workflows" ||
    !data ||
    Array.isArray(data) ||
    Object.keys(data).sort().join(",") !==
      "platform_contract,platform_non_tenant" ||
    data.platform_non_tenant !== "true" ||
    data.platform_contract !== "1"
  )
    drift();
  return true;
}

/** The customer namespace used by customer-worker and the API holds tenant
 * workflows, so it carries no ownership claim at all: a platform marker here
 * would misstate what its histories contain. Existing state is never repaired. */
export function validateCustomerNamespace(source) {
  const { value, drift } = parseDescribe(source, CUSTOMER_ERROR_CODE);
  const info = value.namespaceInfo;
  const data = info?.data ?? {};
  if (
    info?.name !== "default" ||
    !registeredLocal(value) ||
    ![undefined, ""].includes(info?.description) ||
    typeof data !== "object" ||
    Array.isArray(data) ||
    Object.keys(data).length
  )
    drift();
  return true;
}

const CONTRACTS = {
  "platform-automation": [validatePlatformNamespace, ERROR_CODE],
  default: [validateCustomerNamespace, CUSTOMER_ERROR_CODE],
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = process.argv.slice(2);
  // No argument keeps the original platform-only invocation.
  const name = args.length === 0 ? "platform-automation" : args[0];
  if (args.length > 1 || !Object.hasOwn(CONTRACTS, name)) {
    process.stderr.write(`${UNKNOWN_CONTRACT}\n`);
    process.exitCode = 1;
  } else {
    const [validate, code] = CONTRACTS[name];
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of process.stdin) {
        size += chunk.length;
        if (size > MAX_BYTES) throw new Error(code);
        chunks.push(chunk);
      }
      const source = new TextDecoder("utf-8", { fatal: true }).decode(
        Buffer.concat(chunks),
      );
      validate(source);
      process.stdout.write(`${name} namespace contract verified\n`);
    } catch {
      process.stderr.write(`${code}\n`);
      process.exitCode = 1;
    }
  }
}
