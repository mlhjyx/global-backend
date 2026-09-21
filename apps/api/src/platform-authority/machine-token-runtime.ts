import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import {
  MachineTokenClient,
  type MachineTokenClientConfiguration,
} from "./machine-token-client";
import type { RemoteMachineProfile } from "./machine-token-verifier";

function invalid(): never {
  throw new Error("MACHINE_RUNTIME_CONFIGURATION_INVALID");
}

/** Open without following a last-component symlink, then validate the opened inode. */
export async function readMachineSecretFile(path: string): Promise<Buffer> {
  if (!path || !isAbsolute(path)) invalid();
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  ).catch(invalid);
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.size < 1 ||
      stat.size > 65536
    )
      invalid();
    const result = await file.readFile();
    if (result.length < 1 || result.length > 65536) invalid();
    return result;
  } finally {
    await file.close();
  }
}

export async function machineTokenConfiguration(
  profile: RemoteMachineProfile,
  runtimeIdentity: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<MachineTokenClientConfiguration> {
  const required = (key: string): string => {
    const value = env[key];
    if (!value || value !== value.trim()) invalid();
    return value;
  };
  const prefix =
    profile === "capability-request"
      ? "CAPABILITY_MACHINE"
      : "TEMPORAL_MACHINE";
  const [ca, certificate, privateKey] = await Promise.all([
    readMachineSecretFile(required("MACHINE_BOOTSTRAP_CA_FILE")),
    readMachineSecretFile(required("MACHINE_BOOTSTRAP_CERT_FILE")),
    readMachineSecretFile(required("MACHINE_BOOTSTRAP_KEY_FILE")),
  ]);
  return Object.freeze({
    profile,
    runtimeIdentity,
    endpoint: required("MACHINE_BOOTSTRAP_ENDPOINT"),
    jwksUri: required(`${prefix}_JWKS_URI`),
    issuer: required(`${prefix}_ISSUER`),
    audience: required(`${prefix}_AUDIENCE`),
    subject: required(`${prefix}_SUBJECT`),
    configurationRevision: required("MACHINE_BOOTSTRAP_CONFIGURATION_REVISION"),
    ca,
    certificate,
    privateKey,
  });
}

export async function createRuntimeMachineTokenClient(
  profile: RemoteMachineProfile,
  runtimeIdentity: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  const configuration = await machineTokenConfiguration(
    profile,
    runtimeIdentity,
    env,
  );
  const client = new MachineTokenClient(configuration);
  configuration.privateKey.fill(0);
  try {
    await client.getToken();
  } catch {
    client.close();
    throw new Error("PLATFORM_MACHINE_TOKEN_UNAVAILABLE");
  }
  return { client, subject: configuration.subject };
}

export async function temporalTlsConfiguration(
  env: NodeJS.ProcessEnv = process.env,
) {
  const address = env.TEMPORAL_ADDRESS;
  const serverNameOverride = env.TEMPORAL_TLS_SERVER_NAME;
  if (
    !address ||
    !serverNameOverride ||
    !/^[A-Za-z0-9.-]+$/.test(serverNameOverride)
  )
    invalid();
  return {
    address,
    tls: {
      serverRootCACertificate: await readMachineSecretFile(
        env.TEMPORAL_TLS_CA_FILE ?? "",
      ),
      serverNameOverride,
    },
  };
}
