import { chmod, mkdtemp, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readMachineSecretFile,
  machineTokenConfiguration,
  temporalTlsConfiguration,
} from "./machine-token-runtime";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("machine runtime configuration", () => {
  it("rejects missing machine configuration rather than using a raw bearer", async () => {
    await expect(
      machineTokenConfiguration("temporal-customer-client", "a".repeat(64), {
        TEMPORAL_API_KEY: "legacy",
      }),
    ).rejects.toThrow("MACHINE_RUNTIME_CONFIGURATION_INVALID");
  });
  it("only loads private bounded regular mode0600 files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "machine-secret-test-"));
    temporaryDirectories.push(dir);
    const path = join(dir, "key");
    await writeFile(path, "private", { mode: 0o600 });
    expect((await readMachineSecretFile(path)).toString()).toBe("private");
    await chmod(path, 0o640);
    await expect(readMachineSecretFile(path)).rejects.toThrow(
      "MACHINE_RUNTIME_CONFIGURATION_INVALID",
    );
  });
  it("rejects symlinks, oversized, empty and relative files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "machine-secret-test-"));
    temporaryDirectories.push(dir);
    const path = join(dir, "key");
    await writeFile(path, "private", { mode: 0o600 });
    const link = join(dir, "link");
    await symlink(path, link);
    await expect(readMachineSecretFile(link)).rejects.toThrow(
      "MACHINE_RUNTIME_CONFIGURATION_INVALID",
    );
    await writeFile(path, Buffer.alloc(65537));
    await expect(readMachineSecretFile(path)).rejects.toThrow(
      "MACHINE_RUNTIME_CONFIGURATION_INVALID",
    );
    await writeFile(path, "");
    await expect(readMachineSecretFile(path)).rejects.toThrow(
      "MACHINE_RUNTIME_CONFIGURATION_INVALID",
    );
    await expect(readMachineSecretFile("key")).rejects.toThrow(
      "MACHINE_RUNTIME_CONFIGURATION_INVALID",
    );
  });
  it("uses fixed caller profile and the corresponding trusted configuration, never env bearer material", async () => {
    const dir = await mkdtemp(join(tmpdir(), "machine-secret-test-"));
    temporaryDirectories.push(dir);
    const path = join(dir, "material");
    await writeFile(path, "fixture", { mode: 0o600 });
    const env = {
      MACHINE_BOOTSTRAP_CA_FILE: path,
      MACHINE_BOOTSTRAP_CERT_FILE: path,
      MACHINE_BOOTSTRAP_KEY_FILE: path,
      MACHINE_BOOTSTRAP_ENDPOINT:
        "https://issuer.example/api/internal/v1/platform-machine-tokens",
      MACHINE_BOOTSTRAP_CONFIGURATION_REVISION: "a".repeat(64),
      TEMPORAL_MACHINE_JWKS_URI: "https://issuer.example/temporal/jwks",
      TEMPORAL_MACHINE_ISSUER: "issuer",
      TEMPORAL_MACHINE_AUDIENCE: "temporal",
      TEMPORAL_MACHINE_SUBJECT: "customer",
      CAPABILITY_MACHINE_JWKS_URI: "https://issuer.example/identity/jwks",
      CAPABILITY_MACHINE_ISSUER: "capability-issuer",
      CAPABILITY_MACHINE_AUDIENCE: "platform-automation-capability-read",
      CAPABILITY_MACHINE_SUBJECT: "capability",
      TEMPORAL_API_KEY: "must-not-be-consumed",
      TEMPORAL_ADDRESS: "temporal.example:7233",
      TEMPORAL_TLS_SERVER_NAME: "temporal.example",
      TEMPORAL_TLS_CA_FILE: path,
    };
    expect(
      await machineTokenConfiguration(
        "temporal-customer-client",
        "b".repeat(64),
        env,
      ),
    ).toMatchObject({
      profile: "temporal-customer-client",
      subject: "customer",
      issuer: "issuer",
      runtimeIdentity: "b".repeat(64),
    });
    expect(
      await machineTokenConfiguration(
        "capability-request",
        "b".repeat(64),
        env,
      ),
    ).toMatchObject({
      profile: "capability-request",
      subject: "capability",
      issuer: "capability-issuer",
    });
    expect(await temporalTlsConfiguration(env)).toMatchObject({
      address: "temporal.example:7233",
      tls: {
        serverNameOverride: "temporal.example",
        serverRootCACertificate: Buffer.from("fixture"),
      },
    });
    await expect(
      temporalTlsConfiguration({
        ...env,
        TEMPORAL_TLS_SERVER_NAME: "bad/name",
      }),
    ).rejects.toThrow("MACHINE_RUNTIME_CONFIGURATION_INVALID");
    await expect(
      machineTokenConfiguration("temporal-customer-client", "b".repeat(64), {
        ...env,
        TEMPORAL_MACHINE_SUBJECT: " customer",
      }),
    ).rejects.toThrow("MACHINE_RUNTIME_CONFIGURATION_INVALID");
  });
});
